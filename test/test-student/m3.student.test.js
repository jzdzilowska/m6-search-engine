/*
    In this file, add your own test cases that correspond to functionality introduced for each milestone.
    You should fill out each test case so it adequately tests the functionality you implemented.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')();
require('../helpers/sync-guard');
const id = distribution.util.id;

const n1 = {ip: '127.0.0.1', port: 7010};
const n2 = {ip: '127.0.0.1', port: 7011};
const n3 = {ip: '127.0.0.1', port: 7012};

test('(1 pts) student test', (done) => {
  // Test: local.groups.put creates distribution[gid] with distributed services
  const g = {[id.getSID(n1)]: n1, [id.getSID(n2)]: n2};
  distribution.local.groups.put('studentG1', g, (e, v) => {
    try {
      expect(e).toBeFalsy();
      expect(v).toEqual(g);
      // Verify that distributed services were instantiated on the group
      expect(distribution.studentG1).toBeDefined();
      expect(distribution.studentG1.comm).toBeDefined();
      expect(distribution.studentG1.status).toBeDefined();
      expect(distribution.studentG1.groups).toBeDefined();
      expect(distribution.studentG1.routes).toBeDefined();
      distribution.local.groups.del('studentG1', () => done());
    } catch (error) {
      done(error);
    }
  });
});


test('(1 pts) student test', (done) => {
  // Test: all.comm.send fans out to all nodes, collecting per-node nids
  const grp = {[id.getSID(n1)]: n1, [id.getSID(n2)]: n2, [id.getSID(n3)]: n3};
  distribution.local.groups.put('studentG2', grp, (e, v) => {
    const remote = {service: 'status', method: 'get'};
    distribution.studentG2.comm.send(['sid'], remote, (e, v) => {
      try {
        const sids = Object.keys(grp);
        expect(Object.keys(v).length).toBe(sids.length);
        sids.forEach((sid) => {
          expect(v[sid]).toBeDefined();
        });
        distribution.local.groups.del('studentG2', () => done());
      } catch (error) {
        done(error);
      }
    });
  });
});


test('(1 pts) student test', (done) => {
  // Test: local.groups add then rem updates the group membership correctly
  const g = {[id.getSID(n1)]: n1};
  distribution.local.groups.put('studentG3', g, (e, v) => {
    distribution.local.groups.add('studentG3', n2, (e, v) => {
      try {
        expect(e).toBeFalsy();
        expect(v[id.getSID(n2)]).toEqual(n2);
        expect(v[id.getSID(n1)]).toEqual(n1);
      } catch (error) {
        done(error);
        return;
      }
      distribution.local.groups.rem('studentG3', id.getSID(n1), (e, v) => {
        try {
          expect(e).toBeFalsy();
          expect(v[id.getSID(n1)]).toBeUndefined();
          expect(v[id.getSID(n2)]).toEqual(n2);
          distribution.local.groups.del('studentG3', () => done());
        } catch (error) {
          done(error);
        }
      });
    });
  });
});

test('(1 pts) student test', (done) => {
  // Test: routes.get works with both string and {service, gid} object config
  const testSvc = {ping: (cb) => cb(null, 'pong')};
  distribution.local.routes.put(testSvc, 'studentSvc', (e, v) => {
    distribution.local.routes.get('studentSvc', (e1, v1) => {
      try {
        expect(e1).toBeFalsy();
        expect(v1).toBeDefined();
        expect(typeof v1.ping).toBe('function');
      } catch (error) {
        done(error);
        return;
      }
      distribution.local.routes.get({service: 'studentSvc', gid: 'local'}, (e2, v2) => {
        try {
          expect(e2).toBeFalsy();
          expect(v2).toBeDefined();
          expect(typeof v2.ping).toBe('function');
          distribution.local.routes.rem('studentSvc', () => done());
        } catch (error) {
          done(error);
        }
      });
    });
  });
});

test('(1 pts) student test', (done) => {
  // Test: all.status.get(heapTotal) returns a summed positive number
  const grp = {[id.getSID(n1)]: n1, [id.getSID(n2)]: n2};
  distribution.local.groups.put('studentG5', grp, (e, v) => {
    distribution.studentG5.status.get('heapTotal', (e, v) => {
      try {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThan(0);
        distribution.local.groups.del('studentG5', () => done());
      } catch (error) {
        done(error);
      }
    });
  });
});

/*
   Setup: start nodes used by distributed tests
*/

beforeAll((done) => {
  const remote = {service: 'status', method: 'stop'};
  remote.node = n1;
  distribution.local.comm.send([], remote, () => {
    remote.node = n2;
    distribution.local.comm.send([], remote, () => {
      remote.node = n3;
      distribution.local.comm.send([], remote, () => {
        distribution.node.start((e) => {
          if (e) return done(e);
          distribution.local.status.spawn(n1, (e, v) => {
            if (e) return done(e);
            distribution.local.status.spawn(n2, (e, v) => {
              if (e) return done(e);
              distribution.local.status.spawn(n3, (e, v) => {
                if (e) return done(e);
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
  distribution.local.comm.send([], remote, () => {
    remote.node = n2;
    distribution.local.comm.send([], remote, () => {
      remote.node = n3;
      distribution.local.comm.send([], remote, () => {
        if (globalThis.distribution.node.server) {
          globalThis.distribution.node.server.close();
        }
        done();
      });
    });
  });
});
