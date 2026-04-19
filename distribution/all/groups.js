// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 * @typedef {import("../util/id.js").Node} Node
 *
 * @typedef {Object} Groups
 * @property {(config: Config | string, group: Object.<string, Node>, callback: Callback) => void} put
 * @property {(name: string, callback: Callback) => void} del
 * @property {(name: string, callback: Callback) => void} get
 * @property {(name: string, node: Node, callback: Callback) => void} add
 * @property {(name: string, node: string, callback: Callback) => void} rem
 */

/**
 * @param {Config} config
 * @returns {Groups}
 */
function groups(config) {
  const context = {gid: config.gid || 'all'};

  /**
   * @param {Config | string} config
   * @param {Object.<string, Node>} group
   * @param {Callback} callback
   */
  function put(config, group, callback) {
    // tell every node in the group to run put
    const remote = {service: 'groups', method: 'put'};
    globalThis.distribution[context.gid].comm.send([config, group], remote, callback);
  }

  /**
   * @param {string} name
   * @param {Callback} callback
   */
  function del(name, callback) {
    const remote = {service: 'groups', method: 'del'};
    globalThis.distribution[context.gid].comm.send([name], remote, callback);
  }

  /**
   * @param {string} name
   * @param {Callback} callback
   */
  function get(name, callback) {
    // each node returns its own view of the group 
    const remote = {service: 'groups', method: 'get'};
    globalThis.distribution[context.gid].comm.send([name], remote, callback);
  }

  /**
   * @param {string} name
   * @param {Node} node
   * @param {Callback} callback
   */
  function add(name, node, callback) {
    const remote = {service: 'groups', method: 'add'};
    globalThis.distribution[context.gid].comm.send([name, node], remote, callback);
  }

  /**
   * @param {string} name
   * @param {string} node
   * @param {Callback} callback
   */
  function rem(name, node, callback) {
    const remote = {service: 'groups', method: 'rem'};
    globalThis.distribution[context.gid].comm.send([name, node], remote, callback);
  }

  return {
    put, del, get, add, rem,
  };
}

module.exports = groups;
