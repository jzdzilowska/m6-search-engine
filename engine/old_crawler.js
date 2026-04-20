const {urlKey} = require('./utils');
const http = require('http');
const https = require('https');
const {URL} = require('url');

const BATCH_SIZE = 1000;
const FETCH_TIMEOUT = 2500;// 1 second
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

  /* Restrict crawl to seed domains */
  // AWS cant access foreign wikipedia pages so limit to english ones?
  const seedDomains = new Set();
  for (const s of config.seeds) {
    try { seedDomains.add(new URL(s).hostname); } catch (e) { /* */ }
  }

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
          // console.log(`[crawler]   redirect ${res.statusCode} → ${next}`);
          res.resume();
          return fetchPage(next, cb);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          // console.log(`[crawler]   ${pageUrl} → HTTP ${res.statusCode}`);
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
      console.error(`[crawler]   request error ${pageUrl}: ${err.code || err.message || err}`);
      done(null, null);
    });
    req.on('timeout', () => {
      console.error(`[crawler]   timeout ${pageUrl}`);
      req.destroy();
      done(null, null);
    });
  }

  /* ---- MR mapper: parse raw HTML on worker nodes ---- */
  /* Self-contained (no require) — serialised and sent to workers.
     Extracts text, title, and outlinks from raw HTML via regex.
     Emits:
       { '__page__:<urlHash>': JSON content }   — processed page
       { <outlink>: '1' }                       — each discovered link
     Shuffle distributes outlinks deterministically by URL hash. */
  const crawlMapper = (key, value) => {
    if (!value || !value.html) return [];
    const url = value.url || '';
    const html = value.html;

    // Strip scripts/styles then tags → plain text
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[#\w]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Extract <title>
    let title = url;
    try {
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tm) title = tm[1].trim();
    } catch (e) { /* */ }

    // Extract outlinks via regex (no JSDOM — workers can't require)
    const linkRe = /<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi;
    const outlinks = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1].trim();
      if (href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
      try {
        let base = url;
        if (base.endsWith('index.html')) {
          base = base.slice(0, -'index.html'.length);
        }
        const abs = new URL(href, base).href;
        if (abs.startsWith('http://') || abs.startsWith('https://')) {
          outlinks.push(abs);
        }
      } catch (e) { /* */ }
    }

    const uniqueLinks = [...new Set(outlinks)].slice(0, 500);
    const results = [];

    // Emit processed page content (special prefix key)
    results.push({
      ['__page__:' + key]: JSON.stringify({
        url,
        text: text.substring(0, 50000),
        title: (title || '').substring(0, 500),
        outlinks: uniqueLinks,
      }),
    });

    // Emit each outlink — shuffle hashes these to nodes for dedup
    for (const link of uniqueLinks) {
      results.push({[link]: '1'});
    }

    return results;
  };

  /* ---- MR reducer: dedup outlinks, pass through content ---- */
  const crawlReducer = (key, values) => {
    return {[key]: values[0]};
  };

  /* ---- wave loop (fetch → store raw HTML → MR → update frontier) ---- */
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

    /* Phase 1 — fetch raw HTML on coordinator (parallel within batch) */
    let fetchDone = 0;
    const fetchedPages = [];

    batch.forEach((url) => {
      visited.add(url);

      fetchPage(url, (e, html) => {
        if (html && html.length > 50) {
          fetchedPages.push({url, html});
        }

        if (++fetchDone < batch.length) return;

        if (fetchedPages.length === 0) {
          return saveState(() => setImmediate(runWave));
        }

        /* Phase 2 — store raw HTML in distributed store (sharded) */
        console.log(
            `[crawler] Storing ${fetchedPages.length} pages for MR`,
        );
        const batchKeys = [];
        let storeDone = 0;

        fetchedPages.forEach(({url, html}) => {
          const pk = urlKey(url);
          batchKeys.push(pk);
          distribution[crawlGid].store.put({url, html}, pk, () => {
            if (++storeDone === fetchedPages.length) {
              runCrawlMR(batchKeys);
            }
          });
        });
      });
    });

    /* Phase 3 — MR: map extracts content + outlinks, shuffle distributes,
       reduce deduplicates */
    function runCrawlMR(keys) {
      console.log(`[crawler] MR map: ${keys.length} pages`);

      distribution[crawlGid].mr.exec(
          {keys, map: crawlMapper, reduce: crawlReducer},
          (e, results) => {
            if (e) {
              console.error('[crawler] MR failed:', e);
              return saveState(() => setImmediate(runWave));
            }

            /* Separate content entries from outlinks in MR output */
            const contents = [];
            const newLinks = [];

            for (const result of (results || [])) {
              if (!result || typeof result !== 'object') continue;
              for (const [k, v] of Object.entries(result)) {
                if (k.startsWith('__page__:')) {
                  try {
                    const content =
                        typeof v === 'string' ? JSON.parse(v) : v;
                    const pk = k.slice('__page__:'.length);
                    contents.push({content, pk});
                  } catch (err) { /* */ }
                } else if (v === '1') {
                  newLinks.push(k);
                }
              }
            }

            console.log(
                `[crawler] MR reduce: ${contents.length} pages, ` +
                `${newLinks.length} outlinks`,
            );

            /* Phase 4 — persist processed content (overwrite raw HTML) */
            let contentStored = 0;

            function onAllStored() {
              for (const {content} of contents) {
                crawledUrls.push(content.url);
                totalCrawled++;
              }

              /* Add outlinks to frontier (same-domain only) */
              for (const link of newLinks) {
                if (!visited.has(link) && !queued.has(link)) {
                  try {
                    const h = new URL(link).hostname;
                    if (!seedDomains.has(h)) continue;
                  } catch (e) { continue; }
                  queued.add(link);
                  frontier.push(link);
                }
              }

              saveState(() => setImmediate(runWave));
            }

            if (contents.length === 0) return onAllStored();

            contents.forEach(({content, pk}) => {
              distribution[crawlGid].store.put(content, pk, () => {
                if (++contentStored === contents.length) {
                  onAllStored();
                }
              });
            });
          },
      );
    }
  }

  loadState(() => runWave());
}

module.exports = {crawl};
