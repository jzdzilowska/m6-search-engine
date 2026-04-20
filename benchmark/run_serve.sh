#!/usr/bin/env bash
# Run benchmark_serve.js: benchmark pipeline + web server in one shot.
# Edit the config below, then just run: ./benchmark/run_serve.sh
#
# Any extra CLI args override the defaults below, e.g.:
#   ./benchmark/run_serve.sh --maxPages 200

set -e

# ─── Configuration (edit these) ──────────────────────────────────────
SEEDS="https://en.wikipedia.org/wiki/Computer_science"
MAX_PAGES=100000
NODES=20
BASE_PORT=7110
SERVER_PORT=3000
QUERY_TERMS=(
    "Machine Learning" "Operating System" "Compiler Construction"
    "Cybersecurity" "Database Management" "Distributed Systems"
    "Software Testing" "Human-Computer Interaction" "Cloud Computing"
    "Parallel Computing" "Information Theory" "Virtual Machine"
    "Alan Turing" "Grace Hopper" "Edsger Dijkstra" "Ada Lovelace"
)
QUERY_RUNS=1000
WARMUP_QUERIES=2
CLEAN=true          # wipe store before run
SKIP_CRAWL=false
SKIP_INDEX=false
IP="127.0.0.1"     # use private IP on AWS
# ─────────────────────────────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# Kill any leftover workers on default port range
for port in $(seq 7110 7160); do
  lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done
# Kill coordinator
lsof -ti:1234 2>/dev/null | xargs -r kill -9 2>/dev/null || true
# Kill server port
lsof -ti:"$SERVER_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true

# Join query terms with commas (JS splits on comma)
QUERY_TERMS_CSV=$(IFS=,; echo "${QUERY_TERMS[*]}")

# Build args from config
ARGS=(
  --seeds "$SEEDS"
  --maxPages "$MAX_PAGES"
  --nodes "$NODES"
  --basePort "$BASE_PORT"
  --serverPort "$SERVER_PORT"
  --queryTerms "$QUERY_TERMS_CSV"
  --queryRuns "$QUERY_RUNS"
  --warmupQueries "$WARMUP_QUERIES"
  --ip "$IP"
)
[[ "$CLEAN" == "true" ]] && ARGS+=(--clean)
[[ "$SKIP_CRAWL" == "true" ]] && ARGS+=(--skipCrawl)
[[ "$SKIP_INDEX" == "true" ]] && ARGS+=(--skipIndex)

# Extra CLI args ($@) override the config above
node "$DIR/benchmark_serve.js" "${ARGS[@]}" "$@"
