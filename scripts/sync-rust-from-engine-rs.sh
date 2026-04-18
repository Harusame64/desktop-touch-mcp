#!/usr/bin/env bash
# One-shot monorepo migration: copy Rust engine sources from the sibling
# desktop-touch-engine-rs working tree into this repo's root, preserving
# TS coexistence. Safe to re-run (idempotent — it overwrites).
#
# Excludes (never copied):
#   .git/, target/, node_modules/, *.node, libnode.*, node.def, node.lib,
#   .vitest-out.*, package.json, package-lock.json, tsconfig.json, TS sources
#   under src/, docs/, CHANGELOG, README*, CLAUDE.md, LICENSE, SECURITY.md,
#   server.json, glama.json, .gitignore, Dockerfile, tests/ (fold1 has its own).
#
# Includes (copied):
#   Cargo.toml, Cargo.lock, build.rs, .cargo/config.toml
#   src/{dhash,lib,pixel_diff}.rs, src/uia/*.rs
#   index.d.ts, index.js (napi bindings)
#   __test__/*.spec.ts  (TS tests for the native addon)

set -euo pipefail

SRC=/d/git/desktop-touch-engine-rs
DST=/d/git/desktop-touch-mcp

test -d "$SRC" || { echo "ERROR: source repo not found: $SRC"; exit 1; }
test -f "$DST/package.json" || { echo "ERROR: $DST does not look like the MCP repo"; exit 1; }

copy_file() {
  local rel="$1"
  local src_path="$SRC/$rel"
  local dst_path="$DST/$rel"
  test -e "$src_path" || { echo "  skip (not in source): $rel"; return 0; }
  mkdir -p "$(dirname "$dst_path")"
  cp -f "$src_path" "$dst_path"
  echo "  file : $rel"
}

copy_dir() {
  local rel="$1"
  local src_path="$SRC/$rel"
  local dst_path="$DST/$rel"
  test -d "$src_path" || { echo "  skip (not in source): $rel/"; return 0; }
  mkdir -p "$dst_path"
  # Copy contents (including hidden), no overwrite of unrelated neighbors
  cp -Rf "$src_path/." "$dst_path/"
  echo "  dir  : $rel/"
}

echo "=== Rust crate files ==="
copy_file "Cargo.toml"
copy_file "Cargo.lock"
copy_file "build.rs"
copy_dir  ".cargo"

echo "=== Rust sources under src/ ==="
copy_file "src/dhash.rs"
copy_file "src/lib.rs"
copy_file "src/pixel_diff.rs"
copy_dir  "src/uia"

echo "=== napi-rs bindings (JS/TS surface of the native addon) ==="
copy_file "index.d.ts"
copy_file "index.js"

echo "=== TS specs for the native addon ==="
copy_dir  "__test__"

echo
echo "=== Done ==="
echo "Remember:"
echo "  - Add Rust build artefacts to .gitignore (target/, *.node, libnode.*, node.def, node.lib)"
echo "  - Merge napi config into desktop-touch-mcp/package.json if you want single-package build"
