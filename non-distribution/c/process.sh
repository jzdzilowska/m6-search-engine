#!/bin/bash

# Convert input to a stream of non-stopword terms
# Usage: input > ./process.sh > output

# Convert non-letter characters to newlines, make lowercase, convert to ASCII; then remove stopwords (inside d/stopwords.txt)
# Non-letter characters include things like ©, ®, and ™ as well!
#
# Commands that will be useful: tr, iconv, grep
# Tip: Make sure your program doesn't emit a non-zero exit code if there are no words left after removing stopwords.
# You can combine the grep invocation with `|| true` to achieve this. Be careful though, as this will also hide other errors!

tr -cs '[:alpha:]' '\n' | tr '[:upper:]' '[:lower:]' | iconv -c -t ASCII | grep -vxFf d/stopwords.txt || true
# replace non letters with newlines
# make lowercase
# convert to ascii, removing non-ascii characters
# remove stopwords using grep -v (invert match), -x (whole line), -
# f (file with patterns)
# if no words left, don't error out