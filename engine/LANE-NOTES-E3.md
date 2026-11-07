# LANE-NOTES — Ticket E3: Turn solver (chance nodes) + convergence-speed investigation

Lane: Muse builder lane (Antigravity quota was exhausted; coordinator reassigned).
Host: InterServer VPS, work dir `/root/claude-lane/work/plo-e3-turn/plo-engine`.
All cargo runs were gated on the host discipline (no Finch gate process running and
5-minute load < 1.6 at invocation time). One disclosure: the post-fix debug
verification was launched in a verified-clear window, but a new Finch gate started
in the ~3 minutes between that check and the launch; the debug tests completed in
under a second of run time and the cargo process was removed immediately on
discovery. No gate was affected (all gates running that evening completed).

## Part A — Convergence-speed investigation: verdict NO DEFECT

Question: does the E2 DCFR implement the paper's discounting/weighting correctly, or
is there a weighting defect behind the long Nash tails on small tie-heavy spots
(3x3 sample: 0.41% @5k; identical-range 6x6: 0.0477% @30k)?

Code audit of `crates/plo-solve/src/cfr.rs` against Brown & Sandholm (2019):

1. **Average-strategy weighting (γ = 2): CORRECT.** The paper discounts the
   accumulated strategy sum by ((t−1)/t)^γ each iteration before adding the current
   strategy; the weight of iteration t in the final sum is then Π_{k>t}((k−1)/k)^γ
   = (t/T)^γ ∝ t^γ. The code instead *adds* `t^γ · reach · σ_t` each iteration and
   never rescales the sum — the same polynomial weighting up to the normalisation
   applied at extraction. Equivalent, not a defect.
2. **Regret discounting (α = 1.5, β = 0): CORRECT in factors and placement.**
   Positive regrets are scaled by t^α/(t^α+1), negative by t^β/(t^β+1) (β = 0 ⇒ 1/2,
   special-cased as `t_beta = 1.0` ⇒ 0.5 — matches the paper), per player on that
   player's own alternating half-iteration. Alternating updates are used (OOP
   traversal, then IP traversal, per iteration).
3. **One deviation found (immaterial):** the discount is applied to
   *(old regret + instantaneous regret)*, whereas the paper/OpenSpiel apply it to
   the accumulated regret *before* adding the instantaneous regret. A/B test
   (temporary patch, probe re-run, then reverted — `cfr.rs` is byte-identical to
   the accepted E2 tree, md5 `177dd1f95d39ce81d94c064a36b979d8`): every checkpoint
   of both probe spots moved by at most ±15% with mixed direction (see table).
   Not the cause of the tail; **not adopted** (E2 behaviour left untouched).

Measured convergence (probe example, since deleted; `solve_river`, full runs,
target 0; baseline = shipped E2 code, variant = discount-before-add):

| iterations | sample 3x3 baseline | sample 3x3 variant | sym 6x6 baseline | sym 6x6 variant |
|-----------:|--------------------:|-------------------:|-----------------:|----------------:|
| 1,000  | 1.408003% | 1.463908% | 0.952253% | 0.907368% |
| 3,000  | 0.539577% | 0.560914% | 0.365418% | 0.352898% |
| 10,000 | 0.082579% | 0.093910% | 0.106002% | 0.113865% |
| 30,000 | 0.016348% | 0.017456% | 0.047699% | 0.045919% |

The baseline column reproduces the coordinator's E2 numbers exactly (0.0477% @30k
on the symmetry spot), confirming the probe measures the shipped solver.

**Explanation of the tail:** the failing bound was 0.02% of pot = 0.02 chips per
100-chip pot, on games whose equilibria place large average-strategy mass on
exactly-indifferent actions (tie/split-heavy ranges). Nash distance there decays
polynomially (measured ≈ T^-0.7…T^-1.5) because it is driven by residual strategy
mass on indifferent actions, not by regret signal. Real spots are unaffected:
E2's 200×200 river spots reached 0.08% in ~3.3k iterations, and E3's turn spots
reach 0.24% in ~1.3–1.8k iterations. **The 0.05% symmetry bound is left as is**
(30k-iteration measurement 0.0477% > 0.02%, so per the ticket the restore condition
is not met).

## Part B — Turn solver: what was built

New module `crates/plo-solve/src/turn.rs`:

- `TurnSpot` / `TurnGame`: 4-card board, per-player weighted ranges, pot, stacks,
  **per-street** `TreeConfig`s. Tree = turn decision nodes → `ChanceNode`s (one per
  closed turn history) → one river subtree per river card (48). All-in runouts with
  no stack behind collapse to showdown terminals under the chance node. Pot-limit
  legality on each street reuses E2's `legal_bet_sizes` / `legal_raise_sizes` with
  the pot/stack as of that street's start.
- **Exact chance handling:** for any disjoint pair there are exactly 40 dealable
  river cards (52 − 4 board − 8 hole), each weighted 1/40. Per-runout CSR kernels
  (one per player per runout, plus a pre-river fold kernel) exclude every opponent
  combo containing the river card and give combos containing it empty rows, so
  showdown *and* fold values are exactly 0 for blocked pairs — no approximation.
- `solve_turn`: the E2 vectorised DCFR generalised to the two-street tree (same
  `DcfrConfig`, same discounts, alternating updates), with early stopping measured
  by the turn checker.
- Checker extension in `br.rs`: `compute_exploitability_turn` — independent
  traversal (own recursion, per-runout ranks recomputed via `eval_omaha`, explicit
  pair filtering at chance nodes); shares only the evaluator + data definitions.
- CLI `solve-turn` (`src/bin/solve-turn.rs`) + JSON support in `json.rs`
  (`parse_turn_spot_json` with per-street fields `turn_bet_sizes`,
  `river_bet_sizes`, `turn_raise_sizes`, `river_raise_sizes`, `max_raises`,
  `turn_max_raises`, `river_max_raises`; `format_turn_solve_result_json` keys river
  nodes with `"street"` and `"river_card"`). Smoke-tested end-to-end on a sample
  turn spot (776 nodes out, river nodes keyed by card).
- README: appended "Turn Solver (Ticket E3)" section (design, chance handling,
  memory layout).

Validation (`crates/plo-solve/tests/turn_validation.rs`, new file; E2 tests
untouched):

1. **Card removal** — combo `Kc 9c 3d 4d` has weight exactly 0 on its own 4 cards'
   runouts and full weight on the other 44; every disjoint pair has
   `pair_runout_count == 40`; 48 distinct river cards. PASS (debug + release).
2. **Degenerate** — board `As Ks Qs 2d`, all OOP combos hold `Ts Js` (royal flush
   on every runout), IP can never win/tie: solves to near-zero exploitability with
   OOP EV ≈ pot, IP EV ≈ 0. PASS (debug + release).
3. **Turn-vs-river consistency** (release-only) — turn betting disabled (forced
   check-check); for river cards 2c, Jh, 9s: (a) the turn solve's river strategies
   transplanted into the E2 river game measure ≤ 0.35% Nash there by the E2
   checker; (b) river-root frequencies agree with the direct river solve within
   0.08. **Measured: 3 runouts checked, max root strategy delta = 0.0281**
   (turn solve 30k iterations, river solves 50k; earlier lower budgets showed
   ~0.10 deltas that shrank with budget — convergence slack in indifferent spots,
   not a solver disagreement; the value-based transplant check passed at every
   budget). Turn solve wall for the test ≈ 90s total.
4. **Convergence spot 1 — wet board `Ts 9s 8h 7d`, 120×120 combos** (release-only):
   **Nash 0.2389% of pot** at **1,250 iterations**, wall **28.1s**; tree: 1,797
   nodes / 680 decision nodes / 7 chance nodes / 81,600 infosets; peak memory
   estimate ≈ 10 MB.
5. **Convergence spot 2 — paired board `Kh Kd 7c 2s`, 120×120 combos**
   (release-only): **Nash 0.2240% of pot** at **1,750 iterations**, wall **39.8s**;
   same tree shape (1,797 / 680 / 7 / 81,600), ≈ 10 MB.
   Both under the 0.3% bar and far under the 10-minute guardrail. Menus: turn =
   check / 75% pot / all-in + pot raise (max 1 raise); river = check / 75% pot /
   all-in, no raises (keeps the 48-runout tree inside the guardrail at 120 combos).
6. **JSON roundtrip** — strategies sum to 1 at every node; river nodes carry a
   `river_card`, turn nodes carry `null`. PASS (debug + release).

Heavy tests (3, 4, 5) are marked `#[cfg(not(debug_assertions))]` per the ticket:
debug-mode wall time over 48 runouts is impractical. The light tests (1, 2, 6)
run in both modes.

**Debug-mode catch during verification (fixed):** the first debug run of the light
tests panicked at `plo-eval/src/eval5.rs:135` (`debug_assert` requiring a 5-card
mask). Cause: `TurnGame` precomputes ranks on `board + river_card` for *all*
combos, including combos that contain the river card — for those, a hole pair and
a board triple share the card and no legal 5-card hand exists. In release this was
harmless (those ranks are never read: kernels give blocked combos empty rows and
exclude blocked opponents, and the checker filters blocked pairs before reading
ranks), but it made debug builds unusable. Fix: blocked combos now store a dummy
`HandRank(0)` without evaluating, in both `turn.rs` (game ranks) and `br.rs`
(checker ranks), with explanatory comments. After the fix the debug light tests
pass (3 passed, 0 failed).

## Files created / changed

- Created: `crates/plo-solve/src/turn.rs`, `crates/plo-solve/src/bin/solve-turn.rs`,
  `crates/plo-solve/tests/turn_validation.rs`, `LANE-NOTES-E3.md` (this file).
- Changed: `crates/plo-solve/src/br.rs` (added `compute_exploitability_turn` +
  traversal; river checker untouched), `crates/plo-solve/src/json.rs` (added turn
  parse/format; river functions untouched), `crates/plo-solve/src/lib.rs` (module +
  re-exports), `crates/plo-solve/Cargo.toml` (`solve-turn` bin), `README.md`
  (turn solver section appended).
- Unchanged and verified byte-identical: `crates/plo-solve/src/cfr.rs`,
  `crates/plo-solve/src/game.rs`, all of `plo-cards`, `plo-eval`, `plo-bench`, and
  the E2 test suite. (A temporary convergence-probe example was used for Part A
  and deleted; its output is the table above.)

## Test results

`cargo test --release` (full workspace, run in a gate-free window):

```
     Running unittests src/lib.rs (plo-cards)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/validation.rs (plo-eval)
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.23s
     Running tests/turn_validation.rs (plo-solve, E3)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 111.62s
     Running tests/validation.rs (plo-solve, E2)
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.79s
```

Totals: **25 passed, 0 failed** (E1 12 + E2 7 + E3 6). The suite was run twice in
clear windows — once before and once after the debug-assert fix above — with
identical totals, confirming the fix changed no solver numerics.

Debug mode: `cargo test -p plo-solve --test turn_validation` in debug: **3 passed,
0 failed** (heavy tests cfg-excluded, as designed). The full debug suite was not
run, per coordinator instruction (impractical for the heavy spots).

## Deliberately not done

- No river raises in the two convergence spots' river menus (raise support exists
  in the tree builder and is exercised on the turn street and in the consistency
  test's default river config; the convergence menus were scoped to fit the
  10-minute guardrail at 120 combos with margin — actual walls were 28s/40s, so
  richer river menus are affordable in future spots).
- The discount-before-add DCFR variant from Part A was tested and deliberately not
  adopted (immaterial, mixed direction; E2 solver left byte-identical).
- No flop solver, no bucketing/abstraction (later tickets), no changes to any
  E1/E2 public behaviour.
