/*
    In this file, add your own test case that will confirm your correct implementation of the extra-credit functionality.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')();
require('../helpers/sync-guard');

test('(15 pts) detect the need to reconfigure', (done) => {
  const id = distribution.util.id;

  const n1 = {ip: '127.0.0.1', port: 9101};
  const n2 = {ip: '127.0.0.1', port: 9102};
  const n3 = {ip: '127.0.0.1', port: 9103};

  const groupNodes = {};
  groupNodes[id.getSID(n1)] = n1;
  groupNodes[id.getSID(n2)] = n2;
  groupNodes[id.getSID(n3)] = n3;

  const items = [
    {key: 'alpha', val: {name: 'Alice', age: 30}},
    {key: 'beta', val: {name: 'Bob', age: 25}},
    {key: 'gamma', val: {name: 'Carol', age: 28}},
    {key: 'delta', val: {name: 'Dave', age: 35}},
  ];

  // start coordinator, spawn workers, create group
  distribution.node.start((e) => {
    if (e) return done(e);
    distribution.local.status.spawn(n1, (e) => {
      if (e) return done(e);
      distribution.local.status.spawn(n2, (e) => {
        if (e) return done(e);
        distribution.local.status.spawn(n3, (e) => {
          if (e) return done(e);
          distribution.local.groups.put(
              {gid: 'dgroup'}, groupNodes, (e) => {
                if (e) return done(e);
                distribution.dgroup.groups.put(
                    {gid: 'dgroup'}, groupNodes, (e) => {
                      if (e && Object.keys(e).length > 0) return done(e);
                      insertItems(0);
                    });
              });
        });
      });
    });
  });

  function insertItems(i) {
    if (i >= items.length) return killNodeAndDetect();
    distribution.dgroup.mem.put(items[i].val, items[i].key, (e) => {
      if (e) return done(e);
      insertItems(i + 1);
    });
  }

  function killNodeAndDetect() {
    const oldGroup = {...groupNodes};

    // kill n3 to simulate failure
    distribution.local.comm.send(
        [], {node: n3, service: 'status', method: 'stop'}, () => {
          // detect: try reaching n3, expect error (node is down)
          setTimeout(() => {
            distribution.local.comm.send(
                ['sid'], {node: n3, service: 'status', method: 'get'}, (e) => {
                  // this error means we detected n3 is gone — need to reconfigure
                  expect(e).toBeTruthy();

                  // remove n3 from group and run reconf
                  distribution.local.groups.rem('dgroup', id.getSID(n3), () => {
                    distribution.dgroup.groups.rem(
                        'dgroup', id.getSID(n3), () => {
                          distribution.dgroup.mem.reconf(oldGroup, () => {
                            verifyAllItems(0);
                          });
                        });
                  });
                });
          }, 200);
        });
  }

  function verifyAllItems(i) {
    if (i >= items.length) return cleanup();
    distribution.dgroup.mem.get(items[i].key, (e, v) => {
      try {
        expect(e).toBeFalsy();
        expect(v).toEqual(items[i].val);
      } catch (err) {
        cleanup(() => done(err));
        return;
      }
      verifyAllItems(i + 1);
    });
  }

  function cleanup(cb) {
    distribution.local.comm.send(
        [], {node: n1, service: 'status', method: 'stop'}, () => {
          distribution.local.comm.send(
              [], {node: n2, service: 'status', method: 'stop'}, () => {
                if (distribution.node.server) {
                  distribution.node.server.close();
                }
                if (cb) cb();
                else done();
              });
        });
  }
});
