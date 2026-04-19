#!/bin/bash
# Tests that n-grams (1,2,3) are generated correctly

cd "$(dirname "$0")/../.." || exit 1

# Input: a b c -> should produce unigrams, bigrams, trigrams
result=$(echo -e "a\nb\nc" | ./c/combine.sh | sort)

# Should contain: a, b, c (unigrams), a b, b c (bigrams), a b c (trigram)
if echo "$result" | grep -q "^a$" && echo "$result" | grep -q "a	b" && echo "$result" | grep -q "a	b	c"; then
    echo "$0 success: combine.sh generates n-grams correctly"
    exit 0
else
    echo "$0 failure: combine.sh output mismatch" >&2
    echo "Got: $result" >&2
    exit 1
fi
