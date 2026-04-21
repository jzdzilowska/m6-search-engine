#!/usr/bin/env node

/**
 * Benchmark + Serve: runs the full benchmark pipeline (crawl, index,
 * query timing), saves CSV/JSON metrics, then starts the web UI
 * instead of shutting down.
 *
 * Usage:
 *   node benchmark/benchmark_serve.js --seeds "https://…" --maxPages 100
 *   node benchmark/benchmark_serve.js --skipCrawl --skipIndex --serverPort 3000
 */

const distribution = require('../distribution');
const {crawl: doCrawl} = require('../engine/old_crawler');
const {buildIndex} = require('../engine/indexer');
const {search} = require('../engine/query');
const {startServer} = require('../engine/server');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execSync} = require('child_process');

const args = require('yargs/yargs')(process.argv.slice(2))
    .option('seeds', {
      type: 'string',
      describe: 'Comma-separated seed URLs',
      default: [
        'https://cs.brown.edu/courses/csci1380/sandbox/1/',
        'https://cs.brown.edu/courses/csci1380/sandbox/2/',
      ].join(','),
    })
    .option('maxPages', {
      type: 'number',
      describe: 'Maximum number of pages to crawl',
      default: 100,
    })
    .option('nodes', {
      type: 'number',
      describe: 'Number of worker nodes to spawn',
      default: 3,
    })
    .option('basePort', {
      type: 'number',
      describe: 'Starting port for worker nodes',
      default: 7110,
    })
    .option('serverPort', {
      type: 'number',
      describe: 'Port for the search web UI',
      default: 3000,
    })
    .option('queryTerms', {
      type: 'string',
      describe: 'Comma-separated query strings to benchmark',
      default: 'computer science,algorithm,data structure,network,system',
    })
    .option('queryRuns', {
      type: 'number',
      describe: 'Number of times to run each query (for avg latency)',
      default: 5,
    })
    .option('warmupQueries', {
      type: 'number',
      describe: 'Number of warmup query runs to discard',
      default: 2,
    })
    .option('skipCrawl', {
      type: 'boolean',
      describe: 'Skip crawling (reuse stored pages)',
      default: false,
    })
    .option('skipIndex', {
      type: 'boolean',
      describe: 'Skip indexing (reuse stored index)',
      default: false,
    })
    .option('clean', {
      type: 'boolean',
      describe: 'Wipe all stored data before running',
      default: false,
    })
    .option('ip', {
      type: 'string',
      describe: 'IP address for coordinator and workers (use private IP on AWS)',
      default: '127.0.0.1',
    })
    .help()
    .parse();

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const seeds = args.seeds.split(',').map((s) => s.trim()).filter(Boolean);
const numNodes = args.nodes;
const basePort = args.basePort;
const queryTerms = args.queryTerms.split(',').map((s) => s.trim()).filter(Boolean);

const nodeIp = args.ip;

const workerNodes = [];
for (let i = 0; i < numNodes; i++) {
  workerNodes.push({ip: nodeIp, port: basePort + i});
}

/* ---- Unique output directory ---- */
const runTs = new Date();
const tsStr = runTs.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runId = crypto.randomBytes(3).toString('hex');
const outDir = path.join(__dirname, 'results', `${tsStr}_${runId}`);
fs.mkdirSync(outDir, {recursive: true});

/* ---- Benchmark results collector ---- */
const metrics = {
  config: {
    seeds,
    maxPages: args.maxPages,
    numNodes,
    basePort,
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

/* ---- Measure store directory size on disk ---- */
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

console.log('[bench+serve] ══════════════════════════════════════════');
console.log('[bench+serve]  Benchmark + Serve - Distributed Search Engine');
console.log('[bench+serve] ══════════════════════════════════════════');
console.log(`[bench+serve] Workers    : ${numNodes} (ports ${basePort}–${basePort + numNodes - 1})`);
console.log(`[bench+serve] Seeds      : ${seeds.length} URL(s)`);
console.log(`[bench+serve] Max pages  : ${args.maxPages}`);
console.log(`[bench+serve] Queries    : ${queryTerms.join(', ')}`);
console.log(`[bench+serve] Server port: ${args.serverPort}`);
console.log(`[bench+serve] Output dir : ${outDir}`);
console.log('[bench+serve] ══════════════════════════════════════════');

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

if (args.clean) {
  const storeDir = path.join(__dirname, '..', 'store');
  if (fs.existsSync(storeDir)) {
    fs.rmSync(storeDir, {recursive: true, force: true});
    console.log('[bench+serve] Cleaned store/ directory');
  }
}

markStart('total');

const dist = distribution({ip: nodeIp, port: 1234});

dist.node.start((e) => {
  if (e) {
    console.error('[bench+serve] Failed to start coordinator:', e);
    process.exit(1);
  }
  console.log('[bench+serve] Coordinator node started on port', dist.node.config.port);

  markStart('boot');
  spawnNodes(workerNodes, 0, () => {
    console.log(`[bench+serve] ${numNodes} worker node(s) spawned`);

    const id = dist.util.id;
    const group = {};
    workerNodes.forEach((n) => {
      group[id.getSID(n)] = n;
    });

    const groupNames = ['crawl', 'index'];
    registerGroups(groupNames, group, 0, () => {
      console.log('[bench+serve] Groups registered:', groupNames.join(', '));
      markEnd('boot');
      console.log(`[bench+serve] Boot time: ${metrics.timings.boot.durationMs}ms`);

      /* ---------- Pipeline ---------- */
      if (args.skipCrawl) {
        console.log('[bench+serve] Skipping crawl (--skipCrawl)');
        dist['crawl'].store.get('__crawler_state__', (e, state) => {
          const urls = (state && state.crawledUrls) ? state.crawledUrls : [];
          console.log(`[bench+serve] Recovered ${urls.length} crawled URL(s) from saved state`);
          return runIndexPhase(urls);
        });
        return;
      }
      runCrawlPhase();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Pipeline phases                                                    */
/* ------------------------------------------------------------------ */

function runCrawlPhase() {
  markStart('crawl');
  doCrawl({
    seeds,
    maxPages: args.maxPages,
    groupName: 'crawl',
  }, (e, result) => {
    markEnd('crawl');
    if (e) {
      console.error('[bench+serve] Crawl failed:', e);
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

    console.log(`[bench+serve] Crawl done - ${result.totalCrawled} page(s) in ${dur}ms (${metrics.crawl.pagesPerSec.toFixed(2)} pages/sec)`);
    console.log(`[bench+serve] Crawl store: ${formatBytes(crawlStore.totalBytes)} across ${crawlStore.totalFiles} files, ${Object.keys(crawlStore.perNode).length} node(s)`);
    runIndexPhase(result.crawledUrls);
  });
}

function runIndexPhase(crawledUrls) {
  if (args.skipIndex) {
    console.log('[bench+serve] Skipping index (--skipIndex)');
    return runQueryPhase();
  }

  markStart('index');

  buildIndex({
    crawlGroupName: 'crawl',
    indexGroupName: 'index',
    crawledUrls,
  }, (e, result) => {
    markEnd('index');
    if (e) {
      console.error('[bench+serve] Index failed:', e);
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

    console.log(
        `[bench+serve] Index done - ${result.totalTerms} terms from ${totalDocs} doc(s) ` +
        `in ${dur}ms (${metrics.index.docsPerSec.toFixed(2)} docs/sec)`,
    );
    console.log(`[bench+serve] Total store: ${formatBytes(indexStore.totalBytes)} across ${indexStore.totalFiles} files`);
    console.log(`[bench+serve] Index-only: ${formatBytes(metrics.index.indexOnlyBytes)} across ${metrics.index.indexOnlyFiles} files`);
    runQueryPhase();
  });
}

function runQueryPhase() {
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
        console.log(`[bench+serve] Query "${q}" avg latency: ${avg.toFixed(2)}ms (${measured.length} runs, ${warmup} warmup discarded)`);
        return nextQuery();
      }

      const start = Date.now();
      search(q, {indexGroupName: 'index', maxResults: 10}, (e, results) => {
        const elapsed = Date.now() - start;
        latencies.push(elapsed);
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
  const queriesPerSec = totalQueryRuns / (dur / 1000);

  metrics.query = {
    perQuery,
    overallAvgLatencyMs: +overallAvg.toFixed(2),
    queriesPerSec: +queriesPerSec.toFixed(2),
    totalDurationMs: dur,
  };

  markEnd('total');
  metrics.endToEnd = {
    durationMs: metrics.timings.total.durationMs,
  };

  console.log('[bench+serve] ══════════════════════════════════════════');
  console.log(`[bench+serve] TOTAL end-to-end: ${metrics.endToEnd.durationMs}ms`);
  console.log('[bench+serve] ══════════════════════════════════════════');

  saveAndServe();
}

/* ------------------------------------------------------------------ */
/*  Save results as CSV, then start web server                         */
/* ------------------------------------------------------------------ */

function saveAndServe() {
  // Save raw JSON
  const jsonPath = path.join(outDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(metrics, null, 2));
  console.log(`[bench+serve] JSON saved to ${jsonPath}`);

  // --- component_metrics.csv ---
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
  console.log(`[bench+serve] Component CSV saved to ${compCsvPath}`);

  // --- query_metrics.csv ---
  const qRows = [
    ['query', 'avg_latency_ms', 'min_latency_ms', 'max_latency_ms', 'runs'].join(','),
  ];
  (metrics.query.perQuery || []).forEach((q) => {
    qRows.push([`"${q.query}"`, q.avgLatencyMs, q.minLatencyMs, q.maxLatencyMs, q.runs].join(','));
  });
  const qCsvPath = path.join(outDir, 'query_metrics.csv');
  fs.writeFileSync(qCsvPath, qRows.join('\n') + '\n');
  console.log(`[bench+serve] Query CSV saved to ${qCsvPath}`);

  // --- system_metrics.csv ---
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
  const nodeKeys = Object.keys(latestStore).sort();
  nodeKeys.forEach((nid, i) => {
    const n = latestStore[nid];
    sysRows.push([`Node ${i} Data`, n.bytes, 'bytes'].join(','));
    sysRows.push([`Node ${i} Files`, n.files, 'files'].join(','));
  });

  const sysCsvPath = path.join(outDir, 'system_metrics.csv');
  fs.writeFileSync(sysCsvPath, sysRows.join('\n') + '\n');
  console.log(`[bench+serve] System CSV saved to ${sysCsvPath}`);

  // --- Generate PDF report ---
  try {
    const plotScript = path.join(__dirname, 'plot.py');
    execSync(`python3 "${plotScript}" "${outDir}"`, {stdio: 'inherit'});
    console.log(`[bench+serve] PDF report generated in ${outDir}`);
  } catch (err) {
    console.warn('[bench+serve] plot.py failed (non-fatal):', err.message);
  }

  // --- Start web server instead of shutting down ---
  console.log('[bench+serve] ══════════════════════════════════════════');
  console.log('[bench+serve] Benchmark complete. Starting web server…');
  console.log('[bench+serve] ══════════════════════════════════════════');

  startServer({
    port: args.serverPort,
    indexGroupName: 'index',
  }, (e) => {
    if (e) {
      console.error('[bench+serve] Server failed:', e);
      process.exit(1);
    }
    console.log('[bench+serve] ──────────────────────────────────────');
    console.log(`[bench+serve]  Ready → http://localhost:${args.serverPort}`);
    console.log('[bench+serve] ──────────────────────────────────────');
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function spawnNodes(nodes, idx, cb) {
  if (idx >= nodes.length) return cb();
  dist.local.status.spawn(nodes[idx], (e) => {
    if (e) {
      console.error(`[bench+serve] Cannot spawn worker ${idx}:`, e);
      process.exit(1);
    }
    spawnNodes(nodes, idx + 1, cb);
  });
}

function registerGroups(names, group, idx, cb) {
  if (idx >= names.length) return cb();
  const name = names[idx];
  const config = {gid: name};
  dist.local.groups.put(config, group, () => {
    dist[name].groups.put(config, group, () => {
      registerGroups(names, group, idx + 1, cb);
    });
  });
}

function shutdown() {
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

/* Graceful shutdown on SIGINT */
process.on('SIGINT', () => {
  console.log('\n[bench+serve] Interrupted - shutting down...');
  shutdown();
});
