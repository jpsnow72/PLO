# Preflop 200bb — deep-stack constructed sets + mirrored spot catalog (lane notes)

Branch `preflop-200bb`, base main `7e185c6`. Build-only lane: nothing was
compiled, generated, or run on this VM (no cargo/npm/generator execution
here by rule). The two data files below were written directly; the
coordinator generates and verifies on a host.

## What changed

| File | Change |
|---|---|
| `data/preflop/ranges-config-v1.4.json` | NEW config (v1.3 copied verbatim, then: version bump, `_comment` v1.4 paragraph, `_comment_deep200_6max`, and the `deep200_6max` section). Prior configs untouched. |
| `tools/build_spot_catalog.py` | Additive `--stack-bb {100,200}` mode. Default mode is byte-identical to before. |
| `data/library/spot-catalog-200bb.json` | NEW: the 200bb mirror catalog, written directly from `spot-catalog.json` by the exact transformation the generator now implements (see below). |
| `PREFLOP-200BB-NOTES.md` | This file. |

No engine code, no UI code, no schema, and no existing data file was
modified.

## Task A — `deep200_6max`: 200bb no-rake (cEV) 6-max family, 19 sets

Mirrors the v1.2 `norake_6max` family shape exactly (same section fields:
`cross_check_source`, `rake_note`, `rfi_targets`, `response_targets`,
`continuations` in the v1.1 format), plus `stack_bb: 200` inside the
section and a `gtw_cev_200bb_captures` record of the raw totals consumed.
The top-level `stack_bb` stays 100 — it describes the pre-existing
families; the deep family's depth lives in its section, and every set it
emits must record `stack_bb: 200` (the schema's `stack_bb` is a plain
number 0–1000, so 200 validates with no schema change).

### Target table (fractions of all combos; 3-bet / call for responses)

Anchors are GTO Wizard Cash 6-max Classic cEV **200bb** header totals
collected 2026-11-17 (cross-check targets only — totals, never range
data; the same standing boundary as every prior family).

| Set | Target | Kind |
|---|---|---|
| UTG RFI | 0.169 (band 0.159–0.179) | anchor |
| MP (GTW: HJ) RFI | 0.217 (band 0.207–0.227) | anchor |
| CO RFI | 0.299 (band 0.289–0.309) | anchor |
| BTN RFI | 0.486 (band 0.476–0.496) | anchor |
| SB RFI | **0.3805** (band 0.3505–0.4105) | anchor, reconciled — see caveat |
| BB vs BTN | 0.102 / 0.438 | anchor |
| BB vs CO | 0.071 / 0.367 | interpolated |
| BB vs MP | 0.056 / 0.326 | interpolated |
| BB vs SB | 0.104 / 0.730 | interpolated |
| BB vs UTG | 0.045 / 0.302 | interpolated |
| BTN vs CO | 0.091 / 0.152 | interpolated |
| BTN vs MP | 0.054 / 0.167 | interpolated |
| SB vs BTN | 0.101 / 0.082 | interpolated |
| SB vs CO | 0.075 / 0.071 | interpolated |
| SB vs MP | 0.059 / 0.060 | interpolated |
| SB vs UTG | 0.048 / 0.049 | interpolated |
| BTN vs BB 3-bet / BTN vs SB 3-bet / CO vs BTN 3-bet continuations | v1.1 internal parameters verbatim (continue 50% of open, split call 82% / four-bet 18%) | internal (no published anchor at any depth) |

**Interpolation rule** (stated in the config's `_comment_deep200_6max`):
the one anchored response pair shows the depth deltas call 45.6% → 43.8%
(**−1.8pp**) and 3-bet 9.6% → 10.2% (**+0.6pp**) between the 100bb cEV
family and 200bb. Every non-anchored response target is the corresponding
v1.2 `norake_6max` target shifted by exactly those two deltas, and the
sets are labelled `interpolated` in provenance, exactly as v1.2 labelled
its derived sets. (Anchored RFI depth deltas for context: UTG −1.6pp,
MP −1.7pp, CO −1.8pp, BTN −0.3pp.)

### SB limp caveat

GTO Wizard's 200bb SB plays **raise 19.1% + limp 37.9%** in a
limp-inclusive tree. Our SB set is raise-or-fold (the model every family
uses), so the set-point applies the standing v1 reconciliation rule —
raise + 0.5 × limp = 19.1 + 18.95 = **38.05%** — the same documented
convention as v1 (31.85 → 37.0 against its anchors) and v1.2
(28.4 + 0.5 × 26.4 = 41.6). The limp slice is far larger at 200bb
(37.9% of all hands vs 26.4% at 100bb cEV), so this is the family's
largest judgement call: pure raise-or-fold at the solver's raise total
would be 19.1%, limp-inclusive continue would be 57.0%. Flagged for
Justin, same as the v1.2 SB set-point was.

### ID scheme

Follows the v1.2 precedent (version bump + variant in the ID):

- `constructed-v1.4-6max-deep200-<pos>-rfi`
- `constructed-v1.4-6max-deep200-<resp>-vs-<opener>`
- `constructed-v1.4-6max-deep200-<continuer>-vs-<tb>-3bet`

No collision with any existing ID (the `deep200` discriminator is new).
Family size: 5 RFI + 11 responses + 3 continuations = **19 new sets →
132 total** after regeneration (113 existing + 19).

## Task B — 200bb spot catalog mirror (300 entries)

### Geometry transformation (the whole change, nothing else)

Pots are preflop-determined and do **not** change with depth; only the
stacks behind grow. Per entry, with the generator's own `root_state`
arithmetic (standard-line bets are fractions of the unchanged pot):

- flop roots: stacks 100 → **200** (SPR 10 → 20.0 SRP; 3.33 → 6.6667 in
  3-bet pots)
- standard-line turn/river roots: stacks = 200 − 0.33 × flop pot
  (196.7 SRP, 190.1 in 3-bet pots)
- deep-dive river roots: stacks = 200 − 0.50 × flop pot (195.0);
  deep-dive turn roots check through, so 200
- `spr` recomputed as `round(stacks / pot, 4)`; `pot_chips` unchanged
- entry `id` gains the suffix `-200bb`; each entry gains `stack_bb: 200`
  (appended as the entry's last key — the catalog schema had no stack
  field); the catalog's `name` becomes "PLO library spot catalog (200bb
  mirror)" and a top-level `stack_bb: 200` sits immediately before
  `entries`
- **everything else is carried over byte-for-byte**: boards, lines,
  size menus, range set IDs, coverage figures, caps, tiers, estimates,
  summary counts

The five resulting geometry rows: (pot 10, stacks 200, SPR 20.0) ×95 ·
(16.6, 196.7, 11.8494) ×115 · (30, 200, 6.6667) ×21 · (49.8, 190.1,
3.8173) ×39 · (20, 195, 9.75) ×30.

The delivered file was produced by transforming `spot-catalog.json`
directly (not by running the generator). Before transforming, the same
arithmetic at base 100 was checked against all 300 shipped entries and
reproduced every `stacks_chips` exactly — so the generator change and
the file agree by construction. Coordinator reproduction on a host:

```sh
python3 tools/build_spot_catalog.py --stack-bb 200 \
    --out data/library/spot-catalog-200bb.json   # must be byte-identical
python3 tools/build_spot_catalog.py --verify \
    --out data/library/spot-catalog-200bb.json
python3 tools/build_spot_catalog.py             # 100bb default: unchanged output
python3 tools/build_spot_catalog.py --verify    # still passes on the 100bb file
```

Generator changes, all additive: `root_state(..., stack_bb=100)`,
`make_entry(..., stack_bb=100)` (id suffix + `stack_bb` entry field only
when ≠ 100), `build_catalog(data, stack_bb=100)` (mirror name +
top-level `stack_bb` only when ≠ 100), `verify_catalog` reads each
entry's stack (defaulting 100) and asserts id suffixes and catalog/entry
agreement, and the `--stack-bb` CLI flag. With `--stack-bb 100` every
new code path is inert.

## Open items — required changes NOT made here (by design)

### Engine (needed before the v1.4 config can generate anything)

`build-ranges` parses config sections explicitly in
`engine/crates/plo-solve/src/ranges.rs`; an unknown `deep200_6max`
section is ignored today. Following the `norake_6max` precedent, the
engine lane needs:

1. A `deep200_6max` parser + `deep200_family()` FamilySpec with ID
   prefix `constructed-v1.4-6max-deep200` and rake `no-rake`.
2. **Per-family stack emission**: today every set doc's `stack_bb`
   comes from the top-level config value (100). The deep family must
   emit its section's 200 — in the set docs and in the index entries.
3. New Monte Carlo seed-tag bases for the family's equity passes.
   Ranges in use: raked < ~111k, 8-max opener 300k, no-rake opener
   500k, no-rake continuation 700k, continuation 900k, 8-max
   continuation 1.1M, 8-max no-rake opener 1.3M, 8-max no-rake
   continuation 1.5M. The next clear slots by the established +200k
   spacing are **1_700_000 (opener) / 1_900_000 (continuation)** —
   engine lane to confirm.
4. A generation stage + `--check` handling for the section (anchors
   inside band/tolerance; interpolated reported as deltas), and the
   `build-ranges.rs` default config bump v1.3 → v1.4 (with the usual
   hazard note: regenerating with an older config rewrites the index
   without the newer families).
5. `ranges_validation.rs` tests per family precedent (the v1.2 test
   module is the template: config-carries-family, sets-hit-targets,
   continuation ID list).

### UI (needed before the deep sets are user-visible)

- Guards need **no** change: `ui/src/lib/preflop.ts` checks `stack_bb`
   only with `isNumber`, and set IDs are opaque strings — 200bb sets
   pass the index guard as-is. (Deliberately verified: gating on a new
   field's value is the past-bug class from v1.2.)
- BUT the Preflop page has **no stack dimension**: `groupSets` selects
   by (table, rake, position, context). Once generated, deep200 no-rake
   sets would shadow the v1.2 100bb no-rake sets in the same slots —
   the exact failure the v1.2 rake filter fixed. A Stack pill row
   (100bb / 200bb) with the filter applied *before* position/opener
   selection (the load-bearing order documented in
   PREFLOP-LIB-NOTES) is required, and `setLabel` should show the
   stack. The Starting Hands study reads the same index and inherits
   whatever selection rule lands.

### API / runner / catalog consumers

- API: no change to *serve* the sets — index entries pass through
  (`api/ranges-expand.mjs`, server), and `stack_bb` already rides
  along. Solver presets and the runner reference set IDs explicitly.
- The API loads **one** spot catalog (`catalog_path` →
  `data/library/spot-catalog.json`). Serving the mirror needs either a
  second catalog path + a stack switch in the SpotPicker/runner queue
  UI, or a merged catalog — the `-200bb` ID suffix makes a merge
  collision-free. Queue mechanics (spot IDs in queue items) need no
  change.
- **Known mismatch, deliberate**: the mirror's range sides still
  reference the v1 raked sets and its coverage figures are the 100bb
  ones, because coverage is computed from those sets. Pairing 200bb
  spots with the new `deep200` sets (and recomputing coverage) is a
  follow-on decision for the coordinator/Justin — note the mirror also
  contains 9-max pairs and late-position pairs, for which no 200bb
  preflop family exists (Task A is 6-max only, mirroring the no-rake
  family).
- Estimates: `est_core_hours` and the summary compute bounds are
  carried over unchanged. Deep-stack flop solves will in practice run
  longer per solve than the 100bb plan estimates; the numbers were NOT
  rescaled (no defensible basis yet) — treat the mirror's estimates as
  lower bounds.

## Counts

- New preflop sets defined: **19** (5 RFI + 11 responses + 3
  continuations); library total after regeneration: **132**.
- New catalog entries: **300** (86 flop / 104 turn / 110 river — the
  same split as the 100bb catalog).

## Could not determine from the code

- Whether the coordinator wants the deep family's `--check` anchors
  enforced at the same ±1pp / ±3pp tolerances as `norake_6max` — the
  config carries the same band shapes, but the check wiring is part of
  the engine item above.
- Whether 200bb spots should ultimately pair with the deep200 sets in
  the runner (see the deliberate mismatch above) — a product decision,
  not a code fact.
