#!/usr/bin/env node

/**
 * Unified entry point for the distributed search engine.
 *
 * Each AWS instance runs this script as either a coordinator or a worker.
 *
 * Worker (run first on each worker instance):
 *   node engine/run.js --role worker --ip <private-ip> --port 7110
 *
 * Coordinator (run last, after all workers are up):
 *   node engine/run.js --role coordinator \
 *     --ip <private-ip> \
 *     --workers "10.0.0.2:7110,10.0.0.3:7110,10.0.0.4:7110" \
 *     --seeds "https://example.com" \
 *     --maxPages 500
 *
 * Pipeline (coordinator only):
 *   1. Poll each worker until it responds to a status ping
 *   2. Register crawl / index groups with the worker node set
 *   3. Crawl seed URLs (distributed MR across workers)
 *   4. Build inverted index (distributed MR across workers)
 *   5. Serve the search web UI
 */

const distribution = require('../distribution');

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
        'https://en.wikipedia.org/wiki/Computer_science',
        'https://en.wikipedia.org/wiki/Alan_Turing',
      ].join(','),
    })
    .option('maxPages', {
      type: 'number',
      describe: '[coordinator] Maximum number of pages to crawl',
      default: 100,
    })
    .option('serverPort', {
      type: 'number',
      describe: '[coordinator] Port for the search web UI',
      default: 3000,
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
    .option('maxIndex', {
      type: 'number',
      describe: '[coordinator] Max number of pages to index (default: all)',
      default: 0,
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
/*  Worker                                                             */
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

    const crawlService = require('./worker_crawl');
    dist.local.routes.put(crawlService, 'crawl-fetch', () => {
      console.log(`[worker] Ready - listening on ${nodeIp}:${port} (crawl-fetch registered)`);
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

  console.log('[coordinator] ──────────────────────────────────────');
  console.log('[coordinator]  Distributed Search Engine');
  console.log('[coordinator] ──────────────────────────────────────');
  workerNodes.forEach((n) => console.log(`[coordinator]   worker → ${n.ip}:${n.port}`));
  console.log(`[coordinator] Seeds    : ${seeds.length} URL(s)`);
  console.log(`[coordinator] Max pgs  : ${args.maxPages}`);
  console.log('[coordinator] ──────────────────────────────────────');

  if (args.clean) {
    const fs = require('fs');
    const path = require('path');
    const storeDir = path.join(__dirname, '..', 'store');
    if (fs.existsSync(storeDir)) {
      fs.rmSync(storeDir, {recursive: true, force: true});
      console.log('[coordinator] Cleaned store/ directory');
    }
  }

  const dist = distribution({ip: nodeIp, port});

  dist.node.start((e) => {
    if (e) {
      console.error('[coordinator] Failed to start:', e);
      process.exit(1);
    }
    console.log(`[coordinator] Node started on ${nodeIp}:${port}`);

    waitForWorkers(dist, workerNodes, 0, () => {
      console.log(`[coordinator] All ${workerNodes.length} worker(s) ready`);

      const id = dist.util.id;
      const group = {};
      workerNodes.forEach((n) => {
        group[id.getSID(n)] = n;
      });

      const groupNames = ['crawl', 'index'];
      registerGroups(dist, groupNames, group, 0, () => {
        console.log('[coordinator] Groups registered:', groupNames.join(', '));

        if (args.skipCrawl) {
          console.log('[coordinator] Skipping crawl (--skipCrawl)');
          // Recover URLs from chunked storage (new format) or legacy state
          loadCrawledUrlChunks(dist, 'crawl', (urls) => {
            if (urls.length > 0) {
              console.log(`[coordinator] Recovered ${urls.length} crawled URL(s)`);
              return runIndexPhase(dist, urls);
            }
            // Fallback: try legacy __crawler_state__ format
            dist['crawl'].store.get('__crawler_state__', (e, state) => {
              const legacy = (state && state.crawledUrls) ? state.crawledUrls : [];
              console.log(`[coordinator] Recovered ${legacy.length} URL(s) (legacy)`);
              return runIndexPhase(dist, legacy);
            });
          });
          return;
        }
        runCrawlPhase(dist, seeds);
      });
    });
  });

  process.on('SIGINT', () => {
    console.log('\n[coordinator] Shutting down …');
    let remaining = workerNodes.length;
    if (remaining === 0) process.exit(0);

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
  });
}

/* ------------------------------------------------------------------ */
/*  Pipeline phases                                                    */
/* ------------------------------------------------------------------ */

function runCrawlPhase(dist, seeds) {
  const {crawl} = require('./crawler');
  crawl({
    seeds,
    maxPages: args.maxPages,
    groupName: 'crawl',
  }, (e, result) => {
    if (e) {
      console.error('[coordinator] Crawl failed:', e);
      process.exit(1);
    }
    console.log(`[coordinator] Crawl done - ${result.totalCrawled} page(s)`);
    runIndexPhase(dist, result.crawledUrls);
  });
}

function runIndexPhase(dist, crawledUrls) {
  if (args.skipIndex) {
    console.log('[coordinator] Skipping index (--skipIndex)');
    return runPageRankPhase(dist, crawledUrls);
  }
  if (args.maxIndex > 0 && crawledUrls.length > args.maxIndex) {
    console.log(`[coordinator] Limiting index to ${args.maxIndex} of ${crawledUrls.length} pages`);
    crawledUrls = crawledUrls.slice(0, args.maxIndex);
  }

  const {buildIndex} = require('./indexer');
  buildIndex({
    crawlGroupName: 'crawl',
    indexGroupName: 'index',
    crawledUrls,
  }, (e, result) => {
    if (e) {
      console.error('[coordinator] Index failed:', e);
      process.exit(1);
    }
    console.log(
        `[coordinator] Index done - ${result.totalTerms} terms ` +
        `from ${result.totalDocs} doc(s)`,
    );
    runPageRankPhase(dist, crawledUrls);
  });
}

function runPageRankPhase(dist, crawledUrls) {
  if (args.skipIndex) {
    console.log('[coordinator] Skipping PageRank (--skipIndex)');
    return runServePhase();
  }

  const {computePageRank} = require('./pagerank');
  computePageRank({
    crawlGroupName: 'crawl',
    indexGroupName: 'index',
    crawledUrls,
    iterations: 10,
  }, (e, result) => {
    if (e) {
      console.error('[coordinator] PageRank failed:', e);
      // Non-fatal - continue to serve
    } else {
      console.log(
          `[coordinator] PageRank done - ${result.pageCount} pages, ` +
          `${result.iterations} iterations`,
      );
    }
    runServePhase();
  });
}

function runServePhase() {
  const {startServer} = require('./server');
  startServer({
    port: args.serverPort,
    indexGroupName: 'index',
  }, (e) => {
    if (e) {
      console.error('[coordinator] Server failed:', e);
      process.exit(1);
    }
    console.log('[coordinator] ──────────────────────────────────────');
    console.log(`[coordinator]  Ready → http://${args.ip}:${args.serverPort}`);
    console.log('[coordinator] ──────────────────────────────────────');
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// Polls each worker via a status ping until it responds, then moves to the next.
function waitForWorkers(dist, nodes, idx, cb) {
  if (idx >= nodes.length) return cb();
  const node = nodes[idx];
  console.log(`[coordinator] Waiting for worker ${node.ip}:${node.port} …`);
  const attempt = () => {
    dist.local.comm.send(
        ['sid'], {node, service: 'status', method: 'get'},
        (e) => {
          if (e) {
            setTimeout(attempt, 1000);
          } else {
            console.log(`[coordinator] Worker ${node.ip}:${node.port} is up`);
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
