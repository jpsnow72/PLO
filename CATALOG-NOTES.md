# CATALOG-NOTES — ~300-spot PLO library catalog

## Deliverables

- Generator: `tools/build_spot_catalog.py` (Python standard library only)
- Catalog: `data/library/spot-catalog.json`
- Source taxonomy: `library-plan-2026-11-07.md`, encoded explicitly in the generator
- Source range data: `data/preflop/index.json`, `data/preflop/sets/*.json`, and `data/preflop/class-table.json`

No project build or project-code run was performed. The generator was run over the existing JSON data, and the resulting catalog was re-read in `--verify` mode.

## Count against the plan

The catalog contains exactly **300 entries**. There is no per-group shortfall.

| Plan group | Plan count | Catalog count | Street split used |
| --- | ---: | ---: | --- |
| SRP BTN vs BB | 60 | 60 | 24 flop / 18 turn / 18 river (fixed by the plan) |
| SRP CO vs BB, MP vs BB | 40 | 40 | Per matchup: 9 flop / 5 turn / 6 river |
| SRP SB vs BB | 24 | 24 | 8 flop / 8 turn / 8 river |
| 3-bet pots | 60 | 60 | Per matchup: 7 flop / 6 turn / 7 river |
| Single-raise late-position | 16 | 16 | 8 turn / 8 river |
| Turn/river deep-dives on canonical boards | 60 | 60 | 30 turn / 30 river |
| 9max SRP (UTG/MP opens vs BB) | 40 | 40 | 15 flop / 12 turn / 13 river |
| **Total** | **300** | **300** | **86 flop / 104 turn / 110 river** |

The plan's narrative compute section says “~84 flop spots,” but its taxonomy fixes only the total group counts and the SRP BTN-vs-BB street split. The other street splits above are documented interpretations; together they produce 86 flop entries rather than approximately 84. This is not a group-count shortfall.

Readiness:

- **240 ready**
- **60 needs-range**
- All 60 needs-range entries are in the 3-bet-pots group, so that group is catalogued completely but cannot be solved from v1 ranges until call-vs-3-bet continuation sets exist.

## Needs-range entries

Each of the three planned 3-bet matchups has 20 entries. In every case, the 3-bettor's `three_bet` slice exists inside a v1 `vs_rfi` set and its capped coverage is computed. The opener's continuation does **not** exist. The opener's RFI set was not substituted, because an opening range is not a call-vs-3-bet range.

| Matchup | Entries | Existing side | Missing side and reason |
| --- | ---: | --- | --- |
| BTN opens, BB 3-bets, BTN continues | 20 | BB: `constructed-v1-6max-bb-vs-btn`, action `three_bet` | BTN call-vs-3-bet set does not exist in v1 |
| BTN opens, SB 3-bets, BTN continues | 20 | SB: `constructed-v1-6max-sb-vs-btn`, action `three_bet` | BTN call-vs-3-bet set does not exist in v1 |
| CO opens, BTN 3-bets, CO continues | 20 | BTN: `constructed-v1-6max-btn-vs-co`, action `three_bet` | CO call-vs-3-bet set does not exist in v1 |

For a needs-range entry, the missing side's `*_set`, coverage, capped-combo count, and source-action-combo count are `null`; `status` is `needs-range` and `status_reason` states the missing continuation explicitly.

## Coverage method and distribution

Coverage follows the brief's literal individual-combo definition:

1. For a set side, use its declared action (`raise` for RFI, `call` for vs-RFI, `raise` for the SB raise-or-fold `sb_play` set, and `three_bet` for the existing 3-bettor side of a 3-bet entry).
2. Rank hand classes by that action's frequency.
3. Expand classes using class-table multiplicity.
4. Keep exactly the street cap in concrete combos — flop 300, turn 600, river 1,500 — allowing the boundary class to be partial.
5. Divide kept combo weight by the total combo weight for that action.

Coverage is computed from the preflop source range before board-card removal. It is not conditioned on the catalog's prior-street line; the solver/data model supplied in v1 has no action-conditioned range file to use for that conditioning, and inventing one would violate the brief.

Distribution over **range sides with an existing set** (a needs-range entry contributes only its existing 3-bettor side):

| Street | Cap per side | Sides counted | Min coverage | Median coverage | Max coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flop | 300 | 151 | 0.2262% | 0.5037% | 1.3681% |
| Turn | 600 | 190 | 0.4523% | 1.0074% | 4.9250% |
| River | 1,500 | 199 | 1.1308% | 2.5185% | 12.3126% |

### Material discrepancy in the plan example

The plan gives an illustrative example of a 300-combo cap covering 61% of range weight. That percentage is **not reproduced** under the plan/brief's literal individual-combo formula and the actual v1 set files. The source actions contain tens of thousands of weighted combos; each kept concrete combo contributes at most its class frequency (at most 1.0) to kept weight. For example, the BTN RFI action has 132,655.25 total weighted combos, so 300 maximum-weight combos cover 0.2262%.

The catalog follows the explicit cap and coverage formula rather than silently treating 300 as a number of hand classes or renormalising a sample and calling it top-cap coverage. If the intended product meaning is instead “enough top classes/combos to retain a large share of range weight,” the cap definition needs to change in a future catalog version.

No side in the catalog has fewer positive-frequency combos than its cap, so the “coverage = 100% when total combos < cap” case does not occur.

## Board representatives

Two flop seeds were assigned to each family. Turn and river roots extend the seed with the deterministic runouts described below. Family entry counts are not forced equal; after rotating seed offsets across groups, the catalog's family totals range from 11 to 29 entries.

| Family | Representative flop seeds | Catalog entries |
| --- | --- | ---: |
| Dry A-high rainbow | `As Kd 7c`; `Ah Qd 4c` | 26 |
| Broadway connected | `Qs Jd Tc`; `Ks Qh Jd` | 21 |
| Middle connected | `9s 8d 7c`; `Ts 9h 8d` | 20 |
| Low connected | `6s 5d 4c`; `5s 4h 3d` | 20 |
| Paired high | `As Ad Kc`; `Ks Kh Qd` | 23 |
| Paired low | `7s 7d 2c`; `5s 5h 3d` | 16 |
| Trips | `As Ad Ac`; `8s 8d 8c` | 13 |
| Monotone | `As Ks 7s`; `Qh Jh 4h` | 26 |
| Two-tone flush-draw | `As Ks 7d`; `Qh Jh 4d` | 29 |
| Wet draw-heavy | `Js Ts 8d`; `9h 8h 6d` | 25 |
| Dry K/Q-high | `Ks 8d 3c`; `Qs 9d 4c` | 22 |
| Low dry | `8s 5d 2c`; `7s 4d 2c` | 28 |
| Wheel-heavy | `As 4d 3c`; `Ah 5d 2c` | 20 |
| Double-paired | See below | 11 |

### Double-paired exception

A three-card flop cannot literally be double-paired; two pairs require four board cards. This is a plan/board-data mismatch, handled explicitly rather than by mislabelling a paired flop:

- Seed `As Ad Ks` → turn root `As Ad Ks Kh` → river root `As Ad Ks Kh 3s`
- Seed `Qs Qd Js` → turn root `Qs Qd Js Jh` → river root `Qs Qd Js Jh 2s`

The double-paired family is therefore used only for turn and river roots, where the catalogued board is genuinely double-paired.

### Standard runouts

For non-double-paired seeds, the generator deterministically chooses blank runout cards whose ranks are neither on the flop nor adjacent to any flop rank (ace counts as adjacent to both king and deuce). Suits are scanned in `s/h/d/c` order for determinism. This preserves the seed family's identity as far as a single standard runout can; it is a catalog convention, not solver output.

## Standard lines and root geometry

The catalog uses a normalized root state with **100 chips behind per side at the flop root**. This is a solve-root convention, not a reconstruction of each player's exact preflop chip contributions.

Flop roots:

| Pot type | Pot chips | Stacks chips | SPR |
| --- | ---: | ---: | ---: |
| SRP | 10.0 | 100.0 | 10.0000 |
| 3-bet | 30.0 | 100.0 | 3.3333 |

### Primary turn/river entries

Standard line:

- Turn root: `flop: OOP check; IP bet 33% of pot; OOP call; turn: <card>`
- River root: the same flop line, then `turn: OOP check; IP check; river: <card>`

The 33% size is the small flop size in the plan's standardized menu. A bet/call was chosen for primary subtrees because it creates a contested pot and a materially different root from the flop solve; the turn then checks through for river roots so the river entry isolates the river decision without adding another arbitrary turn-sizing branch.

Resulting roots:

| Pot type | Pot chips | Stacks chips | SPR |
| --- | ---: | ---: | ---: |
| SRP turn/river | 16.6 | 96.7 | 5.8253 |
| 3-bet turn/river | 49.8 | 90.1 | 1.8092 |

### Deep-dive entries

Deep dives use a different standard line so they are not duplicates of the primary subtree entries on the same board/matchup/street:

- Turn root: `flop: OOP check; IP check; turn: <card>`
- River root: flop checks through, then `turn: OOP check; IP bet 50% of pot; OOP call; river: <card>`

The 50% size is the small turn size in the plan's menu. Deep-dive turn roots retain the SRP flop-root state (10.0 pot / 100.0 stacks / 10.0000 SPR). Deep-dive river roots are 20.0 pot / 95.0 stacks / 4.7500 SPR. All deep-dive pairs are SRP pairs.

## Size menus and tiers

Size menus are stored as fractions of pot, matching the engine's existing spot format:

- Flop: bet sizes `[0.33, 0.75]`, raise sizes `[1.0]`, all-in included
- Turn: bet sizes `[0.5, 0.75]`, raise sizes `[1.0]`, all-in included
- River: bet sizes `[0.75]`, raise sizes `[1.0]`, all-in included

A flop entry carries all three streets' menus. A turn entry carries turn and river. A river entry carries river only; earlier-street actions are recorded in `line`.

Tiers follow the plan: flop and turn are `balanced`; river is `precise`.

## Estimates

All timing values are labelled estimates; none is a measurement of a catalog entry.

- Every flop entry carries `est_core_hours.minimum = 5.0` and `maximum = 9.0`, from the plan.
- With 86 flop entries, the catalog summary scales that range to **430–774 core-hours**.
- The plan gives no defensible per-entry turn or river timing range—only an aggregate of under 40 core-hours for 216 turn/river solves. Turn/river entries therefore carry an `estimate_not_allocated_per_entry` object with null per-entry bounds and the plan aggregate as their basis.
- The catalog has 214 turn/river entries, not 216. The summary retains the plan's “under 40 core-hours” figure as a labelled planning bound rather than prorating it and presenting a newly derived number as if it came from the plan.

## Interpretation calls

1. **SB first-in sets.** The SB sets use context `sb_play`, not `rfi`, but the range-construction notes define them as raise-or-fold and their hand actions contain only `fold` and `raise`. The catalog therefore uses the well-defined `raise` slice for SB-vs-BB and deep-dive SB pairs. This is a catalog/range interpretation; it does not change the existing UI/API v1 restriction on loading `sb_play` sets.

2. **9-max “UTG/MP.”** The plan does not enumerate 9-max seats. The 40-entry group uses UTG, UTG+1, LJ, and HJ as the opener seats against BB—UTG/UTG+1 for the early end and LJ/HJ for the middle seats for which complete v1 pairs exist. UTG+2 also has a complete pair and is used in deep dives, but it is not one of the four group matchups.

3. **Single-raise late position.** The plan's shorthand example (“BTN vs SB-complete etc.”) does not correspond to a distinct v1 limp/complete set. The group is interpreted as three existing HU SRP pairs: CO opens/BTN calls, MP opens/BTN calls, and BTN opens/SB calls. No SB limp range was invented. If “SB-complete” was intended to mean a literal SB limp pot, that specific pot type still needs a range set.

4. **3-bet coverage.** The existing 3-bettor side's coverage is computed from its `three_bet` action. The missing continuation side remains null. An entry is `needs-range` even though one side's coverage is known.

5. **Deep-dive distinctness.** Deep dives rotate through all 17 ready SRP pair definitions (six-max and nine-max) and the canonical board-seed cycle. Their check/check flop line and IDs distinguish them from primary turn/river entries that use the 33% bet/call flop line.

6. **Board allocation.** Seed starting offsets are rotated by group and matchup. This was done deliberately after an initial consecutive allocation over-concentrated paired boards; the final family totals are 11–29 entries rather than a narrow set of early-list families dominating the catalog.

7. **Catalog geometry.** Pot and stacks describe the state at the solve root after the declared preflop pot type and, for turn/river entries, after the declared standard line. They are not all the same merely because the underlying preflop matchup is the same.

## Verification

Run from the tree root:

```bash
python3 tools/build_spot_catalog.py --out data/library/spot-catalog.json
python3 tools/build_spot_catalog.py --verify --out data/library/spot-catalog.json
```

The generator verifies the catalog in memory before writing it. The explicit verify pass re-reads the written JSON and source range data and asserts:

- exactly 300 entries and the plan group counts;
- 86 flop / 104 turn / 110 river entries;
- unique IDs;
- board card counts, duplicate-card absence, seed/board consistency, and runout presence in lines;
- street caps, tiers, and standardized size menus;
- root pot/stacks/SPR geometry;
- every non-null coverage value, kept-combo count, and source-action-combo count by recomputing them from the set files and class table;
- exactly 60 needs-range entries, each with exactly one missing side and a non-empty reason.

Latest explicit result: **VERIFY PASS**, with 300 entries, 60 needs-range entries, and the coverage distribution tabulated above.

## Addendum — ranges v1.1 regeneration (2026-11-07)
Ranges v1.1 added the three call-vs-3bet continuation sets (constructed-v1.1-6max-{btn-vs-bb,btn-vs-sb,co-vs-btn}-3bet). The generator's 3-bet pair definitions now use them, so all 300 entries are `ready` (was 240 ready / 60 needs-range); the verifier's needs-range expectation is now 0 and passes. Continuation-side coverage uses PRODUCT weights: a combo's postflop weight is the opener's RFI raise frequency times the continuation set's conditional call frequency (the v1.1 sets' frequencies are conditional on having opened). The four_bet slice roots a different pot (a 4-bet pot) and is not used by these spots.
