#!/usr/bin/env bash
# Ticket E5a benchmark: single-thread vs N-thread wall time at fixed
# iterations on the canonical E4 flop spot (measure-flop's
# `canonical` board, exact bucketing, 200 combos/side).
#
# Usage (run on the build host, from anywhere):
#   cargo build --release -p plo-solve --bin measure-flop   # once
#   ITERS=120 THREADS_LIST="1 6" ./bench-e5a.sh
#
# Environment:
#   ITERS        DCFR iterations per run (default 120, the E4 default;
#                ~3.6 s/iter single-threaded was the E4 measurement, so
#                120 iters ~ 7 min for the 1-thread run — lower ITERS for
#                a smoke check, raise it for a stable ratio)
#   THREADS_LIST Space-separated thread counts (default "1 $(nproc)")
#   BIN          measure-flop binary path (default: target/release
#                relative to this script's directory)
#
# Expected output: one `RESULT canonical K=exact iters=<n> wall=<s>s
# per_1k_iters=<s>s checker_nash=<x>% of pot ...` line per thread count,
# followed by this script's `SPEEDUP threads=<t> wall=<s>s speedup=<r>x`
# summary lines. The checker_nash values must agree across thread counts
# (the E5a design is bit-identical; expect agreement to all printed
# digits). Speedup on the coordinator's 6-vCPU host should land in the
# ~3-5x range at 6 threads (Amdahl: flop-street traversal, iteration
# setup, and the final checker pass stay sequential).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${BIN:-$SCRIPT_DIR/target/release/measure-flop}"
ITERS="${ITERS:-120}"
THREADS_LIST="${THREADS_LIST:-1 $(nproc)}"

if [[ ! -x "$BIN" ]]; then
    echo "measure-flop binary not found at $BIN" >&2
    echo "build it first: cargo build --release -p plo-solve --bin measure-flop" >&2
    exit 1
fi

declare -a THREADS_ARR=($THREADS_LIST)
declare -A WALLS

for t in "${THREADS_ARR[@]}"; do
    echo "=== PLO_SOLVER_THREADS=$t, iters=$ITERS ==="
    out="$(PLO_SOLVER_THREADS="$t" "$BIN" solve canonical exact "$ITERS")"
    echo "$out"
    wall="$(echo "$out" | sed -n 's/.*wall=\([0-9.]*\)s.*/\1/p' | tail -1)"
    WALLS[$t]="$wall"
done

base_threads="${THREADS_ARR[0]}"
base_wall="${WALLS[$base_threads]}"
echo "=== summary (baseline: $base_threads thread(s), wall ${base_wall}s) ==="
for t in "${THREADS_ARR[@]}"; do
    w="${WALLS[$t]}"
    speedup="$(awk -v b="$base_wall" -v w="$w" 'BEGIN { printf "%.2f", b / w }')"
    echo "SPEEDUP threads=$t wall=${w}s speedup=${speedup}x"
done
