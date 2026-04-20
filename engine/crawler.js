const {urlKey} = require('./utils');
const http = require('http');
const https = require('https');
const {convert} = require('html-to-text');
const {URL} = require('url');

const BATCH_SIZE = 5;
const FETCH_TIMEOUT = 15000;
const MAX_BODY = 2 * 1024 * 1024; // 2 MB cap per page
const MAX_TEXT = 30000; // truncate extracted text
const MAX_FRONTIER = 200000; // cap frontier to avoid unbounded growth

const STATE_KEY = '__crawler_state__';
const URL_LIST_KEY = '__crawled_urls__';

/**
 * Distributed crawler with persistence and bounded memory.
 *
 * Memory-critical design decisions:
 *   - visited/queued are stored as a Set of SHA-256 hashes (32 hex chars each)
 *     instead of full URLs, cutting memory ~3-5x.
 *   - crawledUrls are flushed to the distributed store in batches, not held in
 *     a growing coordinator-side array.
 *   - JSDOM is NOT used for link extraction (it allocates a full DOM tree per
 *     page). A regex-based extractor is used instead.
 *   - Frontier is capped at MAX_FRONTIER entries.
 *   - Batch size is kept small to limit concurrent HTML bodies in memory.
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
  let crawledUrlsBuf = []; // small buffer, flushed to store periodically
  let totalCrawledUrlsStored = 0;

  // Seed the initial frontier
  for (const s of config.seeds) {
    const h = quickHash(s);
    queuedHashes.add(h);
    frontier.push(s);
  }

  /* ---- deterministic short hash for set membership ---- */
  function quickHash(url) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
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

  /* ---- persist lightweight state (hashes, not full URLs) ---- */
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

  /* ---- flush crawled URL buffer to distributed store ---- */
  function flushUrlBuffer(cb) {
    if (crawledUrlsBuf.length === 0) return cb();
    const chunk = crawledUrlsBuf.splice(0);
    const chunkKey = URL_LIST_KEY + ':' + totalCrawledUrlsStored;
    totalCrawledUrlsStored += chunk.length;
    distribution[crawlGid].store.put(chunk, chunkKey, () => cb());
  }

  /* ---- fetch a single URL ---- */
  function fetchPage(pageUrl, cb) {
    let called = false;
    const done = (err, body) => {
      if (called) return;
      called = true;
      cb(err, body);
    };

    const mod = pageUrl.startsWith('https') ? https : http;
    const opts = {
      timeout: FETCH_TIMEOUT,
      headers: {'User-Agent': 'CS1380-SearchBot/1.0'},
      rejectUnauthorized: false,
    };

    let req;
    try {
      req = mod.get(pageUrl, opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 &&
            res.headers.location) {
          const next = new URL(res.headers.location, pageUrl).href;
          res.resume();
          return fetchPage(next, cb);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return done(null, null);
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY) {
            res.destroy();
            body = body.substring(0, MAX_BODY);
          }
        });
        res.on('end', () => done(null, body));
        res.on('error', () => done(null, null));
      });
    } catch (err) {
      return done(null, null);
    }
    req.on('error', () => done(null, null));
    req.on('timeout', () => { req.destroy(); done(null, null); });
  }

  /* ---- extract text + links WITHOUT JSDOM (regex-based) ---- */
  function processPage(url, html) {
    let text = '';
    try { text = convert(html, {wordwrap: false}); } catch (e) { /* */ }

    let title = url;
    try {
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m) title = m[1].trim();
    } catch (e) { /* */ }

    const outlinks = [];
    const seen = new Set();
    let base = url;
    if (base.endsWith('index.html')) base = base.slice(0, -'index.html'.length);

    const hrefRe = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = hrefRe.exec(html)) !== null) {
      try {
        const href = match[1];
        if (!href || href.startsWith('#') || href.startsWith('javascript:') ||
            href.startsWith('mailto:')) continue;
        const abs = new URL(href, base).href;
        if ((abs.startsWith('http://') || abs.startsWith('https://')) &&
            !seen.has(abs)) {
          seen.add(abs);
          outlinks.push(abs);
          if (outlinks.length >= 200) break;
        }
      } catch (e) { /* invalid URL */ }
    }

    return {
      url,
      text: text.substring(0, MAX_TEXT),
      title: title.substring(0, 500),
      outlinks,
    };
  }

  /* ---- wave loop ---- */
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
      if (!visitedHashes.has(h)) batch.push(url);
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
          `[crawler] Wave: ${batch.length} URLs ` +
          `| crawled: ${totalCrawled} ` +
          `| frontier: ${frontier.length} ` +
          `| visited: ${visitedHashes.size}`,
      );
    }

    let done = 0;
    const pageResults = [];

    batch.forEach((url) => {
      const h = quickHash(url);
      visitedHashes.add(h);

      fetchPage(url, (e, html) => {
        if (html && html.length > 50) {
          const content = processPage(url, html);
          pageResults.push(content);
        }

        if (++done < batch.length) return;

        if (pageResults.length === 0) {
          return saveState(() => setImmediate(runWave));
        }

        let stored = 0;
        pageResults.forEach((content) => {
          crawledUrlsBuf.push(content.url);
          totalCrawled++;

          content.outlinks.forEach((link) => {
            const lh = quickHash(link);
            if (!visitedHashes.has(lh) && !queuedHashes.has(lh)) {
              queuedHashes.add(lh);
              if (frontier.length < MAX_FRONTIER) frontier.push(link);
            }
          });

          const pk = urlKey(content.url);
          distribution[crawlGid].store.put(content, pk, () => {
            if (++stored === pageResults.length) {
              const shouldFlush = crawledUrlsBuf.length >= 200;
              const next = () => {
                // Periodic save every 500 pages
                if (totalCrawled % 500 === 0) {
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
      });
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

  loadState(() => runWave());
}

module.exports = {crawl};
