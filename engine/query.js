const {tokenize, stemWords, loadStopwords, urlKey} = require('./utils');

let cachedPageRanks = null;

function search(queryStr, config, callback) {
  const distribution = globalThis.distribution;
  const indexGid = config.indexGroupName || 'index';
  const crawlGid = config.crawlGroupName || 'crawl';
  const maxResults = config.maxResults || 10;

  const stopwords = loadStopwords();
  const tokens = tokenize(queryStr, stopwords);
  const terms = stemWords(tokens);

  if (terms.length === 0) {
    return callback(null, []);
  }

  const uniqueTerms = [...new Set(terms)];

  function withPageRank(cb) {
    if (cachedPageRanks !== null) return cb(cachedPageRanks);
    distribution[indexGid].store.get('__pagerank__', (e, ranks) => {
      cachedPageRanks = (!e && ranks && typeof ranks === 'object') ? ranks : {};
      cb(cachedPageRanks);
    });
  }

  withPageRank((pageRanks) => {
    distribution[indexGid].store.get('__totalDocs__', (e, totalDocs) => {
      if (e || !totalDocs) totalDocs = 1;

      const urlScores = {};
      const termDetails = {};
      let pending = uniqueTerms.length;
      const missedTerms = [];

      uniqueTerms.forEach((term) => {
        distribution[indexGid].store.get(term, (e, postings) => {
          if (!e && postings && typeof postings === 'object') {
            const df = Object.keys(postings).length;
            const idf = Math.log(1 + totalDocs / (1 + df));

            for (const [url, tf] of Object.entries(postings)) {
              const tfidf = tf * idf;
              const pr = pageRanks[url] || (1 / totalDocs);
              const prBoost = 1 + Math.max(0, Math.log(pr * totalDocs));
              const score = tfidf * prBoost;
              urlScores[url] = (urlScores[url] || 0) + score;

              if (!termDetails[url]) termDetails[url] = [];
              termDetails[url].push({term, tf, idf: +idf.toFixed(4), score: +score.toFixed(4)});
            }
          } else {
            missedTerms.push(term);
          }

          if (--pending === 0) {
            const ranked = Object.entries(urlScores)
                .map(([url, score]) => ({
                  url,
                  score,
                  details: termDetails[url] || [],
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);

            if (missedTerms.length > 0 && ranked.length < 3) {
              suggestCorrections(distribution, indexGid, missedTerms, tokens, (suggestions) => {
                fetchSnippets(distribution, crawlGid, ranked, tokens, (err, results) => {
                  if (results) results.suggestions = suggestions;
                  callback(err, results);
                });
              });
            } else {
              fetchSnippets(distribution, crawlGid, ranked, tokens, callback);
            }
          }
        });
      });
    });
  });
}

/* ── Spell Check: edit-distance suggestions ── */

function generateEdits(word) {
  const edits = new Set();
  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i <= word.length; i++) {
    // deletions
    if (i < word.length) {
      edits.add(word.slice(0, i) + word.slice(i + 1));
    }
    // insertions
    for (const c of alpha) {
      edits.add(word.slice(0, i) + c + word.slice(i));
    }
    // replacements
    if (i < word.length) {
      for (const c of alpha) {
        if (c !== word[i]) {
          edits.add(word.slice(0, i) + c + word.slice(i + 1));
        }
      }
    }
    // transpositions
    if (i < word.length - 1) {
      edits.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    }
  }
  edits.delete(word);
  return [...edits].filter((e) => e.length > 1);
}

function suggestCorrections(distribution, indexGid, missedTerms, originalTokens, cb) {
  const suggestions = {};
  let remaining = missedTerms.length;

  missedTerms.forEach((term) => {
    const candidates = generateEdits(term);
    const origToken = originalTokens.find((t) =>
      stemWords([t])[0] === term) || term;
    let checked = 0;
    let bestCandidate = null;
    let bestDf = 0;

    if (candidates.length === 0) {
      if (--remaining === 0) cb(suggestions);
      return;
    }

    const toCheck = candidates.slice(0, 30);
    toCheck.forEach((candidate) => {
      distribution[indexGid].store.get(candidate, (e, postings) => {
        if (!e && postings && typeof postings === 'object') {
          const df = Object.keys(postings).length;
          if (df > bestDf) {
            bestDf = df;
            bestCandidate = candidate;
          }
        }
        if (++checked === toCheck.length) {
          if (bestCandidate && bestDf >= 2) {
            suggestions[origToken] = bestCandidate;
          }
          if (--remaining === 0) cb(suggestions);
        }
      });
    });
  });

  if (missedTerms.length === 0) cb(suggestions);
}

function fetchSnippets(distribution, crawlGid, results, queryTokens, callback) {
  if (results.length === 0) return callback(null, results);

  let pending = results.length;
  const queryLower = queryTokens.map((t) => t.toLowerCase());

  results.forEach((result) => {
    const key = urlKey(result.url);
    distribution[crawlGid].store.get(key, (e, page) => {
      if (!e && page && page.text) {
        result.snippet = extractSnippet(page.text, queryLower);
        if (page.title) result.title = page.title;
      }
      if (--pending === 0) {
        callback(null, results);
      }
    });
  });
}

function extractSnippet(text, queryTerms) {
  const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 20);

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sl = sentences[i].toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (sl.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  let raw;
  if (bestIdx >= 0) {
    raw = sentences[bestIdx].trim();
    if (raw.length > 250) raw = raw.slice(0, 250) + '...';
  } else {
    raw = text.slice(0, 250).trim();
    if (text.length > 250) raw += '...';
  }

  // Highlight matched query terms with <mark> tags
  let highlighted = raw;
  for (const term of queryTerms) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    highlighted = highlighted.replace(re, '\x00$1\x01');
  }
  // Use placeholder chars to avoid double-escaping issues in the HTML renderer
  return highlighted;
}

module.exports = {search};
