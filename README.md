# distribution

This is the distribution library. 

## Environment Setup

We recommend using the prepared [container image](https://github.com/brown-cs1380/container).

## Installation

After you have setup your environment, you can start using the distribution library.
When loaded, distribution introduces functionality supporting the distributed execution of programs. To download it:

```sh
$ npm i '@brown-ds/distribution'
```

This command downloads and installs the distribution library.

## Testing

There are several categories of tests:
  *	Regular Tests (`*.test.js`)
  *	Scenario Tests (`*.scenario.js`)
  *	Extra Credit Tests (`*.extra.test.js`)
  * Student Tests (`*.student.test.js`) - inside `test/test-student`

### Running Tests

By default, all regular tests are run. Use the options below to run different sets of tests:

1. Run all regular tests (default): `$ npm test` or `$ npm test -- -t`
2. Run scenario tests: `$ npm test -- -c` 
3. Run extra credit tests: `$ npm test -- -ec`
4. Run the `non-distribution` tests: `$ npm test -- -nd`
5. Combine options: `$ npm test -- -c -ec -nd -t`

## Usage

To try out the distribution library inside an interactive Node.js session, run:

```sh
$ node
```

Then, load the distribution library:

```js
> let distribution = require("@brown-ds/distribution")();
> distribution.node.start(console.log);
```

Now you have access to the full distribution library. You can start off by serializing some values. 

```js
> s = distribution.util.serialize(1); // '{"type":"number","value":"1"}'
> n = distribution.util.deserialize(s); // 1
```

You can inspect information about the current node (for example its `sid`) by running:

```js
> distribution.local.status.get('sid', console.log); // null 8cf1b (null here is the error value; meaning there is no error)
```

You can also store and retrieve values from the local memory:

```js
> distribution.local.mem.put({name: 'nikos'}, 'key', console.log); // null {name: 'nikos'} (again, null is the error value) 
> distribution.local.mem.get('key', console.log); // null {name: 'nikos'}

> distribution.local.mem.get('wrong-key', console.log); // Error('Key not found') undefined
```

You can also spawn a new node:

```js
> node = { ip: '127.0.0.1', port: 8080 };
> distribution.local.status.spawn(node, console.log);
```

Using the `distribution.all` set of services will allow you to act 
on the full set of nodes created as if they were a single one.

```js
> distribution.all.status.get('sid', console.log); // {} { '8cf1b': '8cf1b', '8cf1c': '8cf1c' } (now, errors are per-node and form an object)
```

You can also send messages to other nodes:

```js
> distribution.local.comm.send(['sid'], {node: node, service: 'status', method: 'get'}, console.log); // null 8cf1c
```

Most methods in the distribution library are asynchronous and take a callback as their last argument.
This callback is invoked when the method completes, with the first argument being an error (if any) and the second argument being the result.
The following runs the sequence of commands described above inside a script (note the nested callbacks):

```js
let distribution = require("@brown-ds/distribution")();
// Now we're only doing a few of the things we did above
const out = (cb) => {
  distribution.local.status.stop(cb); // Shut down the local node
};
distribution.node.start(() => {
  // This will run only after the node has started
  const node = {ip: '127.0.0.1', port: 8765};
  distribution.local.status.spawn(node, (e, v) => {
    if (e) {
      return out(console.log);
    }
    // This will run only after the new node has been spawned
    distribution.all.status.get('sid', (e, v) => {
      // This will run only after we communicated with all nodes and got their sids
      console.log(v); // { '8cf1b': '8cf1b', '8cf1c': '8cf1c' }
      // Shut down the remote node
      distribution.local.comm.send([], {service: 'status', method: 'stop', node: node}, () => {
        // Finally, stop the local node
        out(console.log); // null, {ip: '127.0.0.1', port: 1380}
      });
    });
  });
});
```

# Results and Reflections

## M1: Serialization / Deserialization

### Summary
185 lines of code total. Key challenges included:

1. **Avoiding double-encoding in recursive structures**: Biggest problem I've encountered while working on my implementation. Initially, calling stringify at every recursion level caused exponential string growth for nested objects. Managed to solve this by separating serializeHelper (returns objects) from serialize (calls stringify once at the end).

2. **Handling special JS values**: NaN, infinity, etc. can't be directly represented in JSON. Solved by using string markers (e.g., `"NaN"`) and a wrapper that's type-tagged: `{type: ..., value: ...}`.

3. **Deserializing functions**: Haven't seen the eval function beforehand, so this was new. The main issue was that functions need to be reconstructed from their string representation, which this one  (`eval('(' + fnString + ')')`) solved.  Also, handles both arrow functions and regular function declarations. Learned why one must use paranthesis in this case, to force expression evaluation. Yay!

### Correctness & Performance Characterization

*Correctness*: 46 tests total (5 student tests + 5 scenarios + 36 provided tests); these take ~0.6 seconds to execute. This includes objects with nested structures, all primitive types (number, string, boolean, null, undefined, BigInt), special values (NaN, Infinity), complex objects (Date, Error, Array, Object), and functions.

*Performance*: Mentioned in the latency portion of package.json, same with dev machine specification. But: 

**Local Development (macOS, Apple M2):**
| Workload | Serialize (μs) | Deserialize (μs) | Total (μs) |
|----------|----------------|------------------|------------|
| Base Types (T2) | 3.46 | 7.18 | 10.64 |
| Functions (T3) | 1.73 | 4.67 | 6.40 |
| Complex Structures (T4) | 16.53 | 27.75 | 44.28 |

**AWS EC2 (Linux x64, Node v20.20.0):**
| Workload | Serialize (μs) | Deserialize (μs) | Total (μs) |
|----------|----------------|------------------|------------|
| Base Types (T2) | 7.34 | 12.42 | 19.76 |
| Functions (T3) | 4.79 | 9.21 | 14.00 |
| Complex Structures (T4) | 24.47 | 37.36 | 61.83 |


## M2#

## Summary
My implementation is based on 4 components, with appx 593 lines of code:
- `comm.js`: HTTP client for sending serialized messages to remote nodes
- `node.js`: HTTP server for handling incoming requests and routing them to services
- `status.js`: Service for node configuration and status information
- `routes.js`: Service registry for storing and retrieving services by name

Key challenges included:
1. **Callbacks**: Nesting callbacks for sequential operations quickly became messy and hard to debug. I dealt with this by being very consistent with the error-first callback pattern & breaking things into smaller helper functions where possible.
2. **Getting serialization right on both ends**: Messages need to be serialized before sending and deserialized when received, and it's easy to forget one side or double-serialize by accident. Took some trial and error to get `util.serialize`/`util.deserialize` working consistently between the client and server.
3. **Parsing the URL path correctly**: The server needs to extract the gid, service name, and method from paths like `/<gid>/<service>/<method>`. Edge cases like empty strings or missing parts caused some headaches until I've added proper validation.
4. **Handling network errors**: Connections can fail, time out, or return unexpected responses - had to make sure every error path actually called the callback with an error instead of silently failing or crashing.


## Correctness & Performance Characterization
*Correctness*: Wrote 5 tests in `m2.student.test.js`; cover status retrieval, routes registration/removal, and comm message sending.

*Performance*: Characterized using `test/m2.comm.benchmark.js` (1000 iterations per benchmark). Results are in `package.json`.

**Local development (macOS):**
- comm sequential (status.get nid): 6,311 req/s, 145 μs avg latency
- comm sequential (status.get sid): 9,909 req/s, 93 μs avg latency
- comm parallel: 14,250 req/s, 5.72 ms avg
- RPC sequential: ~673 req/s, ~1.46 ms avg 

**AWS EC2 (Ubuntu, Linux x64, Node v20.20.0):**
- comm sequential (status.get nid): 1,886 req/s, 475 μs avg latency
- comm sequential (status.get sid): 2,771 req/s, 320 μs avg latency
- comm parallel (c=100): 6,103 req/s, 13.09 ms avg
- RPC benchmark did not complete on this run (remote node failed to start within timeout).


## Key Feature
`createRPC` takes a function that exists on one machine and makes it callable from a different machine over the network. The caller doesn't need to know where the function actually runs, they just call it like any other function, and the result comes back. Under the hood, it wraps the original function in a way that, when called remotely, sends a message back to the original machine saying "run this function with these inputs." The original machine executes the function locally, then sends the result back over the network.

This is useful since it lets you distribute work across multiple machines while keeping the code simple. I.e., the caller just calls a function, and the networking details are handled automatically.

## M3: Node Groups & Gossip Protocols


### Summary
My implementation has 6 new software components, appx 250 added lines of code added since previous implementation. Key challenges included:

1. **Getting group-specific services to work**: Each group needs its own version of comm, status, routes, etc. that knows which group it belongs to. Wiring up `local.groups.put` to dynamically create `distribution[gid]` with the right services took a while to get right, lots of back and forth between the groups service and the setup function in `all/all.js`.

2. **Fan-out and collecting responses**: When sending a message to all nodes in a group, you have to wait for everyone to respond before calling the callback. I kept track of how many responses came back and stored errors/values in maps keyed by node SID. Easy to mess up the counting.

3. **Adding group IDs to the routing path**: The URL format changed from `/<service>/<method>` to `/<gid>/<service>/<method>`, which meant updating comm, routes, and node.js together (based on EdStem post num 158). So, `routes.get` now handles both the old string format and the new `{service, gid}` object format.

### Correctness & Performance Characterization
*Correctness*: Wrote 5 student tests for local.groups CRUD, distributed comm fan-out, routes config formats, and distributed status aggregation. The provided tests cover multi-node setups for all.comm, all.status, all.groups, and all.routes.

*Performance*: Measured `status.spawn` latency over 5 sequential spawns. Local (Docker, Node v20): avg 97.99 ms, 10.21 spawns/s. AWS EC2 (Ubuntu, Node v20): avg 146.49 ms, 6.83 spawns/s.

### Key Feature
Gossip protocols are about scaling. If every node sends messages to every other node, that's O(n) messages per update, i.e., doesn't scale. With gossip, each node picks a random handful of neighbors (e.g., log(n) of them) and shares the update. Those neighbors do the same, and eventually everyone gets the message. It's not instant and not guaranteed, but for things like health checks or membership changes, that's fine. The payoff is that you can scale to thousands of nodes without drowning in network traffic.

## M5: Distributed Execution Engine

### Summary
My implementation comprises 1 new software component (`distribution/all/mr.js`); ~250 added lines of code over prev implementation. Key challenges:

1. **Coordinating async phases across nodes**: The orchestrator must wait for all nodes to finish each phase (map, shuffle, reduce) before moving on. Solved by registering a coordinator notification service locally and tracking per-phase completion counts—each node calls `notify` on the coordinator after finishing, and the coordinator triggers the next phase when all nodes report in.

2. **Serializing functions across nodes**: The mapper and reducer functions need to run on remote worker nodes. Rather than relying on `this` binding (may not survive serialization), the coordinator passes the mapper/reducer as arguments when triggering each phase via `comm.send`, letting the framework's serializer handle function transfer.

3. **Shuffle correctness—grouping values by key on the right node**: During shuffle, each node hashes its map output keys via `naiveHash` to determine which node is responsible for reducing that key, then sends the value there via `mem.append`. Getting the hash targets to agree across all nodes required using the same group lookup and hash function consistently.

### Correctness & Performance Characterization

*Correctness*: I wrote 5 student tests (min temperature, word frequency, string matching, inverted index, character frequency) and 4 scenario workflows (ncdc max temp, dlib word frequency, TF-IDF, string matching). Together with 3 graded tests (ncdc, avgwrdl, cfreq), all 12 pass.

*Performance*: My word-frequency workflow (5 documents, 3 nodes, 10 iterations) can sustain ~111.56 docs/second, with an average latency of 44.82 ms per MapReduce run (min 37.35 ms, max 64.74 ms). Measured on local macOS, Apple M2, 16 GB RAM.

### Key Feature
The scatter-gather orchestrator dynamically registers ephemeral services (`mr-<id>`) on all group nodes and sequences the map → shuffle → reduce pipeline via a coordinator notification protocol. Each phase runs in parallel across all nodes; the coordinator only advances to the next phase after all nodes have confirmed completion. Cleanup deregisters all ephemeral services at the end.
