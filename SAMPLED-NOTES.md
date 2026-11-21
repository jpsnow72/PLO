# SAMPLED — sampling is the default trim + the SAMPLED chip (PLO #11)

Justin's decisions (2026-11-21): frequency-weighted **sampling** is the
default range-trimming policy for catalog solves (replacing the
top-slice), and sampled solves carry a visible **SAMPLED · NN%** chip in
the Library and the Explorer. Built on main 8f908e3 content (1b865f7 +
the #35 win35-fix merge).

## 1. Defaults changed — every site

`top` remains selectable everywhere it was before (env var, settings
file, per-request `*_range_mode`); only the DEFAULT moved to `sample`.

| Site | Was | Now |
| --- | --- | --- |
| `api/server.mjs` — `QUEUE_RANGE_MODE` env fallback | `?? 'top'` | `?? 'sample'` |
| `api/server.mjs` — per-request capped set expansion (`spot[<side>_range_mode]` fallback in POST /api/solves) | `?? 'top'` | `?? 'sample'` |
| `api/ranges-expand.mjs` — `expandRangeSetCapped` `mode` parameter default (+ its JSDoc) | `'top'` | `'sample'` |
| `packaging/templates/runner-settings.txt` — shipped `QUEUE_RANGE_MODE=` value; comment now marks sample "(default)" | `top` | `sample` |
| `packaging/templates/start.bat` — fallback when the settings file/setting is absent (+ its comment line) | `top` | `sample` |
| `packaging/templates/start.sh` — same fallback | `top` | `sample` |
| `packaging/templates/INSTALL.md` — "Range trimming" section | "`top` (default)" | "`sample` (default)", top listed second |
| `api/README.md` — env table `QUEUE_RANGE_MODE` default column | `top` | `sample` |

Deliberately NOT changed: `RUN1-NOTES.md` / `RUN2-NOTES.md` still say
"default `top`" — those are dated build records of what shipped then,
not living docs. The mode names, validation (`range_mode must be "top"
or "sample"`), the seeded Efraimidis–Spirakis draw, and the per-spot
seed derivation are all untouched.

Note for the burn already running on Justin's PC: its package predates
this change, but its `runner-settings.txt` was set to
`QUEUE_RANGE_MODE=sample` by hand at launch — same behaviour, no
restart needed for consistency with this ship.

## 2. The chip rule (single source: `ui/src/lib/sampled.ts`)

Every capped solve's meta sidecar already stored, per side,
`range_expansion.{oop,ip} = { mode, coverage_pct, kept_combos,
total_combos, seed, ... }`. The chip rule:

- Show when **either** side's `mode === 'sample'`.
- The number is the **lower of the two sides' `coverage_pct`** (the
  honest worst case; a side absent from the record contributes
  nothing).
- No chip for: both sides `top`; missing/null expansion (custom solves
  with hand-entered ranges, the bundled sample); a sampled record with
  **no numeric coverage on any side** (a number is never fabricated).
- Label: `SAMPLED · NN.N%` (one decimal). Tooltip: what sampling means
  + the per-side record (mode, coverage, kept/total combos, seed).

Component: `ui/src/components/SampledChip.tsx`, used by both surfaces.
Styling is the Library's existing neutral meta-chip treatment (the
Source chip: `border-navy-600`, `text-ink-dim`, uppercase) — NOT the
solid green of the certified GTO badge and NOT the amber of
LOCKED/APPROXIMATION. Sampling is provenance, not a quality verdict.

## 3. Data flow

```
engine job meta (server)                UI
──────────────────────────────          ──────────────────────────────
job.range_expansion
  → <id>.meta.json sidecar
  → listLibrary()  [CHANGED: surfaces
    meta.range_expansion verbatim,
    null when absent — same additive
    pattern as #23's starting_pot /
    effective_stack / locked]
  → GET /api/library  → LibraryItem.range_expansion (types.ts)
  → libraryRow()      → LibraryRow.sampled = sampledInfo(expansion)
  → SpotPicker row    → <SampledChip> beside the LOCKED chip

Explorer: the engine payload does NOT carry the expansion (it lives in
the meta), so the opening surface passes it through the store:
loadRawSolve(raw, name, source, id, rangeExpansion?) →
store.solveRangeExpansion → Explorer header renders <SampledChip>
beside AccuracyBadge. Wired open paths: SpotPicker (row), Dashboard
(library item + job), Heuristics (linked library item), Solver
(finished job — JobRecord now types range_expansion).
Not wired: Quiz's re-open of a stored solve (opens by id alone, no
list item at hand) — the chip is simply absent there, same as any
solve opened without its meta.
```

Types: `RangeExpansion` / `RangeExpansionSide` in `ui/src/lib/types.ts`,
carried on `LibraryItem` and `JobRecord`; `LibraryRow` gains
`rangeExpansion` + precomputed `sampled`.

## 4. Tests (gate runs these; lane is build-only)

- `ui/tests/sampled.test.ts` — sampledInfo/sampledLabel/sampledTitle +
  libraryRow plumbing: min-coverage, one-side-sampled, top → none,
  missing → none, sampled-without-any-coverage → none, malformed mode
  → none, tooltip contents, row carry-through. Run route mirrors
  `preflop-stack.test.ts` (tsc → CJS, `node --test`).
- `api/library-sampled.test.mjs` — boots the real server on a scratch
  DATA_DIR with three seeded library entries; asserts GET /api/library
  returns the sampled record verbatim, the top record verbatim (policy
  is the UI's call), and explicit `null` when the meta has none. Runs
  under the standing glob: `node --test api/*.test.mjs`.
