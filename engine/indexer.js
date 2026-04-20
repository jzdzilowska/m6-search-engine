const {urlKey} = require('./utils');

/**
 * Build an inverted index with TF-IDF from crawled pages using MapReduce.
 *
 * Single MR job:
 *   Map   – tokenise, stem, count per-term frequency for each page.
 *   Reduce – aggregate postings across pages for each term.
 *
 * After MR the posting lists are persisted to the index group store so the
 * query engine can look them up directly.
 *
 * @param {object}   config
 * @param {string}   [config.pagesGroupName]  - Group holding crawled pages
 * @param {string}   [config.indexGroupName]  - Group to store the index
 * @param {string[]} config.crawledUrls       - URLs that were crawled
 * @param {Function} callback                 - (err, {totalTerms, totalDocs})
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
   * Tokenises, stems (Porter algorithm), counts per-term frequency.
   * Emits { term: { url, tf } } for every unique stem in the page.
   * ----------------------------------------------------------------- */
  const indexMapper = (key, value) => {
    /* --- inline Porter stemmer (matches natural.PorterStemmer) --- */
    function porterStem(w) {
      if (w.length < 3) return w;
      const cons = '[^aeiou]'; const vowel = '[aeiou]';
      const C = cons + '[^aeiou]*'; const V = vowel + '[aeiou]*';
      const mgr0 = new RegExp('^(' + C + ')?' + V + C);
      const mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);
      const meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');
      const s_v = new RegExp('^(' + C + ')?' + vowel);
      let stem = w; let suffix; let re; let re2; let re3; let re4;

      if (w.length > 2) {
        const ch1 = w.substr(0,1);
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
          const map = {ational:'ate',tional:'tion',enci:'ence',anci:'ance',izer:'ize',bli:'ble',alli:'al',entli:'ent',eli:'e',ousli:'ous',ization:'ize',ation:'ate',ator:'ate',alism:'al',iveness:'ive',fulness:'ful',ousness:'ous',aliti:'al',iviti:'ive',biliti:'ble',logi:'log'};
          stem = fp[1] + map[fp[2]];
        }
      }

      re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
      if (re.test(stem)) {
        const fp = re.exec(stem);
        if (mgr0.test(fp[1])) {
          const map = {icate:'ic',ative:'',alize:'al',iciti:'ic',ical:'ic',ful:'',ness:''};
          stem = fp[1] + map[fp[2]];
        }
      }

      re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
      re2 = /^(.+?)(s|t)(ion)$/;
      if (re.test(stem)) { const fp = re.exec(stem); if (mgr1.test(fp[1])) stem = fp[1]; }
      else if (re2.test(stem)) { const fp = re2.exec(stem); if (mgr1.test(fp[1]+fp[2])) stem = fp[1]+fp[2]; }

      re = /^(.+?)e$/;
      if (re.test(stem)) {
        const fp = re.exec(stem);
        const sfx = new RegExp('^' + C + vowel + '[^aeiouwxy]$');
        if (mgr1.test(fp[1]) || (meq1.test(fp[1]) && !sfx.test(fp[1]))) stem = fp[1];
      }

      re = /ll$/;
      if (re.test(stem) && mgr1.test(stem)) stem = stem.slice(0, -1);

      if (w.length > 2 && w.substr(0,1) === 'y') stem = stem.substr(0,1).toLowerCase() + stem.substr(1);
      return stem;
    }

    /* --- inline stopwords (common English) --- */
    const STOP = new Set(['a','about','above','after','again','against','all',
      'am','an','and','any','are','aren','as','at','be','because','been',
      'before','being','below','between','both','but','by','can','could',
      'did','do','does','doing','don','down','during','each','few','for',
      'from','further','get','got','had','has','have','having','he','her',
      'here','hers','herself','him','himself','his','how','i','if','in',
      'into','is','isn','it','its','itself','just','ll','me','might',
      'more','most','my','myself','no','nor','not','now','of','off','on',
      'once','only','or','other','our','ours','ourselves','out','over',
      'own','re','s','same','she','should','so','some','such','t','than',
      'that','the','their','theirs','them','themselves','then','there',
      'these','they','this','those','through','to','too','under','until',
      'up','ve','very','was','we','were','what','when','where','which',
      'while','who','whom','why','will','with','would','you','your',
      'yours','yourself','yourselves','d','m','o','ll','ve']);

    /* --- extract text --- */
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

  /* ----- Run MR and persist the resulting index ----- */
  distribution[pagesGid].mr.exec(
      {keys: pageKeys, map: indexMapper, reduce: indexReducer},
      (e, results) => {
        if (e) {
          console.error('[indexer] MR error:', e);
          return callback(e);
        }
        if (!results || results.length === 0) {
          return callback(null, {totalTerms: 0, totalDocs});
        }

        console.log(`[indexer] Storing ${results.length} terms …`);

        // Persist total-docs metadata so the query engine can compute IDF
        distribution[indexGid].store.put(
            totalDocs, '__totalDocs__',
            () => {
              // Batch-store posting lists to avoid overwhelming the cluster
              const BATCH = 500;
              let idx = 0;

              function storeBatch() {
                if (idx >= results.length) {
                  console.log(
                      `[indexer] Complete. ${results.length} terms indexed ` +
                      `across ${totalDocs} docs.`,
                  );
                  return callback(null, {
                    totalTerms: results.length,
                    totalDocs,
                  });
                }

                const batch = results.slice(idx, idx + BATCH);
                let done = 0;

                batch.forEach((obj) => {
                  const term = Object.keys(obj)[0];
                  const postings = obj[term];
                  distribution[indexGid].store.put(
                      postings, term,
                      () => {
                        if (++done === batch.length) {
                          idx += BATCH;
                          setImmediate(storeBatch);
                        }
                      },
                  );
                });
              }

              storeBatch();
            },
        );
      },
  );
}

module.exports = {buildIndex};
