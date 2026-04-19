#!/bin/bash
# Tests that text is normalized and stopwords are removed

cd "$(dirname "$0")/../.." || exit 1

# Test: uppercase to lowercase, remove stopwords ("the", "a", "is")
result=$(echo "The Quick Brown Fox" | ./c/process.sh | sort)
expected=$(echo -e "brown\nfox\nquick" | sort)

if [ "$result" = "$expected" ]; then
    echo "$0 success: process.sh correctly normalizes text and removes stopwords"
    exit 0
else
    echo "$0 failure: process.sh output mismatch" >&2
    echo "Expected: $expected" >&2
    echo "Got: $result" >&2
    exit 1
fi
