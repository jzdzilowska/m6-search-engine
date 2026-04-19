// @ts-check
/**
 * @typedef {import("../types.js").Node} Node
 * @typedef {import("../types.js").Callback} Callback
 */
const http = require('node:http');
const url = require('node:url');
const log = require('../util/log.js');

const yargs = require('yargs/yargs');

/**
 * @returns {Node}
 */
function setNodeConfig() {
  const args = yargs(process.argv)
      .help(false)
      .version(false)
      .parse();

  let maybeIp; let maybePort; let maybeOnStart;
  if (typeof args.ip === 'string') {
    maybeIp = args.ip;
  }
  if (typeof args.port === 'string' || typeof args.port === 'number') {
    maybePort = parseInt(String(args.port), 10);
  }

  if (args.help === true || args.h === true) {
    console.log('Node usage:');
    console.log('  --ip <ip address>      The ip address to bind the node to');
    console.log('  --port <port>          The port to bind the node to');
    console.log('  --config <config>      The serialized config string');
    process.exit(0);
  }

  if (typeof args.config === 'string') {
    let config = undefined;
    try {
      config = (globalThis.__libDeserialize || globalThis.distribution.util.deserialize)(args.config);
    } catch (error) {
      try {
        config = JSON.parse(args.config);
      } catch {
        console.error('Cannot deserialize config string: ' + args.config);
        process.exit(1);
      }
    }

    if (typeof config?.ip === 'string') {
      maybeIp = config?.ip;
    }
    if (typeof config?.port === 'number') {
      maybePort = config?.port;
    }
    if (typeof config?.onStart === 'function') {
      maybeOnStart = config?.onStart;
    }
  }

  // Default values for config
  maybeIp = maybeIp ?? '127.0.0.1';
  maybePort = maybePort ?? 1234;

  return {
    ip: maybeIp,
    port: maybePort,
    onStart: maybeOnStart,
  };
}
/*
    The start function will be called to start your node.
    It will take a callback as an argument.
    After your node has booted, you should call the callback.
*/


/**
 * @param {(err?: Error | null) => void} callback
 * @returns {void}
 */
function start(callback) {
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  const server = http.createServer((req, res) => {
    /* Your server will be listening for PUT requests. */
    const serialize = globalThis.distribution?.util?.serialize;
    const deserialize = globalThis.distribution?.util?.deserialize;

    const sendResponse = (error, value) => {
      try {
        const response = serialize([error, value]);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(response);
      } catch (err) {
        // fallback
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Internal server error: failed to serialize response');
      }
    };

    if (typeof serialize !== 'function' || typeof deserialize !== 'function') {
      res.writeHead(500, {'Content-Type': 'text/plain'});
      res.end('Internal server error: serialization utilities not available');
      return;
    }
    // only accept PUT requests
    if (req.method !== 'PUT') {
      try {
        const errorResponse = serialize(new Error('Only PUT requests are supported'));
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(errorResponse);
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('Only PUT requests are supported');
      }
      return;
    }

    /*
      The path of the http request will determine the service to be used.
      url will have the form: http://node_ip:node_port/<gid>/<service>/<method>
    */
    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';

    // path: /<gid>/<service>/<method> or legacy /<service>/<method>
    const pathParts = pathname.split('/').filter((part) => part !== '');

    let gid; let serviceName; let methodName;
    if (pathParts.length >= 3) {
      [gid, serviceName, methodName] = pathParts;
    } else if (pathParts.length === 2) {
      // backwards-compatible with M2 path format: /<service>/<method>
      gid = 'local';
      [serviceName, methodName] = pathParts;
    } else {
      return sendResponse(new Error('Invalid path format. Expected /<gid>/<service>/<method>'), null);
    }

    /*
      A common pattern in handling HTTP requests in Node.js is to have a
      subroutine that collects all the data chunks belonging to the same
      request. These chunks are aggregated into a body variable.

      When the req.on('end') event is emitted, it signifies that all data from
      the request has been received. Typically, this data is in the form of a
      string. To work with this data in a structured format, it is often parsed
      into a JSON object using JSON.parse(body), provided the data is in JSON
      format.

      Our nodes expect data in JSON format.
    */

    /** @type {any[]} */
    const body = [];

    req.on('data', (chunk) => {
      body.push(chunk);
    });
    req.on('error', (err) => {
      sendResponse(new Error(`Request error: ${err.message}`), null);
    });

    req.on('end', () => {
      // increment message count safely
      try {
        const status = globalThis.distribution?.local?.status;
        if (status && typeof status.incrementCount === 'function') {
          status.incrementCount();
        }
      } catch (err) {
        // errors in incrementing count
      }

      /*
        Here, you can handle the service requests.
        Use the local routes service to get the service you need to call.
        You need to call the service with the method and arguments provided in the request.
        Then, you need to serialize the result and send it back to the caller.
      */

      // parsing request body (serialized message/arguments)
      const bodyString = Buffer.concat(body).toString();
      let args = [];
      if (bodyString) {
        try {
          args = deserialize(bodyString);
        } catch (err) {
          return sendResponse(new Error(`Failed to deserialize request body: ${err.message}`), null);
        }
      }
      if (!Array.isArray(args)) {
        args = [];
      }

      // routes service to get the requested service
      const routes = globalThis.distribution?.local?.routes;
      if (!routes || typeof routes.get !== 'function') {
        return sendResponse(new Error('Routes service not available'), null);
      }
      routes.get({service: serviceName, gid: gid}, (routeError, service) => {
        if (routeError) {
          return sendResponse(routeError, null);
        }
        if (!service) {
          return sendResponse(new Error(`Service '${serviceName}' not found`), null);
        }
        if (typeof service[methodName] !== 'function') { // method exists on service?
          return sendResponse(new Error(`Method '${methodName}' not found on service '${serviceName}'`), null);
        }
        try {
          service[methodName](...args, (error, value) => {
            sendResponse(error, value);
          });
        } catch (err) {
          sendResponse(err instanceof Error ? err : new Error(String(err)), null);
        }
      });
    });
  });

  /*
    Your server will be listening on the port and ip specified in the config
    You'll be calling the `callback` callback when your server has successfully
    started.

    At some point, we'll be adding the ability to stop a node
    remotely through the service interface.
  */

  // Important: allow tests to access server
  globalThis.distribution.node.server = server;
  const config = globalThis.distribution.node.config;

  server.once('listening', () => {
    callback(null);
  });

  server.once('error', (error) => {
    callback(error);
  });

  server.listen(config.port, config.ip);
}

module.exports = {start, config: setNodeConfig()};
