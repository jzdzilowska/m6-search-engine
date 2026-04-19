/**
 * m4 Distributed Storage Performance Benchmark
 *
 * 3 stages:
 *   1. Generate 1000 key-value pairs in memory
 *   2. Insert all into the distributed store, measuring latency + throughput
 *   3. Retrieve all by key, measuring latency + throughput
 *
 * AWS usage (3 separate EC2 instances):
 *   On each instance, start a worker node first:
 *     node distribution.js --config '{"ip":"0.0.0.0","port":7201}'
 *   Then on ONE instance, run the benchmark:
 *     node test/m4.storage.benchmark.js
 *
 * Local usage:
 *   Set REMOTE = false, then just run:
 *     node test/m4.storage.benchmark.js
 */

const crypto = require('crypto');

// ---- TOGGLE THIS ----
// true  = nodes already running on separate EC2 instances
// false = spawn all nodes locally on this machine
const REMOTE = true;

// coordinator binds to 0.0.0.0 so it works on EC2 (can't bind to public IP)
const config = {ip: '0.0.0.0', port: 7200};
require('../distribution.js')(config);
const distribution = globalThis.distribution;
const id = distribution.util.id;

const NUM_OBJECTS = 1000;

// worker nodes, one per EC2 instance
// each instance should already be running:
//   node distribution.js --config '{"ip":"0.0.0.0","port":7201}'
const n1 = {ip: '3.135.205.34', port: 7201};
const n2 = {ip: '18.222.21.211', port: 7201};
const n3 = {ip: '18.118.149.129', port: 7201};

function randomString(len) {
  return crypto.randomBytes(len).toString('hex');
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(2)} μs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function reportStats(label, latencies, totalMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const throughput = (latencies.length / totalMs) * 1000;

  console.log(`\n  ${label}:`);
  console.log(`    Total time:  ${formatMs(totalMs)}`);
  console.log(`    Throughput:  ${throughput.toFixed(2)} ops/s`);
  console.log(`    Avg latency: ${formatMs(avg)}`);
  console.log(`    Min latency: ${formatMs(sorted[0])}`);
  console.log(`    Max latency: ${formatMs(sorted[sorted.length - 1])}`);
  console.log(`    P50 latency: ${formatMs(percentile(sorted, 50))}`);
  console.log(`    P95 latency: ${formatMs(percentile(sorted, 95))}`);
  console.log(`    P99 latency: ${formatMs(percentile(sorted, 99))}`);

  return {throughput, avg, p50: percentile(sorted, 50)};
}

async function main() {
  console.log('='.repeat(70));
  console.log('T5: DISTRIBUTED STORAGE BENCHMARK');
  console.log(`Mode: ${REMOTE ? 'REMOTE (3 separate EC2 instances)' : 'LOCAL'}`);
  console.log('='.repeat(70));

  // start the coordinator node
  await new Promise((resolve, reject) => {
    distribution.node.start((e) => e ? reject(e) : resolve());
  });
  console.log(`Coordinator started on ${config.ip}:${config.port}`);

  if (REMOTE) {
    // remote mode: nodes are already running on each EC2 instance
    // just ping each one to make sure we can reach them
    console.log('Verifying remote nodes are reachable...');
    for (const node of [n1, n2, n3]) {
      await new Promise((resolve, reject) => {
        distribution.local.comm.send(
            ['sid'], {node, service: 'status', method: 'get'}, (e, v) => {
              if (e) {
                console.error(`  FAIL ${node.ip}:${node.port} — ${e.message}`);
                reject(e);
              } else {
                console.log(`  OK   ${node.ip}:${node.port} (sid: ${v})`);
                resolve(v);
              }
            });
      });
    }
    console.log('All 3 remote nodes reachable');
  } else {
    // local mode: spawn worker nodes as child processes
    for (const node of [n1, n2, n3]) {
      await new Promise((resolve, reject) => {
        distribution.local.status.spawn(node, (e) => e ? reject(e) : resolve());
      });
    }
    console.log('Spawned 3 local worker nodes');
  }

  // create the group
  const groupNodes = {};
  [n1, n2, n3].forEach((n) => {
    groupNodes[id.getSID(n)] = n;
  });

  await new Promise((resolve, reject) => {
    distribution.local.groups.put(
        {gid: 'benchGroup', hash: id.naiveHash},
        groupNodes,
        (e) => e ? reject(e) : resolve(),
    );
  });
  console.log('Group "benchGroup" created with 3 nodes\n');

  // ---- Stage 1: Generate 1000 key-value pairs ----
  console.log(`Stage 1: Generating ${NUM_OBJECTS} key-value pairs...`);
  const pairs = [];
  for (let i = 0; i < NUM_OBJECTS; i++) {
    pairs.push({
      key: `k${i}_${randomString(4)}`,
      value: {
        idx: i,
        data: randomString(16),
        ts: Date.now(),
      },
    });
  }
  console.log(`  Generated ${pairs.length} pairs in memory.`);

  // ---- Stage 2: Insert all objects ----
  console.log(`\nStage 2: Inserting ${NUM_OBJECTS} objects...`);
  const insertLatencies = [];
  const insertStart = Date.now();

  for (const {key, value} of pairs) {
    const opStart = Date.now();
    await new Promise((resolve, reject) => {
      distribution.benchGroup.store.put(value, key, (e, v) => {
        if (e) reject(e);
        else resolve(v);
      });
    });
    insertLatencies.push(Date.now() - opStart);
  }

  const insertTotal = Date.now() - insertStart;
  const insertStats = reportStats('Insertion', insertLatencies, insertTotal);

  // ---- Stage 3: Retrieve all objects ----
  console.log(`\nStage 3: Retrieving ${NUM_OBJECTS} objects...`);
  const getLatencies = [];
  const getStart = Date.now();
  let getErrors = 0;

  for (const {key} of pairs) {
    const opStart = Date.now();
    await new Promise((resolve) => {
      distribution.benchGroup.store.get(key, (e, v) => {
        if (e) getErrors++;
        resolve(v);
      });
    });
    getLatencies.push(Date.now() - opStart);
  }

  const getTotal = Date.now() - getStart;
  const getStats = reportStats('Retrieval', getLatencies, getTotal);

  if (getErrors > 0) {
    console.log(`  Retrieval errors: ${getErrors}`);
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Objects:              ${NUM_OBJECTS}`);
  console.log(`  Nodes:                3`);
  console.log(`  Insert throughput:    ${insertStats.throughput.toFixed(2)} ops/s`);
  console.log(`  Insert avg latency:   ${formatMs(insertStats.avg)}`);
  console.log(`  Retrieve throughput:  ${getStats.throughput.toFixed(2)} ops/s`);
  console.log(`  Retrieve avg latency: ${formatMs(getStats.avg)}`);
  console.log('='.repeat(70));
  console.log('\nPaste these into package.json report.M4:');
  console.log(`  "throughput": { "aws": [${insertStats.throughput.toFixed(2)}, ${getStats.throughput.toFixed(2)}] }`);
  console.log(`  "latency":    { "aws": [${insertStats.avg.toFixed(2)}, ${getStats.avg.toFixed(2)}] }`);

  // cleanup — only stop nodes if we spawned them locally
  if (!REMOTE) {
    for (const node of [n1, n2, n3]) {
      await new Promise((resolve) => {
        distribution.local.comm.send(
            [], {node, service: 'status', method: 'stop'}, () => resolve(),
        );
      });
    }
  }
  if (globalThis.distribution.node.server) {
    globalThis.distribution.node.server.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
