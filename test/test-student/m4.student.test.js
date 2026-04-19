/*
    In this file, add your own test cases that correspond to functionality introduced for each milestone.
    You should fill out each test case so it adequately tests the functionality you implemented.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')();
require('../helpers/sync-guard');
const id = distribution.util.id;

jest.spyOn(process, 'exit').mockImplementation((n) => { });

test('(1 pts) student test', (done) => {
  // local mem: put with null key uses sha256, then update via second put, verify updated value
  const obj = {name: 'Alice', age: 30};
  const updatedObj = {name: 'Alice', age: 31};
  const autoKey = id.getID(obj);

  distribution.local.mem.put(obj, null, (e, v) => {
    expect(e).toBeFalsy();
    expect(v).toEqual(obj);

    distribution.local.mem.put(updatedObj, autoKey, (e, v) => {
      expect(e).toBeFalsy();
      distribution.local.mem.get(autoKey, (e, v) => {
        try {
          expect(e).toBeFalsy();
          expect(v).toEqual(updatedObj);
          done();
        } catch (error) {
          done(error);
        }
      });
    });
  });
});


test('(1 pts) student test', (done) => {
  // local store: put, get, update (re-put same key), get confirms update, del, get confirms gone
  const val1 = {x: 1};
  const val2 = {x: 2};
  const key = 'studentStoreUpdate';

  distribution.local.store.put(val1, key, (e, v) => {
    expect(e).toBeFalsy();
    distribution.local.store.get(key, (e, v) => {
      expect(v).toEqual(val1);
      distribution.local.store.put(val2, key, (e, v) => {
        expect(e).toBeFalsy();
        distribution.local.store.get(key, (e, v) => {
          expect(v).toEqual(val2);
          distribution.local.store.del(key, (e, v) => {
            expect(e).toBeFalsy();
            expect(v).toEqual(val2);
            distribution.local.store.get(key, (e, v) => {
              try {
                expect(e).toBeInstanceOf(Error);
                done();
              } catch (error) {
                done(error);
              }
            });
          });
        });
      });
    });
  });
});


test('(1 pts) student test', (done) => {
  // removing one node changes placement for at most 1/n of keys
  const nodes = [
    {ip: '10.0.0.1', port: 3000},
    {ip: '10.0.0.2', port: 3000},
    {ip: '10.0.0.3', port: 3000},
    {ip: '10.0.0.4', port: 3000},
    {ip: '10.0.0.5', port: 3000},
  ];
  const fullNids = nodes.map((n) => id.getNID(n));
  const reducedNids = fullNids.slice(0, 4);

  let changed = 0;
  const total = 100;
  for (let i = 0; i < total; i++) {
    const kid = id.getID('testkey' + i);
    const full = id.consistentHash(kid, fullNids);
    const reduced = id.consistentHash(kid, reducedNids);
    if (full !== reduced) changed++;
  }

  try {
    // rgh 1/5 of keys should change (the ones on the removed)
    expect(changed).toBeLessThan(total * 0.5);
    done();
  } catch (error) {
    done(error);
  }
});

test('(1 pts) student test', (done) => {
  // distributed mem: put multiple items, verify each lands on the correct hash-determined node
  const items = [
    {key: 'distA', value: {v: 'alpha'}},
    {key: 'distB', value: {v: 'beta'}},
    {key: 'distC', value: {v: 'gamma'}},
  ];

  let pending = items.length;
  items.forEach(({key, value}) => {
    distribution.studentGroup.mem.put(value, key, (e, v) => {
      expect(e).toBeFalsy();
      if (--pending === 0) verifyAll();
    });
  });

  function verifyAll() {
    let check = items.length;
    items.forEach(({key, value}) => {
      const kid = id.getID(key);
      const nodes = Object.values(studentGroupNodes);
      const nids = nodes.map((n) => id.getNID(n));
      const nid = id.naiveHash(kid, nids);
      const target = nodes.find((n) => id.getNID(n) === nid);

      distribution.local.comm.send(
          [{key, gid: 'studentGroup'}],
          {node: target, service: 'mem', method: 'get'},
          (e, v) => {
            try {
              expect(e).toBeFalsy();
              expect(v).toEqual(value);
            } catch (error) {
              done(error);
              return;
            }
            if (--check === 0) done();
          });
    });
  }
});

test('(1 pts) student test', (done) => {
  // distributed store: cross-group isolation, put to groupA, get from groupB returns error
  const value = {secret: 'data'};
  const key = 'crossGroupKey';

  distribution.studentGroup.store.put(value, key, (e, v) => {
    expect(e).toBeFalsy();
    distribution.studentGroupB.store.get(key, (e, v) => {
      try {
        expect(e).toBeInstanceOf(Error);
        expect(v).toBeFalsy();
        done();
      } catch (error) {
        done(error);
      }
    });
  });
});


/*
    Setup
*/
const n1 = {ip: '127.0.0.1', port: 7101};
const n2 = {ip: '127.0.0.1', port: 7102};
const n3 = {ip: '127.0.0.1', port: 7103};

const studentGroupNodes = {};
studentGroupNodes[id.getSID(n1)] = n1;
studentGroupNodes[id.getSID(n2)] = n2;
studentGroupNodes[id.getSID(n3)] = n3;

beforeAll((done) => {
  const fs = require('fs');
  const path = require('path');
  fs.rmSync(path.join(__dirname, '../../store'), {recursive: true, force: true});
  fs.mkdirSync(path.join(__dirname, '../../store'));

  const remote = {service: 'status', method: 'stop'};
  remote.node = n1;
  distribution.local.comm.send([], remote, (e, v) => {
    remote.node = n2;
    distribution.local.comm.send([], remote, (e, v) => {
      remote.node = n3;
      distribution.local.comm.send([], remote, (e, v) => {
        startNodes();
      });
    });
  });

  const startNodes = () => {
    distribution.node.start((e) => {
      if (e) return done(e);
      distribution.local.status.spawn(n1, (e, v) => {
        if (e) return done(e);
        distribution.local.status.spawn(n2, (e, v) => {
          if (e) return done(e);
          distribution.local.status.spawn(n3, (e, v) => {
            if (e) return done(e);
            const configA = {gid: 'studentGroup'};
            const configB = {gid: 'studentGroupB', hash: id.consistentHash};
            distribution.local.groups.put(configA, studentGroupNodes, (e, v) => {
              distribution.local.groups.put(configB, studentGroupNodes, (e, v) => {
                done();
              });
            });
          });
        });
      });
    });
  };
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
