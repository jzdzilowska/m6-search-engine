const {urlKey} = require('./utils');
const crypto = require('crypto');

const BATCH_SIZE = 50;
const MAX_FRONTIER = 200000;

const STATE_KEY = '__crawler_state__';
const URL_LIST_KEY = '__crawled_urls__';

/**
 * Distributed crawler — fetching is distributed across workers.
 *
 * The coordinator manages the frontier, visited/queued sets, and persistence.
 * Each wave, it splits a batch of URLs round-robin across all workers in the
 * crawl group, sending them via RPC to the 'crawl-fetch' service registered
 * locally on each worker at boot time. Workers do the HTTP fetching, text
 * extraction, link extraction, and page storage. They return outlinks back
 * to the coordinator for deduplication and frontier management.
 */
function crawl(config, callback) {
  const distribution = globalThis.distribution;
  const maxPages = config.maxPages || 1000;
  const crawlGid = config.groupName || 'crawl';
  const batchSize = config.batchSize || BATCH_SIZE;

  let visitedHashes = new Set();
  let queuedHashes = new Set();
  let frontier = [];
  let totalCrawled = 0;
  let crawledUrlsBuf = [];
  let totalCrawledUrlsStored = 0;
  let workerNodes = [];

  for (const s of config.seeds) {
    const h = quickHash(s);
    queuedHashes.add(h);
    frontier.push(s);
  }

  function quickHash(url) {
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  }

  /* ---- get worker node list ---- */
  function getWorkers(cb) {
    distribution.local.groups.get(crawlGid, (e, group) => {
      if (e || !group) return cb(new Error('Cannot get crawl group'));
      workerNodes = Object.values(group);
      if (workerNodes.length === 0) return cb(new Error('No workers in crawl group'));
      console.log(`[crawler] ${workerNodes.length} worker(s) available for fetching`);
      cb(null);
    });
  }

  /* ---- resume from persisted state ---- */
  function loadState(cb) {
    distribution[crawlGid].store.get(STATE_KEY, (e, state) => {
      if (e || !state) {
        console.log('[crawler] No saved state, starting fresh');
        return cb();
      }
      console.log(
          `[crawler] Resuming: ${state.totalCrawled} pages crawled, ` +
          `${state.frontier.length} in frontier`,
      );
      visitedHashes = new Set(state.visitedHashes || []);
      queuedHashes = new Set(state.queuedHashes || []);
      frontier = state.frontier || [];
      totalCrawled = state.totalCrawled || 0;
      totalCrawledUrlsStored = state.totalCrawledUrlsStored || 0;
      cb();
    });
  }

  /* ---- persist state ---- */
  function saveState(cb) {
    const state = {
      visitedHashes: [...visitedHashes],
      queuedHashes: [...queuedHashes],
      frontier: frontier.slice(0, MAX_FRONTIER),
      totalCrawled,
      totalCrawledUrlsStored,
    };
    distribution[crawlGid].store.put(state, STATE_KEY, () => cb());
  }

  /* ---- flush crawled URL buffer to store ---- */
  function flushUrlBuffer(cb) {
    if (crawledUrlsBuf.length === 0) return cb();
    const chunk = crawledUrlsBuf.splice(0);
    const chunkKey = URL_LIST_KEY + ':' + totalCrawledUrlsStored;
    totalCrawledUrlsStored += chunk.length;
    distribution[crawlGid].store.put(chunk, chunkKey, () => cb());
  }

  /* ---- wave loop: distribute URLs to workers ---- */
  function runWave() {
    if (frontier.length === 0 || totalCrawled >= maxPages) {
      console.log(`[crawler] Complete. ${totalCrawled} pages crawled.`);
      return flushUrlBuffer(() => saveState(() => {
        loadCrawledUrls((urls) => callback(null, {totalCrawled, crawledUrls: urls}));
      }));
    }

    const remaining = maxPages - totalCrawled;
    const batch = [];
    while (batch.length < Math.min(batchSize, remaining) &&
           frontier.length > 0) {
      const url = frontier.shift();
      const h = quickHash(url);
      if (!visitedHashes.has(h)) {
        visitedHashes.add(h);
        batch.push(url);
      }
    }

    if (batch.length === 0) {
      if (frontier.length > 0) return setImmediate(runWave);
      console.log(`[crawler] Complete. ${totalCrawled} pages crawled.`);
      return flushUrlBuffer(() => saveState(() => {
        loadCrawledUrls((urls) => callback(null, {totalCrawled, crawledUrls: urls}));
      }));
    }

    if (totalCrawled % 100 === 0 || batch.length > 1) {
      console.log(
          `[crawler] Wave: ${batch.length} URLs → ${workerNodes.length} workers ` +
          `| crawled: ${totalCrawled} ` +
          `| frontier: ${frontier.length} ` +
          `| visited: ${visitedHashes.size}`,
      );
    }

    // Split batch round-robin across workers
    const workerBatches = workerNodes.map(() => []);
    batch.forEach((url, i) => {
      workerBatches[i % workerNodes.length].push(url);
    });

    let workersResponded = 0;
    const totalWorkersSent = workerBatches.filter((b) => b.length > 0).length;

    if (totalWorkersSent === 0) {
      return setImmediate(runWave);
    }

    // Collect all pages from all workers, then store from coordinator
    const allPages = [];

    workerBatches.forEach((subBatch, idx) => {
      if (subBatch.length === 0) return;

      const workerNode = workerNodes[idx];
      distribution.local.comm.send(
          [subBatch],
          {node: workerNode, service: 'crawl-fetch', method: 'fetchBatch'},
          (e, result) => {
            if (!e && result) {
              if (result.pages && result.pages.length > 0) {
                allPages.push(...result.pages);
              }
              if (result.outlinks && result.outlinks.length > 0) {
                for (const link of result.outlinks) {
                  const lh = quickHash(link);
                  if (!visitedHashes.has(lh) && !queuedHashes.has(lh)) {
                    queuedHashes.add(lh);
                    if (frontier.length < MAX_FRONTIER) frontier.push(link);
                  }
                }
              }
            } else if (e) {
              console.error(`[crawler] Worker ${workerNode.ip}:${workerNode.port} error:`, e.message || e);
            }

            if (++workersResponded === totalWorkersSent) {
              // All workers responded — now store pages from coordinator
              if (allPages.length === 0) {
                return setImmediate(runWave);
              }

              let stored = 0;
              allPages.forEach((content) => {
                crawledUrlsBuf.push(content.url);
                totalCrawled++;

                const pk = urlKey(content.url);
                distribution[crawlGid].store.put(content, pk, () => {
                  if (++stored === allPages.length) {
                    const shouldFlush = crawledUrlsBuf.length >= 200;
                    const next = () => {
                      if (totalCrawled % 500 === 0 && totalCrawled > 0) {
                        return saveState(() => setImmediate(runWave));
                      }
                      setImmediate(runWave);
                    };
                    if (shouldFlush) {
                      flushUrlBuffer(next);
                    } else {
                      next();
                    }
                  }
                });
              });
            }
          },
      );
    });
  }

  /* ---- reconstruct full URL list from stored chunks ---- */
  function loadCrawledUrls(cb) {
    const allUrls = [];
    let idx = 0;
    function loadNext() {
      const key = URL_LIST_KEY + ':' + idx;
      distribution[crawlGid].store.get(key, (e, chunk) => {
        if (e || !chunk || !Array.isArray(chunk)) return cb(allUrls);
        allUrls.push(...chunk);
        idx += chunk.length;
        loadNext();
      });
    }
    loadNext();
  }

  /* ---- start: get workers, load state, run ---- */
  getWorkers((e) => {
    if (e) return callback(e);
    loadState(() => runWave());
  });
}

module.exports = {crawl};
