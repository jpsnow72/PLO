# RANGES-NOTES — Constructed preflop ranges v1 (method `constructed-equity-v1`)

Build-only lane deliverable. Nothing in this tree was compiled or run on the
Muse VM; all code is written to compile by construction against the verified
E3/E4 engine APIs, and the coordinator runs the commands in §8 on a host.
Branch: `ranges-constructed-v1` (based on `integrate-phase2`).

## 1. What was built

| Piece | Location |
| --- | --- |
| Range-construction library | `engine/crates/plo-solve/src/ranges.rs` (~1,880 lines) |
| CLI | `engine/crates/plo-solve/src/bin/build-ranges.rs` (registered in `plo-solve/Cargo.toml`; `pub mod ranges` in `lib.rs`) |
| Config (all tunables) | `data/preflop/ranges-config-v1.json` |
| Tests | `engine/crates/plo-solve/tests/ranges_validation.rs` (6 tests) |
| Schema amendment | `data/preflop/rangeset.schema.json` (see §6) |
| Docs | `data/preflop/README.md` (constructed-sets section), `data/preflop/sets/README.md` |

Generated on the host at run time (not committed by this lane):
`data/preflop/sets/constructed-v1-*.json` (41 sets), `data/preflop/class-table.json`,
and a refreshed `data/preflop/index.json`.

## 2. Methodology

1. **Class enumeration.** All C(52,4) = 270,725 combos are enumerated and
   canonicalised with the engine's existing `plo_cards::canonicalize_plo_hand`
   (minimum over all 24 suit permutations, cards sorted rank-desc/suit-asc).
   Grouping by canonical mask yields exactly **16,432 classes**; each class
   keeps its representative, its combo multiplicity, and its concrete combo
   list. The rangeset key is derived from the representative by the
   rangeset format rule (ranks non-increasing; suits relabelled by first
   occurrence → `s`, `h`, `d`, `c`), and every emitted key is checked against
   a Rust mirror of the importer's canonical-form validation.
2. **Equities (seeded Monte Carlo).** Exact preflop hand-vs-range equity is
   not enumerable (C(48,4) opponent combos × C(44,5) boards per class), so —
   as the brief allows for sampling where exact enumeration is infeasible —
   equities are Monte Carlo with the engine's deterministic RNG
   (`DeterministicRng`, xoshiro256**). Three passes per class: vs a random
   hand (20,000 samples), vs a reference range = top 25% of classes by
   equity-vs-random (12,000), and vs each opener's constructed RFI range
   (4,000; one pass per opener, shared by all responders). Every stream's
   seed derives from the config master seed + pass tag + class index, and
   sampling is parallelised over classes with `std::thread` — results are
   bit-for-bit identical for any thread count. Sample counts and the seed
   are recorded in `class-table.json` next to the numbers. Standard error at
   the default counts is ~0.35pp (vs random) to ~0.8pp (vs opener).
3. **Playability features (exact).** Pair structure (kind + top pair rank),
   suitedness pattern ([2,2] double / [4] four / [3,1] three / [2,1,1]
   single / rainbow; the [4] pattern reuses the double-suited component —
   one flush suit but no dead suits), connectedness (best rundown chain
   over distinct ranks, gap-1 links score 1.0, gap-2 links 0.5, ace also
   counted low; component = chain score / 3), high-card strength
   (0.6·top/14 + 0.4·(top+second)/28). Trips are scored deliberately low —
   published class data has trips opening ~0–1% even on the button.
4. **Score.** `score = 0.35·eq_random + 0.25·eq_reference + 0.12·pair +
   0.10·suitedness + 0.10·connectedness + 0.08·high_card` (weights in config;
   all components in [0,1]). For response sets, equity vs the opener's range
   takes the `eq_reference` weight slot.
5. **Selection.** Classes are ranked by score (ties broken by key, so the
   output is fully deterministic). RFI sets take classes from the top until
   the position's target opening frequency is reached. There is no hard
   cliff: a linear ramp over ±1pp of cumulative combo mass around the
   target gives boundary classes fractional frequencies, and a deterministic
   residual correction on boundary classes then matches the achieved total
   to the target to <1e-9 (before 6-decimal rounding in the JSON).
   Response sets are built in two slices against the opener's *constructed*
   range (iterate once: RFI first, then responses): the 3-bet slice is the
   top of the response-score ranking fitted to the pair's 3-bet target; the
   call slice ranks the remaining classes by equity-vs-opener discounted by
   a realisation factor (0.92 in position, 0.84 out of position, by postflop
   acting order), excludes classes below a 0.30 discounted-equity floor
   (relaxed in 0.02 steps only if the floor would make the call target
   unreachable), and fits to the call target over the not-already-3-bet
   mass. Fold is the remainder, so every hand's frequencies sum to 1.
6. **Sets emitted (41).** RFI for every non-BB position (SB uses the
   schema's `sb_play` context, raise-or-fold) — 5 (6max) + 8 (9max);
   responses: BB vs every opener, SB vs every non-blind opener, BTN vs
   MP/CO (6max) and HJ/CO (9max) — 11 + 17. BB defense *is* the BB vs_rfi
   sets (the schema has no separate bb_defense context).

## 3. Config assumptions (all in `ranges-config-v1.json`, tagged per entry)

- **6-max RFI targets** are the corroborated solver-derived totals from the
  research report (§4.1): UTG 18% (band 17–19), MP 22% (21–23), CO 30%
  (29–31), BTN 49% (48–50), SB 37% (34–40, raise-or-fold reconciliation of
  PLO.com's 33.6 raise + 6.8 limp vs ThinkGTO's 40% raise-or-fold).
- **Defense anchors** (research §4.2): BB vs BTN 3-bet 9% / call 30%;
  SB vs BTN 9% / 4.5%; BB vs UTG 4.3% / 16.3%; BB vs CO 7% / 21%;
  BTN vs CO 8.1% / 13.1%. All other pairs are tagged `interpolated`
  (monotone in opener width), `extrapolated` (BB vs SB blind-vs-blind), or
  `derived` (9-max) in the config — none are presented as published values.
- **9-max targets** follow the research report's §5 derivation rule
  (players-behind seat mapping: LJ ≈ 6-max UTG, HJ ≈ MP, CO/BTN/SB keep
  6-max targets; new early seats 11.5% / 14% / 16% inside the derived
  10–13 / 13–15 / 15–17 bands; BB defense vs the 9-max UTG open tightened
  to 17% total, below the 6-max-vs-UTG line as the report directs).
- **No rake is modelled** (rake-free equities and targets as construction
  assumptions); the cross-check targets were published for 5% rake / 1bb
  cap. Recorded in every set's `rake_note`. Stack depth: 100bb.

## 4. Provenance (per coordinator updates)

- Every set carries a `provenance` block: method `constructed-equity-v1`,
  tool + version, config version + FNV-1a hash of the config file.
- 6-max sets record `sources` = **[PLO.com](https://plo.com/plo-6-max-opening-ranges)**
  (licence note: numbers free to cite with a link back; cited as cross-check
  targets only — no PLO.com data is transcribed into any set) **and the
  Upswing Advanced PLO Preflop Guide** (owner-provided copy, personal use;
  no URL — the owner's PDF is the copy of record, and none was invented).
  The 6-max legacy `source` field also carries PLO.com (schema compatibility).
- **ThinkGTO is NOT a source anywhere.** Its totals appear only in the
  research report's comparison tables (its terms bar copying/derivative
  works; a consent request was sent 2026-11-07 — if granted, the
  coordinator updates provenance then).
- 9-max sets carry `sources: []` plus `derivation` (derived-by-mapping) —
  no published 9-max chart exists and none is cited.

## 5. Cross-check step (the hybrid's validation output)

`build-ranges` prints a cross-check table after generation, and
`build-ranges --check` reproduces it any time from the emitted files
(validating each file against the schema rules and recomputing totals from
the emitted hands, so the diff measures the documents, not the build):

- RFI sets must land **inside their published band** (hard failure outside).
- Anchored defense totals must be within **±3pp** of the anchor (hard
  failure outside); interpolated/extrapolated/derived totals print deltas
  only.
- Each 6-max RFI set also prints its delta vs the **Upswing owner-provided
  total** (UTG 17.9 / HJ→MP 21.8 / CO 30.0 / BTN 47.2 / SB 29.7,
  informational). Expect the SB line to show ≈ +7pp: Upswing's 29.7% is a
  raise-only total inside a limp-inclusive SB strategy, while our SB set
  uses the raise-or-fold model — a modelling difference, flagged in the
  config comment, not an error.

Because generation fits the config targets by construction, this check is a
regression/validation diff of the emitted files against the published
targets — it catches emission, rounding, and config drift, and it is the
table to re-run after any future target change (e.g. a ThinkGTO consent or
a rake-model pass).

## 6. Schema amendment (coordinator decision point)

The brief mandates a provenance block with a `sources` array, but the
existing schema required a single external `source {name, url, licence,
retrieved}` — a shape constructed sets cannot honestly fill. The schema was
therefore amended minimally (2026-11-07, documented in the schema's own
description and in `data/preflop/README.md`): `provenance` was added
(`sources` items use a new `$defs/sourceBlock`, where `url` is optional for
owner-provided sources), `source` is required only when no `provenance`
block is present, and a provenance with an empty `sources` list must state
a `derivation`. Transcribed-chart documents are unaffected. The importer's
own hardcoded validation still requires an external source — intentionally:
it validates transcribed charts only; `build-ranges` validates its outputs
with the mirrored rules in `ranges.rs::validate_rangeset`.

## 7. Static sanity checks performed by this lane (no builds run)

- Config and amended schema parse as JSON; config targets cover exactly
  the 13 RFI and 28 response sets the generator emits (asserted by test).
- Set-id slugs, context/action sets, position/table combinations and
  per-hand sum rules were checked by hand against the schema and the
  importer's validation logic (mirrored in `validate_rangeset`).
- Hand-key canonicalisation was verified by hand on the tricky cases
  (equal-rank suit ordering, e.g. AAKK double-suited → `As Ah Ks Kh`;
  rainbow 9-7-3-2 → `9s 7h 3d 2c`); the class-count test asserts the
  enumeration yields exactly 16,432 unique canonical keys summing to
  270,725 combos on the host.
- Upswing totals were read from the owner-provided PDF's section headers
  (UTG/HJ/CO/BTN/SB) — totals only; the guide's hand matrix was not
  transcribed anywhere.

**Not verified statically** (needs the host run): that the Rust compiles
without error (riskiest spots: the config-parser closures and the parallel
map's trait-object coercion in `ranges.rs`), actual Monte Carlo outputs and
timings, and the anchor behaviours asserted by the tests (premium class at
100% in every RFI/3-bet set, trash folding everywhere, frequency sums).
Test sample counts are reduced via config overrides (800/400/2000) so the
suite stays in the tens-of-seconds range in release mode; the two heavy
tests still exercise the real targets end to end.

## 8. Coordinator commands (on a host, from the tree root)

```bash
cd engine
cargo build --release -p plo-solve --bin build-ranges
cargo test  --release -p plo-solve --test ranges_validation
cd ..
./engine/target/release/build-ranges --data-dir data/preflop            # generate + print cross-check
./engine/target/release/build-ranges --data-dir data/preflop --check    # validate emitted files + cross-check
```

(If `cargo test --release` for the whole workspace is preferred, the new
test target runs as part of it.) Runtime estimate for a full generation at
default sample counts: dominated by ~850M Monte Carlo trials across the
three passes; expect single-digit to low-tens of minutes on a multicore
host (parallelised; per-class seeds make output thread-count-invariant).
Treat the first run's wall time as the measurement, not this estimate.

## 9. Known limitations / deliberate simplifications

- SB is raise-or-fold (no limp range) — a modelling choice matching one of
  the two published SB models; noted in the config.
- Call/3-bet targets are fractions of all combos the responder can hold,
  against the opener's constructed range; they do not condition on players
  behind the responder (e.g. SB calls ignore BB behind). v1 scope.
- Equities are Monte Carlo estimates; classes near a selection boundary can
  swap sides between seeds. The ramp band is the mitigation.
- Route 4 (self-improvement loop: re-derive leaf/realisation values from
  our own postflop solves and rebuild) is queued after this lands, per the
  plan; the config is versioned (`ranges-config-v1`) so v2 ranges can be
  diffed against these.
