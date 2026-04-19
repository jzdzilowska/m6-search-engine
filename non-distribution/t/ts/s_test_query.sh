#!/bin/bash
# Tests that query returns matching lines from global index

cd "$(dirname "$0")/../.." || exit 1

# Setup: create a test global index with non-stopword terms
cp d/global-index.txt d/global-index.txt.bak 2>/dev/null || true
echo "appl | http://example.com 5" > d/global-index.txt
echo "banana | http://other.com 3" >> d/global-index.txt

# Query for "apple" (will be stemmed to "appl")
result=$(./query.js apple)

# Restore original
mv d/global-index.txt.bak d/global-index.txt 2>/dev/null || rm -f d/global-index.txt

# Should find the "appl" line
if echo "$result" | grep -q "appl |" && echo "$result" | grep -q "http://example.com"; then
    echo "$0 success: query.js correctly searches the index"
    exit 0
else
    echo "$0 failure: query.js did not return expected results" >&2
    echo "Got: $result" >&2
    exit 1
fi
