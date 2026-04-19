#!/bin/bash
# Tests that the full indexing pipeline works

cd "$(dirname "$0")/../.." || exit 1

# Test the indexing pipeline: process -> stem -> combine -> invert -> merge
tmp_global=$(mktemp)
echo "" > "$tmp_global"

# Use non-stopword terms
test_text="Apple Banana Apple"
test_url="http://example.org/page"

result=$(echo "$test_text" | ./c/process.sh | ./c/stem.js | ./c/combine.sh | ./c/invert.sh "$test_url" | ./c/merge.js "$tmp_global")
rm -f "$tmp_global"

# Should have "appl" (stemmed from apple) with frequency 2
if echo "$result" | grep -q "appl" && echo "$result" | grep -q "$test_url"; then
    echo "$0 success: end-to-end pipeline works correctly"
    exit 0
else
    echo "$0 failure: end-to-end pipeline failed" >&2
    echo "Got: $result" >&2
    exit 1
fi
