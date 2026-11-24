# Flop target early stop (issue #56)

## Problem

`solve_flop_with_threads` ran exactly `config.max_iterations`
iterations and ignored `target_exploitability_pct` entirely (the old
module docs said so: "early stopping is intentionally not wired").
Catalog flop spots carry `max_iterations = 2,000,000` with a target of
0.3% (0.5% for the relaxed queued batch, #53), so **no catalog flop
could ever finish**: each would run until the runner's job timeout
killed it and its result was discarded. The turn and river solvers
already stop on target; the flop was the only street that could not.

## Mechanism

One merged checkpoint inside the flop iteration loop serves both
consumers, so the expensive checker pass is never paid twice for the
same iteration:

- The checkpoint extracts the current average strategies with the
  existing `flop_average_strategies` (the same snapshot the final
  result carries) and prices them with the existing
  `compute_exploitability_flop` — the exact code the #48 progress
  reporting already ran mid-solve. Read-only, per the #48 state-safety
  argument: nothing in the checkpoint mutates regrets, cumulative or
  current strategy, locks, or iteration order.
- Progress reporting (#48) prints the reading when the reporter is due
  (`progress.due(iter)`), unchanged.
- The early stop is due when `target_exploitability_pct > 0.0` and
  `iter % STOP_CHECK_EVERY == 0`. On a due checkpoint whose
  `report.nash_distance_pct <= target`, the loop `break`s into the
  **existing** final extraction + pricing below the loop. The result's
  `exploitability` is therefore the final extraction's own measurement
  (identical to what a full run of the same length reports), and the
  new `iterations_run` local — initialised to `max_iterations` and set
  to the break iteration — is what lands in `result.iterations` and
  the result JSON.

Deliberate non-differences from the turn/river pattern:

- Turn/river cache the checkpoint report and reuse it as the final
  report. The flop does not: it always re-prices after the loop, so a
  stopped solve's certified number comes from the same code path as a
  full run's. The cost is one extra checker pass per stopped solve —
  nothing, against a multi-hour run.
- Turn/river also check at `iter == max_iterations`. For the flop that
  check could change nothing (the loop is over either way and the
  final pricing measures the same snapshot), so it is omitted.

## Cadence decision

`STOP_CHECK_EVERY = 1000`, exported from `flop.rs` as a constant equal
to `progress::DEFAULT_PROGRESS_EVERY` — and deliberately **not**
`progress::progress_every()`:

- Stopping behaviour must be identical with progress reporting on,
  off, or at any interval. Reading the env-driven value would make a
  solve's stopping point depend on an operator's reporting knob, and
  `PLO_PROGRESS_EVERY=0` (reporting disabled) must never disable or
  delay the stop. The constant gives the stop its own cadence in the
  same units the codebase already uses for flop checkpoints.
- 1000 is the right order of magnitude because a flop checker pass
  prices all 49 turn subtrees exactly. At the #48 gate a pass on a
  trimmed 25-combo spot cost ~12 s against ~8.5 s per iteration:
  paid once per 1000 iterations that is ~0.14% overhead there, and
  less on catalog spots (300 combos/side), whose iterations are far
  slower. The turn/river `check_interval` (default 25) was rejected
  for the flop: at flop checker prices, a 25-iteration cadence would
  tax every solve ~5% for a stopping precision nobody needs — a
  catalog flop gains nothing from stopping at iteration 975 instead
  of 1000.
- When a progress line and a stop checkpoint fall on the same
  iteration (always, at default settings), the single checkpoint
  computation above serves both — no double checker pass.

Behaviour guarantees:

- **Target 0**: byte-identical to the pre-change solver. `stop_due`
  is always false, the merged checkpoint reduces to the old progress
  block, and `iterations` still reports `max_iterations`.
- **Positive target, target never reached** (or run shorter than one
  cadence): same result as pre-change; the checkpoints are read-only.
  Only wall time differs (the added checker passes).
- **Positive target, reached**: the solve stops at a checkpoint
  multiple of 1000 and reports that snapshot's final pricing.

## Fixture audit (requirement: positive-target flop fixtures that
## expect a full course must pin target 0)

Every flop-solving test and fixture in the repo was audited. **All of
them already pin `target_exploitability_pct: 0.0`** — the codebase's
existing convention for deterministic full-course flop tests — so no
fixture needed changing:

- `tests/flop_validation.rs`: `config(iters)` helper pins 0.0 (used
  by the smoke, zero-sum, and abstraction-loss solves, including the
  `iterations == 60` assertion); the JSON round-trip fixture carries
  `"target_exploitability_pct": 0.0` explicitly.
- `tests/e5_threading.rs`: `fixed_iters` pins 0.0 (bit-identity runs).
- `tests/nodelock_validation.rs`: `fixed_iters` pins 0.0 (both flop
  call sites).
- `tests/action_ev_validation.rs`: `fast_cfg()` pins 0.0; the flop
  solve goes through a JSON fixture with explicit 0.0.
- `src/bin/measure-flop.rs`: both solve configs pin 0.0 — its timing
  and abstraction-loss measurements stay full-course by design.
- `src/bin/solve-flop.rs`: not a fixture — the production path; its
  target comes from the spot JSON, which is exactly the input this
  fix exists to honour.
- No `#[cfg(test)]` module inside `src/` solves a flop.
- Out of scope and untouched: the positive targets in
  `turn_validation.rs` / `validation.rs` belong to turn/river solves,
  whose solvers already stop on target.

## Tests added

`tests/flop_early_stop.rs`, on a 4-combo/side spot in the measured
loss-spot family (the 18-combo version reaches ~0.001% at 4000
iterations, so the small version crosses a loose target at the first
checkpoint with wide margin):

- (a) target 5%, max 4000: stops with `iterations == STOP_CHECK_EVERY
  (1000) < 4000`, final Nash ≤ 5%, zero-sum invariant holds through
  the real final pricing.
- (b) target 0, max 1200 (crosses a checkpoint): full course, legal
  strategies, zero-sum; plus target 5% vs target 0 at max 500 (below
  the first checkpoint) are bit-identical in strategies, EVs, and
  Nash.
- (c) `PLO_PROGRESS_EVERY=0`: the (a) run stops identically. The
  reporter's interval latches once per process, so the test holds in
  every interleaving by construction; the gate's binary-level check
  below is the heavyweight version.

## Gate must verify

1. Full cargo suite (release) green, including the new
   `flop_early_stop` tests and all pre-existing suites unchanged.
2. **Bit-identity, target 0**: solve a fixed flop spot via the
   `solve-flop` binary pre-change (main `e9a81c2f`) and post-change;
   result JSONs byte-identical. Repeat post-change with
   `PLO_PROGRESS_EVERY` unset and `=0` — identical again.
3. **Progress-independence of stopping**: the same spot JSON with a
   positive target, solved post-change with `PLO_PROGRESS_EVERY`
   unset / `=0` / `=250`, produces byte-identical result JSONs (same
   `iterations`, same Nash).
4. **Timed real-spot run**: a catalog flop spot (300 combos/side,
   target 0.3) now *finishes*: `iterations` ≪ 2,000,000, final Nash
   ≤ 0.3, wall time recorded. This is the first catalog flop ever to
   complete; expect hours, not the timeout's worth.
5. Watch: tests (a)/(c) pin the stop at exactly iteration 1000 on the
   fixture. If the fixture's crossing lands at a later checkpoint,
   shrink the fixture spot or loosen its target — do not change the
   cadence to fit the test.
6. Watch: the new tests add up to ~4,200 iterations on a 4-combo spot
   (worst case) to suite wall time; confirm the debug suite stays
   tolerable.

## Activation

Engine-only change: it takes effect wherever the rebuilt solver
binaries land (runner packages, the VPS engine build). Burn runners
keep their running binaries until their next refresh — no runner
restart is implied or required by this change itself.
