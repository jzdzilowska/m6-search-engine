#!/usr/bin/env bash
# Run benchmark and generate PDF report in one shot.
# Edit the config below, then just run: ./benchmark/run.sh
#
# Any extra CLI args override the defaults below, e.g.:
#   ./benchmark/run.sh --maxPages 200

set -e

# ─── Configuration (edit these) ──────────────────────────────────────
SEEDS="https://en.wikipedia.org/wiki/Computer_science"
MAX_PAGES=100
NODES=15
BASE_PORT=7110
QUERY_TERMS=(
    "Machine Learning" "Operating System" "Compiler Construction" 
    "Cybersecurity" "Database Management" "Distributed Systems" 
    "Software Testing" "Human-Computer Interaction" "Cloud Computing"
    "Parallel Computing" "Information Theory" "Virtual Machine"
)
QUERY_RUNS=100
WARMUP_QUERIES=2
CLEAN=true          # wipe store before run
SKIP_CRAWL=false
SKIP_INDEX=false
IP="127.0.0.1"     # use private IP on AWS
# ─────────────────────────────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# Kill any leftover workers on default port range
for port in $(seq 7110 7130); do
  lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

# Build args from config
ARGS=(
  --seeds "$SEEDS"
  --maxPages "$MAX_PAGES"
  --nodes "$NODES"
  --basePort "$BASE_PORT"
  --queryTerms "${QUERY_TERMS[@]}"
  --queryRuns "$QUERY_RUNS"
  --warmupQueries "$WARMUP_QUERIES"
  --ip "$IP"
)
[[ "$CLEAN" == "true" ]] && ARGS+=(--clean)
[[ "$SKIP_CRAWL" == "true" ]] && ARGS+=(--skipCrawl)
[[ "$SKIP_INDEX" == "true" ]] && ARGS+=(--skipIndex)

# Run benchmark — capture output to find the results directory
# Extra CLI args ($@) override the config above
OUTPUT=$(node "$DIR/benchmark.js" "${ARGS[@]}" "$@" 2>&1 | tee /dev/stderr)

# Extract the output directory from benchmark.js output
OUT_DIR=$(echo "$OUTPUT" | grep -oP '(?<=Output dir : ).*')

if [ -z "$OUT_DIR" ]; then
  echo "[run.sh] Could not determine output directory"
  exit 1
fi

echo ""
echo "[run.sh] Generating PDF report..."
python3 "$DIR/plot.py" "$OUT_DIR"
echo "[run.sh] Done. Results in: $OUT_DIR"
