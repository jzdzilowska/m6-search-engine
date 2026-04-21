const {urlKey} = require('./utils');

/**
 * Compute PageRank over the crawled link graph using iterative MapReduce.
 *
 * Each iteration:
 *   Map:    for each page, emit rank/numOutlinks to each outlink,
 *           plus emit the page's outlink list (to preserve graph structure)
 *   Reduce: sum incoming rank contributions, apply damping formula
 *
 * After convergence, store final ranks in the index group store under
 * key '__pagerank__' = {url: rank, ...}
 *
 * @param {object}   config
 * @param {string[]} config.crawledUrls
 * @param {string}   [config.crawlGroupName]
 * @param {string}   [config.indexGroupName]
 * @param {number}   [config.iterations] - default 10
 * @param {Function} callback - (err, {iterations, pageCount})
 */
function computePageRank(config, callback) {
  const distribution = globalThis.distribution;
  const crawlGid = config.crawlGroupName || 'crawl';
  const indexGid = config.indexGroupName || 'index';
  const iterations = config.iterations || 10;
  const crawledUrls = config.crawledUrls || [];

  if (crawledUrls.length === 0) {
    return callback(new Error('No crawled URLs for PageRank'));
  }

  const N = crawledUrls.length;
  const pageKeys = crawledUrls.map(urlKey);
  const damping = 0.85;
  const baseRank = (1 - damping) / N;

  console.log(`[pagerank] Computing PageRank over ${N} pages, ${iterations} iterations`);

  // Step 1: Build the link graph from crawled pages
  const crawledSet = new Set(crawledUrls);
  const graph = {}; // url -> {outlinks: [...], rank: 1/N}

  // Load pages in batches to avoid overwhelming the store
  const LOAD_BATCH = 50;
  let loadIdx = 0;

  function loadBatch() {
    if (loadIdx >= crawledUrls.length) {
      console.log(`[pagerank] Graph loaded: ${Object.keys(graph).length} pages`);
      return runIterations(0);
    }

    const end = Math.min(loadIdx + LOAD_BATCH, crawledUrls.length);
    let pending = end - loadIdx;

    for (let i = loadIdx; i < end; i++) {
      const pageUrl = crawledUrls[i];
      const key = pageKeys[i];
      distribution[crawlGid].store.get(key, (e, page) => {
        if (!e && page) {
          const outlinks = (page.outlinks || []).filter((link) =>
            crawledSet.has(link),
          );
          graph[pageUrl] = {outlinks, rank: 1 / N};
        } else {
          graph[pageUrl] = {outlinks: [], rank: 1 / N};
        }

        if (--pending === 0) {
          loadIdx = end;
          setImmediate(loadBatch);
        }
      });
    }
  }

  loadBatch();

  // Step 2: Iterative PageRank computation (in-memory on coordinator)
  function runIterations(iter) {
    if (iter >= iterations) {
      return storeRanks();
    }

    const newRanks = {};
    for (const url of crawledUrls) {
      newRanks[url] = baseRank;
    }

    // Distribute rank from each page to its outlinks
    for (const [url, data] of Object.entries(graph)) {
      const {outlinks, rank} = data;
      if (outlinks.length === 0) {
        // Dangling node: distribute rank equally to all pages
        const share = rank / N;
        for (const u of crawledUrls) {
          newRanks[u] += damping * share;
        }
      } else {
        const share = rank / outlinks.length;
        for (const link of outlinks) {
          if (newRanks[link] !== undefined) {
            newRanks[link] += damping * share;
          }
        }
      }
    }

    // Update ranks
    for (const url of crawledUrls) {
      graph[url].rank = newRanks[url];
    }

    if (iter % 3 === 0 || iter === iterations - 1) {
      const ranks = crawledUrls.map((u) => graph[u].rank);
      const max = Math.max(...ranks);
      const min = Math.min(...ranks);
      console.log(`[pagerank] Iteration ${iter + 1}/${iterations} - min=${min.toFixed(6)} max=${max.toFixed(6)}`);
    }

    setImmediate(() => runIterations(iter + 1));
  }

  // Step 3: Store final ranks in the index store
  function storeRanks() {
    const ranks = {};
    for (const [url, data] of Object.entries(graph)) {
      ranks[url] = data.rank;
    }

    distribution[indexGid].store.put(ranks, '__pagerank__', (e) => {
      if (e) {
        console.error('[pagerank] Failed to store ranks:', e);
        return callback(e);
      }
      console.log(`[pagerank] Complete. Stored ranks for ${Object.keys(ranks).length} pages.`);
      callback(null, {iterations, pageCount: Object.keys(ranks).length});
    });
  }
}

module.exports = {computePageRank};
