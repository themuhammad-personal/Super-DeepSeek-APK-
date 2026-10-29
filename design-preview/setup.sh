#!/usr/bin/env bash
# ============================================================================
# design-preview/setup.sh — assemble the design preview harness.
#
# Copies the CURRENT engine CSS + our skin from the app bundle and extracts
# the engine's runtime-injected Svelte styles from content.js, reproducing the
# exact cascade the APK ships:
#
#   content.css (engine base) → our-skin.css (our frame) → runtime-styles.css
#
# Run once after cloning and after any engine bundle update:
#   design-preview/setup.sh && python3 -m http.server 8080 --directory design-preview
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BDS="$ROOT/android/app/src/main/bds-assets/bds"
PREV="$ROOT/design-preview"

cp "$BDS/content.css" "$BDS/our-skin.css" "$BDS/sd-genui.css" "$PREV/"

node -e '
const fs = require("fs");
const s = fs.readFileSync(process.argv[1], "utf8");
const out = [];
let i = 0;
while (true) {
  const a = s.indexOf("`", i);
  if (a < 0) break;
  const b = s.indexOf("`", a + 1);
  if (b < 0) break;
  const seg = s.slice(a + 1, b);
  if (seg.includes(".svelte-") && seg.includes("{") && seg.length > 200 && !seg.includes("${") && !/\bX\(|=>|\bfunction\b|\bconst\b/.test(seg)) out.push(seg);
  i = b + 1;
}
// Svelte component styles: {hash:"svelte-x",code:`…`}
const re = /\{hash:"svelte-[a-z0-9]+",code:`/g; let m;
while ((m = re.exec(s))) { const st = m.index + m[0].length, en = s.indexOf("`", st); const seg = s.slice(st, en); if (!out.includes(seg) && !/\bX\(|=>|\bfunction\b|\bconst\b/.test(seg)) out.push(seg); }
fs.writeFileSync(process.argv[2], out.join("\n"));
console.log("runtime style blocks extracted:", out.length);
' "$BDS/content.js" "$PREV/runtime-styles.css"

echo "✔ harness ready — open design-preview/preview.html"
