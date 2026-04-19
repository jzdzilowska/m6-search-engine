/**
 * T6: Comm and RPC Performance Benchmark
 * Characterizes throughput and latency by sending 1000 service requests in a tight loop.
 * 
 * Measures:
 * - Throughput: requests per second
 * - Latency: average, min, max, p50, p95, p99 response times
 */

const config = {ip: '127.0.0.1', port: 8765};

// Use our implementation for comm benchmarks
require('../distribution.js')(config);
const distribution = globalThis.distribution;

// Will be loaded later for RPC benchmarking
let distributionLib = null;

const ITERATIONS = 1000;
const results = [];

/**
 * Calculate percentile from sorted array
 * @param {number[]} sorted - Sorted array of values
 * @param {number} p - Percentile (0-100)
 * @returns {number}
 */
function percentile(sorted, p) {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Format nanoseconds to human readable string
 * @param {bigint} ns - Nanoseconds
 * @returns {string}
 */
function formatNs(ns) {
  const num = Number(ns);
  if (num < 1000) return `${num.toFixed(2)} ns`;
  if (num < 1000000) return `${(num / 1000).toFixed(2)} μs`;
  if (num < 1000000000) return `${(num / 1000000).toFixed(2)} ms`;
  return `${(num / 1000000000).toFixed(2)} s`;
}

/**
 * Run comm benchmark - sends requests sequentially and measures each one
 * @param {string} name - Benchmark name
 * @param {Array} message - Message to send
 * @param {Object} remote - Remote configuration
 * @param {number} iterations - Number of iterations
 * @returns {Promise<Object>}
 */
function runCommBenchmark(name, message, remote, iterations) {
  return new Promise((resolve) => {
    const latencies = [];
    let completed = 0;
    let errors = 0;

    const totalStart = process.hrtime.bigint();

    function sendNext() {
      if (completed >= iterations) {
        const totalEnd = process.hrtime.bigint();
        const totalTimeNs = Number(totalEnd - totalStart);
        const totalTimeSec = totalTimeNs / 1e9;
        const throughput = iterations / totalTimeSec;

        // Sort latencies for percentile calculations
        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        const result = {
          name,
          iterations,
          errors,
          throughput: throughput.toFixed(2),
          totalTime: formatNs(BigInt(Math.round(totalTimeNs))),
          avgLatency: formatNs(BigInt(Math.round(avgLatency))),
          minLatency: formatNs(BigInt(Math.round(sortedLatencies[0]))),
          maxLatency: formatNs(BigInt(Math.round(sortedLatencies[sortedLatencies.length - 1]))),
          p50Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 50)))),
          p95Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 95)))),
          p99Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 99)))),
        };

        results.push(result);
        resolve(result);
        return;
      }

      const start = process.hrtime.bigint();
      distribution.local.comm.send(message, remote, (e, v) => {
        const end = process.hrtime.bigint();
        const latency = Number(end - start);
        latencies.push(latency);

        if (e) errors++;
        completed++;
        
        // Use setImmediate to avoid stack overflow
        setImmediate(sendNext);
      });
    }

    sendNext();
  });
}

/**
 * Run comm benchmark with parallel requests (measures throughput under load)
 * @param {string} name - Benchmark name
 * @param {Array} message - Message to send
 * @param {Object} remote - Remote configuration
 * @param {number} iterations - Number of iterations
 * @param {number} concurrency - Number of concurrent requests
 * @returns {Promise<Object>}
 */
function runParallelCommBenchmark(name, message, remote, iterations, concurrency) {
  return new Promise((resolve) => {
    const latencies = [];
    let completed = 0;
    let started = 0;
    let inFlight = 0;
    let errors = 0;
    let resolved = false;

    const totalStart = process.hrtime.bigint();

    function tryFinish() {
      if (resolved) return;
      if (completed >= iterations && inFlight === 0) {
        resolved = true;
        const totalEnd = process.hrtime.bigint();
        const totalTimeNs = Number(totalEnd - totalStart);
        const totalTimeSec = totalTimeNs / 1e9;
        const throughput = iterations / totalTimeSec;

        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        const result = {
          name,
          iterations,
          errors,
          concurrency,
          throughput: throughput.toFixed(2),
          totalTime: formatNs(BigInt(Math.round(totalTimeNs))),
          avgLatency: formatNs(BigInt(Math.round(avgLatency))),
          minLatency: formatNs(BigInt(Math.round(sortedLatencies[0]))),
          maxLatency: formatNs(BigInt(Math.round(sortedLatencies[sortedLatencies.length - 1]))),
          p50Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 50)))),
          p95Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 95)))),
          p99Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 99)))),
        };

        results.push(result);
        resolve(result);
      }
    }

    function sendRequest() {
      // Launch requests up to concurrency limit
      while (inFlight < concurrency && started < iterations) {
        started++;
        inFlight++;
        const start = process.hrtime.bigint();
        
        distribution.local.comm.send(message, remote, (e, v) => {
          const end = process.hrtime.bigint();
          const latency = Number(end - start);
          latencies.push(latency);

          if (e) errors++;
          inFlight--;
          completed++;
          
          // Try to send more or finish
          if (started < iterations) {
            setImmediate(sendRequest);
          } else {
            tryFinish();
          }
        });
      }
    }

    sendRequest();
  });
}

/**
 * Run comm benchmark using the library's comm (for RPC benchmarking)
 * @param {string} name - Benchmark name
 * @param {Array} message - Message to send
 * @param {Object} remote - Remote configuration
 * @param {number} iterations - Number of iterations
 * @returns {Promise<Object>}
 */
function runCommBenchmarkLib(name, message, remote, iterations) {
  return new Promise((resolve) => {
    const latencies = [];
    let completed = 0;
    let errors = 0;

    const totalStart = process.hrtime.bigint();

    function sendNext() {
      if (completed >= iterations) {
        const totalEnd = process.hrtime.bigint();
        const totalTimeNs = Number(totalEnd - totalStart);
        const totalTimeSec = totalTimeNs / 1e9;
        const throughput = iterations / totalTimeSec;

        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        const result = {
          name,
          iterations,
          errors,
          throughput: throughput.toFixed(2),
          totalTime: formatNs(BigInt(Math.round(totalTimeNs))),
          avgLatency: formatNs(BigInt(Math.round(avgLatency))),
          minLatency: formatNs(BigInt(Math.round(sortedLatencies[0]))),
          maxLatency: formatNs(BigInt(Math.round(sortedLatencies[sortedLatencies.length - 1]))),
          p50Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 50)))),
          p95Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 95)))),
          p99Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 99)))),
        };

        results.push(result);
        resolve(result);
        return;
      }

      const start = process.hrtime.bigint();
      // Use library's comm for RPC
      distributionLib.local.comm.send(message, remote, (e, v) => {
        const end = process.hrtime.bigint();
        const latency = Number(end - start);
        latencies.push(latency);

        if (e) errors++;
        completed++;
        
        setImmediate(sendNext);
      });
    }

    sendNext();
  });
}

/**
 * Run RPC benchmark
 * @param {string} name - Benchmark name
 * @param {Function} rpcFunction - The RPC-wrapped function to call
 * @param {Array} args - Arguments to pass
 * @param {number} iterations - Number of iterations
 * @returns {Promise<Object>}
 */
function runRPCBenchmark(name, rpcFunction, args, iterations) {
  return new Promise((resolve) => {
    const latencies = [];
    let completed = 0;
    let errors = 0;

    const totalStart = process.hrtime.bigint();

    function callNext() {
      if (completed >= iterations) {
        const totalEnd = process.hrtime.bigint();
        const totalTimeNs = Number(totalEnd - totalStart);
        const totalTimeSec = totalTimeNs / 1e9;
        const throughput = iterations / totalTimeSec;

        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        const result = {
          name,
          iterations,
          errors,
          throughput: throughput.toFixed(2),
          totalTime: formatNs(BigInt(Math.round(totalTimeNs))),
          avgLatency: formatNs(BigInt(Math.round(avgLatency))),
          minLatency: formatNs(BigInt(Math.round(sortedLatencies[0]))),
          maxLatency: formatNs(BigInt(Math.round(sortedLatencies[sortedLatencies.length - 1]))),
          p50Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 50)))),
          p95Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 95)))),
          p99Latency: formatNs(BigInt(Math.round(percentile(sortedLatencies, 99)))),
        };

        results.push(result);
        resolve(result);
        return;
      }

      const start = process.hrtime.bigint();
      rpcFunction(...args, (e, v) => {
        const end = process.hrtime.bigint();
        const latency = Number(end - start);
        latencies.push(latency);

        if (e) errors++;
        completed++;
        
        setImmediate(callNext);
      });
    }

    callNext();
  });
}

// ============================================
// Main benchmark runner
// ============================================
async function runBenchmarks() {
  console.log('='.repeat(90));
  console.log('T6: COMM AND RPC PERFORMANCE BENCHMARK');
  console.log('='.repeat(90));
  console.log(`\nIterations per benchmark: ${ITERATIONS}\n`);

  const node = distribution.node.config;

  // ============================================
  // Benchmark 1: Sequential comm requests (status.get)
  // ============================================
  console.log('Running: Sequential comm.send (status.get nid)...');
  await runCommBenchmark(
    'comm.send sequential (status.get nid)',
    ['nid'],
    {node: node, service: 'status', method: 'get'},
    ITERATIONS
  );

  // ============================================
  // Benchmark 2: Sequential comm requests (status.get sid)
  // ============================================
  console.log('Running: Sequential comm.send (status.get sid)...');
  await runCommBenchmark(
    'comm.send sequential (status.get sid)',
    ['sid'],
    {node: node, service: 'status', method: 'get'},
    ITERATIONS
  );

  // ============================================
  // Benchmark 3: Parallel comm requests (concurrency = 10)
  // ============================================
  console.log('Running: Parallel comm.send (concurrency=10)...');
  await runParallelCommBenchmark(
    'comm.send parallel (c=10)',
    ['nid'],
    {node: node, service: 'status', method: 'get'},
    ITERATIONS,
    10
  );

  // ============================================
  // Benchmark 4: Parallel comm requests (concurrency = 50)
  // ============================================
  console.log('Running: Parallel comm.send (concurrency=50)...');
  await runParallelCommBenchmark(
    'comm.send parallel (c=50)',
    ['nid'],
    {node: node, service: 'status', method: 'get'},
    ITERATIONS,
    50
  );

  // ============================================
  // Benchmark 5: Parallel comm requests (concurrency = 100)
  // ============================================
  console.log('Running: Parallel comm.send (concurrency=100)...');
  await runParallelCommBenchmark(
    'comm.send parallel (c=100)',
    ['nid'],
    {node: node, service: 'status', method: 'get'},
    ITERATIONS,
    100
  );

  // ============================================
  // Benchmark 6: RPC calls using library's built-in implementation
  // Uses library's status.spawn to create a remote node for full RPC round-trip
  // ============================================
  console.log('Running: RPC benchmark (using library built-in createRPC + spawn)...');
  
  // Close our node first to free up resources
  if (globalThis.distribution.node.server) {
    globalThis.distribution.node.server.close();
  }
  
  // Small delay to ensure port is released
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Load and start the library's implementation for RPC benchmarking
  const libConfig = {ip: '127.0.0.1', port: 8765};
  distributionLib = require('@brown-ds/distribution')(libConfig);
  
  // Start the library's node for RPC
  await new Promise((resolve, reject) => {
    distributionLib.node.start((e) => {
      if (e) reject(e);
      else resolve();
    });
  });
  
  const remoteNode = {ip: '127.0.0.1', port: 9009};
  
  // Create a simple function and wrap it with RPC using the library's implementation
  let rpcCounter = 0;
  const addOne = () => {
    return ++rpcCounter;
  };

  // Create RPC wrapper using the library's built-in createRPC
  const addOneRPC = distributionLib.util.wire.createRPC(addOne);

  const rpcService = {
    addOne: addOneRPC,
  };

  let rpcBenchmarkSuccess = false;
  
  try {
    // Spawn the remote node using the library's spawn
    await new Promise((resolve, reject) => {
      distributionLib.local.status.spawn(remoteNode, (e, v) => {
        if (e) {
          console.log('Spawn error:', e);
          reject(e);
        } else {
          console.log('Remote node spawned successfully');
          resolve(v);
        }
      });
    });

    // Wait for remote node to be ready by polling (longer on slow envs e.g. EC2)
    let remoteReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        await new Promise((resolve, reject) => {
          distributionLib.local.comm.send(['sid'],
            {node: remoteNode, service: 'status', method: 'get'}, (e, v) => {
              if (e) reject(e);
              else resolve(v);
            });
        });
        remoteReady = true;
        console.log('Remote node is ready');
        break;
      } catch (e) {
        // Keep waiting
      }
    }
    
    if (!remoteReady) {
      throw new Error('Remote node failed to start within timeout');
    }

    // Install the RPC service on the remote node
    await new Promise((resolve, reject) => {
      distributionLib.local.comm.send([rpcService, 'rpcBenchmarkService'],
        {node: remoteNode, service: 'routes', method: 'put'}, (e, v) => {
          if (e) {
            console.log('Failed to install RPC service:', e);
            reject(e);
          } else {
            console.log('RPC service installed on remote node');
            resolve(v);
          }
        });
    });

    // Benchmark RPC calls to the remote node using library's comm
    await runCommBenchmarkLib(
      'RPC via comm (library)',
      [],
      {node: remoteNode, service: 'rpcBenchmarkService', method: 'addOne'},
      ITERATIONS
    );

    console.log(`RPC counter final value: ${rpcCounter} (expected: ${ITERATIONS})`);
    rpcBenchmarkSuccess = true;

    // Cleanup: stop the remote node
    await new Promise((resolve) => {
      distributionLib.local.comm.send([],
        {node: remoteNode, service: 'status', method: 'stop'}, (e, v) => {
          resolve();
        });
    });
  } catch (err) {
    console.log(`RPC benchmark error: ${err.message}`);
    console.log('Note: Full RPC benchmark requires library spawn to work properly.');
    console.log('If the library prints "Invalid serialized object type" (e.g. on AWS), that is a library deserialization issue; comm results are still valid.');
  }
  
  // Close the library's node
  if (distributionLib.node.server) {
    distributionLib.node.server.close();
  }

  // ============================================
  // Print Results
  // ============================================
  console.log('\n' + '='.repeat(90));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(90));
  console.log('');

  // Header
  console.log(
    'Benchmark'.padEnd(35) +
    'Throughput'.padStart(12) +
    'Avg Latency'.padStart(14) +
    'P50'.padStart(12) +
    'P95'.padStart(12) +
    'P99'.padStart(12)
  );
  console.log('-'.repeat(90));

  // Results
  for (const r of results) {
    console.log(
      r.name.padEnd(35) +
      `${r.throughput} req/s`.padStart(12) +
      r.avgLatency.padStart(14) +
      r.p50Latency.padStart(12) +
      r.p95Latency.padStart(12) +
      r.p99Latency.padStart(12)
    );
  }

  console.log('-'.repeat(90));

  // Detailed results
  console.log('\n' + '='.repeat(90));
  console.log('DETAILED RESULTS');
  console.log('='.repeat(90));

  for (const r of results) {
    console.log(`\n${r.name}:`);
    console.log(`  Iterations:  ${r.iterations}`);
    console.log(`  Errors:      ${r.errors}`);
    console.log(`  Total Time:  ${r.totalTime}`);
    console.log(`  Throughput:  ${r.throughput} req/s`);
    console.log(`  Latency:`);
    console.log(`    Average:   ${r.avgLatency}`);
    console.log(`    Min:       ${r.minLatency}`);
    console.log(`    Max:       ${r.maxLatency}`);
    console.log(`    P50:       ${r.p50Latency}`);
    console.log(`    P95:       ${r.p95Latency}`);
    console.log(`    P99:       ${r.p99Latency}`);
    if (r.concurrency) {
      console.log(`  Concurrency: ${r.concurrency}`);
    }
  }

  console.log('\n' + '-'.repeat(90));
  console.log(`Environment: ${process.env.DOCKER ? 'Docker' : 'Local Development'}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log('-'.repeat(90));
}

// ============================================
// Start node and run benchmarks
// ============================================
distribution.node.start((err) => {
  if (err) {
    console.error('Failed to start node:', err);
    process.exit(1);
  }

  console.log(`Node started on ${distribution.node.config.ip}:${distribution.node.config.port}\n`);

  runBenchmarks()
    .then(() => {
      // Cleanup
      if (globalThis.distribution.node.server) {
        globalThis.distribution.node.server.close();
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Benchmark failed:', err);
      if (globalThis.distribution.node.server) {
        globalThis.distribution.node.server.close();
      }
      process.exit(1);
    });
});
