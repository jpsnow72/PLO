#!/usr/bin/env bash
# Build the Windows engine binaries the job
# service needs, into packaging/dist/engine-win/.
#
# The API invokes exactly three engine binaries (see api/server.mjs:
# job kind -> binary name): solve-river, solve-turn, solve-flop.
# build-ranges / measure-flop are data/benchmark tools and are NOT
# part of the runner package.
#
# Prerequisites (checked up front; the script fails loudly with the
# exact missing piece instead of producing a partial package):
#   - rustup + cargo
#   - the Rust target in $TARGET below (this script adds it)
#   - a mingw-w64 cross toolchain on PATH. Two supported flavours:
#       * GCC: Debian/Ubuntu: sudo apt-get install -y gcc-mingw-w64-x86-64
#         (works with the gnu target)
#       * LLVM-MinGW (user-local tarball, no sudo): REQUIRED for the
#         default gnullvm target - rustc's gnu link line asks for
#         -lgcc/-lgcc_eh, which LLVM-MinGW does not provide; the
#         gnullvm target is Rust's LLVM-MinGW target and links cleanly
#         (verified 2026-11-07 on finch-gate with llvm-mingw ucrt).
#
# Static-runtime note: the link uses -static-libgcc/-static-libstdc++
# so the .exe files do not need mingw runtime DLLs beside them for the
# C/C++ runtimes. If a libwinpthread-1.dll exists in the mingw sysroot
# it is copied alongside anyway (harmless, covers pthread-using deps).

set -euo pipefail

TARGET="${PLO_WIN_TARGET:-x86_64-pc-windows-gnullvm}"
LINKER="${PLO_WIN_LINKER:-x86_64-w64-mingw32-clang}"
BINARIES=(solve-river solve-turn solve-flop)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/packaging/dist/engine-win"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v rustup >/dev/null 2>&1 || fail "rustup not found. Install Rust from https://rustup.rs and re-run."
command -v cargo >/dev/null 2>&1 || fail "cargo not found (rustup is present but cargo is not on PATH)."

if ! command -v "$LINKER" >/dev/null 2>&1; then
  fail "mingw-w64 cross linker '$LINKER' not found.
  GCC route: sudo apt-get install -y gcc-mingw-w64-x86-64
    (then re-run with PLO_WIN_TARGET=x86_64-pc-windows-gnu PLO_WIN_LINKER=x86_64-w64-mingw32-gcc)
  LLVM-MinGW route: extract the llvm-mingw ucrt ubuntu tarball and put its bin/ on PATH."
fi

echo "==> Ensuring Rust target $TARGET"
rustup target add "$TARGET"

echo "==> Cross-compiling engine binaries for $TARGET"
cd "$ROOT/engine"
CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER="$LINKER" \
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$LINKER" \
RUSTFLAGS="-C link-args=-static-libgcc -C link-args=-static-libstdc++" \
  cargo build --release --target "$TARGET" \
    --bin solve-river --bin solve-turn --bin solve-flop

RELEASE_DIR="$ROOT/engine/target/$TARGET/release"
mkdir -p "$OUT_DIR"
for bin in "${BINARIES[@]}"; do
  src="$RELEASE_DIR/$bin.exe"
  [[ -f "$src" ]] || fail "expected build output missing: $src"
  cp "$src" "$OUT_DIR/$bin.exe"
  echo "    copied $bin.exe ($(stat -c%s "$OUT_DIR/$bin.exe") bytes)"
done

# Belt-and-braces: ship runtime DLLs the .exe imports if the sysroot
# has them. The gnullvm build imports libunwind.dll (REQUIRED beside
# the exes); GCC builds may need libwinpthread-1.dll. Check the real
# dependency list with objdump before shipping.
MINGW_BIN_DIR="$(dirname "$(command -v "$LINKER")")/../x86_64-w64-mingw32/bin"
for dll in libunwind.dll libwinpthread-1.dll; do
  if [[ -f "$MINGW_BIN_DIR/$dll" ]]; then
    cp "$MINGW_BIN_DIR/$dll" "$OUT_DIR/"
    echo "    copied $dll (mingw sysroot)"
  fi
done

if command -v file >/dev/null 2>&1; then
  echo "==> Output file types:"
  file "$OUT_DIR"/*.exe
fi
echo "Done: Windows engine binaries are in $OUT_DIR"
