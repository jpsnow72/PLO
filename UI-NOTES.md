# UI-1 — Explore UI + solver wizard (first slice): lane notes

Branch: `ui-phase2-explore` (build-only; nothing pushed). Built per
`BRIEF-ui1-explore.md`, in the brief's priority order. **No `npm install`,
dev server, or build was run on this VM** (per constraints, and
`ui/node_modules` is absent), so TypeScript was written carefully and
reviewed by hand but **not compiler-checked — the coordinator's
verification host must run the first `npm install && npm run build`.**
There is no lockfile yet; `package.json` pins exact versions, and the
first install will generate `package-lock.json` (commit it then).

Two things *were* verified from here:

- `node --check api/server.mjs` passes (parse-level).
- The Explorer's navigation model was validated against the real fixture
  (`ui/public/sample-river-solve.json`) with a script: every node's every
  action resolves to either a child node or a legitimate hand-ending
  terminal, every node is reachable from the root, and every strategy row
  sums to 1. Turn-solve navigation follows the engine source
  (`plo-solve/src/turn.rs`, `json.rs`): river subtree roots live at
  `{turnHistory}|r:{Card}` and are told apart by the node's `river_card`.

## Per-item status

1. **`ui/` app skeleton — DONE.** React 18 + Vite 5 + TypeScript (strict)
   + Tailwind 3 + Zustand 4 + react-router 6. App shell with left nav
   (Dashboard, Explore, Tree Explorer, Solver, Preflop, Quick Review,
   Quiz, Heuristics, Settings), design tokens from the Stitch design
   (navy `#0A1628` family, green `#2E9E6B`, amber `#F5A623`) as Tailwind
   theme + CSS vars, engine-status indicator in the nav footer, and a
   local-only placeholder Login page (name in localStorage; clear copy
   that real accounts come with the sync ticket).

2. **Tree Explorer — DONE (centrepiece).** `src/lib/solveTree.ts` parses
   the engine solve JSON (typed, no `any` in the data layer; runtime
   shape guard) and indexes nodes by their engine `history` strings.
   Navigation is fully derived from the JSON: action labels are converted
   to history tokens exactly as `plo-solve` builds them
   (X/F/C/B(n)/BAI(n)/R(n)/RAI(n)). Three-column layout per the design:
   - Left: board (with the river card ring-highlighted inside turn
     solves), street / to-act / pot / to-call, and the line breadcrumb
     (click any step to jump back; Reset).
   - Centre: actions at the node with range-aggregate frequency bars
     (weighted by combo weight from the solve's `*_evs`), click to
     descend; runout picker when an action closes the turn street
     (chance node); terminal note for fold/showdown/all-in endings;
     range-EV summary.
   - Right: "colour by" action selector, 13×13-style range grid grouping
     combos by canonical class (two highest ranks), coloured by the
     selected action's frequency; class → combo list → hand detail
     (exact per-action frequencies, range weight, solve-level EV).
   - Accuracy badge shows the JSON's measured `nash_distance_pct`,
     labelled GTO (certified); the distinct amber `APPROXIMATION` badge
     style exists and is shown in the badge legend (reserved for the V2
     multiway lens — never applied to real data in this slice).
   - Dev-mode frequency sum check (console.warn only) runs at parse.
   - Turn-solve support is implemented (street/river_card fields,
     `|r:` subtree roots) but only exercised against the engine source —
     there is no turn fixture yet; see gaps.

3. **Solver wizard — DONE.** Two range textareas (comma/newline
   separated combos, `:weight` suffixes, validated client-side: real
   4-card combos, no board-card collisions) with quick-pick preset
   chips; board input with texture shortcut chips; pot + effective
   stacks; **bet/raise sizes defined separately per street** (flop /
   turn / river editors, up to 3 sizes each as % of pot, all-in toggle,
   raise cap 0–4); accuracy tier radio (Fast 0.5 / Balanced 0.25 /
   Precise 0.1% of pot → `target_exploitability_pct`, plus an iteration
   cap); rake % and rake cap fields present but **disabled, tagged V2**.
   Submits to the API, polls the job, and offers "Open in Explorer" on
   completion. Engine-offline fallback: clear banner + one-click into
   the bundled sample. Flop boards build a valid form submission; the
   API answers 422 (flop solver is E4) and the message is shown.

4. **`api/` job service — DONE.** Node stdlib only (`server.mjs`, zero
   dependencies). Endpoints: `POST /api/solves` (202 + job; routes by
   board size: 5 cards → `solve-river`, 4 → `solve-turn`, 3 → 422),
   `GET /api/solves/:id`, `GET /api/solves/:id/result`,
   `GET /api/jobs`, `GET /api/library`, `GET /api/library/:id`,
   `GET /api/health`. Jobs run serially; spot + result + `job.json`
   audit files under `DATA_DIR/jobs/<id>/`; finished results are copied
   to `DATA_DIR/library/` (with a `.meta.json` sidecar) so the library
   survives restarts. Job timeout via `JOB_TIMEOUT_MS`. `api/README.md`
   documents config (`PORT`, `HOST`, `ENGINE_BIN`, `DATA_DIR`) and the
   **no-auth / localhost-only** posture. (Added two small endpoints
   beyond the brief's three — `GET /api/jobs` and
   `GET /api/solves/:id/result` + `/api/library/:id` — because the
   Dashboard jobs panel and "Open in Explorer" need them.)

5. **Dashboard + Spot Picker — DONE (basic).** Dashboard: library list
   from the API with accuracy badges, coverage counts by street, jobs
   panel (status, Nash on completion, Open in Explorer). Offline →
   fixture fallback card built from the sample's real JSON + an
   "engine offline" notice. Spot Picker: texture-family cards
   (flush-heavy / paired / connected / dry, classified from each
   solve's board) listing the solves actually available (bundled sample
   + library); families with no solves say so and point at the Solver —
   no invented spots.

6. **Placeholders — DONE as stubs.** Preflop, Quick Review, Quiz,
   Heuristics, Settings render the layout skeleton with a
   "COMING IN A LATER TICKET" tag and honest bullet notes. No fake data.

## How to run (verification host)

```bash
# UI (from repo root)
cd ui
npm install            # first run generates package-lock.json
npm run build          # tsc --noEmit && vite build  (type-check gate)
npm run dev            # http://localhost:5173  (proxies /api -> :8787)

# Engine + API (for live solves; UI works standalone without them)
cd engine && cargo build --release     # produces solve-river / solve-turn
cd ../api && node server.mjs           # http://127.0.0.1:8787
# Optional: seed the library with the verified sample solve by copying a
# solve JSON into api/data/library/<id>.json, or just submit it via the
# wizard using the "Engine sample ranges" preset on board "As Ks Qs 7d 2c".
```

Click-through check: open `/explorer` — the bundled sample loads; the
OOP root aggregates (weighted by combo weight, computed from the
fixture) are Check 66.6%, Bet(33) 0%, Bet(75) 0%, BetAllIn 33.4% —
then descend a `Bet(33)` line, use the breadcrumb to go back, and
colour the grid by different actions.

## Decisions made in the lane

- **Per-action EV is not displayed — because the engine JSON doesn't
  contain it.** The engine reports EV per combo for the whole solve
  (`oop_evs`/`ip_evs`), not per action or per node. The centre column
  therefore shows range-aggregate *frequencies* (the brief's other
  requirement) plus solve-level range EVs, and hand detail shows the
  combo's solve-level EV, labelled as such. If per-action EV is wanted,
  the engine needs an output change (action EVs per node) — flagged for
  a future engine ticket rather than faked here.
- **Canonical class = the combo's two highest ranks** (the standard
  13×13-style grouping); suits are not part of the class key.
- **Turn all-in toggle:** the turn parser takes a single
  `include_all_in` for both streets, so the wizard ORs the turn and
  river toggles for turn spots. Per-street all-in needs an engine
  parser change (it already reads `turn_*`/`river_*` prefixed keys for
  sizes — `turn_include_all_in` would be the natural extension).
- **River spots use the river street editor's sizes only**, matching
  `parse_spot_json` (single `bet_sizes`/`raise_sizes`/`max_raises`).
- React Router `BrowserRouter` (dev-server friendly); if the app is
  later served as pure static files without rewrites, switch to
  `HashRouter` (one line in `src/main.tsx`).

## Known gaps

- **Not type-checked or built yet** (no node_modules on this VM, per
  constraints). Code was reviewed by hand for strict-mode issues
  (indexing, narrowing, unused imports), but the first
  `npm run build` on the verification host is the real gate.
- **No turn-solve fixture**: turn navigation is implemented from the
  engine source and unit-validated only in structure. Recommend the
  coordinator generate one (`solve-turn` on a small 4-card spot) and
  drop it at `ui/public/sample-turn-solve.json` for a click-through.
- **Library/job registry is per-process**: jobs submitted before an API
  restart vanish from `/api/jobs` (their results remain in the library
  and `job.json` audit files remain on disk).
- Range textarea does not support space-separated combo lists (combos
  themselves contain spaces, so entries must be comma/newline
  separated) — the helper text says so.
- The Explorer is desktop-first (3-column grid collapses to stacked
  sections on small screens); the true 390px phone experience is the
  Quick Review ticket, not this one.
- Accessibility: buttons/labels/focus-visible are in; a full AA audit
  (contrast of the faintest text on navy, grid keyboard navigation) is
  still owed.
