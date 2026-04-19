// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 */

/**
 * NOTE: This Target is slightly different from local.all.Target
 * @typedef {Object} Target
 * @property {string} service
 * @property {string} method
 * @property {string} [gid]
 *
 * @typedef {Object} Comm
 * @property {(message: any[], configuration: Target, callback: Callback) => void} send
 */

/**
 * @param {Config} config
 * @returns {Comm}
 */
function comm(config) {
  const context = {};
  context.gid = config.gid || 'all';

  /**
   * @param {any[]} message
   * @param {Target} configuration
   * @param {Callback} callback
   */
  function send(message, configuration, callback) {
    const localGroups = globalThis.distribution.local.groups;
    const localComm = globalThis.distribution.local.comm;

    // fig out which nodes are in this group
    localGroups.get(context.gid, (e, group) => {
      if (e || !group) {
        return callback(new Error(`Group '${context.gid}' not found`), null);
      }

      const sids = Object.keys(group);
      if (sids.length === 0) {
        return callback(new Error('No nodes in group'), null);
      }

      // collect errors and values separately, keyed by sid
      /** @type {Object.<string, Error>} */
      const errorMap = {};
      const valueMap = {};
      let count = 0;

      // fan out
      sids.forEach((sid) => {
        const node = group[sid];
        const remote = {
          node: node,
          service: configuration.service,
          method: configuration.method,
        };

        localComm.send(message, remote, (e, v) => {
          if (e) {
            errorMap[sid] = e;
          } else {
            valueMap[sid] = v;
          }

          // once back fr everyone fire the callback
          count++;
          if (count === sids.length) {
            callback(errorMap, valueMap);
          }
        });
      });
    });
  }

  return {send};
}

module.exports = comm;
