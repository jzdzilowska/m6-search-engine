// @ts-check
/**
 * @typedef {import("../types.js").Callback} Callback
 * @typedef {import("../types.js").Node} Node
 */

const http = require('node:http');

/**
 * @typedef {Object} Target
 * @property {string} service
 * @property {string} method
 * @property {Node} node
 * @property {string} [gid]
 */

/**
 * @param {Array<any>} message
 * @param {Target} remote
 * @param {(error: Error | null, value?: any) => void} callback
 * @returns {void}
 */
function send(message, remote, callback) {
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  if (!remote) {
    return callback(new Error('Remote configuration is required'));
  }
  if (!remote.node) {
    return callback(new Error('Remote node is required'));
  }
  if (!remote.node.ip) {
    return callback(new Error('Remote node IP is required'));
  }
  if (!remote.node.port) {
    return callback(new Error('Remote node port is required'));
  }
  if (!remote.service || typeof remote.service !== 'string' || remote.service === '') {
    return callback(new Error('Remote service is required'));
  }
  if (!remote.method || typeof remote.method !== 'string' || remote.method === '') {
    return callback(new Error('Remote method is required'));
  }

  // message must be an array
  if (message !== undefined && message !== null && !Array.isArray(message)) {
    return callback(new Error('Message must be an array'));
  }

  const serialize = globalThis.distribution?.util?.serialize;
  const deserialize = globalThis.distribution?.util?.deserialize;

  if (typeof serialize !== 'function' || typeof deserialize !== 'function') {
    return callback(new Error('Serialization utilities not available'));
  }

  // build the path: /<gid>/<service>/<method>
  // default to 'local' if not specified
  const gid = remote.gid || 'local';
  const path = `/${gid}/${remote.service}/${remote.method}`; // stack overflow

  let serializedMessage;
  try {
    serializedMessage = serialize(message);
  } catch (err) {
    return callback(new Error(`Failed to serialize message: ${err.message}`));
  }
  const options = {
    hostname: remote.node.ip,
    port: remote.node.port,
    path: path,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serializedMessage),
    },
  };

  // create, send HTTP request
  const req = http.request(options, (res) => {
    const chunks = [];

    res.on('data', (chunk) => {
      chunks.push(chunk);
    });
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString();

      let response; // ----------- //
      try {
        response = deserialize(body);
      } catch (err) {
        return callback(new Error(`Failed to deserialize response: ${err.message}`));
      }

      // server responds w [error, value]
      // if resp is an array of [error, value], extract them
      if (Array.isArray(response) && response.length === 2) {
        const [error, value] = response;
        if (error) {
          return callback(error, null);
        }
        return callback(null, value);
      }
      // if resp is an error directly (from non-PUT request eg)
      if (response instanceof Error) {
        return callback(response, null);
      }
      // return the response as the val
      return callback(null, response);
    });
  });

  // network errors, connection refused... 
  req.on('error', (err) => {
    return callback(new Error(`Network error: ${err.message}`));
  });

  req.on('timeout', () => {
    req.destroy();
    return callback(new Error('Request timed out'));
  });
  req.write(serializedMessage);
  req.end();
}

module.exports = {send};
