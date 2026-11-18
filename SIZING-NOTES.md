# SIZING-NOTES — per-street default bet-size menus (2026-11-17)

Approved by Justin 2026-11-17, gauged from GTO Wizard's actual solved
trees (their custom-tree dialog default is pot-only, but their library
trees use flop 75%, turn/river small size + pot). This lane applied the
new defaults everywhere defaults live. It is a **defaults change only** —
no solver logic changed, and existing saved/library solves are untouched
(menus are frozen into each solve at solve time by design).

## The new default menus

| Street | Bet sizes (fraction of pot) | Raises | Max raises | All-in |
| --- | --- | --- | --- | --- |
| Flop | 0.33, 0.75 | 1.0 (pot) | 2 | included |
| Turn | 0.5, 1.0 | 1.0 (pot) | 2 | included |
| River | 0.5, 1.0 (+ all-in) | 1.0 (pot) | 2 | included |

All-in remains a distinct engine action (`include_all_in_bet` /
`include_all_in_raise`), available at every street exactly as before;
the river menu's "+ all-in" is that flag, not a third listed fraction.

## Locations found and changed

1. **Engine — `engine/crates/plo-solve/src/game.rs`**
   `TreeConfig` is a single street-agnostic struct (one `bet_sizes`
   list), so per-street defaults were implemented as constructors in the
   least invasive way that matches how spots already carry per-street
   configs: `TreeConfig::flop_default()` `[0.33, 0.75]`,
   `TreeConfig::turn_default()` `[0.5, 1.0]`,
   `TreeConfig::river_default()` `[0.5, 1.0]` (private helper
   `with_bet_sizes`; all other fields identical to `Default`).
   `TreeConfig::default()` is **intentionally unchanged**
   (`[0.33, 0.75, 1.0]`): it is the street-agnostic fallback used by
   programmatic spot construction, including the analytic acceptance
   games (e.g. the textbook polar game in `tests/validation.rs`, whose
   equilibrium is derived for that exact menu).

2. **Engine JSON parsers — `engine/crates/plo-solve/src/json.rs`**
   This is where "the default menu" actually reaches solves:
   - `parse_spot_json` (river spots) now starts from
     `TreeConfig::river_default()` instead of `TreeConfig::default()`.
   - `street_config_from_json` (turn + flop spots) now starts from the
     prefix's per-street default (`flop`/`turn`/`river`) instead of
     `TreeConfig::default()`.
   Fallback order is unchanged: `<street>_bet_sizes` wins, then the
   shared `bet_sizes`, then the (new) per-street default base. Spots
   that specify any size field behave exactly as before; only spots
   that omit sizes get the new menus.

3. **Solver wizard — `ui/src/lib/spot.ts`**
   `defaultWizardForm()`: flop `[0.5, 0.75]` → `[0.33, 0.75]`,
   turn `[0.33, 0.75]` → `[0.5, 1.0]`,
   river `[0.33, 0.75, 1.0]` → `[0.5, 1.0]`.
   (The old river list's 1.0 was the pot bet; all-in was and remains the
   separate `allIn` toggle from `emptyStreetSizes`, default on. Raise
   sizes `[1.0]` and `maxRaises` 2 in `emptyStreetSizes` unchanged.
   The wizard already sends per-street sizes, so these defaults flow
   into `flop_bet_sizes` / `turn_bet_sizes` / `river_bet_sizes` exactly
   as the engine parsers expect. `Solver.tsx` itself holds no other
   size defaults — its `SIZE_OPTIONS` are just the pickable fractions.)

4. **Library catalog — `tools/build_spot_catalog.py` + `CATALOG-NOTES.md`**
   `size_menu()`: turn `[0.5, 0.75]` → `[0.5, 1.0]`,
   river `[0.75]` → `[0.5, 1.0]`; flop `[0.33, 0.75]` unchanged.
   The catalog's standard-line derivation sizes are unaffected (flop
   line bets 33%, deep-dive river line bets 50% — both remain the small
   size in their street's menu), so no catalog root pot/stacks/SPR
   changes. `CATALOG-NOTES.md`'s "Size menus and tiers" section was
   updated with a dated change note.

## Tests

New pinning tests (written, not run — host gate runs them):

- `tests/validation.rs::test_per_street_default_bet_menus` — the three
  constructors' menus + raises/cap/all-in fields;
  `TreeConfig::default()` pinned unchanged; a size-less river spot JSON
  parses onto `[0.5, 1.0]`.
- `tests/turn_validation.rs::test_turn_json_per_street_default_menus` —
  size-less turn spot JSON gets turn/river `[0.5, 1.0]`; the shared
  `bet_sizes` fallback still overrides both streets.
- `tests/flop_validation.rs::flop_json_per_street_default_menus` —
  size-less flop spot JSON gets flop `[0.33, 0.75]`, turn `[0.5, 1.0]`,
  river `[0.5, 1.0]`.

No existing test pinned the old *parse* defaults: every JSON test spot
specifies its sizes explicitly (e.g. `[0.75]` per street), and every
analytic test builds on `TreeConfig::default()`, which did not change.
`examples/sample_spot.json` also specifies its menu explicitly.

## Intentionally left alone

- `TreeConfig::default()` — see (1) above.
- `engine/crates/plo-solve/src/bin/measure-flop.rs` — measurement spots
  with explicit `[0.75]` menus; a benchmarking choice, not a default.
- `api/server.mjs` — the runner writes each catalog entry's own
  `size_menu` into the spot JSON; it has no hardcoded bet sizes.
- All saved solves, the bundled sample solve, and result JSON — menus
  are frozen at solve time by design.
- The external library plan doc
  (`library-plan-2026-11-07.md`, goal workspace — outside this lane's
  tree) still says "flop 33%/75%, turn 50%/75%, river 75% + all-in" in
  its config summary. Replacement text for the coordinator:
  "standardised size menus per street (flop 33%/75%, turn 50%/100%,
  river 50%/100% + all-in; raises pot; menus updated 2026-11-17)".

## Coordinator follow-ups

1. Run the engine test suite on a host (`cargo test -p plo-solve`);
   the three new tests above are the sizing pins.
2. Regenerate the library catalog so `data/library/spot-catalog.json`
   picks up the new turn/river menus:
   `python3 tools/build_spot_catalog.py` (writes
   `data/library/spot-catalog.json` by default, after an in-memory
   verify pass that asserts every entry's `size_menu` matches
   `size_menu()`; `python3 tools/build_spot_catalog.py --verify`
   re-checks the committed file).
   Until then the committed catalog still carries the old turn
   `[0.5, 0.75]` / river `[0.75]` menus — which is correct for any
   already-queued solves (solve-time menus are frozen by design).
3. Apply the plan-doc sentence replacement noted above.
