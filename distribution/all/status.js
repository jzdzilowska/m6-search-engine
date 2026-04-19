// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 * @typedef {import("../util/id.js").Node} Node
 *
 * @typedef {Object} Status
 * @property {(configuration: string, callback: Callback) => void} get
 * @property {(configuration: Node, callback: Callback) => void} spawn
 * @property {(callback: Callback) => void} stop
 */

/**
 * @param {Config} config
 * @returns {Status}
 */
function status(config) {
  const context = {};
  context.gid = config.gid || 'all';

  /**
   * @param {string} configuration
   * @param {Callback} callback
   */
  function get(configuration, callback) {
    const remote = {service: 'status', method: 'get'};

    // ask every node in the group for their status value
    globalThis.distribution[context.gid].comm.send([configuration], remote, (e, v) => {
      // heapTotal should be summed across all nodes
      if (configuration === 'heapTotal') {
        const total = Object.values(v).reduce((acc, val) => acc + val, 0);
        return callback(e, total);
      }
      // nid and sid just need a flat list, not keyed by sid
      if (configuration === 'nid' || configuration === 'sid') {
        return callback(e, Object.values(v));
      }
      // everything else stays as the per-node map but check it
      callback(e, v);
    });
  }

  /**
   * @param {Node} configuration
   * @param {Callback} callback
   */
  function spawn(configuration, callback) {
    callback(new Error('status.spawn not implemented'));
  }

  /**
   * Stops all nodes in the group except the local node.
   * @param {Callback} callback
   */
  function stop(callback) {
    const id = globalThis.distribution.util.id;
    const localSid = id.getSID(globalThis.distribution.node.config);

    globalThis.distribution.local.groups.get(context.gid, (e, group) => {
      if (e || !group) return callback(e || new Error('Group not found'));

      // don't stop ourselves, only stop the other nodes
      const sids = Object.keys(group).filter((sid) => sid !== localSid);
      if (sids.length === 0) return callback({}, {});

      /** @type {Object.<string, Error>} */
      const errors = {};
      const values = {};
      let count = 0;

      // send stop to each remote node, collect responses
      sids.forEach((sid) => {
        const node = group[sid];
        const remote = {node, service: 'status', method: 'stop'};
        globalThis.distribution.local.comm.send([], remote, (e, v) => {
          if (e) errors[sid] = e;
          else values[sid] = v;
          count++;
          if (count === sids.length) callback(errors, values);
        });
      });
    });
  }

  return {get, stop, spawn};
}

module.exports = status;
