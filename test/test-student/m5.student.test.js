/*
    In this file, add your own test cases that correspond to functionality introduced for each milestone.
    You should fill out each test case so it adequately tests the functionality you implemented.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')();
require('../helpers/sync-guard');

const id = distribution.util.id;

// using different ports from the main m5 tests nothing collides
const n1 = {ip: '127.0.0.1', port: 7210};
const n2 = {ip: '127.0.0.1', port: 7211};
const n3 = {ip: '127.0.0.1', port: 7212};

const grpA = {};
const grpB = {};
const grpC = {};
const grpD = {};
const grpE = {};

function getDatasetKeys(dataset) {
  return dataset.map((o) => Object.keys(o)[0]);
}

// ---- test 1: ncdc-style min temperature (twist on the given max temp scenario) ----
test('(1 pts) student test', (done) => {
  // ncdc-style: min temperature per year
  const mapper = (key, value) => {
    const parts = value.split(/(\s+)/).filter((e) => e !== ' ');
    const out = {};
    out[parts[1]] = parseInt(parts[3]); // year -> temp
    return [out];
  };

  const reducer = (key, values) => {
    const out = {};
    out[key] = values.reduce((a, b) => Math.min(a, b), Infinity);
    return out;
  };

  const dataset = [
    {'000': '006701199099999 1950 0515070049999999N9 +0000 1+9999'},
    {'106': '004301199099999 1950 0515120049999999N9 +0022 1+9999'},
    {'212': '004301199099999 1950 0515180049999999N9 -0011 1+9999'},
    {'318': '004301265099999 1949 0324120040500001N9 +0111 1+9999'},
    {'424': '004301265099999 1949 0324180040500001N9 +0078 1+9999'},
  ];

  // 1950 has temps 0, 22, -11 => min is -11
  // 1949 has temps 111, 78   => min is 78
  const expected = [{'1950': -11}, {'1949': 78}];

  let cntr = 0;
  dataset.forEach((o) => {
    const key = Object.keys(o)[0];
    const value = o[key];
    distribution.grpA.store.put(value, key, (e, v) => {
      cntr++;
      // wait for all puts to finish before running MR
      if (cntr === dataset.length) {
        distribution.grpA.mr.exec(
            {keys: getDatasetKeys(dataset), map: mapper, reduce: reducer},
            (e, v) => {
              try {
                expect(v).toEqual(expect.arrayContaining(expected));
                expect(v).toHaveLength(expected.length);
                done();
              } catch (e) {
                done(e);
              }
            });
      }
    });
  });
});


test('(1 pts) student test', (done) => {
  // word frequency on a small corpus
  const mapper = (key, value) => {
    const words = value.split(/\s+/).filter((e) => e !== '');
    return words.map((w) => ({[w]: 1}));
  };

  const reducer = (key, values) => {
    const out = {};
    out[key] = values.reduce((s, v) => s + v, 0);
    return out;
  };

  const dataset = [
    {'a': 'the cat sat'},
    {'b': 'the dog sat'},
  ];

  const expected = [
    {the: 2}, {cat: 1}, {sat: 2}, {dog: 1},
  ];

  let cntr = 0;
  dataset.forEach((o) => {
    const key = Object.keys(o)[0];
    const value = o[key];
    distribution.grpB.store.put(value, key, (e, v) => {
      cntr++;
      if (cntr === dataset.length) {
        distribution.grpB.mr.exec(
            {keys: getDatasetKeys(dataset), map: mapper, reduce: reducer},
            (e, v) => {
              try {
                expect(v).toEqual(expect.arrayContaining(expected));
                expect(v).toHaveLength(expected.length);
                done();
              } catch (e) {
                done(e);
              }
            });
      }
    });
  });
});


// ---- test 3: distributed string matching (strmatch-style) ----
test('(1 pts) student test', (done) => {
  // string matching: find docs containing "cat"
  const mapper = (key, value) => {
    if (/cat/.test(value)) {
      return [{[key]: true}];
    }
    return [];
  };

  const reducer = (key, values) => {
    return {[key]: true};
  };

  const dataset = [
    {'x1': 'the cat sat on the mat'},
    {'x2': 'the dog lay on the rug'},
    {'x3': 'a cat and a dog'},
  ];

  const expected = [{x1: true}, {x3: true}];

  let cntr = 0;
  dataset.forEach((o) => {
    const key = Object.keys(o)[0];
    const value = o[key];
    distribution.grpC.store.put(value, key, (e, v) => {
      cntr++;
      if (cntr === dataset.length) {
        distribution.grpC.mr.exec(
            {keys: getDatasetKeys(dataset), map: mapper, reduce: reducer},
            (e, v) => {
              try {
                expect(v).toEqual(expect.arrayContaining(expected));
                expect(v).toHaveLength(expected.length);
                done();
              } catch (e) {
                done(e);
              }
            });
      }
    });
  });
});

// ---- test 4: inverted index (ridx-style) ----
test('(1 pts) student test', (done) => {
  // for each unique word in a doc, emit {word: docId}
  // reducer collects all docIds for that word into a sorted list
  const mapper = (key, value) => {
    const words = value.split(/\s+/).filter((e) => e !== '');
    const unique = [...new Set(words)];
    return unique.map((w) => ({[w]: key}));
  };

  const reducer = (key, values) => {
    return {[key]: values.sort()};
  };

  const dataset = [
    {'p1': 'sun moon'},
    {'p2': 'moon star'},
    {'p3': 'sun star'},
  ];

  const expected = [
    {sun: ['p1', 'p3']},
    {moon: ['p1', 'p2']},
    {star: ['p2', 'p3']},
  ];

  let cntr = 0;
  dataset.forEach((o) => {
    const key = Object.keys(o)[0];
    const value = o[key];
    distribution.grpD.store.put(value, key, (e, v) => {
      cntr++;
      if (cntr === dataset.length) {
        distribution.grpD.mr.exec(
            {keys: getDatasetKeys(dataset), map: mapper, reduce: reducer},
            (e, v) => {
              try {
                expect(v).toEqual(expect.arrayContaining(expected));
                expect(v).toHaveLength(expected.length);
                done();
              } catch (e) {
                done(e);
              }
            });
      }
    });
  });
});

// ---- test 5: character frequency (cfreq-style, tiny dataset) ----
test('(1 pts) student test', (done) => {
  // character frequency across docs
  const mapper = (key, value) => {
    const chars = value.replace(/\s+/g, '').split('');
    return chars.map((c) => ({[c]: 1}));
  };

  const reducer = (key, values) => {
    const out = {};
    out[key] = values.reduce((s, v) => s + v, 0);
    return out;
  };

  // "ab" + "bc" => a:1, b:2 (once from each doc), c:1
  const dataset = [
    {'c1': 'ab'},
    {'c2': 'bc'},
  ];

  const expected = [{a: 1}, {b: 2}, {c: 1}];

  let cntr = 0;
  dataset.forEach((o) => {
    const key = Object.keys(o)[0];
    const value = o[key];
    distribution.grpE.store.put(value, key, (e, v) => {
      cntr++;
      if (cntr === dataset.length) {
        distribution.grpE.mr.exec(
            {keys: getDatasetKeys(dataset), map: mapper, reduce: reducer},
            (e, v) => {
              try {
                expect(v).toEqual(expect.arrayContaining(expected));
                expect(v).toHaveLength(expected.length);
                done();
              } catch (e) {
                done(e);
              }
            });
      }
    });
  });
});

/*
    Test setup and teardown
*/

beforeAll((done) => {
  grpA[id.getSID(n1)] = n1;
  grpA[id.getSID(n2)] = n2;
  grpA[id.getSID(n3)] = n3;

  grpB[id.getSID(n1)] = n1;
  grpB[id.getSID(n2)] = n2;
  grpB[id.getSID(n3)] = n3;

  grpC[id.getSID(n1)] = n1;
  grpC[id.getSID(n2)] = n2;
  grpC[id.getSID(n3)] = n3;

  grpD[id.getSID(n1)] = n1;
  grpD[id.getSID(n2)] = n2;
  grpD[id.getSID(n3)] = n3;

  grpE[id.getSID(n1)] = n1;
  grpE[id.getSID(n2)] = n2;
  grpE[id.getSID(n3)] = n3;

  const startNodes = (cb) => {
    distribution.local.status.spawn(n1, (e, v) => {
      distribution.local.status.spawn(n2, (e, v) => {
        distribution.local.status.spawn(n3, (e, v) => {
          cb();
        });
      });
    });
  };

  function setupGroup(gid, group, cb) {
    distribution.local.groups.put({gid}, group, (e, v) => {
      distribution[gid].groups.put({gid}, group, cb);
    });
  }

  distribution.node.start(() => {
    startNodes(() => {
      setupGroup('grpA', grpA, () => {
        setupGroup('grpB', grpB, () => {
          setupGroup('grpC', grpC, () => {
            setupGroup('grpD', grpD, () => {
              setupGroup('grpE', grpE, () => {
                done();
              });
            });
          });
        });
      });
    });
  });
});

afterAll((done) => {
  const remote = {service: 'status', method: 'stop'};
  remote.node = n1;
  distribution.local.comm.send([], remote, (e, v) => {
    remote.node = n2;
    distribution.local.comm.send([], remote, (e, v) => {
      remote.node = n3;
      distribution.local.comm.send([], remote, (e, v) => {
        if (globalThis.distribution.node.server) {
          globalThis.distribution.node.server.close();
        }
        done();
      });
    });
  });
});
