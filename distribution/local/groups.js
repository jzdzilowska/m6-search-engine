// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 * @typedef {import("../types.js").Node} Node
 */

const id = require('../util/id.js');

// maps group names -> { sid: nodeObj, sid: nodeObj, ... }
/** @type {Object.<string, Object.<string, Node>>} */
const groupTable = {};

// all should always exist and include the local node,
// but cant set it up at require-time since node.config might be not ready
function ensureAllGroup() {
  if (!groupTable['all']) {
    const node = globalThis.distribution?.node?.config;
    groupTable['all'] = {};
    if (node) {
      groupTable['all'][id.getSID(node)] = node;
    }
  }
}

/**
 * @param {string} name
 * @param {Callback} callback
 */
function get(name, callback) {
  callback = callback || function() {};
  ensureAllGroup();

  if (!groupTable[name]) {
    return callback(new Error(`Group '${name}' not found`));
  }
  return callback(null, {...groupTable[name]});
}

/**
 * @param {Config | string} config
 * @param {Object.<string, Node>} group
 * @param {Callback} callback
 */
function put(config, group, callback) {
  callback = callback || function() {};

  // config can be either a plain string name or an object like {gid: 'name', ...}
  let name;
  let fullConfig;

  if (typeof config === 'string') {
    name = config;
    fullConfig = {gid: name};
  } else if (typeof config === 'object' && config.gid) {
    name = config.gid;
    fullConfig = config;
  } else {
    return callback(new Error('Invalid config: must be a string or object with gid'));
  }

  groupTable[name] = {...group};

  // dynamically create distribution.<gid> with all the distributed services
  // so you can do distribution.browncs.status.get(...) etc.
  const {setup} = require('../all/all.js');
  globalThis.distribution[name] = setup(fullConfig);

  return callback(null, group);
}

/**
 * @param {string} name
 * @param {Callback} callback
 */
function del(name, callback) {
  callback = callback || function() {};

  if (!groupTable[name]) {
    return callback(new Error(`Group '${name}' not found`));
  }

  const group = {...groupTable[name]};
  delete groupTable[name];
  // also clean up the distribution.gid services object
  delete globalThis.distribution[name];

  return callback(null, group);
}

/**
 * @param {string} name
 * @param {Node} node
 * @param {Callback} callback
 */
function add(name, node, callback) {
  callback = callback || function() {};
  ensureAllGroup();

  if (!groupTable[name]) {
    return callback(new Error(`Group '${name}' not found`));
  }

  const sid = id.getSID(node);
  groupTable[name][sid] = node;

  return callback(null, {...groupTable[name]});
}

/**
 * @param {string} name
 * @param {string} sid
 * @param {Callback} callback
 */
function rem(name, sid, callback) {
  callback = callback || function() {};
  ensureAllGroup();

  if (!groupTable[name]) {
    return callback(new Error(`Group '${name}' not found`));
  }

  delete groupTable[name][sid];

  return callback(null, {...groupTable[name]});
}

module.exports = {get, put, del, add, rem};
