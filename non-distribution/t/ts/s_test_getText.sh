#!/bin/bash
# Tests that HTML tags are stripped and text is extracted

cd "$(dirname "$0")/../.." || exit 1

# Basic HTML stripping
result=$(echo '<html><body><h1>Hello</h1><p>World</p></body></html>' | ./c/getText.js)

# Check that result contains "Hello" and "World" but no HTML tags
if echo "$result" | grep -qi "hello" && echo "$result" | grep -qi "world" && ! echo "$result" | grep -q "<"; then
    echo "$0 success: getText.js correctly extracts text from HTML"
    exit 0
else
    echo "$0 failure: getText.js did not extract text correctly" >&2
    exit 1
fi
