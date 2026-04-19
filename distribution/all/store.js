// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Config} Config
 * @typedef {import("../types.js").Hasher} Hasher
 * @typedef {import("../types.js").Node} Node
 */


/**
 * @typedef {Object} StoreConfig
 * @property {string | null} key
 * @property {string} gid
 *
 * @typedef {StoreConfig | string | null} SimpleConfig
 */


/**
 * @param {Config} config
 */
function store(config) {
  // each store instance scoped to a group and uses a specific hash function
  const context = {
    gid: config.gid || 'all',
    hash: config.hash || globalThis.distribution.util.id.naiveHash,
    subset: config.subset,
  };

  const id = globalThis.distribution.util.id;

  /**
   * @param {SimpleConfig} configuration
   * @returns {{key: string | null, gid: string}}
   */
  function parseConfig(configuration) {
    // normalize the config, could be a string key, null, or {key, gid} obj
    if (configuration === null || configuration === undefined) {
      return {key: null, gid: context.gid};
    }
    if (typeof configuration === 'string') {
      return {key: configuration, gid: context.gid};
    }
    return {
      key: configuration.key !== undefined ? configuration.key : null,
      gid: configuration.gid || context.gid,
    };
  }

  function resolveNode(kid, callback) {
    // hash the kid against the groups nids to find which node owns this key
    globalThis.distribution.local.groups.get(context.gid, (e, group) => {
      if (e) return callback(e);
      const nodes = Object.values(group);
      const nids = nodes.map((n) => id.getNID(n));
      const targetNid = context.hash(kid, nids);
      const targetNode = nodes.find((n) => id.getNID(n) === targetNid);
      if (!targetNode) {
        return callback(new Error('Could not resolve target node'));
      }
      callback(null, targetNode);
    });
  }

  /**
   * @param {SimpleConfig} configuration
   * @param {Callback} callback
   */
  function get(configuration, callback) {
    const {key, gid} = parseConfig(configuration);

    if (key === null) {
      // null key = fan out to every node and collect all stored keys for this group
      globalThis.distribution.local.groups.get(context.gid, (e, group) => {
        if (e) return callback(e);
        const nodes = Object.values(group);
        let pending = nodes.length;
        const allKeys = [];
        /** @type {Object.<string, Error>} */
        const errors = {};

        if (pending === 0) return callback(errors, allKeys);

        nodes.forEach((node) => {
          const remote = {node, service: 'store', method: 'get'};
          const message = [{key: null, gid}];
          globalThis.distribution.local.comm.send(message, remote, (e, v) => {
            if (e) {
              errors[id.getSID(node)] = e;
            }
            if (v && Array.isArray(v)) {
              allKeys.push(...v);
            }
            if (--pending === 0) {
              callback(errors, allKeys);
            }
          });
        });
      });
      return;
    }

    // single key: hash it, find the responsible node n fetch from its local store
    const kid = id.getID(key);
    resolveNode(kid, (e, targetNode) => {
      if (e) return callback(e);
      const remote = {node: targetNode, service: 'store', method: 'get'};
      const message = [{key, gid}];
      globalThis.distribution.local.comm.send(message, remote, callback);
    });
  }

  /**
   * @param {any} state
   * @param {SimpleConfig} configuration
   * @param {Callback} callback
   */
  function put(state, configuration, callback) {
    let {key, gid} = parseConfig(configuration);
    if (key === null) key = id.getID(state); // auto-generate key from sha256 of value

    // hash key -> resolve node -> write to that node's local store, passing gid for namespace isolation
    const kid = id.getID(key);
    resolveNode(kid, (e, targetNode) => {
      if (e) return callback(e);
      const remote = {node: targetNode, service: 'store', method: 'put'};
      const message = [state, {key, gid}];
      globalThis.distribution.local.comm.send(message, remote, callback);
    });
  }

  /**
   * @param {any} state
   * @param {SimpleConfig} configuration
   * @param {Callback} callback
   */
  function append(state, configuration, callback) {
    // same as put but appends to an array, used by MapReduce shuffle
    let {key, gid} = parseConfig(configuration);
    if (key === null) key = id.getID(state);

    const kid = id.getID(key);
    resolveNode(kid, (e, targetNode) => {
      if (e) return callback(e);
      const remote = {node: targetNode, service: 'store', method: 'append'};
      const message = [state, {key, gid}];
      globalThis.distribution.local.comm.send(message, remote, callback);
    });
  }

  /**
   * @param {SimpleConfig} configuration
   * @param {Callback} callback
   */
  function del(configuration, callback) {
    // specific key n no mass-delete support
    const {key, gid} = parseConfig(configuration);
    if (key === null) {
      return callback(new Error('Key is required for del'));
    }

    const kid = id.getID(key);
    resolveNode(kid, (e, targetNode) => {
      if (e) return callback(e);
      const remote = {node: targetNode, service: 'store', method: 'del'};
      const message = [{key, gid}];
      globalThis.distribution.local.comm.send(message, remote, callback);
    });
  }

  /**
   * @param {Object.<string, Node>} configuration - the old group state
   * @param {Callback} callback
   */
  function reconf(configuration, callback) {
    // basically same thing as mem reconf but for persistent store
    // takes the old group n figures out what needs to move
    const oldGroup = configuration;
    const oldNodes = Object.values(oldGroup);
    const oldNids = oldNodes.map((n) => id.getNID(n));
    const gid = context.gid;

    // gotta ask the OLD nodes for keys, not current group
    // cuz removed nodes might still have stuff on them
    let pending = oldNodes.length;
    const allKeys = [];

    if (pending === 0) return callback(null, null);

    oldNodes.forEach((node) => {
      const remote = {node, service: 'store', method: 'get'};
      globalThis.distribution.local.comm.send([{key: null, gid}], remote, (e, v) => {
        if (v && Array.isArray(v)) {
          allKeys.push(...v);
        }
        if (--pending === 0) {
          doRelocate(allKeys);
        }
      });
    });

    function doRelocate(keys) {
      if (keys.length === 0) return callback(null, null);

      // get the new group (already updated by whoever called reconf)
      globalThis.distribution.local.groups.get(gid, (e, newGroup) => {
        if (e) return callback(e);
        const newNodes = Object.values(newGroup);
        const newNids = newNodes.map((n) => id.getNID(n));

        // hash each key w old nids n new nids, see if it changed
        const toRelocate = [];
        for (const key of keys) {
          const kid = id.getID(key);
          const oldNid = context.hash(kid, oldNids);
          const newNid = context.hash(kid, newNids);
          if (oldNid !== newNid) {
            const oldNode = oldNodes.find((n) => id.getNID(n) === oldNid);
            const newNode = newNodes.find((n) => id.getNID(n) === newNid);
            if (oldNode && newNode) {
              toRelocate.push({key, oldNode, newNode});
            }
          }
        }

        if (toRelocate.length === 0) return callback(null, null);

        let remaining = toRelocate.length;

        // for every key thats in the wrong place now
        // grab it from old node, delete it, n put it on the new one
        toRelocate.forEach(({key, oldNode, newNode}) => {
          const getRemote = {node: oldNode, service: 'store', method: 'get'};
          globalThis.distribution.local.comm.send(
              [{key, gid}], getRemote, (e, value) => {
                if (e) {
                  if (--remaining === 0) callback(null, null);
                  return;
                }
                const delRemote = {node: oldNode, service: 'store', method: 'del'};
                globalThis.distribution.local.comm.send(
                    [{key, gid}], delRemote, (e2, v2) => {
                      const putRemote = {
                        node: newNode, service: 'store', method: 'put',
                      };
                      globalThis.distribution.local.comm.send(
                          [value, {key, gid}], putRemote, (e3, v3) => {
                            if (--remaining === 0) callback(null, null);
                          });
                    });
              });
        });
      });
    }
  }

  /* For the distributed store service, the configuration will
          always be a string */
  return {get, put, append, del, reconf};
}

module.exports = store;
