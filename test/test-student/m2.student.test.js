/*
    In this file, add your own test cases that correspond to functionality introduced for each milestone.
    You should fill out each test case so it adequately tests the functionality you implemented.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')({ip: '127.0.0.1', port: 7070});
require('../helpers/sync-guard');
const local = distribution.local;
const id = distribution.util.id;
const config = distribution.node.config;

// 1: status.get - multiple status properties in sequence
test('(1 pts) student test', (done) => {
  // status.get for sid, ip properties
  local.status.get('sid', (e1, sid) => {
    try {
      expect(e1).toBeFalsy();
      expect(sid).toEqual(id.getSID(config));

      // getting the port
      local.status.get('port', (e2, port) => {
        try {
          expect(e2).toBeFalsy();
          expect(port).toEqual(config.port);
          done();
        } catch (error) {
          done(error);
        }
      });
    } catch (error) {
      done(error);
    }
  });
});


// 2: status.get, error handling of invalid keys
test('(1 pts) student test', (done) => {
  // returns an error for unknown config keys
  local.status.get('nonexistent_key', (e, v) => {
    try {
      expect(e).toBeDefined();
      expect(e).toBeInstanceOf(Error);
      expect(v).toBeFalsy();

      // Also with another invalid key
      local.status.get('foobar', (e2, v2) => {
        try {
          expect(e2).toBeDefined();
          expect(e2).toBeInstanceOf(Error);
          expect(v2).toBeFalsy();
          done();
        } catch (error) {
          done(error);
        }
      });
    } catch (error) {
      done(error);
    }
  });
});


// 3: routes.put, routes.get - ie register n retrieve a custom service
test('(1 pts) student test', (done) => {
  const mathService = { // custom with multiple methods
    add: (a, b, cb) => cb(null, a + b),
    multiply: (a, b, cb) => cb(null, a * b),
  };

  local.routes.put(mathService, 'mathService', (e1, v1) => {
    try {
      expect(e1).toBeFalsy();
      local.routes.get('mathService', (e2, v2) => {
        try {
          expect(e2).toBeFalsy();
          expect(v2).toBeDefined();
          v2.add(5, 3, (e3, result) => {
            try {
              expect(e3).toBeFalsy();
              expect(result).toEqual(8);
              done();
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });
    } catch (error) {
      done(error);
    }
  });
});

// 4: routes.rem, remove a service, verify gone
test('(1 pts) student test', (done) => {
  // TODO: simplify
  const tempService = {
    greet: () => 'Hello!',
  };
  local.routes.put(tempService, 'tempGreeter', (e1, v1) => { // put the serv first
    try {
      expect(e1).toBeFalsy();
      local.routes.get('tempGreeter', (e2, v2) => {
        try { // verify exists
          expect(e2).toBeFalsy();
          expect(v2.greet()).toEqual('Hello!');
          local.routes.rem('tempGreeter', (e3, v3) => {
            try {
              expect(e3).toBeFalsy();
              expect(v3).toEqual(tempService); // TODO: get removed 

              local.routes.get('tempGreeter', (e4, v4) => {
                try {
                  expect(e4).toBeInstanceOf(Error);
                  expect(v4).toBeFalsy();
                  done();
                } catch (error) {
                  done(error);
                }
              });
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });
    } catch (error) {
      done(error);
    }
  });
});

// 5: comm.send, send a message 2 local node, get status
test('(1 pts) student test', (done) => {
  const remote = {node: config, service: 'status', method: 'get'};
  const message = ['sid'];

  local.comm.send(message, remote, (e, v) => {
    try {
      expect(e).toBeFalsy();
      expect(v).toEqual(id.getSID(config));

      const remote2 = {node: config, service: 'routes', method: 'get'};
      const message2 = ['status'];

      local.comm.send(message2, remote2, (e2, v2) => {
        try {
          expect(e2).toBeFalsy();
          expect(v2).toBeDefined();
          expect(v2.get).toBeDefined(); 
          done();
        } catch (error) {
          done(error);
        }
      });
    } catch (error) {
      done(error);
    }
  });
});

/* ------------------------------- INFRA ------------------------------ */
beforeAll((done) => {
  distribution.node.start((e) => {
    if (e) {
      done(e);
      return;
    }
    done();
  });
});

afterAll((done) => {
  if (globalThis.distribution.node.server) {
    globalThis.distribution.node.server.close();
  }
  done();
});
