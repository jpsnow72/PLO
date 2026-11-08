# E5a — Multithreaded DCFR solver: implementation notes

Branch `e5-multithread`, base `main` @ `2fcb6a3`. Build-only lane: no
cargo was run on the authoring machine; all verification commands below are
for the coordinator's build host.

## The seam

The fork lives in exactly one place: **`turn_traverse`'s chance-node arm**
(`engine/crates/plo-solve/src/turn.rs`). At a chance node, the 48 river
runouts are partitioned into contiguous, slot-balanced groups
(`plan_chance_groups`); each group is evaluated on a `std::thread::scope`
worker over a **disjoint partition of the shared `buffers` array**, and the
parent combines the returned counterfactual values in ascending runout
order.

Why this seam covers both target binaries:

- `solve-turn` is one `TurnGame` traversal — every closed turn line passes
  through a chance node, so the fork engages throughout the solve.
- `solve-flop`'s heavy work is its 49-per-history `TurnGame` subtrees,
  driven through `TurnSolverState::traverse_root` → the same
  `turn_traverse`. The flop solver just forwards the thread count into
  each subtree state (`solve_flop_with_threads`); the flop-street
  traversal itself stays sequential, which keeps the 49 subtrees'
  contributions summed in the established order and avoids nested thread
  explosion (outer fork × inner fork). Per E4's accounting the flop street
  is ~0.005% of infosets, so leaving it sequential costs nothing
  measurable.
- `solve-river` is **unchanged**: the river game has no chance nodes, and
  its trees are small next to turn/flop (the E2 spot checks solve in
  seconds). Forking there would need a second partitioning mechanism
  (decision-node children) for little gain. Noted as possible future work.

## Why partitioning is safe (and bit-identical)

1. **Each node is updated by exactly one worker, with identical math.**
   Within a half-iteration, `current_strategy` is fixed — it is recomputed
   only by `begin_update`, which runs between traversals — and the full
   traversal visits every decision node exactly once. A node's regret
   update (including the DCFR discount, applied to
   `regrets + inst_regret` in that order) and its cumulative-strategy
   accumulation therefore happen exactly once, inside exactly one worker,
   with the same operand order as the sequential code.
2. **Subtree buffer ranges are contiguous and disjoint.** Both tree
   builders assign node ids and decision ids in DFS pre-order, so the
   decision nodes of any subtree form one contiguous decision-id range.
   `ForkTables` (built once per `TurnSolverState`) precomputes
   `decision_prefix` / `slot_prefix` / `node_subtree_len`, making any
   subtree's buffer range an O(1) lookup. Sibling ranges are adjacent; the
   fork only relies on each child's range lying inside its group's carved
   slice, which holds by construction.
3. **Combination order is fixed.** Workers return per-child CFV vectors;
   the parent adds `RIVER_DEAL_PROB * child_cfv[i]` into `node_cfv[i]` in
   ascending runout order — the identical sequence of floating-point
   operations as the sequential loop.

Consequence: **results are bit-identical at any thread count**, not merely
within tolerance (single-thread code path is the same function with the
fork branch never taken — the sequential chance loop is preserved
verbatim). The integration tests assert ≤ 1e-9 (ticket tolerance) for
1-vs-4 threads and exactly 0.0 for a repeated 4-thread run, so a platform
float quirk would not produce a spurious failure while a real divergence
still would.

## What changed, per file

- `src/parallel.rs` (**new**): thread-count resolution
  (`solver_threads()`: `PLO_SOLVER_THREADS` ≥ 1 wins as-is; missing /
  unparsable / `0` → `available_parallelism()` → `1`; resolved once per
  process via `OnceLock`), the fork policy (`should_fork`: threads ≥ 2
  and chance-subtree slots ≥ `MIN_FORK_SLOTS = 1024`), and a diagnostic
  fork counter (`parallel_fork_events()`) so tests/benches can prove the
  fork engaged. Pure-resolution unit tests included. **No new
  dependencies** — std scoped threads only, no rayon.
- `src/turn.rs`:
  - `ForkTables` + `ChanceGroup` + `plan_chance_groups` (greedy
    slot-balanced contiguous grouping; group count ≤ threads), with unit
    tests for partitioning and for span contiguity on a real game.
  - `TurnSolverState` gains `threads` (env-resolved at construction,
    `set_threads()` override) and `fork_tables`.
  - `turn_traverse` gains `fork` / `threads` / `buf_base` parameters
    (`buffers[i]` = decision id `buf_base + i`), the chance fork, and
    partition-relative buffer indexing in the decision arm. DCFR
    parameters and every arithmetic expression are untouched.
  - `solve_turn` refactored into a thin wrapper over `solve_turn_impl`;
    new `solve_turn_with_threads`.
- `src/flop.rs`: `solve_flop` delegates to new `solve_flop_with_threads`;
  subtree states get `set_threads(threads)`. Nothing else.
- `src/lib.rs`: `pub mod parallel;`, exports for the two
  `*_with_threads` functions.
- `tests/e5_threading.rs` (**new**): thread-count invariance (turn and
  flop spots, 1 vs 4 threads; flop test also re-asserts the E4 zero-sum
  identity under threading for both modes), exact reproducibility of a
  repeated 4-thread solve, and fork-counter engagement assertions. The
  two tests serialise on a mutex because the fork counter is
  process-wide.
- `engine/bench-e5a.sh` (**new**): benchmark driver over the existing
  `measure-flop` harness (see below).
- `cfr.rs` (river): **untouched** — the single-thread path everywhere is
  the pre-E5a algorithm; DCFR α=1.5 / β=0 / γ=2 semantics unchanged.

## Judgement calls

- **Fork threshold on slots, not nodes.** Fork if the chance subtree
  holds ≥ 1024 total action slots (`combos × actions` summed over its
  decision nodes). Slot count tracks real work (kernel evals scale with
  combos); node count alone does not. 1024 is deliberately low — a fork
  event costs tens of µs of spawn/join against ≥ ~ms of traversal — and
  is a tuning constant, not a correctness parameter.
- **Explicit values in `PLO_SOLVER_THREADS` are honoured above the core
  count** (the planner never makes more groups than children, so an
  oversized value degrades to "one group per child" rather than error).
  `0` is treated as invalid → default.
- **Fork counter.** A process-wide relaxed `AtomicUsize` exists solely
  as a diagnostic so verification can distinguish "fork ran" from "fork
  silently never engaged". It has no effect on solving.
- **Thread stack**: scoped threads use the default 2 MiB stack. Traversal
  depth below a chance node is just the river subtree (~a dozen frames,
  heap-allocated vectors), so this is comfortable headroom; no custom
  stack size is set.
- **No nested forks along a path**: a `TurnGame` has at most one chance
  node per root→leaf path (river subtrees contain no chance nodes), so
  workers never fork again in practice. The partitioning is written
  relative to the caller's `buf_base`, so a hypothetical nested fork
  would still be correct, just less efficient.

## Risks / things the coordinator should eyeball

- **Nothing here was compiled on the authoring machine** (hard rule).
  The changes were reviewed by hand; the most likely first-compile
  friction is borrow/lifetime minutiae around the `split_at_mut` carving
  loop and the scoped-thread closures in the chance arm, and any
  unused-import fallout in the new test file. All are local fixes.
- The bit-identity claim rests on the three-part argument above; the
  e5 tests are the enforcement. If a 1-vs-4 diff ever shows up nonzero
  beyond float noise, the suspect order is: (1) a decision node visited
  by two workers (span bug), (2) combine order at a chance node,
  (3) a `current_strategy` mutation during traversal.
- Memory: unchanged working set (partitions are views into the same
  buffers); workers add per-thread traversal scratch only (the small
  reach/CFV vectors the recursion already allocates).
- Oversubscription interplay: when the API/runner later drives several
  solves concurrently on one host, each solve will try to use all
  threads. That's a caller-side scheduling concern (set
  `PLO_SOLVER_THREADS` per process); flagged here, not solved here.

## Verification (coordinator, on the build host)

```bash
cd engine
# Full crate suite (existing E2/E3/E4 + ranges + new E5a tests):
cargo test --release -p plo-solve
# E5a tests only, both modes:
cargo test --release -p plo-solve --test e5_threading
cargo test -p plo-solve --test e5_threading           # debug (lighter spots)
cargo test -p plo-solve --lib parallel                # env-resolution unit tests
cargo test -p plo-solve --lib e5_fork                 # planner/span unit tests
```

Expected: everything green, including the pre-existing zero-sum identity
tests (`flop_validation`) — the flop e5 test additionally asserts the
identity on the 4-thread result itself, and that the fork counter moves
only for threaded solves.

## Benchmark

`measure-flop` (the E4 harness) already solves the canonical spot at a
fixed iteration count and prints wall time + checker Nash:

```bash
cargo build --release -p plo-solve --bin measure-flop
ITERS=120 THREADS_LIST="1 6" ./bench-e5a.sh
```

Expected output per run (existing `measure-flop` format, unchanged):

```
RESULT canonical K=exact iters=120 wall=<s>s per_1k_iters=<s>s checker_nash=<x>% of pot (oop_ev=..., ip_ev=...)
```

followed by the script's `SPEEDUP threads=<t> wall=<s>s speedup=<r>x`
summary. Acceptance reading: `checker_nash` (and the EVs) must agree
across thread counts to all printed digits (bit-identical design); the
speedup at 6 threads on the 6-vCPU host should be roughly 3–5x (the
flop-street walk, per-iteration setup, `begin_update` sweeps, and the
final checker pass remain sequential). E4's single-thread baseline for
this spot was ~3,600 s per 1,000 iterations; at ITERS=120 the 1-thread
run takes ~7 minutes — use a smaller ITERS (e.g. 20) for a quick smoke,
accepting a noisier ratio.
