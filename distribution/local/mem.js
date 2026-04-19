// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 *
 * @typedef {Object} StoreConfig
 * @property {string | null} key
 * @property {string | null} gid
 *
 * @typedef {StoreConfig | string | null} SimpleConfig
 */

const id = require('../util/id.js');

/** @type {Object.<string, Object.<string, any>>} */
const store = {};

/**
 * @param {SimpleConfig} configuration
 * @returns {{key: string | null, gid: string | null}}
 */
function parseConfig(configuration) {
  if (configuration === null || configuration === undefined) {
    return {key: null, gid: null};
  }
  if (typeof configuration === 'string') {
    return {key: configuration, gid: null};
  }
  return {
    key: configuration.key !== undefined ? configuration.key : null,
    gid: configuration.gid || null,
  };
}

/**
 * @param {any} state
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function put(state, configuration, callback) {
  let {key, gid} = parseConfig(configuration);
  if (key === null) key = id.getID(state);
  const ns = gid || 'local';
  if (!store[ns]) store[ns] = {};
  store[ns][key] = state;
  return callback(null, state);
}

/**
 * @param {any} state
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function append(state, configuration, callback) {
  let {key, gid} = parseConfig(configuration);
  if (key === null) key = id.getID(state);
  const ns = gid || 'local';
  if (!store[ns]) store[ns] = {};
  if (key in store[ns]) {
    if (Array.isArray(store[ns][key])) {
      store[ns][key].push(state);
    } else {
      store[ns][key] = [store[ns][key], state];
    }
  } else {
    store[ns][key] = [state];
  }
  return callback(null, store[ns][key]);
}

/**
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function get(configuration, callback) {
  const {key, gid} = parseConfig(configuration);

  if (key === null) {
    const allKeys = [];
    if (gid) {
      if (store[gid]) allKeys.push(...Object.keys(store[gid]));
    } else {
      for (const ns of Object.values(store)) {
        allKeys.push(...Object.keys(ns));
      }
    }
    return callback(null, allKeys);
  }

  const ns = gid || 'local';
  if (!store[ns] || !(key in store[ns])) {
    return callback(new Error(`Key '${key}' not found in mem`));
  }
  return callback(null, store[ns][key]);
}

/**
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function del(configuration, callback) {
  const {key, gid} = parseConfig(configuration);

  if (key === null) {
    return callback(new Error('Key is required for del'));
  }

  const ns = gid || 'local';
  if (!store[ns] || !(key in store[ns])) {
    return callback(new Error(`Key '${key}' not found in mem`));
  }

  const value = store[ns][key];
  delete store[ns][key];
  return callback(null, value);
}

module.exports = {put, get, del, append};
