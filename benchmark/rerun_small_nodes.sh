#!/usr/bin/env bash
# Rerun benchmark for 1, 2, 7 nodes with 1000 pages and update
# the aws-benchmark scaling_summary.csv in-place.
#
# Usage:
#   ./benchmark/rerun_small_nodes.sh

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

NODE_COUNTS=(1 2 7)
# ─────────────────────────────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
AWS_DIR="$DIR/results/aws-benchmark"
SUMMARY="$AWS_DIR/scaling_summary.csv"

if [ ! -f "$SUMMARY" ]; then
  echo "Error: $SUMMARY not found"
  exit 1
fi

echo "════════════════════════════════════════════════════════════"
echo " Rerunning nodes ${NODE_COUNTS[*]} with $MAX_PAGES pages"
echo " Will update: $SUMMARY"
echo "════════════════════════════════════════════════════════════"

for N in "${NODE_COUNTS[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Running with $N node(s) — $MAX_PAGES pages..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Kill leftover workers
  MAX_PORT=$((BASE_PORT + N + 5))
  for port in $(seq "$BASE_PORT" "$MAX_PORT"); do
    lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done
  lsof -ti:1234 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 1

  ARGS=(
    --seeds "$SEEDS"
    --maxPages "$MAX_PAGES"
    --nodes "$N"
    --basePort "$BASE_PORT"
    --queryTerms "${QUERY_TERMS[*]}"
    --queryRuns "$QUERY_RUNS"
    --warmupQueries "$WARMUP_QUERIES"
    --ip "$IP"
    --clean
  )

  OUTPUT=$(node "$DIR/benchmark.js" "${ARGS[@]}" 2>&1 | tee /dev/stderr) || {
    echo "[rerun] FAILED with $N nodes — skipping"
    continue
  }

  OUT_DIR=$(echo "$OUTPUT" | grep -oP '(?<=Output dir : ).*')
  if [ -z "$OUT_DIR" ]; then
    echo "[rerun] Could not find output dir for N=$N — skipping"
    continue
  fi

  # Copy results.json into aws-benchmark dir
  cp "$OUT_DIR/results.json" "$AWS_DIR/results_n${N}.json" 2>/dev/null || true

  # Extract new CSV row
  NEW_ROW=$(python3 -c "
import json
with open('$OUT_DIR/results.json') as f:
    m = json.load(f)
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
")

  # Replace the matching row in scaling_summary.csv (match by first field = node count)
  python3 -c "
import csv, sys

new_row = '$NEW_ROW'.split(',')
node_count = new_row[0]

lines = open('$SUMMARY').readlines()
with open('$SUMMARY', 'w') as f:
    for line in lines:
        if line.strip().startswith(node_count + ','):
            f.write(','.join(new_row) + '\n')
        else:
            f.write(line)
"

  echo "[rerun] N=$N done — updated $SUMMARY"
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo " Reruns complete! Regenerating plots..."
echo "════════════════════════════════════════════════════════════"

python3 "$DIR/plot_scaling.py" "$AWS_DIR"
echo "[rerun] All done. Updated: $SUMMARY"
