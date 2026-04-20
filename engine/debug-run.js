#!/usr/bin/env node

/**
 * Used AI to generate this file for debugging purposes. Not part of core functionality of search engine.
 * Debug orchestrator — same pipeline as run.js but with live node
 * status monitoring printed to the terminal at each stage.
 *
 * Shows per-node: message counts, heap usage, and store data distribution.
 *
 * Usage:
 *   node engine/debug-run.js --seeds "https://…" --maxPages 100 --nodes 3
 *   node engine/debug-run.js --seeds "https://…" --maxPages 100 --pollInterval 3000
 */

const distribution = require('../distribution');
const fs = require('fs');
const path = require('path');

const args = require('yargs/yargs')(process.argv.slice(2))
    .option('seeds', {
      type: 'string',
      describe: 'Comma-separated seed URLs',
      default: [
        'https://cs.brown.edu/courses/csci1380/sandbox/1/',
        'https://cs.brown.edu/courses/csci1380/sandbox/2/',
      ].join(','),
    })
    .option('maxPages', {type: 'number', default: 100})
    .option('nodes', {type: 'number', default: 3})
    .option('basePort', {type: 'number', default: 7110})
    .option('serverPort', {type: 'number', default: 3000})
    .option('skipCrawl', {type: 'boolean', default: false})
    .option('skipIndex', {type: 'boolean', default: false})
    .option('clean', {type: 'boolean', default: false})
    .option('pollInterval', {
      type: 'number',
      describe: 'How often (ms) to poll node status during long phases',
      default: 5000,
    })
    .help()
    .parse();

const seeds = args.seeds.split(',').map((s) => s.trim()).filter(Boolean);
const numNodes = args.nodes;
const basePort = args.basePort;
const workerNodes = [];
for (let i = 0; i < numNodes; i++) {
  workerNodes.push({ip: '127.0.0.1', port: basePort + i});
}

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

const storeDir = path.join(__dirname, '..', 'store');

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Measure store/ size per node-id subdirectory */
function getStoreSizes() {
  if (!fs.existsSync(storeDir)) return {};
  const perNode = {};
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else {
        const sz = fs.statSync(full).size;
        const rel = path.relative(storeDir, full);
        const parts = rel.split(path.sep);
        const nid = parts[0] || 'unknown';
        const gid = parts[1] || '?';
        const key = `${nid.slice(0, 8)}/${gid}`;
        if (!perNode[key]) perNode[key] = {bytes: 0, files: 0};
        perNode[key].bytes += sz;
        perNode[key].files++;
      }
    }
  }
  walk(storeDir);
  return perNode;
}

/** Query all nodes for message counts + heap, then print a status table */
function printNodeStatus(label, cb) {
  const line = '─'.repeat(70);
  console.log(`\n\x1b[36m${line}\x1b[0m`);
  console.log(`\x1b[36m  NODE STATUS — ${label}\x1b[0m`);
  console.log(`\x1b[36m${line}\x1b[0m`);

  let pending = 3; // counts, heapUsed, heapTotal
  const data = {};

  function maybePrint() {
    if (--pending > 0) return;

    // Per-node RPC stats
    const sids = Object.keys(data.counts || {});
    console.log(`  ${'Node (SID)'.padEnd(14)} ${'Messages'.padEnd(12)} ${'Heap Used'.padEnd(14)} ${'Heap Total'.padEnd(14)}`);
    console.log(`  ${'──────────'.padEnd(14)} ${'────────'.padEnd(12)} ${'─────────'.padEnd(14)} ${'──────────'.padEnd(14)}`);
    for (const sid of sids) {
      const msgs = data.counts[sid] != null ? String(data.counts[sid]) : '?';
      const used = data.heapUsed[sid] != null ? formatBytes(data.heapUsed[sid]) : '?';
      const total = data.heapTotal[sid] != null ? formatBytes(data.heapTotal[sid]) : '?';
      console.log(`  ${sid.padEnd(14)} ${msgs.padEnd(12)} ${used.padEnd(14)} ${total.padEnd(14)}`);
    }

    // Store on disk
    const storeSizes = getStoreSizes();
    const storeKeys = Object.keys(storeSizes).sort();
    if (storeKeys.length > 0) {
      let totalBytes = 0; let totalFiles = 0;
      console.log('');
      console.log(`  ${'Store (nid/gid)'.padEnd(24)} ${'Size'.padEnd(14)} ${'Files'.padEnd(8)}`);
      console.log(`  ${'───────────────'.padEnd(24)} ${'────'.padEnd(14)} ${'─────'.padEnd(8)}`);
      for (const k of storeKeys) {
        const s = storeSizes[k];
        totalBytes += s.bytes;
        totalFiles += s.files;
        console.log(`  ${k.padEnd(24)} ${formatBytes(s.bytes).padEnd(14)} ${String(s.files).padEnd(8)}`);
      }
      console.log(`  ${'TOTAL'.padEnd(24)} ${formatBytes(totalBytes).padEnd(14)} ${String(totalFiles).padEnd(8)}`);
    }

    console.log(`\x1b[36m${line}\x1b[0m\n`);
    if (cb) cb();
  }

  // Fetch from the crawl group (which has all workers)
  const gid = 'crawl';
  dist[gid].comm.send(['counts'], {service: 'status', method: 'get'}, (e, v) => {
    data.counts = v || {};
    maybePrint();
  });
  dist[gid].comm.send(['heapUsed'], {service: 'status', method: 'get'}, (e, v) => {
    data.heapUsed = v || {};
    maybePrint();
  });
  dist[gid].comm.send(['heapTotal'], {service: 'status', method: 'get'}, (e, v) => {
    data.heapTotal = v || {};
    maybePrint();
  });
}

/** Start a periodic status poller; returns a stop function */
function startPolling(label) {
  let count = 0;
  const timer = setInterval(() => {
    count++;
    printNodeStatus(`${label} (poll #${count})`);
  }, args.pollInterval);
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ */
/*  Banner                                                             */
/* ------------------------------------------------------------------ */

console.log('\x1b[33m╔══════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[33m║  DEBUG RUN — Distributed Search Engine       ║\x1b[0m');
console.log('\x1b[33m╠══════════════════════════════════════════════╣\x1b[0m');
console.log(`\x1b[33m║\x1b[0m  Workers : ${numNodes} (ports ${basePort}–${basePort + numNodes - 1})`);
console.log(`\x1b[33m║\x1b[0m  Seeds   : ${seeds.length} URL(s)`);
console.log(`\x1b[33m║\x1b[0m  Max pgs : ${args.maxPages}`);
console.log(`\x1b[33m║\x1b[0m  Poll    : every ${args.pollInterval}ms`);
console.log('\x1b[33m╚══════════════════════════════════════════════╝\x1b[0m');

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

if (args.clean) {
  if (fs.existsSync(storeDir)) {
    fs.rmSync(storeDir, {recursive: true, force: true});
    console.log('[debug] Cleaned store/ directory');
  }
}

const dist = distribution();

dist.node.start((e) => {
  if (e) {
    console.error('[debug] Failed to start coordinator:', e);
    process.exit(1);
  }
  console.log('[debug] Coordinator started on port', dist.node.config.port);

  spawnNodes(workerNodes, 0, () => {
    console.log(`[debug] ${numNodes} worker(s) spawned`);

    const id = dist.util.id;
    const group = {};
    workerNodes.forEach((n) => { group[id.getSID(n)] = n; });

    const groupNames = ['crawl', 'index'];
    registerGroups(groupNames, group, 0, () => {
      console.log('[debug] Groups registered:', groupNames.join(', '));

      printNodeStatus('After Boot', () => {
        if (args.skipCrawl) {
          console.log('[debug] Skipping crawl (--skipCrawl)');
          dist['crawl'].store.get('__crawler_state__', (e, state) => {
            const urls = (state && state.crawledUrls) ? state.crawledUrls : [];
            console.log(`[debug] Recovered ${urls.length} crawled URL(s)`);
            return runIndexPhase(urls);
          });
          return;
        }
        runCrawlPhase();
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Pipeline                                                           */
/* ------------------------------------------------------------------ */

function runCrawlPhase() {
  console.log('\n\x1b[32m▶ CRAWL PHASE\x1b[0m');
  const stopPoll = startPolling('Crawling');
  const start = Date.now();

  const {crawl} = require('./crawler');
  crawl({seeds, maxPages: args.maxPages, groupName: 'crawl'}, (e, result) => {
    stopPoll();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (e) {
      console.error('[debug] Crawl failed:', e);
      process.exit(1);
    }
    console.log(`\x1b[32m✓ Crawl done — ${result.totalCrawled} page(s) in ${elapsed}s\x1b[0m`);
    printNodeStatus('After Crawl', () => runIndexPhase(result.crawledUrls));
  });
}

function runIndexPhase(crawledUrls) {
  if (args.skipIndex) {
    console.log('[debug] Skipping index (--skipIndex)');
    return runServePhase();
  }

  console.log('\n\x1b[32m▶ INDEX PHASE\x1b[0m');
  const stopPoll = startPolling('Indexing');
  const start = Date.now();

  const {buildIndex} = require('./indexer');
  buildIndex({crawlGroupName: 'crawl', indexGroupName: 'index', crawledUrls}, (e, result) => {
    stopPoll();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (e) {
      console.error('[debug] Index failed:', e);
      process.exit(1);
    }
    console.log(`\x1b[32m✓ Index done — ${result.totalTerms} terms from ${result.totalDocs} doc(s) in ${elapsed}s\x1b[0m`);
    printNodeStatus('After Index', () => runServePhase());
  });
}

function runServePhase() {
  console.log('\n\x1b[32m▶ SERVE PHASE\x1b[0m');
  const {startServer} = require('./server');
  startServer({port: args.serverPort, indexGroupName: 'index'}, (e) => {
    if (e) {
      console.error('[debug] Server failed:', e);
      process.exit(1);
    }
    printNodeStatus('Server Ready', () => {
      console.log('\x1b[33m╔══════════════════════════════════════════════╗\x1b[0m');
      console.log(`\x1b[33m║  Ready → http://localhost:${args.serverPort}                 ║\x1b[0m`);
      console.log('\x1b[33m╚══════════════════════════════════════════════╝\x1b[0m');
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function spawnNodes(nodes, idx, cb) {
  if (idx >= nodes.length) return cb();
  dist.local.status.spawn(nodes[idx], (e) => {
    if (e) {
      console.error(`[debug] Cannot spawn worker ${idx}:`, e);
      process.exit(1);
    }
    console.log(`[debug] Spawned worker ${idx} on port ${nodes[idx].port}`);
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

process.on('SIGINT', () => {
  console.log('\n[debug] Shutting down …');
  printNodeStatus('Shutdown', () => {
    let remaining = workerNodes.length;
    if (remaining === 0) {
      if (dist.node.server) dist.node.server.close();
      process.exit(0);
    }
    workerNodes.forEach((node) => {
      dist.local.comm.send([], {node, service: 'status', method: 'stop'}, () => {
        if (--remaining === 0) {
          if (dist.node.server) dist.node.server.close();
          process.exit(0);
        }
      });
    });
    setTimeout(() => process.exit(1), 5000);
  });
});
