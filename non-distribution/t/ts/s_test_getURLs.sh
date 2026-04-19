#!/bin/bash
# Tests that URLs are extracted and resolved to absolute paths

cd "$(dirname "$0")/../.." || exit 1

base_url="https://example.com/page/"
html='<html><body><a href="link.html">Link</a><a href="/root.html">Root</a></body></html>'

result=$(echo "$html" | ./c/getURLs.js "$base_url")

# Should contain absolute URLs
if echo "$result" | grep -q "https://example.com/page/link.html" && echo "$result" | grep -q "https://example.com/root.html"; then
    echo "$0 success: getURLs.js correctly extracts and resolves URLs"
    exit 0
else
    echo "$0 failure: getURLs.js output mismatch" >&2
    echo "Got: $result" >&2
    exit 1
fi
