const {urlKey} = require('./utils');
const http = require('http');
const https = require('https');
const {convert} = require('html-to-text');
const {JSDOM} = require('jsdom');
const {URL} = require('url');

const BATCH_SIZE = 10;
const FETCH_TIMEOUT = 15000;
const MAX_BODY = 5 * 1024 * 1024; // 5 MB

const STATE_KEY = '__crawler_state__';

/**
 * Distributed crawler with persistence.
 *
 * The coordinator fetches pages in parallel batches, extracts text + links,
 * and stores results in the distributed crawl store (sharded across workers).
 * Frontier and visited set are persisted after each wave so the crawler can
 * stop and resume from where it left off.
 */
function crawl(config, callback) {
  const distribution = globalThis.distribution;
  const maxPages = config.maxPages || 1000;
  const crawlGid = config.groupName || 'crawl';
  const batchSize = config.batchSize || BATCH_SIZE;

  let visited = new Set();
  let queued = new Set(config.seeds);
  let frontier = [...config.seeds];
  let totalCrawled = 0;
  let crawledUrls = [];

  /* ---- try to resume from persisted state ---- */
  function loadState(cb) {
    distribution[crawlGid].store.get(STATE_KEY, (e, state) => {
      if (e || !state) {
        console.log('[crawler] No saved state found, starting fresh');
        return cb();
      }
      console.log(`[crawler] Resuming: ${state.totalCrawled} pages already crawled, ${state.frontier.length} URLs in frontier`);
      visited = new Set(state.visited || []);
      queued = new Set(state.queued || []);
      frontier = state.frontier || [];
      totalCrawled = state.totalCrawled || 0;
      crawledUrls = state.crawledUrls || [];
      cb();
    });
  }

  /* ---- persist state after each wave ---- */
  function saveState(cb) {
    const state = {
      visited: [...visited],
      queued: [...queued],
      frontier,
      totalCrawled,
      crawledUrls,
    };
    distribution[crawlGid].store.put(state, STATE_KEY, () => cb());
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
          console.log(`[crawler]   redirect ${res.statusCode} → ${next}`);
          res.resume();
          return fetchPage(next, cb);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.log(`[crawler]   ${pageUrl} → HTTP ${res.statusCode}`);
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
        res.on('end', () => {
          // console.log(`[crawler]   ${pageUrl} → ${body.length} bytes`);
          done(null, body);
        });
        res.on('error', (err) => {
          console.error(`[crawler]   response error ${pageUrl}: ${err.message}`);
          done(null, null);
        });
      });
    } catch (err) {
      console.error(`[crawler]   exception fetching ${pageUrl}: ${err.message}`);
      return done(null, null);
    }
    req.on('error', (err) => {
      console.error(`[crawler]   request error ${pageUrl}: ${err.message}`);
      done(null, null);
    });
    req.on('timeout', () => {
      console.error(`[crawler]   timeout ${pageUrl}`);
      req.destroy();
      done(null, null);
    });
  }

  /* ---- process raw HTML into structured content ---- */
  function processPage(url, html) {
    let text = '';
    try { text = convert(html, {wordwrap: false}); } catch (e) { /* */ }

    let title = url;
    try {
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m) title = m[1].trim();
    } catch (e) { /* */ }

    const outlinks = [];
    try {
      const dom = new JSDOM(html);
      let base = url;
      if (base.endsWith('index.html')) {
        base = base.slice(0, -'index.html'.length);
      }
      dom.window.document.querySelectorAll('a[href]').forEach((a) => {
        try {
          const href = a.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:') ||
              href.startsWith('mailto:')) return;
          const abs = new URL(href, base).href;
          if (abs.startsWith('http://') || abs.startsWith('https://')) {
            outlinks.push(abs);
          }
        } catch (e) { /* */ }
      });
    } catch (e) { /* */ }

    return {
      url,
      text: text.substring(0, 50000),
      title: title.substring(0, 500),
      outlinks: [...new Set(outlinks)].slice(0, 500),
    };
  }

  /* ---- wave loop ---- */
  function runWave() {
    if (frontier.length === 0 || totalCrawled >= maxPages) {
      console.log(`[crawler] Complete. ${totalCrawled} pages crawled.`);
      return saveState(() => callback(null, {totalCrawled, crawledUrls}));
    }

    const remaining = maxPages - totalCrawled;
    const batch = [];
    while (batch.length < Math.min(batchSize, remaining) &&
           frontier.length > 0) {
      const url = frontier.shift();
      if (!visited.has(url)) batch.push(url);
    }

    if (batch.length === 0) {
      if (frontier.length > 0) return setImmediate(runWave);
      console.log(`[crawler] Complete. ${totalCrawled} pages crawled.`);
      return saveState(() => callback(null, {totalCrawled, crawledUrls}));
    }

    console.log(
        `[crawler] Wave: ${batch.length} URLs ` +
        `| crawled so far: ${totalCrawled} ` +
        `| frontier: ${frontier.length}`,
    );

    let done = 0;
    const pageResults = [];

    batch.forEach((url) => {
      visited.add(url);

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
          crawledUrls.push(content.url);
          totalCrawled++;

          content.outlinks.forEach((link) => {
            if (!visited.has(link) && !queued.has(link)) {
              queued.add(link);
              frontier.push(link);
            }
          });

          const pk = urlKey(content.url);
          distribution[crawlGid].store.put(content, pk, () => {
            if (++stored === pageResults.length) {
              saveState(() => setImmediate(runWave));
            }
          });
        });
      });
    });
  }

  loadState(() => runWave());
}

module.exports = {crawl};