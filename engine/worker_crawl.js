/**
 * Crawl-fetch service - registered locally on each worker at boot time.
 *
 * Workers only fetch + extract. They return page content to the coordinator,
 * which handles distributed storage (the coordinator has groups properly
 * registered and can reliably do distribution[gid].store.put).
 */

const http = require('http');
const https = require('https');
const {convert} = require('html-to-text');
const {URL} = require('url');

// const FETCH_TIMEOUT = 15000;
const FETCH_TIMEOUT = 5000;

const MAX_BODY = 2 * 1024 * 1024;
const MAX_TEXT = 30000;
// const BATCH_TIMEOUT = 20000;
const BATCH_TIMEOUT = 10000;

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
 * Fetch a batch of URLs, extract content, return results to coordinator.
 * Storage is NOT done here - coordinator handles it.
 */
function fetchBatch(urls, cb) {
  if (!urls || urls.length === 0) return cb(null, {pages: [], outlinks: []});

  let pending = urls.length;
  let finished = false;
  const pages = [];
  const allOutlinks = [];

  // Safety timeout - return whatever we have after BATCH_TIMEOUT
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    console.log(`[crawl-fetch] Batch timeout - returning ${pages.length}/${urls.length} pages`);
    cb(null, {pages, outlinks: allOutlinks});
  }, BATCH_TIMEOUT);

  urls.forEach((url) => {
    fetchPage(url, (e, html) => {
      if (finished) return;

      if (html && html.length > 50) {
        const content = processPage(url, html);
        pages.push(content);
        allOutlinks.push(...content.outlinks);
      }

      if (--pending === 0) {
        finished = true;
        clearTimeout(timer);
        cb(null, {pages, outlinks: allOutlinks});
      }
    });
  });
}

module.exports = {fetchBatch};
