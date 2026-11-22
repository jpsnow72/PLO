# Solver progress reporting (issue #48)

The engine emitted nothing while solving — a 17-hour flop solve left a
0-byte log, and nobody could say whether it was near its target or days
away. This change adds measured mid-solve progress end to end: engine →
runner → Runner page. Every number shown is the independent checker
pricing the current average strategy — the same computation that
produces a finished solve's certified Nash distance. Nothing is
estimated or interpolated.

## The line

One line per report, to **stderr only** (stdout and the result JSON are
untouched):

```
PROGRESS iter=<n> expl_pct=<x.xxxx> elapsed_s=<integer seconds since solve start>
```

- `iter` — iterations completed when the reading was taken.
- `expl_pct` — Nash distance in % of the starting pot, 4 decimals; the
  same quantity as the final report's `nash_distance_pct`, directly
  comparable to the spot's `target_exploitability_pct`.
- `elapsed_s` — wall seconds since the solve loop started.

## Cadence: `PLO_PROGRESS_EVERY`

Env var, parsed once per process (`engine/crates/plo-solve/src/progress.rs`):

- unset → every **1000** iterations (default)
- a positive integer N → every N iterations
- `0` or an unparseable value → reporting **disabled** (a typo fails
  off, never crashes or silently re-cadences a long solve)

## Engine: where each street hooks the checker

Each solve loop builds the same average-strategy snapshot its final
result carries and calls the same `br.rs` checker its final number
comes from — so a locked solve's mid-solve reading prices the locked
profile exactly as the final check does (locks live in the snapshot
extraction: locked nodes emit their lock vector verbatim).

- **River** (`cfr.rs::solve_river`): snapshot =
  `buffers[did].to_node_strategy(game, did)` over all decision nodes;
  checker = `compute_exploitability`. (Identical to the existing
  early-stop check's snapshot + call.)
- **Turn** (`turn.rs::solve_turn_impl`): snapshot =
  `state.average_strategies(game)`; checker =
  `compute_exploitability_turn`. (Identical to its early-stop check.)
- **Flop** (`flop.rs::solve_flop_with_threads`): snapshot =
  the new `flop_average_strategies` helper (flop-street buffers'
  `to_node_strategy` + each subtree state's `average_strategies`);
  checker = `compute_exploitability_flop`. The final extraction now
  calls the same helper, so mid-solve and final snapshots cannot drift
  apart in shape.

The hook sits at the end of each iteration, after both half-iteration
traversals — the moment the average strategy reflects `iter` completed
iterations. It is independent of the early-stopping configuration: it
fires even when `target_exploitability_pct` is 0 (flop solves, which
have no early stop, report too). When a progress boundary and an
early-stop check land on the same iteration, the checker runs twice;
the cadences are independent by design.

### State safety: why the check cannot perturb the solve

- Every snapshot extractor takes `&self` (`NodeBuffer::to_node_strategy`,
  `FlopNodeBuffer::to_node_strategy`, `TurnSolverState::average_strategies`)
  and allocates fresh `NodeStrategy` values; nothing writes back into
  regrets, cumulative strategy, current strategy, or lock state.
- All three checkers take shared references (`&Game`, `&[NodeStrategy]`)
  and return a fresh report; none takes `&mut` anything, so no clone or
  wrapper was needed anywhere.
- The reporting path touches no RNG (the solvers have none), no
  iteration order, no discount weights, and no threading: the check
  runs on the solve thread between iterations, never inside a
  traversal fork.
- Output goes to stderr via `eprintln!`; the result JSON is built from
  the same values as before. A reported solve's result must therefore
  be **byte-identical** to an unreported one — the gate verifies this
  (below), it is not merely argued.

## Runner (`api/server.mjs`)

- `runJob` now appends the engine's full stderr stream to
  `DATA_DIR/jobs/<jobid>/engine.log` (a write stream; a stream error is
  swallowed so a logging failure can never fail a solve). The existing
  in-memory stderr tail and the failure message built from it are
  unchanged.
- PROGRESS lines are parsed incrementally from the same stream
  (line-buffered across chunks). The latest reading is kept on the job
  record as `progress: { iter, expl_pct, elapsed_s, received_at }`,
  **in memory only** — it reaches `job.json` on the next record write
  (job settle), never one file write per line.
- The job record also gains `target_exploitability_pct`, copied from
  the submitted spot at `submitJob` time (queue spots always carry
  one: balanced 0.3 / precise 0.1; a direct submission may omit it →
  null).
- Exposure is additive and automatic where job objects are returned:
  `publicJob` strips only `stderr_tail`, so `GET /api/solves/:id` and
  `GET /api/jobs` carry `progress` + `target_exploitability_pct` with
  no route changes. Queue items are separate records, so `queueTick`
  mirrors both fields from the running item's job each pass — in
  memory (GET /api/queue reads the live objects), persisting with the
  next `saveQueue()` a state change triggers, including settle.
- No PROGRESS line seen → `progress` stays `null`. Never fabricated.

## UI (Runner page)

- `ui/src/lib/runner.ts`: `JobProgress` type; `QueueItem.progress` and
  `QueueItem.target_exploitability_pct`, both defensively guarded
  (absent/null on older servers → normalised to null).
- `ui/src/pages/Runner.tsx`: a running item with a progress reading
  shows `iter <n> · expl <x.xxxx>% · target <t>%` (target only when the
  item carries one), in the same plain meta line as the elapsed time.
  No bars, no percentages-of-completion — the page shows measurements,
  not guesses.

## Tests

- `api/progress.test.mjs` (new): boots the real server against scratch
  DATA_DIR/ENGINE_BIN with two fake engines. The river fake emits two
  PROGRESS lines before its result; the test asserts a live running
  snapshot carries the reading, the settled record holds the LAST
  reading, `target_exploitability_pct` round-trips, and `engine.log`
  holds the full stream. The turn fake emits nothing; its job finishes
  with `progress: null` in every snapshot. **Lane-verified: 2/2 pass.**
- `engine/crates/plo-solve/src/progress.rs` unit tests: env parsing
  (unset → 1000, `0` → disabled, valid values pass through, invalid →
  disabled). Run by the cargo suite at the gate.
- The lane ran no cargo and no UI build (lane rules); the UI typecheck
  could not run in the lane tree (no `node_modules` there) — first
  compile is the gate's, as usual.

## The overhead question (honest)

A progress reading costs one full checker pass. On river and turn that
pass is the same work the early-stop check already does every
`check_interval` iterations, so the added cost at the default 1000 is
negligible. **On the flop it may not be**: a flop checker pass prices
all 49 turn subtrees at exact combo level, while one flop iteration is
bucketed on the flop street — the pass could plausibly cost as much as
several iterations. If the gate's measurement shows that, the right
response is to raise the default interval (or make it per-street), not
to weaken the check: a progress number that is not the real checker
pricing the real profile is worse than none. This lane built the
mechanism; the tuning belongs to the gate's measurement.

## Gate must verify

(a) **Bit-identity** — solve the same river spot and the same turn
    spot with `PLO_PROGRESS_EVERY=0` vs `PLO_PROGRESS_EVERY=5`; the
    result JSONs must be byte-identical in each pair. (Flop too if a
    short flop spot is handy.)
(b) **Flop checker cost** — from a short flop run with a tiny progress
    interval (e.g. `PLO_PROGRESS_EVERY=5`): measure one checker pass's
    wall time (gap between PROGRESS lines minus iteration time, or
    elapsed deltas) against the flop iteration pace, and report the
    ratio. If a pass costs more than ~an iteration, propose a new
    default interval in the ship notes before this ships.
(c) **Suites green** — full cargo suite (includes the progress.rs
    parsing tests), the api suite via the glob invocation
    `node --test api/*.test.mjs` in a tree with engine binaries built,
    and the UI build.
(d) **Live smoke** — one short queue/direct solve with
    `PLO_PROGRESS_EVERY` set small on the runner: the job shows live
    progress in GET /api/solves/:id, the queue item mirrors it, the
    Runner page renders the iter/expl/target line, and
    `jobs/<id>/engine.log` contains the PROGRESS lines.
