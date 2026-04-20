#!/usr/bin/env node

/**
 * Orchestrator for the distributed search engine.
 *
 * Usage:
 *   node engine/run.js --seeds "https://…,https://…" --maxPages 200
 *
 * Pipeline:
 *   1. Boot local coordinator node + N worker nodes
 *   2. Register crawl / pages / index groups (same node set)
 *   3. Crawl seed URLs (distributed MR)
 *   4. Build inverted index (distributed MR)
 *   5. Start web-UI query server
 */

const distribution = require('../distribution');

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
    .help()
    .parse();

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const seeds = args.seeds.split(',').map((s) => s.trim()).filter(Boolean);
const numNodes = args.nodes;
const basePort = args.basePort;

const workerNodes = [];
for (let i = 0; i < numNodes; i++) {
  workerNodes.push({ip: '127.0.0.1', port: basePort + i});
}

console.log('[run] ──────────────────────────────────────');
console.log('[run]  Distributed Search Engine — CS1380 M6');
console.log('[run] ──────────────────────────────────────');
console.log(`[run] Workers : ${numNodes} (ports ${basePort}–${basePort + numNodes - 1})`);
console.log(`[run] Seeds   : ${seeds.length} URL(s)`);
console.log(`[run] Max pgs : ${args.maxPages}`);
console.log('[run] ──────────────────────────────────────');

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

if (args.clean) {
  const fs = require('fs');
  const path = require('path');
  const storeDir = path.join(__dirname, '..', 'store');
  if (fs.existsSync(storeDir)) {
    fs.rmSync(storeDir, {recursive: true, force: true});
    console.log('[run] Cleaned store/ directory');
  }
}

const dist = distribution();

dist.node.start((e) => {
  if (e) {
    console.error('[run] Failed to start coordinator:', e);
    process.exit(1);
  }
  console.log('[run] Coordinator node started on port',
      dist.node.config.port);

  spawnNodes(workerNodes, 0, () => {
    console.log(`[run] ${numNodes} worker node(s) spawned`);

    const id = dist.util.id;
    const group = {};
    workerNodes.forEach((n) => {
      group[id.getSID(n)] = n;
    });

    const groupNames = ['crawl', 'index'];
    registerGroups(groupNames, group, 0, () => {
      console.log('[run] Groups registered:', groupNames.join(', '));

      /* ---------- Pipeline ---------- */
      if (args.skipCrawl) {
        console.log('[run] Skipping crawl (--skipCrawl)');
        dist['crawl'].store.get('__crawler_state__', (e, state) => {
          const urls = (state && state.crawledUrls) ? state.crawledUrls : [];
          console.log(`[run] Recovered ${urls.length} crawled URL(s) from saved state`);
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
  const {crawl} = require('./crawler');
  crawl({
    seeds,
    maxPages: args.maxPages,
    groupName: 'crawl',
  }, (e, result) => {
    if (e) {
      console.error('[run] Crawl failed:', e);
      process.exit(1);
    }
    console.log(`[run] Crawl done — ${result.totalCrawled} page(s)`);
    runIndexPhase(result.crawledUrls);
  });
}

function runIndexPhase(crawledUrls) {
  if (args.skipIndex) {
    console.log('[run] Skipping index (--skipIndex)');
    return runServePhase();
  }

  const {buildIndex} = require('./indexer');
  buildIndex({
    crawlGroupName: 'crawl',
    indexGroupName: 'index',
    crawledUrls,
  }, (e, result) => {
    if (e) {
      console.error('[run] Index failed:', e);
      process.exit(1);
    }
    console.log(
        `[run] Index done — ${result.totalTerms} terms ` +
        `from ${result.totalDocs} doc(s)`,
    );
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
      console.error('[run] Server failed:', e);
      process.exit(1);
    }
    console.log('[run] ──────────────────────────────────────');
    console.log(`[run]  Ready → http://localhost:${args.serverPort}`);
    console.log('[run] ──────────────────────────────────────');
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function spawnNodes(nodes, idx, cb) {
  if (idx >= nodes.length) return cb();
  dist.local.status.spawn(nodes[idx], (e) => {
    if (e) {
      console.error(`[run] Cannot spawn worker ${idx}:`, e);
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

/* Graceful shutdown — tear down workers on exit */
process.on('SIGINT', () => {
  console.log('\n[run] Shutting down …');
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
