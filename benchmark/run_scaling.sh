#!/usr/bin/env bash
# Run the benchmark at multiple node counts to measure scaling behavior.
# Produces a summary CSV consumed by plot_scaling.py.
#
# Usage:
#   ./benchmark/run_scaling.sh
#   # Then: python3 benchmark/plot_scaling.py benchmark/results/scaling_<ts>/

set -e

# ─── Configuration ───────────────────────────────────────────────────
SEEDS="https://en.wikipedia.org/wiki/Computer_science"
MAX_PAGES=1000
BASE_PORT=7110
QUERY_TERMS=(
    "Machine Learning" "Operating System" "Compiler Construction"
    "Cybersecurity" "Database Management" "Distributed Systems"
    "Software Testing" "Human-Computer Interaction" "Cloud Computing"
    "Parallel Computing" "Information Theory" "Virtual Machine"
    "Alan Turing" "Grace Hopper" "Edsger Dijkstra" "Ada Lovelace"
)
QUERY_RUNS=1000
WARMUP_QUERIES=2
IP="127.0.0.1"

NODE_COUNTS=(1 2 7 10 13 17 20 25 30 35)
# ─────────────────────────────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

TS=$(date -u +%Y-%m-%dT%H-%M-%S)
SCALING_DIR="$DIR/results/scaling_${TS}"
mkdir -p "$SCALING_DIR"

# Summary CSV header
SUMMARY="$SCALING_DIR/scaling_summary.csv"
echo "nodes,crawl_duration_ms,crawl_latency_ms,crawl_throughput,index_duration_ms,index_latency_ms,index_throughput,query_duration_ms,query_latency_ms,query_throughput,total_duration_ms" > "$SUMMARY"

echo "════════════════════════════════════════════════════════════"
echo " Scaling Benchmark — ${#NODE_COUNTS[@]} runs"
echo " Pages: <10 nodes → 500, ≥10 nodes → $MAX_PAGES | Query runs: $QUERY_RUNS"
echo " Node counts: ${NODE_COUNTS[*]}"
echo " Output: $SCALING_DIR"
echo "════════════════════════════════════════════════════════════"

for N in "${NODE_COUNTS[@]}"; do
  echo ""

  # Fewer pages for small clusters to avoid shuffle bottleneck
  if [ "$N" -lt 10 ]; then
    RUN_PAGES=500
  else
    RUN_PAGES=$MAX_PAGES
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Running with $N node(s) — $RUN_PAGES pages..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Kill leftover workers
  MAX_PORT=$((BASE_PORT + N + 5))
  for port in $(seq "$BASE_PORT" "$MAX_PORT"); do
    lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done
  # Also kill coordinator
  lsof -ti:1234 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 1

  ARGS=(
    --seeds "$SEEDS"
    --maxPages "$RUN_PAGES"
    --nodes "$N"
    --basePort "$BASE_PORT"
    --queryTerms "${QUERY_TERMS[*]}"
    --queryRuns "$QUERY_RUNS"
    --warmupQueries "$WARMUP_QUERIES"
    --ip "$IP"
    --clean
  )

  # Run benchmark, capture output
  OUTPUT=$(node "$DIR/benchmark.js" "${ARGS[@]}" 2>&1 | tee /dev/stderr) || {
    echo "[scaling] FAILED with $N nodes — skipping"
    continue
  }

  # Find the output directory
  OUT_DIR=$(echo "$OUTPUT" | grep -oP '(?<=Output dir : ).*')
  if [ -z "$OUT_DIR" ]; then
    echo "[scaling] Could not find output dir for N=$N — skipping"
    continue
  fi

  # Generate PDF for this individual run
  python3 "$DIR/plot.py" "$OUT_DIR" 2>/dev/null || true

  # Copy results.json into scaling dir for reference
  cp "$OUT_DIR/results.json" "$SCALING_DIR/results_n${N}.json" 2>/dev/null || true

  # Extract metrics from results.json and append to summary CSV
  python3 -c "
import json, sys
with open('$OUT_DIR/results.json') as f:
    m = json.load(f)
t = m.get('timings', {})
c = m.get('crawl', {})
ix = m.get('index', {})
q = m.get('query', {})
e2e = m.get('endToEnd', {})
print(','.join(str(x) for x in [
    $N,
    c.get('durationMs', ''),
    c.get('latencyPerPageMs', ''),
    c.get('pagesPerSec', ''),
    ix.get('durationMs', ''),
    ix.get('latencyPerDocMs', ''),
    ix.get('docsPerSec', ''),
    q.get('totalDurationMs', ''),
    q.get('overallAvgLatencyMs', ''),
    q.get('queriesPerSec', ''),
    e2e.get('durationMs', ''),
]))
" >> "$SUMMARY"

  echo "[scaling] N=$N done. Results in $OUT_DIR"
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo " Scaling benchmark complete!"
echo " Summary CSV: $SUMMARY"
echo " Generating scaling plots..."
echo "════════════════════════════════════════════════════════════"

python3 "$DIR/plot_scaling.py" "$SCALING_DIR"
echo "[scaling] All done. Results in: $SCALING_DIR"
