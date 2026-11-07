#!/usr/bin/env bash
# PLO GTO Study — local solve runner (Linux twin of start.bat).
#
# Starts the job service with the catalog solve queue enabled and
# opens the runner page in a browser when xdg-open is available.
# Uses the system `node` (v18+) and the package's engine-linux/
# binaries. Keep the terminal open while solving; Ctrl+C stops the
# server. Finished solves are safe either way (see INSTALL.md).

set -euo pipefail
cd "$(dirname "$0")"
PKG="$PWD"

# --- Range mode from runner-settings.txt (QUEUE_RANGE_MODE) ---
QUEUE_RANGE_MODE="top"
if [[ -f "$PKG/runner-settings.txt" ]]; then
  v="$(grep -E '^QUEUE_RANGE_MODE=' "$PKG/runner-settings.txt" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "${v:-}" ]] && QUEUE_RANGE_MODE="$v"
fi
export QUEUE_RANGE_MODE

# --- Admin password hash written by the setup step (local-env.txt) ---
if [[ -f "$PKG/local-env.txt" ]]; then
  h="$(grep -E '^ADMIN_PASSWORD_HASH=' "$PKG/local-env.txt" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "${h:-}" ]] && export ADMIN_PASSWORD_HASH="$h"
fi
if [[ -z "${ADMIN_PASSWORD_HASH:-}" ]]; then
  echo
  echo "  WARNING: no admin password is set (local-env.txt has no"
  echo "  ADMIN_PASSWORD_HASH). Queue/solve endpoints are OPEN on"
  echo "  port 8787. For the Linux variant, generate a hash with:"
  echo "      node api/hash-password.mjs"
  echo "  and store it as ADMIN_PASSWORD_HASH=... in local-env.txt."
  echo "  Continuing in local dev mode for now..."
  echo
fi

# --- Runtime configuration ---
export ENGINE_BIN="$PKG/engine-linux"
export DATA_DIR="$PKG/local-data"
export PREFLOP_DIR="$PKG/data/preflop"
export CATALOG_PATH="$PKG/data/library/spot-catalog.json"
export UI_DIR="$PKG/ui/dist"
export PORT=8787
export HOST=127.0.0.1
export QUEUE_ENABLED=1
# Library flop solves run for hours: 24 h per-solve cap.
export JOB_TIMEOUT_MS=86400000

mkdir -p "$DATA_DIR"

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node (v18+) is not on PATH — the Linux variant uses the system Node." >&2
  exit 1
}
[[ -x "$ENGINE_BIN/solve-river" ]] || {
  echo "ERROR: engine-linux/solve-river is missing — this package has no Linux engine." >&2
  exit 1
}

( sleep 3
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:8787/admin/runner" >/dev/null 2>&1 || true
  fi
) &

echo "Starting the PLO solve runner..."
echo "  Runner page: http://localhost:8787/admin/runner"
echo "  Keep this terminal open while solving. Press Ctrl+C to stop."
exec node "$PKG/api/server.mjs"
