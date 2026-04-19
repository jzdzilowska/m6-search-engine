require('../../distribution.js')();
const distribution = globalThis.distribution;
const util = distribution.util;
const id = distribution.util.id;

test('(5 pts) (scenario) use the local store', (done) => {
  /*
      Use the distributed store to put a key-value pair.
      Make sure to run the check() function at the last callback of your solution.
  */
  const user = {first: 'Josiah', last: 'Carberry'};
  const key = 'jcarbspsg';

  distribution.local.store.put(user, key, (e, v) => {
    if (e) return done(e);
    check();
  });

  function check() {
    distribution.local.store.get(key, (e, v) => {
      try {
        expect(v).toEqual(user);
        done();
      } catch (error) {
        done(error);
      }
    });
  }
});


test('(5 pts) (scenario) two keys map to the same node', () => {
  /*

        Identify two keys that consistentHash maps to the same node. You will
        likely need to try a few (but not many) keys. What can you conclude
        about using consistentHash for a small number of keys.

    */
  const nodeIds = [
    util.id.getNID({ip: '192.168.0.1', port: 8000}),
    util.id.getNID({ip: '192.168.0.2', port: 8000}),
    util.id.getNID({ip: '192.168.0.3', port: 8000}),
    util.id.getNID({ip: '192.168.0.4', port: 8000}),
    util.id.getNID({ip: '192.168.0.5', port: 8000}),
  ];
  let key1 = 'key0';
  let key2 = 'key26';

  const kid1 = util.id.getID(key1);
  const kid2 = util.id.getID(key2);

  const key1Node = util.id.consistentHash(kid1, nodeIds);
  const key2Node = util.id.consistentHash(kid2, nodeIds);

  expect(key1Node).toEqual(key2Node);
});

test('(5 pts) (scenario) hash functions return the same node', () => {
  /*

        Identify a key for which two hash functions agree about its placement.
        You will likely need to try a few (but not many) keys.

    */

  // Feel free to change the nodes (both their number and configuration)
  const nodeIds = [
    util.id.getNID({ip: '192.168.0.1', port: 8000}),
    util.id.getNID({ip: '192.168.0.2', port: 8000}),
    util.id.getNID({ip: '192.168.0.3', port: 8000}),
    util.id.getNID({ip: '192.168.0.4', port: 8000}),
  ];

  let key = 'key7';

  const kid = util.id.getID(key);

  let a = util.id.consistentHash(kid, nodeIds);
  let b = util.id.naiveHash(kid, nodeIds);
  let c = util.id.rendezvousHash(kid, nodeIds);

  expect(a).toEqual(b);
  expect(b).toEqual(c);
});

const n1 = {ip: '127.0.0.1', port: 9001};
const n2 = {ip: '127.0.0.1', port: 9002};
const n3 = {ip: '127.0.0.1', port: 9003};
const n4 = {ip: '127.0.0.1', port: 9004};
const n5 = {ip: '127.0.0.1', port: 9005};
const n6 = {ip: '127.0.0.1', port: 9006};

test('(5 pts) (scenario) use mem.reconf', (done) => {
  /*
  In this scenario, you will use the `mem.reconf` method to reconfigure the placement of items in a group of nodes.
  You will create a group of nodes and place items in them.
  Then, you will remove a node from the group and call `mem.reconf` to place the items in the remaining nodes.
  Finally, you will check if the items are in the right place.
  */

  // Create a group with any number of nodes
  const mygroupGroup = {};
  mygroupGroup[id.getSID(n1)] = n1;
  mygroupGroup[id.getSID(n2)] = n2;
  mygroupGroup[id.getSID(n3)] = n3;

    // Create a set of items and corresponding keys...
  const keysAndItems = [
    {key: 'a', item: {first: 'Josiah', last: 'Carberry'}},
    {key: 'b', item: {first: 'Gus', last: 'Fring'}},
  ];

  const config = {gid: 'mygroup', hash: id.naiveHash};

  distribution.local.groups.put(config, mygroupGroup, (e, v) => {
    // Now, place each one of the items you made inside the group...
    distribution.mygroup.mem.put(keysAndItems[0].item, keysAndItems[0].key, (e, v) => {
      if (e) return done(e);
      distribution.mygroup.mem.put(keysAndItems[1].item, keysAndItems[1].key, (e, v) => {
        if (e) return done(e);
        checkPlacement();
      });
    });
  });

  const checkPlacement = () => {
    const nodes = [n1, n2, n3];
    const nids = nodes.map((n) => id.getNID(n));

    const nodeForKey = (key) => {
      const kid = id.getID(key);
      const nid = id.naiveHash(kid, nids);
      return nodes.find((n) => id.getNID(n) === nid);
    };

    const remote0 = {
      node: nodeForKey(keysAndItems[0].key),
      service: 'mem', method: 'get',
    };
    distribution.local.comm.send(
        [{key: keysAndItems[0].key, gid: 'mygroup'}], remote0, (e, v) => {
          try {
            expect(e).toBeFalsy();
            expect(v).toEqual(keysAndItems[0].item);
          } catch (error) {
            done(error);
            return;
          }

          const remote1 = {
            node: nodeForKey(keysAndItems[1].key),
            service: 'mem', method: 'get',
          };
          distribution.local.comm.send(
              [{key: keysAndItems[1].key, gid: 'mygroup'}], remote1, (e, v) => {
                try {
                  expect(e).toBeFalsy();
                  expect(v).toEqual(keysAndItems[1].item);
                  done();
                } catch (error) {
                  done(error);
                }
              });
        });
  };
});

test('(5 pts) (scenario) redistribute keys and values among nodes', (done) => {
  /*
    This scenario simulates the "Shuffle" phase of MapReduce with multiple keys.

    Setup:
    - n1 has local results: { 'jcarb': 'one', 'lc': 'three' }
    - n2 has local results: { 'jcarb': 'two' }

    Goal:
    - 'jcarb' should be aggregated to ['one', 'two']
    - 'lc' should be aggregated to ['three']

    Your Task:
    1. Fetch the local values from n1 and n2.
    2. For every key-value pair found, use `shuffleGroup.store.append` to
       send it to the correct destination in the distributed system.

    This forces you to trust the hashing mechanism: you don't know where
    'jcarb' or 'lc' will end up, but `append` will route them correctly.
  */

  const shuffleGroup = {};
  shuffleGroup[id.getSID(n1)] = n1;
  shuffleGroup[id.getSID(n2)] = n2;
  shuffleGroup[id.getSID(n3)] = n3;

  // The "map output" data scattered across nodes
  const n1Data = {'jcarb': 'one', 'lc': 'three'};
  const n2Data = {'jcarb': 'two'};

  distribution.local.groups.put('shuffleGroup', shuffleGroup, (e, v) => {
    // Helper to seed local storage (simulating map output)
    const seed = (node, data, callback) => {
      const entries = Object.entries(data);
      let pending = entries.length;
      if (pending === 0) return callback();

      entries.forEach(([k, v]) => {
        const remote = {node: node, service: 'store', method: 'put'};
        const config = {key: k, gid: 'local'};
        distribution.local.comm.send([v, config], remote, (e, v) => {
          if (--pending === 0) {
            return callback();
          }
        });
      });
    };

    // Seed n1 and n2, then run solution
    seed(n1, n1Data, () => {
      seed(n2, n2Data, () => {
        runSolution();
      });
    });
  });

  const runSolution = () => {
    // Helper to process a single node's data
    const processNode = (node, dataToProcess, callback) => {
      const entries = Object.entries(dataToProcess);
      let pending = entries.length;
      if (pending === 0) return callback();

      entries.forEach(([k, v]) => {
        distribution.shuffleGroup.store.append(v, k, (e, v) => {
          if (--pending === 0) callback();
        });
      });
    };

    // Process n1's data, then n2's data, and finlly check the results
    processNode(n1, n1Data, () => {
      processNode(n2, n2Data, () => {
        check();
      });
    });
  };

  const check = () => {
    // Check 'jcarb' aggregation
    distribution.shuffleGroup.store.get('jcarb', (e, v) => {
      try {
        expect(e).toBeFalsy();
        expect(v).toEqual(expect.arrayContaining(['one', 'two']));
        expect(v.length).toBe(2);

        distribution.shuffleGroup.store.get('lc', (e, v) => {
          expect(e).toBeFalsy();
          expect(v).toEqual(expect.arrayContaining(['three']));
          expect(v.length).toBe(1);
          done();
        });
      } catch (error) {
        done(error);
      }
    });
  };
});

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
        remote.node = n4;
        distribution.local.comm.send([], remote, (e, v) => {
          remote.node = n5;
          distribution.local.comm.send([], remote, (e, v) => {
            remote.node = n6;
            distribution.local.comm.send([], remote, (e, v) => {
              startNodes();
            });
          });
        });
      });
    });
  });

  const startNodes = () => {
    // Now, start the nodes listening node
    distribution.node.start(() => {
      // Start the nodes
      distribution.local.status.spawn(n1, (e, v) => {
        distribution.local.status.spawn(n2, (e, v) => {
          distribution.local.status.spawn(n3, (e, v) => {
            distribution.local.status.spawn(n4, (e, v) => {
              distribution.local.status.spawn(n5, (e, v) => {
                distribution.local.status.spawn(n6, (e, v) => {
                  done();
                });
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
        remote.node = n4;
        distribution.local.comm.send([], remote, (e, v) => {
          remote.node = n5;
          distribution.local.comm.send([], remote, (e, v) => {
            remote.node = n6;
            distribution.local.comm.send([], remote, (e, v) => {
              if (globalThis.distribution.node.server) {
                globalThis.distribution.node.server.close();
              }
              done();
            });
          });
        });
      });
    });
  });
});
