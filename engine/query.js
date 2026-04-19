const {tokenize, stemWords, loadStopwords} = require('./utils');

/**
 * Search the distributed inverted index.
 *
 * 1. Tokenise & stem the query (same pipeline as the indexer).
 * 2. Look up each query term in the distributed index store.
 * 3. Compute TF-IDF scores:  score(url) = Σ  tf(term,url) · log(1+N/(1+df))
 * 4. Return the top-N results sorted by descending score.
 *
 * @param {string}   queryStr
 * @param {object}   config
 * @param {string}   [config.indexGroupName]  - Group holding the index
 * @param {number}   [config.maxResults]      - Top-N results (default 10)
 * @param {Function} callback - (err, [{url, score}, …])
 */
function search(queryStr, config, callback) {
  const distribution = globalThis.distribution;
  const indexGid = config.indexGroupName || 'index';
  const maxResults = config.maxResults || 10;

  const stopwords = loadStopwords();
  const tokens = tokenize(queryStr, stopwords);
  const terms = stemWords(tokens);

  console.log(`[query] "${queryStr}" → tokens=${JSON.stringify(tokens)} stems=${JSON.stringify(terms)}`);

  if (terms.length === 0) {
    console.log('[query] No terms after stemming, returning empty');
    return callback(null, []);
  }

  // Deduplicate query terms
  const uniqueTerms = [...new Set(terms)];

  distribution[indexGid].store.get('__totalDocs__', (e, totalDocs) => {
    console.log(`[query] __totalDocs__ → err=${e ? e.message || e : 'null'}, val=${totalDocs}`);
    if (e || !totalDocs) totalDocs = 1;

    const urlScores = {};
    const termDetails = {}; // per-url breakdown for debugging
    let pending = uniqueTerms.length;

    uniqueTerms.forEach((term) => {
      distribution[indexGid].store.get(term, (e, postings) => {
        console.log(`[query] get("${term}") → err=${e ? e.message || e : 'null'}, postings=${JSON.stringify(postings)}`);
        if (!e && postings && typeof postings === 'object') {
          const df = Object.keys(postings).length;
          const idf = Math.log(1 + totalDocs / (1 + df));

          for (const [url, tf] of Object.entries(postings)) {
            const score = tf * idf;
            urlScores[url] = (urlScores[url] || 0) + score;

            if (!termDetails[url]) termDetails[url] = [];
            termDetails[url].push({term, tf, idf: +idf.toFixed(4), score: +score.toFixed(4)});
          }
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

          callback(null, ranked);
        }
      });
    });
  });
}

module.exports = {search};
