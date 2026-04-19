#!/bin/bash
# Tests that Porter stemmer correctly reduces words to their root forms

cd "$(dirname "$0")/../.." || exit 1

# Test basic stemming: running -> run, happily -> happili
result=$(echo -e "running\nhappily\njumping" | ./c/stem.js)
expected=$(echo -e "run\nhappili\njump")

if [ "$result" = "$expected" ]; then
    echo "$0 success: stem.js correctly stems words"
    exit 0
else
    echo "$0 failure: stem.js output mismatch" >&2
    echo "Expected: $expected" >&2
    echo "Got: $result" >&2
    exit 1
fi