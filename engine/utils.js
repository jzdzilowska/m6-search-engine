const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let _stopwords = null;

function loadStopwords() {
  if (_stopwords) return _stopwords;
  const filePath = path.join(
      __dirname, '..', 'non-distribution', 'd', 'stopwords.txt',
  );
  const text = fs.readFileSync(filePath, 'utf8');
  _stopwords = new Set(
      text.split('\n').map((w) => w.trim()).filter((w) => w),
  );
  return _stopwords;
}

function tokenize(text, stopwords) {
  if (!stopwords) stopwords = loadStopwords();
  return text
      .replace(/[^a-zA-Z]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopwords.has(w));
}

/**
 * Porter stemmer - same algorithm used by the MR mapper so query stems
 * match index stems (workers lack `require`, so natural can't be used).
 */
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
    const fp = re.exec(stem);
    if (mgr0.test(fp[1])) stem = stem.slice(0, -1);
  } else if (re2.test(stem)) {
    const fp = re2.exec(stem); stem = fp[1];
    re2 = /(at|bl|iz)$/; re3 = /([^aeiouylsz])\1$/;
    re4 = new RegExp('^' + C + vowel + '[^aeiouwxy]$');
    if (re2.test(stem)) stem += 'e';
    else if (re3.test(stem)) stem = stem.slice(0, -1);
    else if (re4.test(stem)) stem += 'e';
  }

  re = /^(.+?)y$/;
  if (re.test(stem)) {
    const fp = re.exec(stem);
    if (s_v.test(fp[1])) stem = fp[1] + 'i';
  }

  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(stem)) {
    const fp = re.exec(stem);
    if (mgr0.test(fp[1])) {
      const map = {ational: 'ate', tional: 'tion', enci: 'ence',
        anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent',
        eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate',
        alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous',
        aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log'};
      stem = fp[1] + map[fp[2]];
    }
  }

  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(stem)) {
    const fp = re.exec(stem);
    if (mgr0.test(fp[1])) {
      const map = {icate: 'ic', ative: '', alize: 'al', iciti: 'ic',
        ical: 'ic', ful: '', ness: ''};
      stem = fp[1] + map[fp[2]];
    }
  }

  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(stem)) {
    const fp = re.exec(stem);
    if (mgr1.test(fp[1])) stem = fp[1];
  } else if (re2.test(stem)) {
    const fp = re2.exec(stem);
    if (mgr1.test(fp[1] + fp[2])) stem = fp[1] + fp[2];
  }

  re = /^(.+?)e$/;
  if (re.test(stem)) {
    const fp = re.exec(stem);
    const sfx = new RegExp('^' + C + vowel + '[^aeiouwxy]$');
    if (mgr1.test(fp[1]) || (meq1.test(fp[1]) && !sfx.test(fp[1]))) {
      stem = fp[1];
    }
  }

  re = /ll$/;
  if (re.test(stem) && mgr1.test(stem)) stem = stem.slice(0, -1);

  if (w.length > 2 && w.substr(0, 1) === 'y') {
    stem = stem.substr(0, 1).toLowerCase() + stem.substr(1);
  }
  return stem;
}

function stemWords(words) {
  return words.map((w) => porterStem(w));
}

function urlKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

module.exports = {loadStopwords, tokenize, stemWords, urlKey};
