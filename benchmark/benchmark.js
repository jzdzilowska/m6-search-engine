#!/usr/bin/env node

/**
 * Benchmark harness for the distributed search engine.
 *
 * Mirrors run.js exactly (coordinator/worker roles, same pipeline),
 * with timing instrumentation added to the coordinator path.
 *
 * Worker (run first on each worker instance):
 *   node benchmark/benchmark.js --role worker --ip <private-ip> --port 7110
 *
 * Coordinator (run last, after all workers are up):
 *   node benchmark/benchmark.js --role coordinator \
 *     --ip <private-ip> \
 *     --workers "10.0.0.2:7110,10.0.0.3:7110,10.0.0.4:7110" \
 *     --seeds "https://example.com" \
 *     --maxPages 500
 *
 * Results saved to benchmark/results/<timestamp>_<id>/
 * Then run: python3 benchmark/plot.py <output_dir>
 */

const distribution = require('../distribution');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = require('yargs/yargs')(process.argv.slice(2))
    .option('role', {
      type: 'string',
      choices: ['coordinator', 'worker'],
      describe: 'coordinator: runs the pipeline | worker: executes distributed tasks',
      demandOption: true,
    })
    .option('ip', {
      type: 'string',
      describe: "This node's own IP address (use the instance's private IP on AWS)",
      default: '127.0.0.1',
    })
    .option('port', {
      type: 'number',
      describe: "This node's listening port (coordinator defaults to 1234, worker to 7110)",
    })
    /* ---- coordinator-only options ---- */
    .option('workers', {
      type: 'string',
      describe: '[coordinator] Comma-separated worker addresses: ip:port,...',
      default: '',
    })
    .option('seeds', {
      type: 'string',
      describe: '[coordinator] Comma-separated seed URLs',
      default: [
        'https://cs.brown.edu/courses/csci1380/sandbox/1/',
        'https://cs.brown.edu/courses/csci1380/sandbox/2/',
      ].join(','),
    })
    .option('maxPages', {
      type: 'number',
      describe: '[coordinator] Maximum number of pages to crawl',
      default: 100,
    })
    .option('queryTerms', {
      type: 'string',
      describe: '[coordinator] Comma-separated query strings to benchmark',
      default: 'computer science,algorithm,data structure,network,system',
    })
    .option('queryRuns', {
      type: 'number',
      describe: '[coordinator] Number of times to run each query (for avg latency)',
      default: 5,
    })
    .option('warmupQueries', {
      type: 'number',
      describe: '[coordinator] Number of warmup query runs to discard',
      default: 2,
    })
    .option('skipCrawl', {
      type: 'boolean',
      describe: '[coordinator] Skip crawling (reuse stored pages)',
      default: false,
    })
    .option('skipIndex', {
      type: 'boolean',
      describe: '[coordinator] Skip indexing (reuse stored index)',
      default: false,
    })
    .option('clean', {
      type: 'boolean',
      describe: '[coordinator] Wipe all stored data before running',
      default: false,
    })
    .help()
    .parse();

if (args.role === 'worker') {
  startWorker();
} else {
  startCoordinator();
}

/* ------------------------------------------------------------------ */
/*  Worker — identical to run.js                                       */
/* ------------------------------------------------------------------ */

function startWorker() {
  const port = args.port || 7110;
  const nodeIp = args.ip;

  console.log(`[worker] Starting on ${nodeIp}:${port}`);

  const dist = distribution({ip: nodeIp, port});
  dist.node.start((e) => {
    if (e) {
      console.error('[worker] Failed to start:', e);
      process.exit(1);
    }

    const crawlService = require('../engine/worker_crawl');
    dist.local.routes.put(crawlService, 'crawl-fetch', () => {
      console.log(`[worker] Ready — listening on ${nodeIp}:${port} (crawl-fetch registered)`);
    });
  });

  process.on('SIGINT', () => {
    if (dist.node.server) dist.node.server.close();
    process.exit(0);
  });
}

/* ------------------------------------------------------------------ */
/*  Coordinator                                                        */
/* ------------------------------------------------------------------ */

function startCoordinator() {
  const port = args.port || 1234;
  const nodeIp = args.ip;
  const seeds = args.seeds.split(',').map((s) => s.trim()).filter(Boolean);
  const queryTerms = args.queryTerms.split(',').map((s) => s.trim()).filter(Boolean);

  const workerNodes = args.workers
      .split(',')
      .map((w) => {
        const trimmed = w.trim();
        if (!trimmed) return null;
        const [ip, p] = trimmed.split(':');
        return {ip, port: parseInt(p, 10)};
      })
      .filter((n) => n && n.ip && !isNaN(n.port));

  if (workerNodes.length === 0) {
    console.error(
        '[coordinator] No workers specified.\n' +
        '  Use --workers "ip1:port1,ip2:port2,..."',
    );
    process.exit(1);
  }

  /* ---- Unique output directory ---- */
  const runTs = new Date();
  const tsStr = runTs.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = crypto.randomBytes(3).toString('hex');
  const outDir = path.join(__dirname, 'results', `${tsStr}_${runId}`);
  fs.mkdirSync(outDir, {recursive: true});

  /* ---- Metrics collector ---- */
  const metrics = {
    config: {
      seeds,
      maxPages: args.maxPages,
      numNodes: workerNodes.length,
      queryTerms,
      queryRuns: args.queryRuns,
      warmupQueries: args.warmupQueries,
      timestamp: runTs.toISOString(),
    },
    timings: {},
    crawl: {},
    index: {},
    query: {},
    endToEnd: {},
    system: {},
  };

  function markStart(name) {
    metrics.timings[name] = {startMs: Date.now()};
  }
  function markEnd(name) {
    const t = metrics.timings[name];
    t.endMs = Date.now();
    t.durationMs = t.endMs - t.startMs;
  }

  function measureStoreSize() {
    const storeDir = path.join(__dirname, '..', 'store');
    if (!fs.existsSync(storeDir)) return {totalBytes: 0, totalFiles: 0, perNode: {}};
    let totalBytes = 0;
    let totalFiles = 0;
    const perNode = {};
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else {
          const sz = fs.statSync(full).size;
          totalBytes += sz;
          totalFiles++;
          const rel = path.relative(storeDir, full);
          const nid = rel.split(path.sep)[0] || 'unknown';
          if (!perNode[nid]) perNode[nid] = {bytes: 0, files: 0};
          perNode[nid].bytes += sz;
          perNode[nid].files++;
        }
      }
    }
    walk(storeDir);
    return {totalBytes, totalFiles, perNode};
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  console.log('[bench] ══════════════════════════════════════════');
  console.log('[bench]  Benchmark — Distributed Search Engine');
  console.log('[bench] ══════════════════════════════════════════');
  workerNodes.forEach((n) => console.log(`[bench]   worker → ${n.ip}:${n.port}`));
  console.log(`[bench] Seeds      : ${seeds.length} URL(s)`);
  console.log(`[bench] Max pages  : ${args.maxPages}`);
  console.log(`[bench] Queries    : ${queryTerms.join(', ')}`);
  console.log(`[bench] Output dir : ${outDir}`);
  console.log('[bench] ══════════════════════════════════════════');

  if (args.clean) {
    const storeDir = path.join(__dirname, '..', 'store');
    if (fs.existsSync(storeDir)) {
      fs.rmSync(storeDir, {recursive: true, force: true});
      console.log('[bench] Cleaned store/ directory');
    }
  }

  markStart('total');

  const dist = distribution({ip: nodeIp, port});

  dist.node.start((e) => {
    if (e) {
      console.error('[bench] Failed to start coordinator:', e);
      process.exit(1);
    }
    console.log(`[bench] Coordinator node started on ${nodeIp}:${port}`);

    markStart('boot');
    waitForWorkers(dist, workerNodes, 0, () => {
      console.log(`[bench] All ${workerNodes.length} worker(s) ready`);

      const id = dist.util.id;
      const group = {};
      workerNodes.forEach((n) => {
        group[id.getSID(n)] = n;
      });

      const groupNames = ['crawl', 'index'];
      registerGroups(dist, groupNames, group, 0, () => {
        console.log('[bench] Groups registered:', groupNames.join(', '));
        markEnd('boot');
        console.log(`[bench] Boot time: ${metrics.timings.boot.durationMs}ms`);

        if (args.skipCrawl) {
          console.log('[bench] Skipping crawl (--skipCrawl)');
          loadCrawledUrlChunks(dist, 'crawl', (urls) => {
            if (urls.length > 0) {
              console.log(`[bench] Recovered ${urls.length} crawled URL(s)`);
              return runIndexPhase(urls);
            }
            dist['crawl'].store.get('__crawler_state__', (e2, state) => {
              const legacy = (state && state.crawledUrls) ? state.crawledUrls : [];
              console.log(`[bench] Recovered ${legacy.length} URL(s) (legacy)`);
              return runIndexPhase(legacy);
            });
          });
          return;
        }
        runCrawlPhase();
      });
    });
  });

  process.on('SIGINT', () => {
    console.log('\n[bench] Interrupted — shutting down…');
    shutdownWorkers(dist, workerNodes);
  });

  /* ------------------------------------------------------------------ */
  /*  Pipeline phases                                                    */
  /* ------------------------------------------------------------------ */

  function runCrawlPhase() {
    const {crawl} = require('../engine/crawler');
    markStart('crawl');
    crawl({
      seeds,
      maxPages: args.maxPages,
      groupName: 'crawl',
    }, (e, result) => {
      markEnd('crawl');
      if (e) {
        console.error('[bench] Crawl failed:', e);
        process.exit(1);
      }
      const dur = metrics.timings.crawl.durationMs;
      metrics.crawl = {
        totalPages: result.totalCrawled,
        durationMs: dur,
        pagesPerSec: result.totalCrawled / (dur / 1000),
        latencyPerPageMs: dur / Math.max(result.totalCrawled, 1),
      };
      const crawlStore = measureStoreSize();
      metrics.crawl.storeTotalBytes = crawlStore.totalBytes;
      metrics.crawl.storeTotalFiles = crawlStore.totalFiles;
      metrics.crawl.storePerNode = crawlStore.perNode;

      console.log(`[bench] Crawl done — ${result.totalCrawled} page(s) in ${dur}ms (${metrics.crawl.pagesPerSec.toFixed(2)} pages/sec)`);
      console.log(`[bench] Crawl store: ${formatBytes(crawlStore.totalBytes)} across ${crawlStore.totalFiles} files`);
      runIndexPhase(result.crawledUrls);
    });
  }

  function runIndexPhase(crawledUrls) {
    if (args.skipIndex) {
      console.log('[bench] Skipping index (--skipIndex)');
      return runQueryPhase();
    }

    const {buildIndex} = require('../engine/indexer');
    markStart('index');
    buildIndex({
      crawlGroupName: 'crawl',
      indexGroupName: 'index',
      crawledUrls,
    }, (e, result) => {
      markEnd('index');
      if (e) {
        console.error('[bench] Index failed:', e);
        process.exit(1);
      }
      const dur = metrics.timings.index.durationMs;
      const totalDocs = result.totalDocs || crawledUrls.length;
      metrics.index = {
        totalTerms: result.totalTerms,
        totalDocs,
        durationMs: dur,
        docsPerSec: totalDocs / (dur / 1000),
        latencyPerDocMs: dur / Math.max(totalDocs, 1),
      };
      const indexStore = measureStoreSize();
      metrics.index.storeTotalBytes = indexStore.totalBytes;
      metrics.index.storeTotalFiles = indexStore.totalFiles;
      metrics.index.storePerNode = indexStore.perNode;
      const crawlBytes = metrics.crawl.storeTotalBytes || 0;
      metrics.index.indexOnlyBytes = Math.max(0, indexStore.totalBytes - crawlBytes);
      metrics.index.indexOnlyFiles = Math.max(0, indexStore.totalFiles - (metrics.crawl.storeTotalFiles || 0));

      console.log(`[bench] Index done — ${result.totalTerms} terms from ${totalDocs} doc(s) in ${dur}ms (${metrics.index.docsPerSec.toFixed(2)} docs/sec)`);
      console.log(`[bench] Total store: ${formatBytes(indexStore.totalBytes)} across ${indexStore.totalFiles} files`);
      runQueryPhase();
    });
  }

  function runQueryPhase() {
    const {search} = require('../engine/query');
    markStart('query');

    const warmup = args.warmupQueries;
    const runs = args.queryRuns;
    const perQuery = [];
    let qi = 0;

    function nextQuery() {
      if (qi >= queryTerms.length) {
        markEnd('query');
        finishQueryPhase(perQuery);
        return;
      }
      const q = queryTerms[qi++];
      const latencies = [];
      let ri = 0;

      function nextRun() {
        if (ri >= warmup + runs) {
          const measured = latencies.slice(warmup);
          const avg = measured.reduce((a, b) => a + b, 0) / measured.length;
          perQuery.push({
            query: q,
            avgLatencyMs: +avg.toFixed(2),
            minLatencyMs: +Math.min(...measured).toFixed(2),
            maxLatencyMs: +Math.max(...measured).toFixed(2),
            runs: measured.length,
            allLatencies: measured.map((l) => +l.toFixed(2)),
          });
          console.log(`[bench] Query "${q}" avg latency: ${avg.toFixed(2)}ms (${measured.length} runs, ${warmup} warmup discarded)`);
          return nextQuery();
        }
        const start = Date.now();
        search(q, {indexGroupName: 'index', maxResults: 10}, (e, results) => {
          latencies.push(Date.now() - start);
          ri++;
          nextRun();
        });
      }
      nextRun();
    }

    nextQuery();
  }

  function finishQueryPhase(perQuery) {
    const dur = metrics.timings.query.durationMs;
    const allAvgs = perQuery.map((p) => p.avgLatencyMs);
    const overallAvg = allAvgs.length > 0 ?
      allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : 0;
    const totalQueryRuns = perQuery.reduce((s, p) => s + p.runs, 0);

    metrics.query = {
      perQuery,
      overallAvgLatencyMs: +overallAvg.toFixed(2),
      queriesPerSec: +(totalQueryRuns / (dur / 1000)).toFixed(2),
      totalDurationMs: dur,
    };

    markEnd('total');
    metrics.endToEnd = {durationMs: metrics.timings.total.durationMs};

    console.log('[bench] ══════════════════════════════════════════');
    console.log(`[bench] TOTAL end-to-end: ${metrics.endToEnd.durationMs}ms`);
    console.log('[bench] ══════════════════════════════════════════');

    saveAndReport();
  }

  /* ------------------------------------------------------------------ */
  /*  Save results as CSV                                                */
  /* ------------------------------------------------------------------ */

  function saveAndReport() {
    const jsonPath = path.join(outDir, 'results.json');
    fs.writeFileSync(jsonPath, JSON.stringify(metrics, null, 2));
    console.log(`[bench] JSON saved to ${jsonPath}`);

    // component_metrics.csv
    const compRows = [
      ['component', 'duration_ms', 'latency_ms', 'throughput', 'throughput_unit', 'items'].join(','),
    ];
    if (metrics.timings.boot) {
      compRows.push(['Boot', metrics.timings.boot.durationMs, '', '', '', ''].join(','));
    }
    if (metrics.timings.crawl) {
      const c = metrics.crawl;
      compRows.push(['Crawler', c.durationMs, c.latencyPerPageMs.toFixed(2),
        c.pagesPerSec.toFixed(2), 'pages/sec', c.totalPages].join(','));
    }
    if (metrics.timings.index) {
      const ix = metrics.index;
      compRows.push(['Indexer', ix.durationMs, ix.latencyPerDocMs.toFixed(2),
        ix.docsPerSec.toFixed(2), 'docs/sec', ix.totalDocs].join(','));
    }
    if (metrics.timings.query) {
      const q = metrics.query;
      compRows.push(['Query', q.totalDurationMs, q.overallAvgLatencyMs.toFixed(2),
        q.queriesPerSec.toFixed(2), 'queries/sec', ''].join(','));
    }
    compRows.push(['End-to-End', metrics.endToEnd.durationMs, metrics.endToEnd.durationMs, '', '', ''].join(','));
    const compCsvPath = path.join(outDir, 'component_metrics.csv');
    fs.writeFileSync(compCsvPath, compRows.join('\n') + '\n');
    console.log(`[bench] Component CSV saved to ${compCsvPath}`);

    // query_metrics.csv
    const qRows = [
      ['query', 'avg_latency_ms', 'min_latency_ms', 'max_latency_ms', 'runs'].join(','),
    ];
    (metrics.query.perQuery || []).forEach((q) => {
      qRows.push([`"${q.query}"`, q.avgLatencyMs, q.minLatencyMs, q.maxLatencyMs, q.runs].join(','));
    });
    const qCsvPath = path.join(outDir, 'query_metrics.csv');
    fs.writeFileSync(qCsvPath, qRows.join('\n') + '\n');
    console.log(`[bench] Query CSV saved to ${qCsvPath}`);

    // system_metrics.csv
    const numNodes = workerNodes.length;
    const sysRows = [
      ['metric', 'value', 'unit'].join(','),
      ['Worker Nodes', numNodes, 'nodes'].join(','),
      ['Seed URLs', seeds.length, 'URLs'].join(','),
      ['Max Pages', args.maxPages, 'pages'].join(','),
    ];
    if (metrics.crawl.totalPages != null) {
      sysRows.push(['Pages Crawled', metrics.crawl.totalPages, 'pages'].join(','));
      sysRows.push(['Crawl Store Size', metrics.crawl.storeTotalBytes || 0, 'bytes'].join(','));
      sysRows.push(['Crawl Store Files', metrics.crawl.storeTotalFiles || 0, 'files'].join(','));
    }
    if (metrics.index.totalTerms != null) {
      sysRows.push(['Unique Index Terms', metrics.index.totalTerms, 'terms'].join(','));
      sysRows.push(['Indexed Documents', metrics.index.totalDocs, 'docs'].join(','));
      sysRows.push(['Total Store Size', metrics.index.storeTotalBytes || 0, 'bytes'].join(','));
      sysRows.push(['Total Store Files', metrics.index.storeTotalFiles || 0, 'files'].join(','));
      sysRows.push(['Index-Only Size', metrics.index.indexOnlyBytes || 0, 'bytes'].join(','));
      sysRows.push(['Index-Only Files', metrics.index.indexOnlyFiles || 0, 'files'].join(','));
    }
    const latestStore = metrics.index.storePerNode || metrics.crawl.storePerNode || {};
    Object.keys(latestStore).sort().forEach((nid, i) => {
      const n = latestStore[nid];
      sysRows.push([`Node ${i} Data`, n.bytes, 'bytes'].join(','));
      sysRows.push([`Node ${i} Files`, n.files, 'files'].join(','));
    });
    const sysCsvPath = path.join(outDir, 'system_metrics.csv');
    fs.writeFileSync(sysCsvPath, sysRows.join('\n') + '\n');
    console.log(`[bench] System CSV saved to ${sysCsvPath}`);

    console.log('[bench] Benchmark complete. Shutting down…');
    console.log(`[bench] To generate PDF report run:`);
    console.log(`[bench]   python3 benchmark/plot.py ${outDir}`);
    shutdownWorkers(dist, workerNodes);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function waitForWorkers(dist, nodes, idx, cb) {
  if (idx >= nodes.length) return cb();
  const node = nodes[idx];
  console.log(`[bench] Waiting for worker ${node.ip}:${node.port} …`);
  const attempt = () => {
    dist.local.comm.send(
        ['sid'], {node, service: 'status', method: 'get'},
        (e) => {
          if (e) {
            setTimeout(attempt, 1000);
          } else {
            console.log(`[bench] Worker ${node.ip}:${node.port} is up`);
            waitForWorkers(dist, nodes, idx + 1, cb);
          }
        },
    );
  };
  attempt();
}

function registerGroups(dist, names, group, idx, cb) {
  if (idx >= names.length) return cb();
  const name = names[idx];
  const config = {gid: name};
  dist.local.groups.put(config, group, () => {
    dist[name].groups.put(config, group, () => {
      registerGroups(dist, names, group, idx + 1, cb);
    });
  });
}

function loadCrawledUrlChunks(dist, gid, cb) {
  const URL_LIST_KEY = '__crawled_urls__';
  const allUrls = [];
  let idx = 0;
  function loadNext() {
    const key = URL_LIST_KEY + ':' + idx;
    dist[gid].store.get(key, (e, chunk) => {
      if (e || !chunk || !Array.isArray(chunk)) return cb(allUrls);
      allUrls.push(...chunk);
      idx += chunk.length;
      loadNext();
    });
  }
  loadNext();
}

function shutdownWorkers(dist, workerNodes) {
  let remaining = workerNodes.length;
  if (remaining === 0) {
    if (dist.node.server) dist.node.server.close();
    process.exit(0);
  }
  workerNodes.forEach((node) => {
    dist.local.comm.send(
        [], {node, service: 'status', method: 'stop'},
        () => {
          if (--remaining === 0) {
            if (dist.node.server) dist.node.server.close();
            process.exit(0);
          }
        },
    );
  });
  setTimeout(() => process.exit(1), 5000);
}
