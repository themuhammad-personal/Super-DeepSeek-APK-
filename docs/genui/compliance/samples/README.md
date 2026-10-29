# Real model output samples (put them here)

This folder is intentionally empty in the source tree: **no live-model
compliance numbers have been measured yet**. Numbers must come from real
DeepSeek responses, never from hand-written fixtures.

How to collect (about 30–50 samples gives a useful first estimate):

1. In the app, ask a mix of visual and ordinary prompts (calculators, charts,
   games, posters, explanations, plain factual questions, Bangla and English).
2. Copy each **raw** assistant answer (DeepSeek "Copy" button keeps the
   markdown fences) into its own file here, e.g. `017-emi-bn.md`.
3. Add a short front-matter block on top:

   ```
   ---
   prompt: EMI ক্যালকুলেটর বানাও
   expect: visual      # or: prose
   ---
   ```
4. Run `npm run genui:compliance` — it writes
   `docs/genui/compliance/REPORT.md` and `report.json`.

Files whose front-matter has `synthetic: true` are excluded from the
reported numbers.
