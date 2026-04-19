/**
 * Latency Benchmark
 * Uses high-resolution timers (process.hrtime.bigint())
 * Results stored in-memory
 */

require('../distribution.js')();
const util = globalThis.distribution.util;

const ITERATIONS = 1000;
const results = [];

/**
 * Measure latency for a single operation
 * @param {Function} operation - Function to measure
 * @returns {bigint} - Time in nanoseconds
 */
function measureLatency(operation) {
  const start = process.hrtime.bigint();
  operation();
  const end = process.hrtime.bigint();
  return end - start;
}

/**
 * Run benchmark for a workload
 * @param {string} name - Workload name
 * @param {any} testData - Data to serialize/deserialize
 * @param {number} iterations - Number of iterations
 */
function runBenchmark(name, testData, iterations) {
  const serializeLatencies = [];
  const deserializeLatencies = [];

  for (let i = 0; i < iterations; i++) {
    // Measure serialize
    let serialized;
    const serTime = measureLatency(() => {
      serialized = util.serialize(testData);
    });
    serializeLatencies.push(serTime);

    // Measure deserialize
    const deserTime = measureLatency(() => {
      util.deserialize(serialized);
    });
    deserializeLatencies.push(deserTime);
  }

  // Calculate avgs but readable
  const avgSerialize = Number(serializeLatencies.reduce((a, b) => a + b, 0n) / BigInt(iterations)) / 1000;
  const avgDeserialize = Number(deserializeLatencies.reduce((a, b) => a + b, 0n) / BigInt(iterations)) / 1000;

  // Store result
  results.push({
    workload: name,
    iterations,
    avgSerializeUs: avgSerialize.toFixed(2),
    avgDeserializeUs: avgDeserialize.toFixed(2),
    totalAvgUs: (avgSerialize + avgDeserialize).toFixed(2),
  });
}

// ============================================
// Workload 1: Base (T2)
// ============================================
const baseTypesWorkload = {
  num: 42,
  negNum: -17,
  float: 3.14159,
  str: 'hello world',
  emptyStr: '',
  boolTrue: true,
  boolFalse: false,
  nil: null,
  undef: undefined,
  nan: NaN,
  posInf: Infinity,
  negInf: -Infinity,
};

// ============================================
// Workload 2: Functions (T3)
// ============================================
const functionsWorkload = {
  arrowFn: (a, b) => a + b,
  regularFn: function multiply(x, y) { return x * y; },
  noArgsFn: () => 42,
  complexFn: (arr) => arr.map((x) => x * 2).filter((x) => x > 5).reduce((a, b) => a + b, 0),
};

// ============================================
// Workload 3: Recursive Structs (T4)
// ============================================
const complexWorkload = {
  simpleArr: [1, 2, 3, 4, 5],
  nestedArr: [[1, 2], [3, [4, 5, [6, 7]]]],
  simpleObj: {a: 1, b: 2, c: 3},
  nestedObj: {
    level1: {
      level2: {
        level3: {
          value: 'deep',
        },
      },
    },
  },
  date: new Date('2024-01-15T12:00:00Z'),
  error: new Error('test error message'),
  mixed: {
    nums: [1, 2, 3],
    strs: ['a', 'b', 'c'],
    nested: {
      date: new Date(),
      arr: [1, 'two', true, null],
    },
  },
};

// ============================================
// Run Benchmarks
// ============================================
console.log('Running latency benchmarks...\n');
console.log(`Iterations per workload: ${ITERATIONS}\n`);

runBenchmark('Base Types (T2)', baseTypesWorkload, ITERATIONS);
runBenchmark('Functions (T3)', functionsWorkload, ITERATIONS);
runBenchmark('Complex Structures (T4)', complexWorkload, ITERATIONS);

runBenchmark('Single Number', 42, ITERATIONS);
runBenchmark('Single String (short)', 'hello', ITERATIONS);
runBenchmark('Single String (long)', 'a'.repeat(1000), ITERATIONS);
runBenchmark('Simple Object', {a: 1, b: 2}, ITERATIONS);
runBenchmark('Large Array (100 elements)', Array.from({length: 100}, (_, i) => i), ITERATIONS);
runBenchmark('Deeply Nested (10 levels)', (() => {
  let obj = {value: 'bottom'};
  for (let i = 0; i < 10; i++) {
    obj = {nested: obj};
  }
  return obj;
})(), ITERATIONS);

// ============================================
// Print outcome
// ============================================
console.log('='.repeat(80));
console.log('LATENCY BENCHMARK RESULTS (Local Development)');
console.log('='.repeat(80));
console.log('');
console.log('Workload'.padEnd(30) + 'Serialize (μs)'.padEnd(18) + 'Deserialize (μs)'.padEnd(18) + 'Total (μs)');
console.log('-'.repeat(80));

for (const r of results) {
  console.log(
      r.workload.padEnd(30) +
      r.avgSerializeUs.padStart(12) +
      r.avgDeserializeUs.padStart(18) +
      r.totalAvgUs.padStart(14),
  );
}

console.log('-'.repeat(80));
console.log(`\nEnvironment: Local Development`);
console.log(`Node.js: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Iterations: ${ITERATIONS}`);
