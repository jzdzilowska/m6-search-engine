#!/usr/bin/env node

/*
Merge the current inverted index (assuming the right structure) with the global index file
Usage: input > ./merge.js global-index > output

The inverted indices have the different structures!

Each line of a local index is formatted as:
  - `<word/ngram> | <frequency> | <url>`

Each line of a global index is be formatted as:
  - `<word/ngram> | <url_1> <frequency_1> <url_2> <frequency_2> ... <url_n> <frequency_n>`
  - Where pairs of `url` and `frequency` are in descending order of frequency
  - Everything after `|` is space-separated

-------------------------------------------------------------------------------------
Example:

local index:
  word1 word2 | 8 | url1
  word3 | 1 | url9
EXISTING global index:
  word1 word2 | url4 2
  word3 | url3 2

merge into the NEW global index:
  word1 word2 | url1 8 url4 2
  word3 | url3 2 url9 1

Remember to error gracefully, particularly when reading the global index file.
*/

const fs = require('fs');
const readline = require('readline'); // read input line by line from disk
// The `compare` function can be used for sorting.
const compare = (a, b) => { // sort things by frequency descending
  // i.e., SEARCH! order by freq high to low, so that the most relevant results appear first in index
  if (a.freq > b.freq) {
    return -1;
  } else if (a.freq < b.freq) {
    return 1;
  } else {
    return 0;
  }
};
const rl = readline.createInterface({
  input: process.stdin, // stdin is whatever's piped on the left, before "|"
});

// 1. Read the incoming local index data from standard input (stdin) line by line.
let localIndex = '';
rl.on('line', (line) => {
  localIndex += line + '\n'; // accumulate lines from stdin
});

rl.on('close', () => {
  // 2. Read the global index name/location, using process.argv
  // and call printMerged as a callback
  const globalIndexFile = process.argv[2]; // here argv[0] is 'node', argv[1] is 'merge.js', argv[2] is the global index file path
  fs.readFile(globalIndexFile, 'utf-8', (err, data) => {
    if (err) {
      // If file doesn't exist, treat as empty
      printMerged(null, '');
    } else {
      printMerged(null, data);
    }
  });
});

/* 
Parse local, global indices, merge them, and print the result.
*/
const printMerged = (err, data) => {
  if (err) {
    console.error('Error reading file:', err);
    return;
  }

  // Split the data into an array of lines
  const localIndexLines = localIndex.split('\n'); // turns into array of lines
  const globalIndexLines = data.split('\n');

  localIndexLines.pop();
  globalIndexLines.pop();

  const local = {}; // local will be Map<term, Map<url, freq>> from stdin
  const global = {}; // global will be Map<term, Map<url, freq>> from file

  // 3. For each line in `localIndexLines`, parse them and add them to the `local` object
  // where keys are terms and values store a url->freq map (one entry per url).
  for (const line of localIndexLines) {
    if (!line.trim()) continue;
    const parts = line.split(' | ');
    const term = parts[0].trim();
    const freq = parseInt(parts[1].trim()); // frequency computed in invert.js
    // which returns pizza | 3 | https://example.com/page1
    const url = parts[2].trim();
    
    if (!local[term]) {
      local[term] = {};
    }
    local[term][url] = (local[term][url] || 0) + freq;
  }

  // 4. For each line in `globalIndexLines`, parse them and add them to the `global` object
  // where keys are terms and values are url->freq maps (one entry per url).
  // Use the .trim() method to remove leading and trailing whitespace from a string.
  for (const line of globalIndexLines) {
    if (!line.trim()) continue;
    const parts = line.split(' | ');
    const term = parts[0].trim();
    const rest = parts[1].trim().split(' ');
    
    const grouped = {};
    for (let i = 0; i < rest.length; i += 2) {
      const url = rest[i];
      const freq = parseInt(rest[i + 1]);
      grouped[url] = freq;
    }
    global[term] = grouped; // Map<url, freq>
  }

  // 5. Merge the local index into the global index:
  // - For each term in the local index, if the term exists in the global index:
  //     - Merge by url so there is at most one entry per url.
  //     - Sum frequencies for duplicate urls.
  // - If the term does not exist in the global index:
  //     - Add it as a new entry with the local index's data.
  for (const term in local) {
    if (!global[term]) {
      global[term] = {};
    }
    for (const url in local[term]) {
      global[term][url] = (global[term][url] || 0) + local[term][url];
    }
  }

  // 6. Print the merged index to the console in the same format as the global index file:
  //    - Each line contains a term, followed by a pipe (`|`), followed by space-separated pairs of `url` and `freq`.
  //    - Terms should be printed in alphabetical order.
  const sortedTerms = Object.keys(global).sort();
  for (const term of sortedTerms) {
    const urlFreqPairs = [];
    for (const url in global[term]) {
      urlFreqPairs.push({url, freq: global[term][url]});
    }
    // Sort by frequency descending
    urlFreqPairs.sort(compare);
    
    const pairStr = urlFreqPairs.map((p) => `${p.url} ${p.freq}`).join(' ');
    console.log(`${term} | ${pairStr}`);
  }
};

// local: pizza | 3 | https://site/a
//        pasta | 1 | https://site/a
// i.e., what does this page contain? 
// global: pizza | https://site/b 2 https://site/c 5
// merged: pizza | https://site/a 3 https://site/c 5 https://site/b 2
//         pasta | https://site/a 11
// i.e., where does this term appear across all pages, with frequencies

/*
Overall, merge.js maintains the master search index for the crawler.
It waits until it has read the entire local index for one page from stdin.
It then reads the existing global index file from disk using the path passed on the command line.
Next, it parses both local and global data into in-memory maps so they’re easy to combine.
For each term, it merges URL–frequency counts, adding frequencies when the same term appears in the same URL again.
It sorts URLs by descending frequency and terms alphabetically to preserve the required index format.
Finally, it prints the updated global index to stdout so it can be saved as the new global-index.txt.
*/