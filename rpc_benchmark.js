#!/usr/bin/env node
/**
 * RPC Throughput & Latency Benchmark (library-only, both nodes)
 * Sends 1000 sequential RPC calls and measures performance.
 */
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const LOCAL_PORT = 7770;
const REMOTE_PORT = 7771;
const ITERS = 1000;

// Child: library-only node
const childScript = path.join(__dirname, '_rpc_child.js');
fs.writeFileSync(childScript, `
const dist = require('@brown-ds/distribution')({ip:'127.0.0.1', port:${REMOTE_PORT}});
dist.node.start(() => { process.send && process.send('ready'); });
`);

const child = fork(childScript, [], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});
child.stderr.on('data', d => process.stderr.write(d));

child.on('message', (msg) => {
  if (msg === 'ready') {
    console.log('Remote node ready on port ' + REMOTE_PORT);
    startLocal();
  }
});

child.on('error', (e) => { console.error('Child error:', e); process.exit(1); });

function startLocal() {
  // Use LIBRARY for local node too (so serialization matches)
  const distribution = require('@brown-ds/distribution')({ip:'127.0.0.1', port: LOCAL_PORT});
  globalThis.distribution = distribution;

  distribution.node.start(() => {
    console.log('Local node ready on port ' + LOCAL_PORT);
    const remoteNode = {ip: '127.0.0.1', port: REMOTE_PORT};

    let attempts = 0;
    function poll() {
      attempts++;
      distribution.local.comm.send(['sid'],
        {node: remoteNode, service: 'status', method: 'get'}, (e, v) => {
          if (e && attempts < 20) return setTimeout(poll, 250);
          if (e) { console.error('Cannot reach remote'); cleanup(); return; }
          console.log('Remote reachable (attempt ' + attempts + ')');
          runBenchmark(distribution, remoteNode);
        });
    }
    poll();
  });
}

function runBenchmark(distribution, remoteNode) {
  let counter = 0;
  const inc = () => ++counter;
  const incRPC = distribution.util.wire.createRPC(distribution.util.wire.toAsync(inc));
  const svc = { inc: incRPC };

  distribution.local.comm.send([svc, 'rpcBench'],
    {node: remoteNode, service: 'routes', method: 'put'}, (e, v) => {
      if (e) { console.error('Install error:', e); cleanup(); return; }
      console.log('RPC service installed. Sending ' + ITERS + ' requests...');

      const latencies = [];
      let done = 0;
      let errors = 0;
      const totalStart = process.hrtime.bigint();

      function next() {
        if (done >= ITERS) {
          const totalElapsed = Number(process.hrtime.bigint() - totalStart);
          const throughput = ITERS / (totalElapsed / 1e9);
          latencies.sort((a, b) => a - b);
          const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
          const p50 = latencies[Math.floor(latencies.length * 0.50)];
          const p95 = latencies[Math.floor(latencies.length * 0.95)];
          const p99 = latencies[Math.floor(latencies.length * 0.99)];

          function fmt(ns) {
            if (ns < 1000) return ns.toFixed(2) + ' ns';
            if (ns < 1e6) return (ns/1000).toFixed(2) + ' us';
            if (ns < 1e9) return (ns/1e6).toFixed(2) + ' ms';
            return (ns/1e9).toFixed(2) + ' s';
          }

          console.log('\n=== createRPC BENCHMARK RESULTS ===');
          console.log('Iterations:  ' + ITERS);
          console.log('Errors:      ' + errors);
          console.log('Counter:     ' + counter + ' (expected ' + ITERS + ')');
          console.log('Total time:  ' + fmt(totalElapsed));
          console.log('Throughput:  ' + throughput.toFixed(2) + ' req/s');
          console.log('Avg latency: ' + fmt(avg));
          console.log('P50 latency: ' + fmt(p50));
          console.log('P95 latency: ' + fmt(p95));
          console.log('P99 latency: ' + fmt(p99));
          console.log('Min latency: ' + fmt(latencies[0]));
          console.log('Max latency: ' + fmt(latencies[latencies.length - 1]));
          cleanup();
          return;
        }

        // Progress every 100
        if (done > 0 && done % 100 === 0) {
          process.stdout.write('  ' + done + '/' + ITERS + '...\n');
        }

        const t0 = process.hrtime.bigint();
        distribution.local.comm.send([],
          {node: remoteNode, service: 'rpcBench', method: 'inc'}, (e, v) => {
            latencies.push(Number(process.hrtime.bigint() - t0));
            if (e) errors++;
            done++;
            setImmediate(next);
          });
      }
      next();
    });
}

function cleanup() {
  if (globalThis.distribution && globalThis.distribution.node.server) {
    globalThis.distribution.node.server.close();
  }
  child.kill();
  try { fs.unlinkSync(childScript); } catch(e) {}
  setTimeout(() => process.exit(0), 300);
}
