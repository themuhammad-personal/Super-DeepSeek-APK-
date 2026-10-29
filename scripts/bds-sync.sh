#!/usr/bin/env bash
# ============================================================================
# bds-sync.sh — refresh the bundled better-deepseek engine from upstream.
#
# The engine bundle committed at
#   android/app/src/main/bds-assets/bds/
# is a SUPERSET of the public upstream build (EdgeTypE/better-deepseek
# v0.1.14): it carries this app's own patches (Super DeepSeek branding,
# android-target hardening, category-nav removal, …).  DO NOT blind-copy an
# upstream build over it — upstream lags behind.
#
# This script:
#   1. clones/updates upstream into .bds-upstream/ (git-ignored),
#   2. builds the android-target bundle,
#   3. compares it against the committed bundle and reports a DIFF SUMMARY
#      (identical injected.js/sandbox.js means the upstream core is in sync),
#   4. never overwrites the committed bundle on its own — review the diff,
#      port what's needed, then commit.
#
# Usage:  scripts/bds-sync.sh [--replace]
#   --replace  actually copies the fresh upstream build over the committed
#              bundle (only when you know upstream moved ahead of our fork).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="https://github.com/EdgeTypE/better-deepseek.git"
UPSTREAM_DIR="$ROOT/.bds-upstream"
BUNDLE_DIR="$ROOT/android/app/src/main/bds-assets/bds"
REPLACE=0
[[ "${1:-}" == "--replace" ]] && REPLACE=1

echo "▸ upstream: $UPSTREAM_URL"
if [[ -d "$UPSTREAM_DIR/.git" ]]; then
  git -C "$UPSTREAM_DIR" fetch --depth 1 origin main
  git -C "$UPSTREAM_DIR" reset --hard origin/main
else
  git clone --depth 1 "$UPSTREAM_URL" "$UPSTREAM_DIR"
fi

echo "▸ building android-target engine bundle…"
(cd "$UPSTREAM_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund >/dev/null 2>&1 \
  && npm run build:android >/dev/null)

SRC="$UPSTREAM_DIR/dist-android"
echo "▸ comparing fresh upstream build vs committed bundle:"
for f in content.js injected.js sandbox.js content.css sandbox.html; do
  a="$SRC/$f"; b="$BUNDLE_DIR/$f"
  if [[ ! -f "$a" ]]; then printf "   %-14s (missing upstream)\n" "$f"; continue; fi
  if [[ ! -f "$b" ]]; then printf "   %-14s (missing locally)\n" "$f"; continue; fi
  if cmp -s "$a" "$b"; then
    printf "   %-14s IDENTICAL\n" "$f"
  else
    printf "   %-14s differs  (upstream %s bytes / committed %s bytes)\n" "$f" "$(stat -c%s "$a")" "$(stat -c%s "$b")"
  fi
done

if [[ "$REPLACE" == 1 ]]; then
  echo "▸ --replace: copying upstream build over the committed bundle…"
  for f in content.js injected.js sandbox.js content.css sandbox.html static; do
    if [[ -e "$SRC/$f" ]]; then rm -rf "$BUNDLE_DIR/$f"; cp -r "$SRC/$f" "$BUNDLE_DIR/$f"; fi
  done
  echo "  ⚠ our-skin.css and any local-only files were kept. Re-run app tests."
else
  echo "▸ dry run only. Our committed bundle is a patched superset — port changes"
  echo "  deliberately (or pass --replace if upstream moved ahead of our fork)."
fi
