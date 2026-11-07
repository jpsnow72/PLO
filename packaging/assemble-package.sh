#!/usr/bin/env bash
# Assemble the portable local-runner package into
# packaging/dist/plo-runner/ — a folder that can be zipped as-is and
# unzipped anywhere on the target machine (paths with spaces are fine;
# nothing is installed and no admin rights are needed).
#
# Layout produced:
#   plo-runner/
#     start.bat  setup.bat  start.sh  INSTALL.md  runner-settings.txt
#     api/            job service (server + modules + README)
#     ui/dist/        built web UI (served by the API on the same origin)
#     engine-win/     Windows engine .exe files (when built)
#     engine-linux/   Linux engine binaries (Linux variant / testing)
#     node-win/       portable Node.js node.exe (checksum-verified)
#     data/preflop/   range sets + class table
#     data/library/   spot-catalog.json
#     local-data/     created empty; the runner's jobs/library/queue live here
#
# Hard prerequisites (the script stops with instructions when missing):
#   - ui/dist built:            cd ui && npm install && npm run build
#   - Linux engine built:       cd engine && cargo build --release
# Soft prerequisite:
#   - Windows engine:           packaging/build-windows-engine.sh
#     (missing .exe files produce a loud warning, not a stop: the
#     Linux variant of the package is still assembled for testing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT/packaging/dist"
PKG="$DIST_DIR/plo-runner"
BINARIES=(solve-river solve-turn solve-flop)
API_FILES=(server.mjs auth.mjs hash-password.mjs ranges-expand.mjs runner-login.mjs uploader.mjs README.md package.json)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# --- Prerequisites -----------------------------------------------------------
[[ -f "$ROOT/ui/dist/index.html" ]] || fail "ui/dist is missing. Build the UI first:
    cd \"$ROOT/ui\" && npm install && npm run build"

for bin in "${BINARIES[@]}"; do
  [[ -x "$ROOT/engine/target/release/$bin" ]] || fail "Linux engine binary missing: engine/target/release/$bin
  Build the engine first:
    cd \"$ROOT/engine\" && cargo build --release"
done

WIN_OK=1
for bin in "${BINARIES[@]}"; do
  [[ -f "$DIST_DIR/engine-win/$bin.exe" ]] || WIN_OK=0
done
if [[ "$WIN_OK" -ne 1 ]]; then
  echo "WARNING: packaging/dist/engine-win/ does not hold all of: ${BINARIES[*]} (.exe)" >&2
  echo "         The Windows package will NOT be able to solve until they exist." >&2
  echo "         Build them with: packaging/build-windows-engine.sh" >&2
  echo "         Continuing: the Linux variant is still assembled for testing." >&2
fi

# --- Assemble ----------------------------------------------------------------
# Guard the destructive step: only ever wipe our own package directory.
case "$PKG" in
  */packaging/dist/plo-runner) ;;
  *) fail "internal error: unexpected package path $PKG" ;;
esac
rm -rf "$PKG"
mkdir -p "$PKG/api" "$PKG/ui" "$PKG/engine-linux" "$PKG/data/library" "$PKG/local-data"

for f in "${API_FILES[@]}"; do
  cp "$ROOT/api/$f" "$PKG/api/$f"
done

cp -r "$ROOT/ui/dist" "$PKG/ui/dist"

for bin in "${BINARIES[@]}"; do
  cp "$ROOT/engine/target/release/$bin" "$PKG/engine-linux/$bin"
  chmod +x "$PKG/engine-linux/$bin"
done

if [[ "$WIN_OK" -eq 1 ]]; then
  mkdir -p "$PKG/engine-win"
  cp "$DIST_DIR"/engine-win/*.exe "$PKG/engine-win/"
  # Optional mingw runtime DLL placed there by build-windows-engine.sh.
  cp "$DIST_DIR"/engine-win/*.dll "$PKG/engine-win/" 2>/dev/null || true
fi

cp -r "$ROOT/data/preflop" "$PKG/data/preflop"
cp "$ROOT/data/library/spot-catalog.json" "$PKG/data/library/spot-catalog.json"

cp "$SCRIPT_DIR/templates/start.bat" "$PKG/start.bat"
cp "$SCRIPT_DIR/templates/setup.bat" "$PKG/setup.bat"
cp "$SCRIPT_DIR/templates/start.sh" "$PKG/start.sh"
cp "$SCRIPT_DIR/templates/INSTALL.md" "$PKG/INSTALL.md"
cp "$SCRIPT_DIR/templates/runner-settings.txt" "$PKG/runner-settings.txt"
chmod +x "$PKG/start.sh"

cat > "$PKG/local-data/README.txt" <<'EOF'
This folder is the runner's own data: the solve queue (queue.json),
finished solves (library/), job records (jobs/) and, once you connect
to a central library, runner-config.json (a login cookie - treat it
like a password). It is created by start.bat; this file only keeps the
folder present inside the zip.
EOF

# Portable Node for Windows (downloaded + checksum-verified).
"$SCRIPT_DIR/fetch-node-win.sh" "$PKG/node-win"

echo
echo "==> Package assembled at $PKG"
find "$PKG" -maxdepth 2 -type d | sort
echo
echo "Total size: $(du -sh "$PKG" | cut -f1)"
if [[ "$WIN_OK" -ne 1 ]]; then
  echo "NOTE: engine-win/ is EMPTY in this package (see warning above) - start.bat cannot solve on Windows yet."
fi
echo "Next: zip the plo-runner folder as-is, or test the Linux variant with $PKG/start.sh"
