/**
 * Crawl-fetch service — registered locally on each worker at boot time.
 *
 * Because this module is require()'d directly by the worker process (never
 * serialized over RPC), all require() calls work normally.
 *
 * The coordinator sends batches of URLs via:
 *   comm.send([urls], {node, service: 'crawl-fetch', method: 'fetchBatch'}, cb)
 *
 * The service fetches each URL, extracts text + outlinks, stores the page in
 * the distributed crawl store, and returns {crawled, outlinks} to the caller.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const {convert} = require('html-to-text');
const {URL} = require('url');

const FETCH_TIMEOUT = 15000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_TEXT = 30000;

function urlKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

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

/**
 * Fetch a batch of URLs, extract content, store pages, return results.
 * Called by coordinator via RPC.
 *
 * @param {string[]} urls - URLs to fetch
 * @param {Function} cb - callback(err, {crawled: string[], outlinks: string[]})
 */
function fetchBatch(urls, cb) {
  if (!urls || urls.length === 0) return cb(null, {crawled: [], outlinks: []});

  const distribution = globalThis.distribution;
  const crawlGid = 'crawl';

  let pending = urls.length;
  const crawled = [];
  const allOutlinks = [];

  urls.forEach((url) => {
    fetchPage(url, (e, html) => {
      if (html && html.length > 50) {
        const content = processPage(url, html);
        crawled.push(content.url);
        allOutlinks.push(...content.outlinks);

        const pk = urlKey(content.url);
        distribution[crawlGid].store.put(content, pk, () => {
          if (--pending === 0) {
            cb(null, {crawled, outlinks: allOutlinks});
          }
        });
      } else {
        console.log(`[crawl-fetch] SKIP ${url} — ${html ? html.length + ' bytes (too short)' : 'no response'}`);
        if (--pending === 0) {
          cb(null, {crawled, outlinks: allOutlinks});
        }
      }
    });
  });
}

module.exports = {fetchBatch};
