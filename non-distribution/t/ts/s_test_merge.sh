#!/bin/bash
# Tests that local index merges correctly with global index

cd "$(dirname "$0")/../.." || exit 1

# Create a temp global index
tmp_global=$(mktemp)
echo "apple | http://a.com 5" > "$tmp_global"

# Local index to merge (same term, different URL)
local_input="apple | 3 | http://b.com"

result=$(echo "$local_input" | ./c/merge.js "$tmp_global")
rm -f "$tmp_global"

# Should contain both URLs, sorted by frequency (5 > 3)
if echo "$result" | grep -q "apple |" && echo "$result" | grep -q "http://a.com 5" && echo "$result" | grep -q "http://b.com 3"; then
    echo "$0 success: merge.js correctly merges indices"
    exit 0
else
    echo "$0 failure: merge.js output mismatch" >&2
    echo "Got: $result" >&2
    exit 1
fi
