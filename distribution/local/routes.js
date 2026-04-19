/**
 * @typedef {import("../types").Callback} Callback
 * @typedef {string} ServiceName
 */

/** @type {Object.<string, object>} */
const serviceTable = {};

/**
 * Get the built-in services from distribution.local
 * lazily to avoid circular dependency issues
 * @returns {Object.<string, object>}
 */
function getBuiltinServices() {
  const local = globalThis.distribution.local;
  return {
    status: local.status,
    routes: local.routes,
    comm: local.comm,
    groups: local.groups,
    gossip: local.gossip,
    mem: local.mem,
    store: local.store,
  };
}

/**
 * @param {ServiceName | {service: ServiceName, gid?: string}} configuration
 * @param {Callback} callback
 * @returns {void}
 */
function get(configuration, callback) {
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  if (configuration == null) {
    return callback(new Error('Service name cannot be null or undefined'));
  }

  // extr service name, config can be a string / object with {service, gid}
  let serviceName;
  let gid;

  if (typeof configuration === 'string') {
    serviceName = configuration;
  } else if (typeof configuration === 'object' && configuration.service) {
    serviceName = configuration.service;
    gid = configuration.gid;
  } else {
    return callback(new Error('Invalid configuration format'));
  }

    // gid is 'local' / not specified - then look in local services
    if (typeof serviceName !== 'string' || serviceName === '') {
    return callback(new Error('Service name must be a non-empty string'));
  }
  if (!gid || gid === 'local') {
    // check dynamically registered services
    if (serviceTable[serviceName]) {
      return callback(null, serviceTable[serviceName]);
    }

    // then check built-in services (w safe access)
    try {
      const builtins = getBuiltinServices();
      if (builtins[serviceName]) {
        return callback(null, builtins[serviceName]);
      }
    } catch (err) {
      // TODO: just continue to error?
    }
    return callback(new Error(`Service '${serviceName}' not found`));
  }

  // If gid is specified & not 'local', first fall back to local services
  // (incoming requests should resolve to local service handlers, not distributed ones)
  if (serviceTable[serviceName]) {
    return callback(null, serviceTable[serviceName]);
  }
  try {
    const builtins = getBuiltinServices();
    if (builtins[serviceName]) {
      return callback(null, builtins[serviceName]);
    }
  } catch (err) {
    // continue to error
  }
  return callback(new Error(`Service '${serviceName}' not found in group '${gid}'`));
}

/**
 * @param {object} service
 * @param {string} configuration
 * @param {Callback} callback
 * @returns {void}
 */
function put(service, configuration, callback) {
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  if (service == null) {
    return callback(new Error('Service cannot be null or undefined'));
  }
  // val config (service name)
  if (typeof configuration !== 'string' || configuration === '') {
    return callback(new Error('Service name must be a non-empty string'));
  }

  // Store the service in the service table
  serviceTable[configuration] = service;
  // ret the name (eg routes.put(exampleService, "f", console.log) > f)
  return callback(null, configuration);
}

/**
 * @param {string} configuration
 * @param {Callback} callback
 */
function rem(configuration, callback) {
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  if (typeof configuration !== 'string' || configuration === '') {
    return callback(new Error('Service name must be a non-empty string'));
  }

  // check if exists
  if (!serviceTable[configuration]) {
    return callback(new Error(`Service '${configuration}' not found`));
  }
  const removedService = serviceTable[configuration];
  delete serviceTable[configuration];

  return callback(null, removedService);
}

module.exports = {get, put, rem};
