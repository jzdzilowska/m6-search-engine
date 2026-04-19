// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 *
 * @typedef {Object} Routes
 * @property {(service: object, name: string, callback: Callback) => void} put
 * @property {(configuration: string, callback: Callback) => void} rem
 */

/**
 * @param {Config} config
 * @returns {Routes}
 */
function routes(config) {
  const context = {};
  context.gid = config.gid || 'all';

  /**
   * @param {object} service
   * @param {string} name
   * @param {Callback} callback
   */
  function put(service, name, callback) {
    // register this service on every node in the group
    const remote = {service: 'routes', method: 'put'};
    globalThis.distribution[context.gid].comm.send([service, name], remote, callback);
  }

  /**
   * @param {string} configuration
   * @param {Callback} callback
   */
  function rem(configuration, callback) {
    // remove the service from every node in the group
    const remote = {service: 'routes', method: 'rem'};
    globalThis.distribution[context.gid].comm.send([configuration], remote, callback);
  }

  return {put, rem};
}

module.exports = routes;
