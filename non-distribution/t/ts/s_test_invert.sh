#!/bin/bash
# Tests that terms are inverted with frequency counts

cd "$(dirname "$0")/../.." || exit 1

url="http://example.org"
# Input: word appearing twice
result=$(echo -e "apple\napple\nbanana" | ./c/invert.sh "$url" | grep "^apple ")

# Should have apple with freq 2
if echo "$result" | grep -q "| 2 |" && echo "$result" | grep -q "$url"; then
    echo "$0 success: invert.sh correctly counts term frequencies"
    exit 0
else
    echo "$0 failure: invert.sh output mismatch" >&2
    echo "Got: $result" >&2
    exit 1
fi
