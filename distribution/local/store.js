// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 *
 * @typedef {Object} StoreConfig
 * @property {?string} key
 * @property {?string} gid
 *
 * @typedef {StoreConfig | string | null} SimpleConfig
 */

const id = require('../util/id.js');
const fs = require('fs');
const path = require('path');
const storeRoot = path.join(__dirname, '..', '..', 'store'); // all persistent data lives here

/**
- Use absolute paths to make sure they are agnostic to where your code is running from!
  Use the `path` module for that.
*/

/**
 * @param {SimpleConfig} configuration
 * @returns {{key: string | null, gid: string | null}}
 */
function parseConfig(configuration) {
  // can be a string, null, or {key, gid}, just normalize it
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

function getDir(gid) {
  // path is store/<nid>/<gid> so different nodes and groups dont clobber each other
  const nid = id.getNID(globalThis.distribution.node.config);
  const ns = gid || 'local';
  return path.join(storeRoot, nid, ns);
}

function safeFilename(key) {
  // strip anything thats not alphanumeric so we dont break the filesystem
  return key.replace(/[^a-zA-Z0-9]/g, '');
}

function getFilePath(key, gid) {
  const dir = getDir(gid);
  return path.join(dir, safeFilename(key));
}

/**
 * @param {any} state
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function put(state, configuration, callback) {
  let {key, gid} = parseConfig(configuration);
  if (key === null) key = id.getID(state); // no key, hash the value itself

  try {
    const dir = getDir(gid);
    fs.mkdirSync(dir, {recursive: true}); // make sure the directory exists first

    const filepath = path.join(dir, safeFilename(key));
    const serialize = globalThis.distribution.util.serialize;
    const data = serialize(state); // serialize before writing so we can store any js object
    fs.writeFileSync(filepath, data);
    return callback(null, state);
  } catch (e) {
    return callback(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function get(configuration, callback) {
  const {key, gid} = parseConfig(configuration);

  if (key === null) {
    // no key means return all keys, just list the filenames in the dir
    try {
      const dir = getDir(gid);
      if (!fs.existsSync(dir)) {
        return callback(null, []);
      }
      const files = fs.readdirSync(dir);
      return callback(null, files);
    } catch (e) {
      return callback(e instanceof Error ? e : new Error(String(e)));
    }
  }

  try {
    const filepath = getFilePath(key, gid);
    if (!fs.existsSync(filepath)) {
      return callback(new Error(`Key '${key}' not found in store`));
    }
    const deserialize = globalThis.distribution.util.deserialize;
    const data = fs.readFileSync(filepath, 'utf8'); // read the raw string
    const value = deserialize(data); // turn it back into a js object
    return callback(null, value);
  } catch (e) {
    return callback(e instanceof Error ? e : new Error(String(e)));
  }
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

  try {
    const filepath = getFilePath(key, gid);
    if (!fs.existsSync(filepath)) {
      return callback(new Error(`Key '${key}' not found in store`));
    }
    const deserialize = globalThis.distribution.util.deserialize;
    const data = fs.readFileSync(filepath, 'utf8');
    const value = deserialize(data); // read value before deleting so we can return it
    fs.unlinkSync(filepath); // actually remove from disk
    return callback(null, value);
  } catch (e) {
    return callback(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * @param {any} state
 * @param {SimpleConfig} configuration
 * @param {Callback} callback
 */
function append(state, configuration, callback) {
  // append pushes onto an array instead of overwriting, if the key
  // doesnt exist yet we just start a new array
  let {key, gid} = parseConfig(configuration);
  if (key === null) key = id.getID(state);

  try {
    const dir = getDir(gid);
    fs.mkdirSync(dir, {recursive: true});
    const filepath = path.join(dir, safeFilename(key));
    const serialize = globalThis.distribution.util.serialize;
    const deserialize = globalThis.distribution.util.deserialize;

    let existing;
    if (fs.existsSync(filepath)) {
      existing = deserialize(fs.readFileSync(filepath, 'utf8'));
      if (Array.isArray(existing)) {
        existing.push(state); 
      } else {
        existing = [existing, state]; 
      }
    } else {
      existing = [state]; // first entry
    }

    fs.writeFileSync(filepath, serialize(existing));
    return callback(null, existing);
  } catch (e) {
    return callback(e instanceof Error ? e : new Error(String(e)));
  }
}

module.exports = {put, get, del, append};
