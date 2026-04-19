# non-distribution

This milestone aims (among others) to refresh (and confirm) everyone's
background on developing systems in the languages and libraries used in this
course.

By the end of this assignment you will be familiar with the basics of
JavaScript, shell scripting, stream processing, Docker containers, deployment
to AWS, and performance characterization—all of which will be useful for the
rest of the project.

Your task is to implement a simple search engine that crawls a set of web
pages, indexes them, and allows users to query the index. All the components
will run on a single machine.

## Getting Started

To get started with this milestone, run `npm install` inside this folder. To
execute the (initially unimplemented) crawler run `./engine.sh`. Use
`./query.js` to query the produced index. To run tests, do `npm run test`.
Initially, these will fail.

### Overview

The code inside `non-distribution` is organized as follows:

```
.
├── c            # The components of your search engine
├── d            # Data files like seed urls and the produced index
├── s            # Utility scripts for linting your solutions
├── t            # Tests for your search engine
├── README.md    # This file
├── crawl.sh     # The crawler
├── index.sh     # The indexer
├── engine.sh    # The orchestrator script that runs the crawler and the indexer
├── package.json # The npm package file that holds information like JavaScript dependencies
└── query.js     # The script you can use to query the produced global index
```

### Submitting

To submit your solution, run `./scripts/submit.sh` from the root of the stencil. This will create a
`submission.zip` file which you can upload to the autograder.



### Summary

> Summarize your implementation, including the most challenging aspects; remember to update the `report` section of the `package.json` file with the total number of hours it took you to complete M0 (`hours`), the total number of JavaScript lines you added, including tests (`jsloc`), the total number of shell lines you added, including for deployment and testing (`sloc`).
My implementation completes M0 using 6 core components and 9 tests - the JS programs handle word stemming (`stem.js`), HTML-to-text conversion (`getText.js`), link discovery (`getURLs.js`), merging per-page indices into a global index (`merge.js`), and searching the index (`query.js`); more in-depth walkthrough is provided in the comments of aforementioned files. The shell script (`process.sh`) cleans raw text by lowercasing it, splitting it into one word per line, converting to ASCII, and removing stopwords so downstream components always see a simple, consistent stream of terms.

The most challenging part was `merge.js`, as it was difficult to translate between two different index formats (i.e., the local index produced for a single page (`term | freq | url`) and the global index that stores all URLs and frequencies for each term), especially with having just started acquainting myself with the codebase, and not yet being certain of how inputs/outputs of all components connect. Implementing this required merging counts by term and URL without duplication, and re-emitting the result in a sorted, stable format - forced me to think clearly about data flow. I also had to re-familiarize myself with Node's stdin-driven execution model and with shell pipelines in `process.sh`, especially how Unix tools communicate purely through streams.


## Correctness & Performance Characterization


> Describe how you characterized the correctness and performance of your implementation.
*Correctness* was validated by writing 9 tests that individually exercise each component in isolation (stemming, text extraction, URL extraction, normalization, local index creation, global index merging) to ensure that every stage produces output in exactly the format expected by the next one in the pipeline. I've written these tests after having completed all required JavaScript components for M0, rather than incrementally after finishing each individual component.

*Performance* was measured by running the crawler, indexer, and query components on AWS instance and locally, and recording throughput values, which are documented in the `"throughput"` section of `package.json`. 


## Wild Guess

> How many lines of code do you think it will take to build the fully distributed, scalable version of your search engine? Add that number to the `"dloc"` portion of package.json, and justify your answer below.
Approximately 5000 lines, accounting for distributed communication protocols (~1000 lines?), consensus and fault tolerance (~1000 lines), distributed storage/indexing (~1000 lines), mapred framework (~1000 lines), and testing/utilities (~1000 lines).
