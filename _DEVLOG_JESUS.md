12:00AM - Try workload locally before pushing to AWS for a bit
- ran with default params
- running with command for poster locally: 

```bash
node engine/run.js --seeds "https://en.wikipedia.org/wiki/Computer_science" --maxPages 100000 --nodes 5 --clean

# running previously successful pipeline to access query on old data



--skipCrawl --skipIndex 

# kill ports
for port in $(seq 7110 7150); do lsof -ti:$port | xargs -r kill -9; done
```

Index hanged at 1k pages (either that or i got impatient. tried with 5 nodes, doing 10 now)

1:00AM Check-in: Was able to run 1k version, but was very slow (took like 10 min 20 nodes).

Skipping to local benchmarks first to see if i can reduce this cuz ik AWS gonna be slower. 

1:00AM: GOAL: create benchmarks
Performance:
- end-to-end measurements and measurements of individual components
- throughput
latency
how long does it take for system to respond to query (latency)
- how many queries can it handle per second? (throughput)
how long does it take for sys to store and index page (latency)
-  how many pages can it store and index per sec (throughput)
- how long (latency) does distributed computation take (NLP, page ranking, etc) (OPTIONAL)
- over how many throughput elts (pages) per computation

visualize results with bar chart, one axis (base) is computation, other axis is latency or throughput
i want 2 graphs and a table
1 graph is latency vs components and end-to-end
1 graph is throughput vs compnoents and end-to-end
table shows total number of seconds end-to-end for completion and each component completion (cralwer, indexer, query)

note: moving end-to-end from graph to table so we can see each component seperately

2:00AM 
- benchmark on wikipedia, 15 nodes, 100 pages. NOte how the indexer has like 17k terms from the crawler
- discovered latency of indexer was 1407ms, while crawler was 101ms. In `indexer.js`, changing BATCH=50 to BATCH=500 to see if that will change it. I suspect that this latency is due to the amount of read/write operations we do and that increasing batch size before reading/writing will decrease latency
- bruh that did nothing


# IMPORTANT


Modified mr.js, but this is really important modification. 
BEFORE: shuffle sends one HTTP round-trip per KV-pair. This led to tens of thousands of HTTP requests!
AFTER: batch all pairs that we want to send to the same node. That way, we reduce the amount of RPC calls, reducing latency 10x


confirmed mapreduce crawl faster, set waves to 100