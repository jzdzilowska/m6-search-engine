#!/usr/bin/env node

/*
Convert each term to its stem
Usage: input > ./stem.js > output
*/

const readline = require('readline');
const natural = require('natural');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', function(line) { // every time a new line appears in stdin
  // line is one term only, from process? 
  // Print the Porter stem from `natural` for each element of the stream.
  console.log(natural.PorterStemmer.stem(line)); // write stemmed word to stdout
});
