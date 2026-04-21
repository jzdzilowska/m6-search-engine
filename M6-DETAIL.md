# M6: Distributed Search Engine - Complete Reference

## Table of Contents

1. [What is M6?](#what-is-m6)
2. [High-Level Architecture](#high-level-architecture)
3. [Deployment Model](#deployment-model)
4. [The Pipeline](#the-pipeline)
5. [Component Deep Dives](#component-deep-dives)
   - [run.js - Orchestrator](#runjs---orchestrator)
   - [crawler.js - Distributed Crawler](#crawlerjs---distributed-crawler)
   - [worker_crawl.js - Worker Fetch Service](#worker_crawljs---worker-fetch-service)
   - [indexer.js - MapReduce Inverted Index](#indexerjs---mapreduce-inverted-index)
   - [pagerank.js - Link Analysis](#pagerankjs---link-analysis)
   - [query.js - Search & Ranking](#queryjs---search--ranking)
   - [server.js - Web UI](#serverjs---web-ui)
   - [utils.js - Shared Utilities](#utilsjs---shared-utilities)
6. [The Distribution Layer](#the-distribution-layer)
7. [Data Flow (End to End)](#data-flow-end-to-end)
8. [Design Choices](#design-choices)
9. [Extra Credit Extensions](#extra-credit-extensions)
10. [Presentation Walkthrough](#presentation-walkthrough)

---

## What is M6?

M6 is the final milestone of Brown's CS1380 (Distributed Computer Systems). It integrates every previous milestone into a single product: a **fully distributed web search engine** deployed on AWS EC2.

The target corpus is **Project Gutenberg** (70,000+ free eBooks in HTML). The system crawls Gutenberg, indexes it using MapReduce, ranks pages with PageRank, and serves search results through a web UI.

---

## High-Level Architecture

```
                         +--------------------------+
                         |      COORDINATOR         |
                         |   (EC2 m7i-flex.large)   |
                         |                          |
                         |  run.js (orchestrator)   |
                         |  crawler.js (frontier)   |
                         |  indexer.js (MR driver)  |
                         |  pagerank.js (PR calc)   |
                         |  server.js (web UI)      |
                         |  query.js (search logic) |
                         +-----+-----+------+------+
                               |     |      |
                    RPC (HTTP) |     |      | RPC (HTTP)
                               |     |      |
              +----------------+     |      +----------------+
              |                      |                       |
     +--------v--------+   +--------v--------+   +----------v------+
     |    WORKER 1      |   |    WORKER 2      |   |    WORKER 3      |
     | (EC2 m7i-flex)   |   | (EC2 m7i-flex)   |   | (EC2 m7i-flex)   |
     |                  |   |                  |   |                  |
     | worker_crawl.js  |   | worker_crawl.js  |   | worker_crawl.js  |
     | local store      |   | local store      |   | local store      |
     | MR map/reduce    |   | MR map/reduce    |   | MR map/reduce    |
     +---------+--------+   +--------+---------+   +--------+---------+
               |                     |                       |
               +---------------------+-----------------------+
                         Sharded Distributed Store
                       (pages, index postings, state)
```

**Key ideas:**
- The **coordinator** drives the pipeline (crawl, index, pagerank, serve) and acts as the control plane.
- **Workers** do the heavy lifting: HTTP fetching, page storage, MapReduce computation.
- All inter-node communication uses JSON-over-HTTP RPC (the distribution framework's `comm.send`).
- Data is **sharded** across workers using consistent hashing (SHA-256 of the storage key, modulo number of nodes).

---

## Deployment Model

| Resource | Role | Address | Port |
|----------|------|---------|------|
| EC2 #1 | Coordinator | Private IP (e.g. 172.31.x.x) | 1234 (RPC), 3000 (web UI) |
| EC2 #2 | Worker 1 | Private IP | 7110 |
| EC2 #3 | Worker 2 | Private IP | 7110 |
| EC2 #4 | Worker 3 | Private IP | 7110 |

All instances are **m7i-flex.large** (2 vCPU, 8 GB RAM). They communicate over private IPs within the same VPC. The web UI is exposed on the coordinator's public IP, port 3000.

**Boot order:**
1. SSH into each worker, run: `node --max-old-space-size=6144 engine/run.js --role worker --ip <private-ip> --port 7110`
2. SSH into coordinator, run: `node --max-old-space-size=6144 engine/run.js --role coordinator --ip <coordinator-private-ip> --workers "w1:7110,w2:7110,w3:7110" --seeds "..." --maxPages 100000`

The coordinator polls each worker until it responds, then proceeds.

---

## The Pipeline

The coordinator runs these phases **sequentially**:

```
1. BOOT         Start node, poll workers until alive
2. REGISTER     Create "crawl" and "index" groups on all nodes
3. CRAWL        Wave-based BFS fetching (distributed across workers)
4. INDEX        MapReduce inverted index (distributed across workers)
5. PAGERANK     Iterative link analysis (coordinator-side, reads from store)
6. SERVE        Start HTTP server for search queries
```

Each phase must complete before the next begins. Flags allow skipping phases:
- `--skipCrawl` skips phase 3 (reuses stored pages)
- `--skipIndex` skips phases 4 and 5 (reuses stored index)
- `--clean` wipes all stored data before running

---

## Component Deep Dives

### run.js - Orchestrator

**File:** `engine/run.js` (367 lines)

This is the CLI entry point. Depending on `--role`, it either boots a worker or a coordinator.

**Worker mode** (`--role worker`):
1. Starts a distribution node on the given IP:port
2. Registers the `crawl-fetch` service locally (from `worker_crawl.js`)
3. Sits idle, waiting for RPC calls from the coordinator

**Coordinator mode** (`--role coordinator`):
1. Parses `--workers` into a list of `{ip, port}` objects
2. Starts its own distribution node on port 1234
3. Sequentially polls each worker via `status.get` RPC until all respond
4. Registers groups (`crawl`, `index`) both locally and on all remote workers
5. Runs the pipeline: crawl -> index -> pagerank -> serve

**Key helpers:**
- `waitForWorkers(dist, nodes, idx, cb)` - Recursive poller. Retries every 1s until a worker responds.
- `registerGroups(dist, names, group, idx, cb)` - Puts group config on local + remote.
- `loadCrawledUrlChunks(dist, gid, cb)` - Reconstructs the crawled URL list from chunked storage (used when `--skipCrawl`).

---

### crawler.js - Distributed Crawler

**File:** `engine/crawler.js` (233 lines)

Implements a **wave-based BFS** crawler. The coordinator maintains all state; workers only fetch.

**State (all in-memory on coordinator):**
- `frontier[]` - Queue of URLs to visit next
- `visitedHashes` (Set) - SHA-256 prefixes of already-fetched URLs
- `queuedHashes` (Set) - SHA-256 prefixes of URLs already in the frontier
- `totalCrawled` (int) - Count of pages crawled so far
- `crawledUrlsBuf[]` - Buffer of crawled URLs, flushed to store in chunks of 200

**Wave loop (one iteration):**
1. Pull up to `BATCH_SIZE` (30) unvisited URLs from the frontier
2. Split the batch **round-robin** across N workers
3. Send each sub-batch to its worker via RPC (`crawl-fetch.fetchBatch`)
4. Workers fetch HTML, extract text/links, return results to coordinator
5. Coordinator stores each page in the distributed store (`distribution[crawlGid].store.put`)
6. Outlinks are deduplicated and pushed onto the frontier
7. Every 500 pages, persist full state to the store (enables crash recovery)
8. Repeat until `maxPages` or frontier empty

**Crash recovery:**
- On startup, the crawler calls `loadState()` which reads `__crawler_state__` from the distributed store
- If found, it restores the frontier, visited/queued sets, and totalCrawled counter
- This means if the process dies at 56K pages, you can restart and it picks up from there

**URL deduplication:**
- Uses SHA-256 prefix (16 hex chars) of the URL
- `quickHash(url)` = first 16 chars of SHA-256
- Both visited and queued hashes are checked before adding to frontier

**Storage format:**
- Key: `SHA-256(url)` (full 64 hex chars, via `urlKey()`)
- Value: `{url, text, title, outlinks}`
- URL chunks: stored under keys `__crawled_urls__:0`, `__crawled_urls__:200`, etc.

---

### worker_crawl.js - Worker Fetch Service

**File:** `engine/worker_crawl.js` (147 lines)

Each worker registers this as a local RPC service called `crawl-fetch`. The coordinator calls `fetchBatch(urls)` on it.

**What it does for each URL:**
1. HTTP/HTTPS GET with 15s timeout, 2MB max body
2. Follows one redirect level
3. Extracts plain text via `html-to-text` library
4. Extracts `<title>` via regex
5. Extracts outlinks via regex on `<a href="...">` tags (up to 200 per page)
6. Resolves relative URLs to absolute
7. Returns `{pages: [...], outlinks: [...]}` to the coordinator

**Safety:**
- `BATCH_TIMEOUT` (20s): If all fetches haven't completed after 20s, return whatever we have
- Double-callback guard prevents crashes from concurrent error + timeout events
- Skips `javascript:`, `mailto:`, `#` links
- Body capped at 2MB, text capped at 30K chars

---

### indexer.js - MapReduce Inverted Index

**File:** `engine/indexer.js` (266 lines)

Builds a searchable inverted index from crawled pages using the distribution framework's MapReduce.

**Strategy:** Process pages in chunks of 50, stream results directly to the index store after each chunk. This avoids accumulating all results in coordinator memory.

**Mapper** (runs on each worker, once per page stored on that node):
1. Extract `value.text` from stored page JSON
2. Tokenize: strip non-alpha characters, lowercase, split on whitespace
3. Filter: remove words <= 1 char and ~130 hardcoded English stopwords
4. Stem: apply a full inline Porter stemmer (~70 lines)
5. Count term frequency (TF) for each stem
6. Emit: `[{term1: {url, tf}}, {term2: {url, tf}}, ...]`

**Why everything is inline:** Workers execute serialized functions in a clean context where `require` is unavailable. The entire Porter stemmer and stopword list must be embedded in the mapper function body.

**Reducer** (runs on workers, once per unique term after shuffle):
- Input: term + array of `{url, tf}` entries from all pages
- Output: `{term: {url1: tf1, url2: tf2, ...}}` (postings list)

**Post-MR storage (coordinator-side):**
- For each term in the results, read existing postings from the index store, merge new postings in, write back (handles cross-chunk term overlap)
- Done in batches of 200 to avoid overwhelming RPC
- Finally stores `__totalDocs__ = N` (needed for IDF at query time)

---

### pagerank.js - Link Analysis

**File:** `engine/pagerank.js` (142 lines)

Computes PageRank over the crawled link graph using the iterative power method. Runs on the coordinator (in-memory, reads from distributed store).

**Algorithm:**

```
Parameters:
  d = 0.85       (damping factor)
  N = total pages
  iterations = 10

Initialization:
  rank(page) = 1/N  for all pages

Each iteration:
  For each page P:
    If P has outlinks:
      contribute rank(P) / |outlinks(P)| to each outlink
    Else (dangling node):
      contribute rank(P) / N to ALL pages

  new_rank(P) = (1-d)/N + d * sum_of_contributions(P)
```

**Steps:**
1. Load the link graph from the distributed crawl store (batch of 50 pages at a time)
2. Filter outlinks to only include pages we actually crawled (no dead links)
3. Run `iterations` rounds of the power method
4. Store final ranks as `__pagerank__` in the index store: `{url: rank, ...}`

**Dangling nodes:** Pages with no outlinks distribute their rank equally to all pages (standard treatment).

---

### query.js - Search & Ranking

**File:** `engine/query.js` (212 lines)

Takes a text query, computes relevance scores, returns ranked results with snippets.

**Pipeline:**

```
User query: "ocean exploration"
  |
  v
Tokenize: ["ocean", "exploration"]
  |
  v
Stem: ["ocean", "explor"]
  |
  v
Deduplicate terms
  |
  v
Fetch __totalDocs__ (N) from index store
  |
  v
For each term, fetch postings from index store
  (e.g. "ocean" -> {url1: 5, url2: 2, url3: 8})
  |
  v
Score each URL:
  score(url) = SUM over terms of: tf * idf * prBoost
  where:
    idf = log(1 + N / (1 + df))
    prBoost = 1 + max(0, log(PageRank(url) * N))
  |
  v
Sort by score descending, take top 10-20
  |
  v
Fetch page text from crawl store for each result
  |
  v
Extract best snippet (sentence with most query term matches)
  |
  v
If many terms missed (not in index), run spell check
  |
  v
Return results with snippets + suggestions
```

**Scoring formula:**
```
score(url, query) = SUM_t [ tf(t, url) * log(1 + N/(1+df(t))) * (1 + max(0, log(PR(url)*N))) ]
```

Where:
- `tf(t, url)` = raw term frequency of term t in url's page
- `df(t)` = number of documents containing term t
- `PR(url)` = PageRank of url
- `N` = total number of indexed documents

**PageRank caching:** The full `__pagerank__` object is fetched once and cached in memory (`cachedPageRanks`) for subsequent queries.

---

### server.js - Web UI

**File:** `engine/server.js` (323 lines)

Minimal HTTP server with three routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Search form (centered, minimalist) |
| `/search?q=...` | GET | Execute query, render results |
| `/status` | GET | JSON debug endpoint |

**Design:** Black-and-white, Inter font, underline-only input, black button with inverted hover. Results show rank number, clickable title/URL, snippet with highlighted terms, TF-IDF score, and matched term tags.

**Features:**
- Query latency displayed next to result count
- Spell check suggestions ("Did you mean: ...?")
- Highlighted snippets (matched terms wrapped in `<mark>`)
- Status endpoint returns JSON with uptime, query count, doc count, worker count, memory usage

---

### utils.js - Shared Utilities

**File:** `engine/utils.js` (129 lines)

Four shared functions:

| Function | Purpose |
|----------|---------|
| `loadStopwords()` | Reads ~570 stopwords from file, caches in memory |
| `tokenize(text, stopwords)` | Strip non-alpha, lowercase, split, filter by length and stopwords |
| `stemWords(words)` | Apply Porter stemmer to each word |
| `urlKey(url)` | SHA-256 of URL as hex string (storage key) |

The Porter stemmer here is identical to the one inlined in the indexer mapper, ensuring query stems match index stems.

---

## The Distribution Layer

The engine code sits on top of a distribution framework (from earlier milestones). Key services:

| Service | What it does |
|---------|--------------|
| `comm.send(msg, target, cb)` | Send an RPC message to a specific node or broadcast to a group |
| `store.put(value, key, cb)` | Store a value at a key (sharded across group nodes by hash) |
| `store.get(key, cb)` | Retrieve a value by key (routed to the correct node) |
| `groups.put(config, group, cb)` | Register a named group of nodes |
| `mr.exec({keys, map, reduce}, cb)` | Execute a MapReduce job across the group |
| `status.get(cb)` / `status.stop(cb)` | Health check / shutdown a node |

**How sharding works:**
- `naiveHash(key)` maps a key to a numeric hash
- `hash % nodeCount` determines which node stores it
- `store.get` and `store.put` automatically route to the correct node

**How MapReduce works:**
1. Coordinator registers ephemeral services on all nodes
2. Each node runs the mapper on its locally-stored keys
3. Shuffle: each node hashes its map output keys and sends them to the responsible node
4. Each node runs the reducer on its shuffled data
5. Coordinator collects all reduce results
6. Cleanup: deregisters all ephemeral services

---

## Data Flow (End to End)

```
SEED URLs (e.g. https://www.gutenberg.org/ebooks/1)
       |
       | coordinator picks batch of 30
       v
+--[WAVE LOOP]--+
|               |
|  Split round-robin across 3 workers
|       |           |           |
|       v           v           v
|   Worker 1    Worker 2    Worker 3
|   fetch 10    fetch 10    fetch 10
|   URLs each   URLs each   URLs each
|       |           |           |
|       +-----+-----+-----+----+
|             |
|             v
|    Coordinator receives {pages, outlinks}
|             |
|    +--------+--------+
|    |                 |
|    v                 v
|  Store pages      Add new outlinks
|  in crawl store   to frontier
|  (sharded)        (deduplicated)
|    |
+----+ repeat until maxPages
       |
       v
  List of all crawled URLs (stored in chunks)
       |
       v
+--[INDEX PHASE]--+
|                 |
|  Pages split into chunks of 50
|  For each chunk:
|    MapReduce across crawl group
|      Map:    page -> [{term: {url, tf}}, ...]
|      Shuffle: group by term, route to owner node
|      Reduce: merge [{url, tf}] into {url: tf, ...}
|    Store postings in index group (merge with existing)
|                 |
+-----------------+
       |
       v
  Index store now has:
    __totalDocs__ = N
    "ocean" -> {url1: 5, url2: 2}
    "explor" -> {url1: 3, url5: 7}
    ...
       |
       v
+--[PAGERANK PHASE]--+
|                    |
|  Load link graph from crawl store
|  Run 10 iterations of power method
|  Store __pagerank__ in index store
|                    |
+--------------------+
       |
       v
+--[SERVE PHASE]--+
|                 |
|  Start HTTP server on :3000
|  GET /search?q=ocean
|    -> tokenize, stem
|    -> lookup postings
|    -> score with TF-IDF * PageRank boost
|    -> fetch snippets from crawl store
|    -> render HTML
|                 |
+-----------------+
```

---

## Design Choices

### 1. Coordinator-Managed Frontier (vs. Distributed Frontier)

We chose to keep the URL frontier **centralized** on the coordinator. Why?
- Deduplication is trivial (one Set, not distributed consensus)
- Round-robin dispatch gives even load distribution
- State persistence is a single JSON blob
- Trade-off: coordinator is a bottleneck if frontier grows huge (mitigated by MAX_FRONTIER = 200K cap)

### 2. Workers Fetch, Coordinator Stores

Workers do HTTP fetching and return raw pages to the coordinator, which then calls `distribution[gid].store.put`. Why not have workers store directly?
- Workers don't have the group properly registered in all cases
- Coordinator can guarantee consistent hashing since it has the group state
- Simpler error handling (coordinator retries if store fails)

### 3. Inline Porter Stemmer

The distribution framework serializes mapper/reducer functions and sends them to workers. Workers run them in a fresh context where `require()` is unavailable. Solution: embed the entire Porter stemmer (~70 lines) and stopword list (~130 words) directly in the mapper function body.

### 4. Chunked MapReduce

Rather than one giant MR job over all 56K+ pages, we split into chunks of 50. Why?
- Memory: accumulating all results on the coordinator would OOM
- Fault tolerance: if one chunk fails, we lose 50 pages not all of them
- Progress visibility: logs show chunk X/Y progress
- Cross-chunk terms are handled by read-merge-write on the index store

### 5. In-Memory PageRank (vs. Distributed Iterative MR)

PageRank runs entirely on the coordinator in memory rather than as distributed MapReduce. Why?
- The graph fits in RAM (56K URLs with outlinks ~ 100MB)
- Iterative MR would require 10 rounds of full scatter-gather (expensive RPC)
- Much simpler to debug
- Trade-off: won't scale to millions of pages (but fine for Gutenberg scale)

### 6. SHA-256 Storage Keys

Page URLs can contain special characters that break the filesystem-backed store. Solution: hash every URL with SHA-256 and use the hex digest as the storage key. Both crawler and indexer use `urlKey(url)` for consistency.

### 7. Wave-Based BFS (not DFS or random)

BFS ensures breadth coverage of the site before going deep. Waves provide natural batch boundaries for RPC calls and progress logging.

### 8. Crash Recovery via State Persistence

Every 500 pages, the crawler serializes its entire state (frontier, visited set, queued set, counters) to the distributed store. On restart, it loads this state and resumes from where it left off.

---

## Extra Credit Extensions

### 1. PageRank (Link Analysis)

Standard iterative power method with damping factor d=0.85, 10 iterations. Dangling nodes (pages with no outlinks) spread their rank uniformly. Final ranks boost query results via:

```
prBoost = 1 + max(0, log(PageRank(url) * N))
```

This means heavily-linked pages (catalog pages, popular books) rank higher when multiple results have similar TF-IDF.

### 2. Spell Check / Query Suggestions

When a query term has zero hits in the index and few total results are found:
1. Generate all 1-edit-distance variants (deletions, insertions, replacements, transpositions)
2. Check up to 30 candidates against the index store
3. Pick the candidate with the highest document frequency (must be >= 2 docs)
4. Return as a "Did you mean: X?" suggestion

### 3. Highlighted Snippets

Query terms are visually highlighted in result snippets:
- `query.js` inserts `\x00` / `\x01` markers around matched terms in the snippet text
- `server.js` escapes HTML first, then replaces the markers with `<mark>` / `</mark>` tags
- This two-pass approach avoids double-escaping or XSS issues

Snippet extraction finds the sentence with the most query term matches, capped at 250 characters.

### 4. Debug / Status Endpoint

`GET /status` returns a JSON object:
```json
{
  "uptime_seconds": 3421,
  "total_queries_served": 47,
  "indexed_documents": 56707,
  "worker_nodes": 3,
  "index_group": "index",
  "memory_mb": 412.3,
  "node_version": "v18.17.0"
}
```

---

## Presentation Walkthrough

Use this section as a script/guide for presenting M6. It walks through the architecture and demonstrates each component.

### Opening (30s)

"We built a distributed search engine that crawls Project Gutenberg, indexes 56,000+ pages across 4 EC2 instances, and serves ranked search results through a web UI. The system uses MapReduce for indexing, PageRank for link analysis, and TF-IDF for query scoring."

### Architecture Slide (2 min)

Walk through the 4-node setup:

1. **Coordinator** (port 1234 + 3000):
   - Drives the entire pipeline sequentially
   - Manages the crawl frontier (URL queue, deduplication)
   - Orchestrates MapReduce jobs
   - Computes PageRank
   - Serves the web UI

2. **Workers** (port 7110 each):
   - Register a `crawl-fetch` service at boot
   - Fetch HTML pages when asked by coordinator
   - Store data shards (pages and index postings)
   - Execute map/shuffle/reduce tasks during MapReduce

3. **Communication**:
   - All RPC is JSON over HTTP (framework's `comm.send`)
   - Groups define which nodes participate in which operations
   - Storage is sharded: SHA-256(key) mod N determines which worker holds the data

### Crawling (1.5 min)

"The crawler uses a wave-based BFS. Each wave, the coordinator pulls 30 URLs from the frontier, splits them round-robin across 3 workers. Workers fetch the HTML, extract plain text and links, and return them. The coordinator stores pages in the distributed store and adds new outlinks to the frontier."

Key points to mention:
- URL deduplication: SHA-256 prefix to avoid visiting the same page twice
- Crash recovery: state saved every 500 pages, resume on restart
- Throughput: ~18 pages/sec with 3 workers
- Target: 100K+ pages from Project Gutenberg

### Indexing (1.5 min)

"After crawling, we build an inverted index using MapReduce. Pages are processed in chunks of 50. The mapper tokenizes text, removes stopwords, applies Porter stemming, and counts term frequency. The reducer merges postings per term. Results are streamed to the index store chunk by chunk."

Key points:
- Mapper is 100% self-contained (inline stemmer + stopwords) because workers can't `require`
- Chunking prevents OOM on coordinator
- Cross-chunk merging via read-merge-write on the index store
- Final metadata: `__totalDocs__` stored for IDF calculation

### PageRank (1 min)

"We compute PageRank using the iterative power method. Load the link graph, initialize all ranks to 1/N, then iterate 10 times. Each iteration: pages distribute their rank to outlinks (or equally to all pages if dangling). Final ranks stored in the index store and used as a scoring boost at query time."

Formula:
```
new_rank(P) = (1-d)/N + d * SUM(rank(Q)/outlinks(Q)) for all Q linking to P
```

### Query & Ranking (1.5 min)

"When a user searches, we tokenize and stem the query, look up postings for each term, compute TF-IDF scores boosted by PageRank, and return the top results with snippets."

Scoring: `score = SUM[ tf * log(1 + N/(1+df)) * (1 + max(0, log(PR*N))) ]`

Breakdown:
- TF-IDF captures content relevance
- PageRank boost rewards structurally important pages
- Snippet extraction finds the sentence with the most query matches
- Spell check triggers when terms miss and results are sparse

### Web UI Demo (1 min)

Show:
1. The search form (clean, minimal design)
2. A search query with results showing titles, URLs, highlighted snippets, scores
3. A misspelled query triggering "Did you mean: ...?"
4. The `/status` endpoint JSON response

### Challenges & Lessons (1 min)

1. **No RPC timeout**: If a worker dies, the coordinator blocks forever. Mitigated with tmux and crash-resume, but a proper timeout remains future work.
2. **Function serialization**: Can't use `require` on workers. Had to inline the entire Porter stemmer.
3. **SSH fragility**: Long crawls on EC2 break when your IP changes. Always use tmux.
4. **Memory pressure**: 60K+ URL hashes in memory. Needed `--max-old-space-size=6144`.
5. **Security groups**: Switching networks changed our public IP, locking us out of all instances.

### Closing (30s)

"The system demonstrates a real distributed systems pipeline: distributed fetching, sharded storage, MapReduce computation, and a query layer that ties it all together. We implemented 4 extra credit features: PageRank, spell check, highlighted snippets, and a debug endpoint."

---

## File Summary

| File | Lines | Role |
|------|-------|------|
| `engine/run.js` | 367 | CLI entry point, pipeline orchestration |
| `engine/crawler.js` | 233 | Wave-based BFS, frontier management |
| `engine/worker_crawl.js` | 147 | HTTP fetching, text/link extraction |
| `engine/indexer.js` | 266 | MapReduce inverted index |
| `engine/pagerank.js` | 142 | Iterative PageRank computation |
| `engine/query.js` | 212 | TF-IDF + PageRank search |
| `engine/server.js` | 323 | Web UI + status endpoint |
| `engine/utils.js` | 129 | Shared stemmer, tokenizer, URL hasher |
| `distribution/all/mr.js` | 336 | MapReduce framework (scatter-gather) |
| `distribution/all/store.js` | 263 | Sharded key-value store |
| `distribution/all/comm.js` | 82 | Group RPC broadcast |

**Total engine code:** ~1,819 lines
**Total distribution code:** ~2,800 lines
**Grand total:** ~4,600 lines

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `html-to-text` | ^9.x | HTML to plaintext in crawler |
| `jsdom` | ^22.x | (legacy, replaced by regex extraction) |
| `yargs` | ^17.x | CLI argument parsing |

---

## Running Locally (Quick Start)

```bash
# Small test with the CS1380 sandbox (20 pages, 3 local workers)
node engine/run.js --role coordinator \
  --clean \
  --seeds "https://cs.brown.edu/courses/csci1380/sandbox/1/" \
  --maxPages 20

# Then open http://localhost:3000
```

## Running on AWS (Full Deployment)

```bash
# On each worker (3 separate EC2 instances):
tmux new -s worker
node --max-old-space-size=6144 engine/run.js --role worker --ip <private-ip> --port 7110

# On the coordinator:
tmux new -s coord
node --max-old-space-size=6144 engine/run.js --role coordinator \
  --ip <coordinator-private-ip> \
  --workers "172.31.x.x:7110,172.31.y.y:7110,172.31.z.z:7110" \
  --seeds "https://www.gutenberg.org/ebooks/1,https://www.gutenberg.org/ebooks/11,https://www.gutenberg.org/browse/scores/top" \
  --maxPages 100000 \
  --serverPort 3000
```
