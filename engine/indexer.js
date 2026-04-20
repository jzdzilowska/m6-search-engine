const {urlKey} = require('./utils');

/**
 * Build an inverted index with TF-IDF from crawled pages using MapReduce.
 *
 * Memory-critical: results from each MR chunk are streamed directly to the
 * index store and discarded — never accumulated in a coordinator-side array.
 * For terms that appear across multiple chunks, the reducer's postings are
 * merged into whatever is already stored (read-merge-write).
 */
function buildIndex(config, callback) {
  const distribution = globalThis.distribution;
  const pagesGid = config.crawlGroupName || config.pagesGroupName || 'crawl';
  const indexGid = config.indexGroupName || 'index';
  const crawledUrls = config.crawledUrls || [];

  if (crawledUrls.length === 0) {
    return callback(new Error('No crawled URLs to index'));
  }

  const totalDocs = crawledUrls.length;
  const pageKeys = crawledUrls.map(urlKey);

  console.log(`[indexer] Indexing ${totalDocs} pages …`);

  /* -----------------------------------------------------------------
   * Mapper — fully self-contained (no require — workers lack it).
   * ----------------------------------------------------------------- */
  const indexMapper = (key, value) => {
    function porterStem(w) {
      if (w.length < 3) return w;
      const cons = '[^aeiou]'; const vowel = '[aeiou]';
      const C = cons + '[^aeiou]*'; const V = vowel + '[aeiou]*';
      const mgr0 = new RegExp('^(' + C + ')?' + V + C);
      const mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);
      const meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');
      const s_v = new RegExp('^(' + C + ')?' + vowel);
      let stem = w; let re; let re2; let re3; let re4;

      if (w.length > 2) {
        const ch1 = w.substr(0, 1);
        if (ch1 === 'y') stem = ch1.toUpperCase() + w.substr(1);
      }

      re = /^(.+?)(ss|i)es$/; re2 = /^(.+?)([^s])s$/;
      if (re.test(stem)) stem = stem.replace(re, '$1$2');
      else if (re2.test(stem)) stem = stem.replace(re2, '$1$2');

      re = /^(.+?)eed$/; re2 = /^(.+?)(ed|ing)$/;
      if (re.test(stem)) {
        const fp = re.exec(stem); if (mgr0.test(fp[1])) stem = stem.slice(0, -1);
      } else if (re2.test(stem)) {
        const fp = re2.exec(stem); stem = fp[1];
        re2 = /(at|bl|iz)$/; re3 = /([^aeiouylsz])\1$/; re4 = new RegExp('^' + C + vowel + '[^aeiouwxy]$');
        if (re2.test(stem)) stem += 'e';
        else if (re3.test(stem)) stem = stem.slice(0, -1);
        else if (re4.test(stem)) stem += 'e';
      }

      re = /^(.+?)y$/;
      if (re.test(stem)) { const fp = re.exec(stem); if (s_v.test(fp[1])) stem = fp[1] + 'i'; }

      re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
      if (re.test(stem)) {
        const fp = re.exec(stem);
        if (mgr0.test(fp[1])) {
          const map = {ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log'};
          stem = fp[1] + map[fp[2]];
        }
      }

      re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
      if (re.test(stem)) {
        const fp = re.exec(stem);
        if (mgr0.test(fp[1])) {
          const map = {icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: ''};
          stem = fp[1] + map[fp[2]];
        }
      }

      re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
      re2 = /^(.+?)(s|t)(ion)$/;
      if (re.test(stem)) { const fp = re.exec(stem); if (mgr1.test(fp[1])) stem = fp[1]; }
      else if (re2.test(stem)) { const fp = re2.exec(stem); if (mgr1.test(fp[1] + fp[2])) stem = fp[1] + fp[2]; }

      re = /^(.+?)e$/;
      if (re.test(stem)) {
        const fp = re.exec(stem);
        const sfx = new RegExp('^' + C + vowel + '[^aeiouwxy]$');
        if (mgr1.test(fp[1]) || (meq1.test(fp[1]) && !sfx.test(fp[1]))) stem = fp[1];
      }

      re = /ll$/;
      if (re.test(stem) && mgr1.test(stem)) stem = stem.slice(0, -1);

      if (w.length > 2 && w.substr(0, 1) === 'y') stem = stem.substr(0, 1).toLowerCase() + stem.substr(1);
      return stem;
    }

    const STOP = new Set(['a', 'about', 'above', 'after', 'again', 'against', 'all',
      'am', 'an', 'and', 'any', 'are', 'aren', 'as', 'at', 'be', 'because', 'been',
      'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could',
      'did', 'do', 'does', 'doing', 'don', 'down', 'during', 'each', 'few', 'for',
      'from', 'further', 'get', 'got', 'had', 'has', 'have', 'having', 'he', 'her',
      'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
      'into', 'is', 'isn', 'it', 'its', 'itself', 'just', 'll', 'me', 'might',
      'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
      'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over',
      'own', 're', 's', 'same', 'she', 'should', 'so', 'some', 'such', 't', 'than',
      'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
      'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
      'up', 've', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
      'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
      'yours', 'yourself', 'yourselves', 'd', 'm', 'o', 'll', 've']);

    let text;
    if (typeof value === 'object' && value !== null) {
      text = value.text || '';
    } else {
      text = String(value || '');
    }
    if (!text || text.length < 5) return [];

    const words = text
        .replace(/[^a-zA-Z]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w));

    if (words.length === 0) return [];

    const stemmed = words.map((w) => porterStem(w));

    const tf = {};
    for (const w of stemmed) {
      tf[w] = (tf[w] || 0) + 1;
    }

    const url = (typeof value === 'object' && value.url) ? value.url : key;
    const results = [];
    for (const [term, count] of Object.entries(tf)) {
      if (term.length > 0) {
        results.push({[term]: {url, tf: count}});
      }
    }
    return results;
  };

  /* -----------------------------------------------------------------
   * Reducer — merges per-page TF entries into a single posting list
   * per term: { url1: tf1, url2: tf2, … }
   * ----------------------------------------------------------------- */
  const indexReducer = (key, values) => {
    const postings = {};
    for (const v of values) {
      if (v && v.url) {
        postings[v.url] = (postings[v.url] || 0) + v.tf;
      }
    }
    return {[key]: postings};
  };

  /* ----- Run MR in chunks, stream each chunk to store ----- */
  const MR_CHUNK = 50;
  let chunkIdx = 0;
  let totalTermsWritten = 0;

  function runNextChunk() {
    if (chunkIdx >= pageKeys.length) {
      return finishIndex();
    }

    const chunkKeys = pageKeys.slice(chunkIdx, chunkIdx + MR_CHUNK);
    const chunkNum = Math.floor(chunkIdx / MR_CHUNK) + 1;
    const totalChunks = Math.ceil(pageKeys.length / MR_CHUNK);
    console.log(
        `[indexer] MR chunk ${chunkNum}/${totalChunks} ` +
        `(${chunkKeys.length} pages)`,
    );

    distribution[pagesGid].mr.exec(
        {keys: chunkKeys, map: indexMapper, reduce: indexReducer},
        (e, results) => {
          if (e) {
            console.error(`[indexer] MR chunk ${chunkNum} error:`, e);
            chunkIdx += MR_CHUNK;
            return setImmediate(runNextChunk);
          }

          if (!results || results.length === 0) {
            chunkIdx += MR_CHUNK;
            return setImmediate(runNextChunk);
          }

          // Stream this chunk's results directly to the index store,
          // merging with any existing postings from prior chunks.
          storeChunkResults(results, () => {
            chunkIdx += MR_CHUNK;
            // Hint GC to free the results array
            results.length = 0;
            if (global.gc) global.gc();
            setImmediate(runNextChunk);
          });
        },
    );
  }

  /**
   * Write one chunk's MR results into the index store.
   * For each term, read existing postings, merge, write back.
   * Done in batches of STORE_BATCH to avoid overwhelming RPC.
   */
  function storeChunkResults(results, cb) {
    const STORE_BATCH = 200;
    let idx = 0;

    function nextBatch() {
      if (idx >= results.length) return cb();

      const batch = results.slice(idx, idx + STORE_BATCH);
      let pending = batch.length;

      batch.forEach((obj) => {
        const term = Object.keys(obj)[0];
        const newPostings = obj[term];

        distribution[indexGid].store.get(term, (e, existing) => {
          let merged;
          if (!e && existing && typeof existing === 'object') {
            merged = existing;
            for (const [url, tf] of Object.entries(newPostings)) {
              merged[url] = (merged[url] || 0) + tf;
            }
          } else {
            merged = newPostings;
          }

          distribution[indexGid].store.put(merged, term, () => {
            totalTermsWritten++;
            if (--pending === 0) {
              idx += STORE_BATCH;
              setImmediate(nextBatch);
            }
          });
        });
      });
    }

    nextBatch();
  }

  function finishIndex() {
    console.log(`[indexer] Storing __totalDocs__ = ${totalDocs}`);
    distribution[indexGid].store.put(totalDocs, '__totalDocs__', () => {
      console.log(
          `[indexer] Complete. ${totalTermsWritten} term writes ` +
          `across ${totalDocs} docs.`,
      );
      callback(null, {totalTerms: totalTermsWritten, totalDocs});
    });
  }

  runNextChunk();
}

module.exports = {buildIndex};
