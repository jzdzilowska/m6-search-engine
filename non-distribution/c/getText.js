#!/usr/bin/env node

/*
Extract all text from an HTML page.
Usage: input > ./getText.js > output
*/
// so intended pipeline is cat page.html | ./getText.js
// html comes from stdin, text goes to stdout

const {convert} = require('html-to-text'); // node js imports other code via require
// from the html-to-text package, we import the convert function. From nodemodules
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
});

let html = '';

rl.on('line', (line) => {
  // 1. Read HTML input from standard input, line by line using the `readline` module.
  html += line + '\n';
});

// 2. after all input is received, use convert to output plain text.
rl.on('close', () => {
  const text = convert(html, {wordwrap: false});
  console.log(text);
});
