# Preflop library v1.2 — rake dimension + no-rake 6-max family (lane notes)

Branch `preflop-lib-v12`, base main `d1c9e00`. Build-only lane: nothing was
compiled or run on this VM (no cargo/npm here by rule). Everything below is
written + committed; the coordinator generates and verifies on a host.

## What changed

### Config — `data/preflop/ranges-config-v1.2.json` (new file)

v1's config is untouched (it is the historical record; changing it would
change its hash and invalidate v1 provenance). The v1.2 file is a full copy
of v1 plus:

- `norake_6max` — the no-rake 6-max family: RFI targets, response targets,
  and continuations, anchored on the GTO Wizard cEV (no-rake) totals
  collected 2026-11-17 (cross-check targets only, exactly like the PLO.com
  totals were used for v1; no range data transcribed).
- `cross_check_source_3` + `gtw_raked_rfi_6max` + `gtw_raked_defense_6max` —
  the GTO Wizard **raked** (PLO100, 5%/2bb cap) totals, added as a third
  cross-check source for the raked family. Informational only: `--check`
  prints deltas next to the Upswing ones; no construction target changed.
- `build-ranges` now defaults to the v1.2 config.

### No-rake targets (kind / derivation)

- Anchors (exact GTO Wizard cEV totals, band ±1pp; SB ±3pp): RFI UTG 18.5 /
  HJ(MP) 23.4 / CO 31.7 / BTN 48.9; BB defense vs UTG 3.9/32.0, vs HJ
  5.0/34.4, vs CO 6.5/38.5, vs BTN 9.6/45.6, vs SB open 9.8/74.8; SB vs BTN
  9.5/10.0 (3-bet/call).
- SB RFI set-point **0.416** (band 0.386–0.446): GTO Wizard's SB plays
  raise 28.4 + limp 26.4. Our model is raise-or-fold, so v1's documented
  reconciliation rule (raise + 0.5 × limp) gives 28.4 + 13.2 = 41.6. Same
  rule as v1's SB (31.85 → 37 vs the Upswing-era anchors); the delta is
  documented in the config comment. **This is a construction judgement —
  flag for Justin if the SB set looks off.**
- Interpolated (no GTO Wizard anchor exists; derivation stated in the
  config): SB vs CO/MP/UTG (scaled from the SB-vs-BTN anchor by v1's SB
  interpolation ratios) and BTN vs CO/MP (raked anchors widened by a
  conservative share of the observed cEV blind-defense call widening).
- Continuations vs 3-bet: no external no-rake targets exist — the v1.1
  internal parameters are reused verbatim and labelled `internal`
  everywhere, as v1.1 did.

### ID scheme (existing IDs stable)

- Raked sets keep their v1/v1.1 IDs (`constructed-v1-6max-…`,
  `constructed-v1.1-6max-…`) — Solver presets and the API reference them.
- No-rake sets: `constructed-v1.2-6max-norake-<pos>-rfi`,
  `…-norake-<resp>-vs-<opener>`, `…-norake-<continuer>-vs-<tb>-3bet`
  (follows the v1.1 version-bump precedent; the variant is in the ID).
- Family size: 19 new sets (5 RFI + 11 responses + 3 continuations) →
  63 sets total after regeneration (44 raked + 19 no-rake).

### Engine — `engine/crates/plo-solve/src/ranges.rs`, `src/bin/build-ranges.rs`

- Every generated set document and index entry now records
  `rake: "raked" | "no-rake"` (schema amended: `rangeset.schema.json`).
  Pre-v1.2 files on disk don't carry it yet; the validator treats a
  missing `rake` as legacy (constructed IDs must record it once
  regenerated) and the UI defaults a missing field to `raked`.
- Construction machinery is shared: `build_*_set_styled` builders take an
  explicit target + family (sources/derivation/rake); the original
  signatures remain as raked wrappers, so the raked generation path is
  byte-identical in behaviour. No-rake generation runs as a third stage
  with its own equity seeds (tags 500k/700k bases; raked tags stay < 111k,
  continuation base 900k — no collisions).
- Provenance is doc-driven: raked 6-max sets cite PLO.com + Upswing +
  GTO Wizard raked (top-level source stays PLO.com); no-rake sets cite
  exactly the GTO Wizard cEV source; 9-max/continuation docs unchanged in
  shape. `check` honours the variant (no-rake docs check against the
  no-rake targets; Upswing/GTW-raked informational deltas print for raked
  6-max only).

### UI/API touch points

- API: **no change needed** — `api/ranges-expand.mjs` and the server pass
  index entries through without field validation, so `rake` flows to the
  client; no-rake sets are solve-compatible under the existing context
  rule (`rfi`/`vs_rfi`).
- UI (`ui/src/lib/preflop.ts`, `ui/src/pages/Preflop.tsx`): `RakeVariant`
  type + `rakeOf()` (absent → `raked`), `setLabel` appends ` · Raked` /
  ` · No-rake` only when the field is present (legacy labels unchanged),
  and a Rake pill row under the Table row on the Preflop page.
- **Guard check (the past-bug class):** the type guards deliberately do
  NOT gate on the `rake` value — gating on a new field is exactly how an
  unrecognised `vs_three_bet` context once silently dropped the whole
  index. `rake` is read leniently after the guard passes.
- **Load-bearing filter order:** `groupSets` filters by rake *before*
  position/opener selection. Without that, the two variants of the same
  spot shadow each other (both BB-vs-BTN ids end in `-vs-btn`, and the
  page picks the first match). Commented in the code.
- 9-max + No-rake has no sets; the page's existing empty state covers it
  honestly ("No range set matches the current selection").

## How index.json is regenerated (coordinator, on a host)

`data/preflop/index.json`, `sets/*.json`, and `class-table.json` are
tool-generated — never hand-edited. With this branch:

```sh
cargo build --release -p plo-solve --bin build-ranges
cargo test  --release -p plo-solve --test ranges_validation
cargo run   --release -p plo-solve --bin build-ranges          # v1.2 config is the default
cargo run   --release -p plo-solve --bin build-ranges -- --check
```

Expected: 63 sets (44 raked + 19 no-rake), every set doc gains `rake`,
raked 6-max provenance gains the third source, class-table provenance
moves to `ranges-config-v1.2` (frequencies identical — same seeds,
targets, and machinery; only provenance/config-hash fields move).
Then a UI build (`tsc` + `vite build`) to compile the TS changes, the
full gate, and ship per protocol.

**Hazard:** running the generator with the v1 config rewrites
`index.json` *without* the v1.2 entries. Always regenerate with the
v1.2 config (it is the binary default now; the warning is in the bin's
doc header).

## Flagged for Justin — v1.3 retarget candidate (NOT changed in v1.2)

**BTN RFI, raked family.** GTO Wizard's raked (PLO100) solution opens the
button **42.6%**; our v1 target is **49%** (band 48–50) — which matches
the **no-rake** anchor (48.9), not the raked one. Rake costs the button
~6pp of opens, and our raked BTN set was effectively built to a no-rake
number. The v1.2 lane deliberately did not retarget (that would change
shipped set contents); both anchors are now recorded per position in the
config and cited in provenance. Related, smaller: GTO Wizard raked BB
calls also run wider than our PLO.com anchors (vs UTG call 24.2 vs our
16.3 target; vs SB open 62.4 vs our extrapolated 32) — `--check` now
prints these deltas on every raked 6-max response set. Corroboration in
the other direction: the SB reconciliation of the raked totals
(31.9 + 0.5 × 9.9 = 36.85) lands on our SB target of 37.

## Open risks

1. **Nothing compiled.** First host compile may surface errors — most
   likely spots: the duplicated no-rake parse loops and the styled-builder
   refactor in `ranges.rs`, and the new test module code. All written to
   the existing patterns, but unverified.
2. **BB vs SB no-rake call target 0.748** (+ 3-bet 0.098 = 84.6% continue)
   stresses the call-fit floor-relaxation path; it relaxes to a 0 floor by
   design, but the achieved total should be eyeballed in the first
   generation run.
3. **SB 0.416 set-point** is a judgement call (v1's rule applied to a much
   larger limp slice — 26.4% of hands). If Justin prefers pure
   raise-or-fold at 28.4 or full limp-inclusive 54.8, it's a one-line
   config change + regeneration.
4. **Regeneration rewrites all 44 raked set files** (provenance gains
   `rake`, config version/hash). Frequencies must not move — the
   coordinator should diff achieved totals before/after.
5. 8-max is untouched (separate follow-on; needs position support in
   `positions_for`, the schema's `table_size` enum, and the UI
   `TableSize` type — none exist yet).
