#!/usr/bin/env bash
# Download the official portable Node.js for Windows (x64) and place
# node.exe into the runner package, checksum-verified.
#
#   packaging/fetch-node-win.sh [dest-dir]
#     dest-dir defaults to packaging/dist/plo-runner/node-win
#
# The zip is verified against the official SHASUMS256.txt published
# with the same release before anything is extracted. A mismatch is a
# hard failure — a partial or unverified node.exe is never packaged.

set -euo pipefail

# --- Pinned Node version (single place to bump) ---
NODE_VERSION="22.11.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="${1:-$ROOT/packaging/dist/plo-runner/node-win}"

DIST_BASE="https://nodejs.org/dist/v${NODE_VERSION}"
ZIP_NAME="node-v${NODE_VERSION}-win-x64.zip"
ZIP_URL="${DIST_BASE}/${ZIP_NAME}"
SUMS_URL="${DIST_BASE}/SHASUMS256.txt"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v sha256sum >/dev/null 2>&1 || fail "sha256sum not found (coreutils)."

download() {
  # download <url> <out-file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    fail "neither curl nor wget is available to download Node."
  fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Downloading Node v${NODE_VERSION} (Windows x64) from nodejs.org"
download "$ZIP_URL" "$WORK_DIR/$ZIP_NAME"
download "$SUMS_URL" "$WORK_DIR/SHASUMS256.txt"

echo "==> Verifying SHA-256 against the official SHASUMS256.txt"
(
  cd "$WORK_DIR"
  grep " ${ZIP_NAME}\$" SHASUMS256.txt > node.zip.sha256
  [[ -s node.zip.sha256 ]] || fail "no checksum line for ${ZIP_NAME} in SHASUMS256.txt"
  sha256sum -c node.zip.sha256
)

echo "==> Extracting node.exe"
mkdir -p "$DEST_DIR"
MEMBER="node-v${NODE_VERSION}-win-x64/node.exe"
if command -v unzip >/dev/null 2>&1; then
  unzip -j -o "$WORK_DIR/$ZIP_NAME" "$MEMBER" -d "$WORK_DIR/extract" >/dev/null
  cp "$WORK_DIR/extract/node.exe" "$DEST_DIR/node.exe"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$WORK_DIR/$ZIP_NAME" "$MEMBER" "$DEST_DIR/node.exe" <<'PYEOF'
import sys, zipfile
zip_path, member, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zip_path) as zf:
    with zf.open(member) as src, open(out_path, "wb") as dst:
        dst.write(src.read())
PYEOF
else
  fail "neither unzip nor python3 is available to extract node.exe."
fi

SIZE=$(stat -c%s "$DEST_DIR/node.exe")
[[ "$SIZE" -gt 10000000 ]] || fail "extracted node.exe looks too small (${SIZE} bytes); refusing to package it."
echo "Done: $DEST_DIR/node.exe (${SIZE} bytes, Node v${NODE_VERSION}, checksum verified)"
