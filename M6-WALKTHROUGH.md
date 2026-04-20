# M6: Distributed Search Engine — Implementation Walkthrough

## Overview

Six files in `engine/` implement a distributed search engine. The pipeline is **crawl → index → serve**, orchestrated by a single CLI entry point.

```
engine/
  run.js      — CLI orchestrator (boots nodes, runs pipeline)
  crawler.js  — wave-based web crawler
  indexer.js  — MapReduce inverted index builder
  query.js    — TF-IDF search over distributed index
  server.js   — web UI (search form + ranked results)
  utils.js    — shared Porter stemmer, tokenizer, URL hasher
```

**To run:**

```bash
node engine/run.js --clean --seeds "https://cs.brown.edu/courses/csci1380/sandbox/1/" --maxPages 20
```

Then open `http://localhost:3000`.

---

## run.js — Orchestrator

Entry point. Parses CLI args, boots the distributed system, runs the pipeline.

**Boot sequence:**

1. Initialize the distribution framework (coordinator on port 1234)
2. Spawn N worker nodes (default 3, ports 7110–7112) via `distribution.local.status.spawn()`
3. Register two groups — `crawl` and `index` — each containing all worker nodes
4. Execute phases sequentially: crawl → index → serve

**CLI options:**

| Flag | Default | Purpose |
|------|---------|---------|
| `--seeds` | CS1380 sandbox URLs | Comma-separated seed URLs |
| `--maxPages` | 100 | Stop crawling after N pages |
| `--nodes` | 3 | Number of worker nodes |
| `--basePort` | 7110 | Starting port for workers |
| `--serverPort` | 3000 | Web UI port |
| `--clean` | false | Wipe stored data before running |
| `--skipCrawl` | false | Skip crawl phase, reuse stored pages |
| `--skipIndex` | false | Skip index phase, reuse stored index |

Ctrl-C triggers graceful shutdown: sends stop commands to all workers, then exits.

---

## crawler.js — Wave-Based Distributed Crawler

Fetches web pages in batches, extracts text and links, stores results in the distributed store. New outlinks feed back into the frontier for subsequent waves.

**Wave loop (each iteration):**

1. Pull a batch (default 10) of unvisited URLs from the frontier
2. Fetch all URLs in parallel using Node.js `http`/`https`
3. For each successful fetch:
   - Extract plain text from HTML via `html-to-text`
   - Extract `<title>` via regex
   - Extract outlinks via `jsdom` DOM parsing (filters out `#`, `javascript:`, `mailto:`)
   - Resolve relative URLs to absolute
4. Store each page as JSON in `distribution.crawl.store`:
   ```json
   {
     "url": "https://example.com/page",
     "text": "extracted plain text...",
     "title": "Page Title",
     "outlinks": ["https://example.com/other"]
   }
   ```
   Storage key = SHA-256 hash of the URL (avoids collisions from the framework's filename sanitizer)
5. Push new outlinks onto the frontier (skip already-visited/queued URLs)
6. Repeat until `maxPages` reached or frontier empty

**Safeguards:**

- 15-second timeout per request
- 5MB max body size
- Double-callback guard prevents crashes from concurrent error + timeout
- Follows one redirect level
- Logs every fetch result (bytes received, errors, timeouts)

---

## indexer.js — MapReduce Inverted Index Builder

Takes the crawled pages and builds a searchable inverted index using a single MapReduce job over the `crawl` group store.

**Input:** List of crawled URLs → hashed to storage keys → passed to `distribution.crawl.mr.exec()`.

### Mapper (runs on each worker, once per locally-stored page)

1. Extracts `value.text` from the stored page JSON
2. Tokenizes: strips non-alpha, lowercases, splits on whitespace
3. Filters out words ≤1 character and stopwords (hardcoded inline set of ~130 common English words)
4. Stems each word using an inline Porter stemmer (~70 lines implemented directly in the function body)
5. Counts term frequency (TF) for each stem
6. Emits `[{term: {url, tf}}, ...]` for every unique stem in the page

**Why everything is inline:** Worker processes execute serialized functions in a context where `require` is undefined. No npm packages can be imported. The Porter stemmer and stopword list are implemented entirely within the mapper function body.

### Reducer (runs on each worker, once per unique term)

- Receives all `{url, tf}` entries for a single term across all pages
- Merges into a postings object: `{url1: tf1, url2: tf2, ...}`

### Post-MR storage

After MapReduce completes, the coordinator stores results in `distribution.index.store`:

1. `__totalDocs__` → total number of crawled pages (needed for IDF at query time)
2. Each term's postings list (stored in batches of 50):
   - Key: the stemmed term (e.g., `"ocean"`)
   - Value: `{"https://page1.com": 5, "https://page2.com": 2}`

---

## query.js — Search & Ranking

Receives a text query, looks up terms in the distributed index, computes TF-IDF scores, returns ranked results.

**Pipeline:**

1. Tokenize the query (same logic as indexer: strip non-alpha, lowercase, remove stopwords)
2. Stem each token using the same Porter stemmer from `utils.js`
3. Deduplicate query terms
4. Look up `__totalDocs__` (= N) from `distribution.index.store`
5. For each stemmed query term, call `distribution.index.store.get(term)` to retrieve its postings
6. Score each URL:
   ```
   score(url) = Σ tf(term, url) × log(1 + N / (1 + df))
   ```
   where `df` = number of documents containing the term
7. Sort by score descending, return top 20
8. Each result includes per-term breakdown (matched terms, their TF and IDF values)

---

## server.js — Web UI

HTTP server with two routes:

- `GET /` — centered search form
- `GET /search?q=...` — calls `query.js`, renders ranked results

Minimal black-and-white design: Inter font, underline-only input, black button with inverted hover. Results page shows rank number, clickable URL, TF-IDF score, and matched term tags.

---

## utils.js — Shared Utilities

Four functions used by the indexer and query engine:

- **`porterStem(word)`** — Full Porter stemmer algorithm. Identical logic is duplicated inside the indexer mapper because workers can't require this file. Both produce the same stems so queries match the index.
- **`tokenize(text, stopwords)`** — Strips non-alpha, lowercases, splits, filters by length and stopwords.
- **`loadStopwords()`** — Reads `non-distribution/d/stopwords.txt` into a Set. Cached after first load.
- **`urlKey(url)`** — `SHA-256(url)` as hex. Used as storage key for crawled pages.

---

## Data Flow

```
Seeds (URLs)
    │
    ▼
  CRAWLER (coordinator)
  fetch pages → extract text + links → store
    │
    │  distribution.crawl.store.put(pageJSON, sha256(url))
    ▼
  CRAWL GROUP STORE (sharded across 3 workers)
    │
    │  distribution.crawl.mr.exec({map, reduce})
    ▼
  INDEXER (MapReduce)
  Map:     page → [{term: {url, tf}}, ...]
  Shuffle: group by term across workers
  Reduce:  merge postings per term
    │
    │  distribution.index.store.put(postings, term)
    ▼
  INDEX GROUP STORE (sharded across 3 workers)
  + __totalDocs__ metadata
    │
    │  distribution.index.store.get(term)
    ▼
  QUERY ENGINE
  tokenize → stem → lookup → TF-IDF score → rank
    │
    ▼
  WEB UI (localhost:3000)
  search form → ranked results page
```

---

## Dependencies Added

| Package | Purpose |
|---------|---------|
| `jsdom` | DOM parsing for link extraction in crawler |
| `html-to-text` | HTML → plaintext conversion in crawler |
| `yargs` | CLI argument parsing in run.js |
| `natural` | Originally for Porter stemmer — now unused, replaced by inline implementation |

---

## Known Limitations

1. **Stopword mismatch** — The mapper uses ~130 inline stopwords. The query engine reads ~570 stopwords from file. Some indexed terms are unsearchable because they pass the mapper's filter but get blocked at query time.

2. **No crawl persistence** — Frontier and visited set are in-memory only. If the process dies mid-crawl, that state is lost (stored pages survive, but you can't resume where you left off).

3. **Coordinator-bottlenecked crawling** — All HTTP fetching happens on the coordinator process, not distributed across workers. Workers only handle storage and MapReduce computation.

4. **`--clean` clears wrong directory** — Wipes `store/` in the project root, but actual data lives in `node_modules/@brown-ds/distribution/store/`.
