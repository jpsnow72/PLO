# E4 — Bucketed flop prototype + tree-size measurements

**Status: COMPLETE.** Built on the accepted E3 tree.
Host: finch-gate (6 vCPU / ~8 GB RAM), single-threaded solver.
Spot definitions: see `crates/plo-solve/src/bin/measure-flop.rs`.
Raw logs in the lane work dir: `measure-estimates.log`, `measure-loss.log`,
`measure-canonical-{exact,k100,k50}-500.log`, `measure-paired-k100-500.log`,
`measure-monotone-k100-500.log`, `release-suite.log`.

## What was built

- `plo-solve/src/buckets.rs` (~570 lines): 12-dim texture-feature vectors per
  combo (f0 hole-pair structure ×2.0 weight — primary; f1 pair height; f2
  board-pair interaction; f3 3-connectedness incl. wheel; f4 straight-draw
  potential; f5 flush-draw strength; f6 nut-flush blocker; f7 suit pattern;
  f8 top-two strength; f9 low-card share; f10 overcard share; f11 board-rank
  duplication). **Never raw equity alone.** Deterministic weighted k-means
  (Lloyd ≤50 iters, fixed-seed k-means++ init, range-weight centroids, ties
  to lowest centroid, empty clusters re-seeded to the farthest point).
  `BucketAssignment::to_json()` serialises board, K, members, weights and
  centroids with the solve output.
- `plo-solve/src/flop.rs` (~1,216 lines): `FlopGame` (flop street only; one
  turn-card subtree per closed flop history × 49 turn cards, 245 live
  subtrees per spot), bucketed DCFR on the flop reusing the E3
  `TurnSolverState` machinery below the flop, `solve_flop` (fixed budget,
  checker at the end), `expand_bucket_strategies`, memory accounting
  (`strategy_regret_bytes`, `solver_working_bytes`).
- `plo-solve/src/br.rs`: `compute_exploitability_flop` — the bucketed
  profile's exploitability measured by exact combo-level best response in
  the **unabstracted** game. That is the only Nash number reported.
- `plo-solve/src/bin/measure-flop.rs`: estimate table + `solve` +
  `loss` modes. `plo-solve/tests/flop_validation.rs` (7 tests, incl. a
  release-only abstraction-loss test).
- `turn.rs`: extracted reusable `TurnSolverState` + shareable `TurnKernels`
  (one kernel set per turn card, shared across subtrees); `solve_turn`
  rewritten on top with identical numerics (release tests still green).
  **Unchanged, byte-identical to the accepted E2 tree:** `cfr.rs`,
  `game.rs`, `plo-cards`, `plo-eval`, `plo-bench`, E2/E3 test suites.

## A real bug found and fixed in this lane (not in the brief's plan)

**The flop <-> turn-subtree seam was missing a commitment correction.**
Inside a turn subtree the pot (which already contains both players' flop
commitments) is dead money, so subtree values are net of turn/river
contributions only. The flop traversal (solver `eval_subtree` in `flop.rs`
and checker `br_eval_flop_subtree` in `br.rs`) was returning those values
unchanged — the chips a player committed on the flop were never charged.
Effects: (1) the solver over-valued flop lines that commit chips
(bet/raise looked "free" once the hand reached the turn); (2) the checker
measured exploitability in a distorted game, and strategy EVs did not
satisfy the dead-money identity `oop_ev + ip_ev == starting_pot`.
Signature of the bug, on the canonical spot pre-fix (120 iterations):
`oop_ev=44.087, ip_ev=45.900`, sum **89.987 vs pot 12** — the excess is
the expected flop commitments the accounting dropped. The pre-fix Nash
number from that run (**18.2968%**) is therefore **INVALID and discarded**;
its wall time (3,152 s/1k iters) is retained only as a rough pace note.

Fix (both places, identical): when mapping a subtree's root counterfactual
values back to flop combo indexing, subtract
`sub.committed × (valid opponent reach mass for the combo)` — valid means
the opponent combo shares no card with the traverser's (card removal,
matching the subtree kernels). Regression test:
`zero_sum_identity_with_flop_betting_and_raises` (bet + pot raise on the
flop, exact and K=5) asserts the identity to 0.01 chips. **Post-fix the
identity holds on every measured solve** (see the `oop_ev + ip_ev` column
below: 12.000 on the canonical spot, 100.0 on the small spots).

## Measurement table

Canonical spot: board `Ks 7d 2c` (dry rainbow); paired `Ks Kh 7d`; monotone
`Ks 9s 4s`. Ranges: 200 seeded playable combos/side; pot 12, stack 94.
Flop menu: bet 75% / all-in, pot raise / all-in raise, max 1 raise.
Turn/river menus: bet 75% / all-in, no raises.
Fixed solve budget: **500 iterations** (all rows below, unless noted).

### Estimates (no solving — all 12 rows)

| board | K | flop infosets | total infosets | strat+regret f32 | f16 | solver working set | subtrees |
|---|---|---:|---:|---:|---:|---:|---:|
| canonical | exact | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.560 GB | 245 (live 245) |
| canonical | 200 | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.560 GB | 245 (live 245) |
| canonical | 100 | 600 | 22,644,600 | 0.390 GB | 0.195 GB | 1.560 GB | 245 (live 245) |
| canonical | 50 | 300 | 22,644,300 | 0.390 GB | 0.195 GB | 1.560 GB | 245 (live 245) |
| paired | exact | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.563 GB | 245 (live 245) |
| paired | 200 | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.563 GB | 245 (live 245) |
| paired | 100 | 600 | 22,644,600 | 0.390 GB | 0.195 GB | 1.563 GB | 245 (live 245) |
| paired | 50 | 300 | 22,644,300 | 0.390 GB | 0.195 GB | 1.563 GB | 245 (live 245) |
| monotone | exact | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.562 GB | 245 (live 245) |
| monotone | 200 | 1,200 | 22,645,200 | 0.390 GB | 0.195 GB | 1.562 GB | 245 (live 245) |
| monotone | 100 | 600 | 22,644,600 | 0.390 GB | 0.195 GB | 1.562 GB | 245 (live 245) |
| monotone | 50 | 300 | 22,644,300 | 0.390 GB | 0.195 GB | 1.562 GB | 245 (live 245) |

K=200 ≡ exact for 200-combo ranges (flop infosets identical), so K=200 is
never re-solved separately. K=500 would also be exact (`assign_buckets`
returns the exact assignment when K ≥ combo count) and is not tabulated.

**The flop street is 1,200 of 22,645,200 infosets (0.005%).** Bucketing it
moves the totals by less than 0.003% — the exact turn/river subtrees
dominate everything. This is the table's central fact, and it drives the
bottom line.

### Solved rows (500 iterations, post-fix, checker-measured Nash in the unabstracted game)

| board | K | wall | per 1k iters | checker Nash (% pot) | oop_ev + ip_ev (pot) |
|---|---|---:|---:|---:|---:|
| canonical | exact | 1,795.6 s | 3,591 s | **4.1449%** | 5.153 + 6.847 = 12.000 |
| canonical | 100 | 1,821.0 s | 3,642 s | **6.5977%** | 5.125 + 6.875 = 12.000 |
| canonical | 50 | 1,833.5 s | 3,667 s | **9.8506%** | 5.090 + 6.910 = 12.000 |
| paired | 100 | 1,688.8 s | 3,378 s | **8.9432%** | 6.572 + 5.428 = 12.000 |
| monotone | 100 | 1,795.0 s | 3,590 s | **6.0580%** | 5.353 + 6.647 = 12.000 |

Texture at K=100: monotone (6.06%) ≈ canonical (6.60%); the paired board
converges slowest (8.94%) — paired boards are the most tie-heavy.

Host-contention disclosures (all Nash numbers are iteration-determined
and unaffected by contention; wall times are the only numbers at risk):
the K=50 run was launched in a verified-clear window and a Finch gate
(brilliant1) overlapped ~5 of its 30 minutes. **The paired run was
launched at 06:21 UTC while gate-taig2 was already active** — the launch
command's own gate check printed the running gate, but the compound
command launched unconditionally and its output only surfaced after the
fact. That was a process error by this lane against the host discipline;
it is recorded here rather than hidden. (The coordinator separately
recorded that an unrelated overlapping vitest suite flaked taig2 with
timeout failures; this solve is single-threaded, ~1 core.) The monotone
run was launched only after a standalone check confirmed no gate and
5-min load 1.09. Post-fix per-iteration cost ≈ 3.6 s (pre-fix 3.15 s;
the seam-correction pair loop adds the difference).

**Reading the solved rows:** at a fixed 500-iteration budget, finer flop
granularity converges closer (exact 4.14% vs K=50 9.85%). That gap mixes
abstraction loss with a convergence-rate difference — bucket-level regret
updates refine more slowly on tie-heavy spots. Neither number is close to
converged: see extrapolation below.

### Abstraction loss, small spot (board 9c 8d 3h, 18×17 combos, 4,000 iterations)

| config | flop infosets | total infosets | wall | checker Nash (% pot) |
|---|---:|---:|---:|---:|
| exact | 70 | 459,970 | 59.0 s | **0.0012%** |
| K=9 | 36 | 459,936 | 73.8 s | **0.1825%** |
| K=5 | 20 | 459,920 | 46.2 s | **0.1731%** |

At convergence the exact solve is essentially solved (0.0012%), so the
bucketed profiles sit on an **absolute abstraction floor of ≈ +0.18
percentage points** on this texture — comfortably under the 0.3%
production bar. K=5 and K=9 differ by noise at this depth. The validation
test therefore asserts the floor form (≤ 0.3% and ≤ 3× exact + 0.25 pp),
not the brief's original multiplicative form, which is meaningless when
exact ≈ 0. K does not speed the small spot up (subtrees dominate wall
time here too).

### Extrapolation to the 0.3% bar (canonical spot, finch-gate pace ≈ 3,600 s/1k iters)

Nash decays ~polynomially (E3 measured T^-0.7 … T^-1.5 on tie-heavy
spots). From the 500-iteration points:

| config | to 0.3% at p=1.5 | at p=1.0 | at p=0.7 |
|---|---:|---:|---:|
| exact (4.14%) | ~2,900 iters ≈ 2.9 h | ~6,900 iters ≈ 6.9 h | ~21,300 iters ≈ 21 h |
| K=100 (6.60%) | ~3,900 iters ≈ 3.9 h | ~11,000 iters ≈ 11 h | ~41,000 iters ≈ 41 h |
| K=50 (9.85%) | ~5,200 iters ≈ 5.3 h | ~16,400 iters ≈ 16.7 h | ~73,000 iters ≈ 74 h |

Caveats: single-budget extrapolation (no second point on the canonical
spot yet), and K=50 may carry an abstraction floor above 0.3% on this
spot class — in that case no iteration count crosses it. The rental box
(Hetzner dedicated) should be meaningfully faster per core than this
VirtualBox VM, which shortens every wall-clock figure above roughly
proportionally; the RAM conclusion does not depend on the box.

## Bottom line

**RAM is not the binding constraint at this spot size — wall-clock
convergence is.** The canonical 200-combo SRP spot needs **1.56 GB**
solver working set (0.39 GB f32 / 0.195 GB f16 for strategy+regret) at
EVERY K, including exact. The **32 GB tier fits it ~20× over**; there is
no RAM reason to rent 64 GB or 128 GB for this class of spot. (Larger
ranges or richer menus grow the subtrees, not the flop street — a future
measurement ticket should map working set vs range size.)

**K recommendation:** bucketing barely moves memory or speed, so its only
price is accuracy. On the small spot the K=9/K=5 abstraction floor is
~0.18 pp; on the canonical spot K=50 costs roughly 2× the Nash distance
of exact at a fixed 500-iteration budget. **Use K=100–200 (or exact) for
production library solves** — the memory saved by K=50 is ~0 GB and the
accuracy cost is real. If a spot is convergence-limited, spend the wall
time on iterations, not on coarser buckets.

**Time to ≤0.3% on the canonical spot (this host):** exact ≈ 3–21 h
(central ≈ 7 h at p=1.0); K=100 ≈ 4–41 h (central ≈ 11 h); K=50
≈ 5–74 h, possibly never if its abstraction floor exceeds the bar. A single Hetzner month (~700
compute-hours) still covers the ~150-solve library comfortably even at
the pessimistic end, if solves run at Balanced tier and only the spots
that need it get Precise-tier passes — but budget per-solve hours, not
minutes, for flop solves at this range size. Turn spots (minutes) and
river spots (seconds) stay cheap.

## Validation

- `flop_validation.rs` (debug): 6/6 green — bucket determinism +
  serialisation; identical features share a bucket; nuts vs air never
  share on a dry board; turn-card/subtree accounting (49 turn cards, 45
  per combo, 49 − |union| per pair); solver smoke (exact + K=4, legal
  strategies, finite EVs/Nash, zero-sum); zero-sum identity with flop
  betting + raises (exact + K=5).
- Abstraction-loss test (release-only, 4,000 iterations): numbers above;
  exact 0.0012%, K=9 0.1825%, K=5 0.1731% — inside the test's bounds.
- **Full release suite (`cargo test --release`, whole workspace):
  32 passed, 0 failed** — plo-cards 5, plo-eval validation 7, river
  validation 7, turn validation 6, flop validation 7; all 14 suite
  results `ok`. All 25 pre-E4 tests still pass after the turn.rs refactor
  and the seam fix. Debug: flop_validation 6/6 green (the 7th test is
  release-only by design).
- One test-design correction during the lane: the pair-accounting
  assertion originally expected exactly 41 jointly-present subtrees for
  every pair; the correct expectation is 49 − |union of hole cards|
  (pairs that share a card block only one turn card, not two) — fixed
  in the test, and the engine matches it.
