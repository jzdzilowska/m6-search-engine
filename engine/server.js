const http = require('http');
const url = require('url');
const {search} = require('./query');

/**
 * Start a lightweight search-engine web UI.
 *
 *   GET /             → search form
 *   GET /search?q=…   → ranked results page
 *
 * @param {object}   config
 * @param {number}   [config.port]           - HTTP port (default 3000)
 * @param {string}   [config.indexGroupName]  - Index group to query
 * @param {Function} [callback]              - (err, httpServer)
 */
const startTime = Date.now();
let queryCount = 0;

function startServer(config, callback) {
  const port = config.port || 3000;
  const indexGroupName = config.indexGroupName || 'index';

  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(renderSearchPage());
      return;
    }

    if (parsed.pathname === '/search' && req.method === 'GET') {
      const query = parsed.query.q || '';
      if (!query) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(renderSearchPage('Please enter a search query.'));
        return;
      }

      queryCount++;
      const qStart = Date.now();
      search(query, {indexGroupName, crawlGroupName: 'crawl', maxResults: 20}, (e, results) => {
        const latency = Date.now() - qStart;
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(renderResultsPage(query, results || [], latency));
      });
      return;
    }

    if (parsed.pathname === '/status' && req.method === 'GET') {
      serveStatus(res, indexGroupName);
      return;
    }

    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(
        `[server] Search engine running at http://localhost:${port}`,
    );
    if (callback) callback(null, server);
  });
}

function serveStatus(res, indexGid) {
  const distribution = globalThis.distribution;
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  distribution[indexGid].store.get('__totalDocs__', (e, totalDocs) => {
    distribution.local.groups.get('crawl', (e2, crawlGroup) => {
      distribution.local.groups.get('index', (e3, indexGroup) => {
        const workerCount = crawlGroup ? Object.keys(crawlGroup).length : 0;
        const status = {
          uptime_seconds: uptime,
          total_queries_served: queryCount,
          indexed_documents: totalDocs || 0,
          worker_nodes: workerCount,
          index_group: indexGid,
          memory_mb: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
          node_version: process.version,
        };

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(status, null, 2));
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  HTML templates                                                      */
/* ------------------------------------------------------------------ */

const SHARED_STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #fff; color: #000;
      -webkit-font-smoothing: antialiased;
    }
    ::selection { background: #000; color: #fff; }
    a { color: inherit; }
`;

function renderSearchPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search</title>
  <style>
    ${SHARED_STYLES}
    body {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh;
      padding: 2rem;
    }
    .brand {
      font-size: 1.1rem; font-weight: 300; letter-spacing: 0.3em;
      text-transform: uppercase; margin-bottom: 3rem; color: #000;
    }
    form { display: flex; flex-direction: column; align-items: center; gap: 1rem; width: 100%; max-width: 560px; }
    input[type="text"] {
      width: 100%; padding: 14px 0; font-size: 1rem;
      border: none; border-bottom: 1px solid #000;
      outline: none; background: transparent;
      font-family: inherit; letter-spacing: 0.02em;
    }
    input[type="text"]::placeholder { color: #999; font-weight: 300; }
    input[type="text"]:focus { border-bottom: 2px solid #000; }
    button {
      padding: 12px 40px; font-size: 0.85rem; font-weight: 500;
      letter-spacing: 0.15em; text-transform: uppercase;
      background: #000; color: #fff;
      border: 1px solid #000; cursor: pointer;
      font-family: inherit;
      transition: background 0.2s, color 0.2s;
    }
    button:hover { background: #fff; color: #000; }
    .msg { margin-top: 2rem; color: #888; font-size: 0.9rem; font-weight: 300; }
    .footer {
      position: fixed; bottom: 2rem;
      font-size: 0.75rem; color: #bbb; font-weight: 300;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div class="brand">CS1380 Search</div>
  <form action="/search" method="get">
    <input type="text" name="q" placeholder="Search" autofocus>
    <button type="submit">Search</button>
  </form>
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  <div class="footer">Distributed Search Engine · Brown CS1380</div>
</body>
</html>`;
}

function renderResultsPage(query, results, latencyMs) {
  const suggestions = results.suggestions || {};
  const suggestionHtml = Object.keys(suggestions).length > 0 ?
    `<p class="suggestion">Did you mean: <a href="/search?q=${
      encodeURIComponent(Object.values(suggestions).join(' '))
    }">${Object.entries(suggestions).map(([orig, fix]) =>
      `<em>${esc(fix)}</em>`).join(' ')}</a>?</p>` : '';

  const resultsHtml = results.length === 0 ?
    '<p class="empty">No results found.</p>' :
    results.map((r, i) => `
      <article class="result">
        <div class="result-header">
          <span class="num">${String(i + 1).padStart(2, '0')}</span>
          <a href="${esc(r.url)}" target="_blank" rel="noopener" class="link">${r.title ? esc(r.title) : esc(r.url)}</a>
        </div>
        <div class="result-url">${esc(r.url)}</div>
        ${r.snippet ? `<p class="snippet">${highlightSnippet(r.snippet)}</p>` : ''}
        <div class="meta">
          <span class="score">${r.score.toFixed(2)}</span>${
  r.details && r.details.length ?
    r.details
        .map((d) => `<span class="tag">${esc(d.term)}</span>`)
        .join('') :
    ''
}
        </div>
      </article>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(query)} · Search</title>
  <style>
    ${SHARED_STYLES}
    header {
      padding: 1.5rem 3rem;
      border-bottom: 1px solid #e5e5e5;
      display: flex; align-items: center; gap: 2rem;
    }
    .brand-sm {
      font-size: 0.8rem; font-weight: 300; letter-spacing: 0.3em;
      text-transform: uppercase; white-space: nowrap;
    }
    .brand-sm a { text-decoration: none; }
    header form { display: flex; align-items: center; gap: 0.75rem; flex: 1; max-width: 500px; }
    header input[type="text"] {
      flex: 1; padding: 10px 0; font-size: 0.95rem;
      border: none; border-bottom: 1px solid #ccc;
      outline: none; background: transparent;
      font-family: inherit;
    }
    header input[type="text"]:focus { border-bottom-color: #000; }
    header button {
      padding: 8px 24px; font-size: 0.75rem; font-weight: 500;
      letter-spacing: 0.12em; text-transform: uppercase;
      background: #000; color: #fff;
      border: 1px solid #000; cursor: pointer;
      font-family: inherit;
      transition: background 0.2s, color 0.2s;
    }
    header button:hover { background: #fff; color: #000; }
    .results-container {
      max-width: 680px; margin: 0 auto;
      padding: 2.5rem 2rem;
    }
    .summary {
      font-size: 0.8rem; color: #999; font-weight: 300;
      margin-bottom: 2.5rem; letter-spacing: 0.02em;
      padding-bottom: 1rem; border-bottom: 1px solid #eee;
    }
    .summary strong { color: #000; font-weight: 500; }
    .result {
      margin-bottom: 2rem; padding-bottom: 2rem;
      border-bottom: 1px solid #f0f0f0;
    }
    .result:last-child { border-bottom: none; }
    .result-header { display: flex; align-items: baseline; gap: 1rem; }
    .num {
      font-size: 0.75rem; font-weight: 300; color: #bbb;
      font-variant-numeric: tabular-nums;
    }
    .link {
      font-size: 0.95rem; font-weight: 500; color: #000;
      text-decoration: none; word-break: break-all;
      line-height: 1.5;
      transition: color 0.15s;
    }
    .link:hover { color: #666; }
    .result-url {
      padding-left: 2.25rem; margin-top: 0.2rem;
      font-size: 0.75rem; color: #888; word-break: break-all;
    }
    .snippet {
      padding-left: 2.25rem; margin-top: 0.5rem;
      font-size: 0.85rem; color: #444; line-height: 1.6;
      font-weight: 300;
    }
    .meta { margin-top: 0.5rem; padding-left: 2.25rem; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    .score {
      font-size: 0.75rem; font-weight: 500; color: #999;
      font-variant-numeric: tabular-nums;
      margin-right: 0.25rem;
    }
    .tag {
      font-size: 0.7rem; font-weight: 400; color: #666;
      background: #f5f5f5; padding: 2px 8px;
      letter-spacing: 0.03em;
    }
    .empty { color: #999; font-weight: 300; font-size: 0.95rem; }
    .suggestion {
      margin-bottom: 1.5rem; font-size: 0.85rem; color: #666; font-weight: 300;
    }
    .suggestion a { color: #1a0dab; text-decoration: none; }
    .suggestion em { font-style: italic; font-weight: 500; }
    .latency { font-size: 0.7rem; color: #bbb; margin-left: 0.5rem; }
    mark { background: #fff3cd; padding: 1px 2px; border-radius: 2px; color: #000; }
  </style>
</head>
<body>
  <header>
    <div class="brand-sm"><a href="/">CS1380 Search</a></div>
    <form action="/search" method="get">
      <input type="text" name="q" value="${esc(query)}" autofocus>
      <button type="submit">Search</button>
    </form>
  </header>
  <div class="results-container">
    <p class="summary">
      ${results.length} result${results.length !== 1 ? 's' : ''}
      for <strong>${esc(query)}</strong>
      ${latencyMs ? `<span class="latency">(${latencyMs}ms)</span>` : ''}
    </p>
    ${suggestionHtml}
    ${resultsHtml}
  </div>
</body>
</html>`;
}

function highlightSnippet(snippet) {
  // Query.js marks highlights with \x00...\x01 placeholders
  // First escape HTML, then convert placeholders to <mark> tags
  let safe = esc(snippet);
  safe = safe.replace(/\x00/g, '<mark>').replace(/\x01/g, '</mark>');
  return safe;
}

function esc(str) {
  return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
}

module.exports = {startServer};
