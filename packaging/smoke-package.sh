#!/usr/bin/env bash
# Boot smoke for the assembled runner package (#35).
#
# Boots the packaged api/server.mjs briefly with the system node, a
# scratch DATA_DIR and a test port, and requires GET /api/health to
# return HTTP 200 with "ok":true and "queue_enabled":true (the smoke
# configures QUEUE_ENABLED=1, mirroring start.sh / start.bat). The
# server is then shut down and the scratch dir removed.
#
# Why this exists: the v2 runner package (Nov 2026) was assembled and
# delivered without its server ever being booted — it was missing three
# runtime modules and could not start at all. No package is deliverable
# until this smoke passes against the assembled tree.
#
# Usage:
#   packaging/smoke-package.sh [PKG_DIR]
#     PKG_DIR defaults to packaging/dist/plo-runner (the assemble
#     output). SMOKE_PORT overrides the test port (default 8799).
#
# Runs on Linux (the coordinator runs it on the VPS after assembling).
# Requires: node (v18+) and curl on PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="${1:-$ROOT/packaging/dist/plo-runner}"
PORT="${SMOKE_PORT:-8799}"

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

[[ -f "$PKG/api/server.mjs" ]] || fail "no api/server.mjs under $PKG — assemble the package first (packaging/assemble-package.sh)."
command -v node >/dev/null 2>&1 || fail "node is not on PATH."
command -v curl >/dev/null 2>&1 || fail "curl is not on PATH."

SCRATCH="$(mktemp -d)"
LOG="$SCRATCH/server.log"
SRV_PID=""

cleanup() {
  if [[ -n "$SRV_PID" ]]; then
    kill "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# Runtime configuration mirrors packaging/templates/start.sh, pointed at
# the scratch data dir and the test port.
ENGINE_BIN="$PKG/engine-linux" \
DATA_DIR="$SCRATCH/data" \
PREFLOP_DIR="$PKG/data/preflop" \
CATALOG_PATH="$PKG/data/library/spot-catalog.json" \
UI_DIR="$PKG/ui/dist" \
PORT="$PORT" \
HOST="127.0.0.1" \
QUEUE_ENABLED=1 \
JOB_TIMEOUT_MS=86400000 \
  node "$PKG/api/server.mjs" >"$LOG" 2>&1 &
SRV_PID=$!

BODY=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "--- packaged server log ---" >&2
    cat "$LOG" >&2
    fail "the packaged server exited during boot (log above)."
  fi
  if BODY="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    break
  fi
  BODY=""
  sleep 0.5
done
[[ -n "$BODY" ]] || { echo "--- packaged server log ---" >&2; cat "$LOG" >&2; fail "GET /api/health never returned 200 within 30s."; }

grep -q '"ok":true' <<<"$BODY" || fail "health payload lacks \"ok\":true — got: $BODY"
grep -q '"queue_enabled":true' <<<"$BODY" || fail "health payload lacks \"queue_enabled\":true (smoke sets QUEUE_ENABLED=1) — got: $BODY"

echo "SMOKE PASS: $PKG booted; GET /api/health -> $BODY"
