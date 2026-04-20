// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 * @typedef {import("../util/id.js").NID} NID
 */

/**
 * Map functions used for mapreduce
 * @callback Mapper
 * @param {string} key
 * @param {any} value
 * @returns {object[]}
 */

/**
 * Reduce functions used for mapreduce
 * @callback Reducer
 * @param {string} key
 * @param {any[]} value
 * @returns {object}
 */

/**
 * @typedef {Object} MRConfig
 * @property {Mapper} map
 * @property {Reducer} reduce
 * @property {string[]} keys
 *
 * @typedef {Object} Mr
 * @property {(configuration: MRConfig, callback: Callback) => void} exec
 */


/*
  Note: The only method explicitly exposed in the `mr` service is `exec`.
  Other methods, such as `map`, `shuffle`, and `reduce`, should be dynamically
  installed on the remote nodes and not necessarily exposed to the user.
*/

/**
 * @param {Config} config
 * @returns {Mr}
 */
function mr(config) {
  const context = {
    gid: config.gid || 'all',
  };

  /**
   * @param {MRConfig} configuration
   * @param {Callback} callback
   * @returns {void}
   */
  function exec(configuration, callback) {
    const id = globalThis.distribution.util.id;
    const mrID = id.getID(`mr-${Date.now()}-${Math.random()}`);
    const gid = context.gid;
    const mapGid = mrID + ':map';
    const shuffleGid = mrID + ':shuffle';
    const coordinatorNode = globalThis.distribution.node.config;
    const mrServiceName = 'mr-' + mrID.substring(0, 10);
    const coordServiceName = mrServiceName + '-coord';

    globalThis.distribution.local.groups.get(gid, (e, group) => {
      if (e) return callback(e);
      const nodes = Object.values(group);
      const nodeCount = nodes.length;

      if (nodeCount === 0) return callback(null, []);

      let mapDone = 0;
      let shuffleDone = 0;
      let reduceDone = 0;
      const reduceResults = [];

      /* ---- coordinator service (registered on this node only) ---- */
      const coordService = {
        notify: function(phase, data, cb) {
          if (typeof cb !== 'function') cb = () => {};
          cb(null, 'ok');

          if (phase === 'map') {
            mapDone++;
            // print if in indexer
            if (configuration.map.name === 'indexMapper') {
              console.log(`[mr] Map phase: ${mapDone}/${nodeCount} nodes done`);
            }
            if (mapDone === nodeCount) {
              triggerPhase('shuffle');
            }
          } else if (phase === 'shuffle') {
            shuffleDone++;
            if (shuffleDone === nodeCount) {
              triggerPhase('reduce');
            }
          } else if (phase === 'reduce') {
            if (Array.isArray(data)) reduceResults.push(...data);
            reduceDone++;
            if (reduceDone === nodeCount) {
              doCleanup();
            }
          }
        },
      };

      /* worker registered on every group node */
      const mrService = {
        map: function(mapper, keys, gid, mapGid, coordNode, coordSvc, cb) {
          if (typeof cb !== 'function') cb = () => {};
          const local = globalThis.distribution.local;
          let pending = keys.length;
          const outputs = [];

          if (pending === 0) {
            return local.comm.send(
                ['map', null],
                {node: coordNode, service: coordSvc, method: 'notify'},
                () => cb(null, 'ok'));
          }

          keys.forEach((key) => {
            local.store.get({key, gid}, (e, value) => {
              if (!e && value !== undefined) {
                try {
                  const r = mapper(key, value);
                  const a = Array.isArray(r) ? r : [r];
                  outputs.push(...a);
                } catch (_) { /* skip bad records */ }
              }
              if (--pending === 0) {
                if (outputs.length === 0) {
                  return local.comm.send(
                      ['map', null],
                      {node: coordNode, service: coordSvc, method: 'notify'},
                      () => cb(null, 'ok'));
                }
                local.mem.put(outputs, {key: 'mapResults', gid: mapGid}, () => {
                  local.comm.send(
                      ['map', null],
                      {node: coordNode, service: coordSvc, method: 'notify'},
                      () => cb(null, 'ok'));
                });
              }
            });
          });
        },

        shuffle: function(mapGid, shuffleGid, gid, coordNode, coordSvc, cb) {
          if (typeof cb !== 'function') cb = () => {};
          const local = globalThis.distribution.local;
          const id = globalThis.distribution.util.id;

          local.mem.get({key: 'mapResults', gid: mapGid}, (e, outputs) => {
            if (e || !Array.isArray(outputs) || outputs.length === 0) {
              return local.comm.send(
                  ['shuffle', null],
                  {node: coordNode, service: coordSvc, method: 'notify'},
                  () => cb(null, 'ok'));
            }

            local.groups.get(gid, (e, group) => {
              if (e) {
                return local.comm.send(
                    ['shuffle', null],
                    {node: coordNode, service: coordSvc, method: 'notify'},
                    () => cb(null, 'ok'));
              }

              const groupNodes = Object.values(group);
              const nids = groupNodes.map((n) => id.getNID(n));

              // Build a NID→node lookup to avoid re-hashing nodes
              const nidToNode = {};
              for (let i = 0; i < groupNodes.length; i++) {
                nidToNode[nids[i]] = groupNodes[i];
              }

              // Bucket pairs by target node
              const buckets = {}; // nid -> [{key, value}]
              outputs.forEach((obj) => {
                if (obj && typeof obj === 'object') {
                  for (const [k, v] of Object.entries(obj)) {
                    const kid = id.getID(k);
                    const targetNid = id.naiveHash(kid, nids);
                    if (!buckets[targetNid]) buckets[targetNid] = [];
                    buckets[targetNid].push({key: k, value: v});
                  }
                }
              });

              const nidKeys = Object.keys(buckets);
              if (nidKeys.length === 0) {
                return local.comm.send(
                    ['shuffle', null],
                    {node: coordNode, service: coordSvc, method: 'notify'},
                    () => cb(null, 'ok'));
              }

              // One RPC per target node with all its pairs
              let left = nidKeys.length;
              nidKeys.forEach((nid) => {
                const targetNode = nidToNode[nid];
                local.comm.send(
                    [buckets[nid], shuffleGid],
                    {node: targetNode, service: 'mem', method: 'batchAppend'},
                    () => {
                      if (--left === 0) {
                        local.comm.send(
                            ['shuffle', null],
                            {node: coordNode, service: coordSvc, method: 'notify'},
                            () => cb(null, 'ok'));
                      }
                    },
                );
              });
            });
          });
        },

        reduce: function(reducer, shuffleGid, coordNode, coordSvc, cb) {
          if (typeof cb !== 'function') cb = () => {};
          const local = globalThis.distribution.local;

          // @ts-ignore
          local.mem.get({key: null, gid: shuffleGid}, (e, keys) => {
            if (!keys || keys.length === 0) {
              return local.comm.send(
                  ['reduce', []],
                  {node: coordNode, service: coordSvc, method: 'notify'},
                  () => cb(null, 'ok'));
            }

            let left = keys.length;
            const results = [];

            keys.forEach((sk) => {
              local.mem.get({key: sk, gid: shuffleGid}, (e, values) => {
                if (!e && values !== undefined) {
                  const arr = Array.isArray(values) ? values : [values];
                  try {
                    results.push(reducer(sk, arr));
                  } catch (_) { /* skip */ }
                }
                if (--left === 0) {
                  local.comm.send(
                      ['reduce', results],
                      {node: coordNode, service: coordSvc, method: 'notify'},
                      () => cb(null, 'ok'));
                }
              });
            });
          });
        },

        cleanup: function(mapGid, shuffleGid, cb) {
          if (typeof cb !== 'function') cb = () => {};
          const local = globalThis.distribution.local;
          // Delete map results and shuffle data from in-memory store
          local.mem.del({key: 'mapResults', gid: mapGid}, () => {
            local.mem.get({key: null, gid: shuffleGid}, (e, keys) => {
              if (!keys || keys.length === 0) return cb(null, 'ok');
              let left = keys.length;
              keys.forEach((sk) => {
                local.mem.del({key: sk, gid: shuffleGid}, () => {
                  if (--left === 0) cb(null, 'ok');
                });
              });
            });
          });
        },
      };

      /* phase triggering */
      function triggerPhase(phase) {
        const lc = globalThis.distribution.local.comm;

        if (phase === 'map') {
          nodes.forEach((node) => {
            lc.send(
                [configuration.map, configuration.keys, gid, mapGid,
                  coordinatorNode, coordServiceName],
                {node, service: mrServiceName, method: 'map'},
                () => {},
            );
          });
        } else if (phase === 'shuffle') {
          nodes.forEach((node) => {
            lc.send(
                [mapGid, shuffleGid, gid,
                  coordinatorNode, coordServiceName],
                {node, service: mrServiceName, method: 'shuffle'},
                () => {},
            );
          });
        } else if (phase === 'reduce') {
          nodes.forEach((node) => {
            lc.send(
                [configuration.reduce, shuffleGid,
                  coordinatorNode, coordServiceName],
                {node, service: mrServiceName, method: 'reduce'},
                () => {},
            );
          });
        }
      }

      /* deregister services and free shuffle memory, then return results */
      function doCleanup() {
        // Free in-memory shuffle data on every node to prevent OOM on large jobs
        const local = globalThis.distribution.local;
        let cleaned = 0;
        const cleanupNodes = nodes.length;

        function afterClean() {
          globalThis.distribution[gid].routes.rem(mrServiceName, () => {
            local.routes.rem(coordServiceName, () => {
              callback(null, reduceResults);
            });
          });
        }

        if (cleanupNodes === 0) return afterClean();

        nodes.forEach((node) => {
          local.comm.send(
              [mapGid, shuffleGid],
              {node, service: mrServiceName, method: 'cleanup'},
              () => {
                if (++cleaned === cleanupNodes) afterClean();
              },
          );
        });
      }

      /* register services then kick off map */
      globalThis.distribution.local.routes.put(
          coordService, coordServiceName, () => {
            globalThis.distribution[gid].routes.put(
                mrService, mrServiceName, () => {
                  triggerPhase('map');
                },
            );
          },
      );
    });
  }

  return {exec};
}

module.exports = mr;
