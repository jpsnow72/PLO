# NODELOCK — implementation notes (Ship 3, engine ticket)

Implements the 2026-11-17 nodelocking brief: a solve may fix one player's
strategy at a chosen decision node (a list of such locks per solve) and
re-solve the rest of the tree around it, with the honesty contract intact —
locked output is badged `locked: true` + the lock list, and the independent
checker prices the locked profile exactly as it prices unlocked ones.

## Design decisions

- **Lock spec lives in `DcfrConfig.locks: Vec<NodeLock>`** (the shared
  solver config for river/turn/flop, following the TreeConfig/DcfrConfig
  pattern). `NodeLock { history, player, frequencies }` is defined in the
  new `engine/crates/plo-solve/src/locks.rs`. Consequence: `DcfrConfig`
  lost its `Copy` derive (it now owns a Vec). Every existing construction
  site uses `..DcfrConfig::default()` struct-update syntax and every solve
  entry point takes `&DcfrConfig`, so nothing else had to change.
- **Node identity = the output history key** (what the Explorer already
  navigates by):
  - River: native history (`"root"`, `"X"`, `"B(75)"`).
  - Turn: native two-street history (`"root"`, `"X/X|r:As"`,
    `"X/X|r:As/B(75)"`). Chance-node histories (`"X/X"`) name no decision
    node and are rejected, as the brief requires.
  - Flop: native flop history for flop-street nodes; the namespaced
    subtree key (`"{flop_history}|t:{turn_card}/..."`) for turn/river
    nodes inside a subtree — `locks.rs::split_subtree_key` is the exact
    inverse of `json.rs::flop_subtree_history`. If the history-key scheme
    in json.rs ever changes, the flop resolver must change with it (the
    coupling is commented in both places).
- **Whole-node semantics**: one frequency vector per node, applied to
  every combo (river/turn) or every bucket (flop street) of the acting
  player at that node. On the flop street this composes correctly with
  bucketing: `expand_bucket_strategies` expands the locked bucket profile
  to combo level, so the JSON output shows the lock vector per combo and
  the checker evaluates exactly that profile in the unabstracted game.
- **Validation is a separate, public step** (`validate_locks_river/turn/
  flop`, returning `SolveError::InvalidLock`): unknown history, wrong
  player, vector length ≠ the node's legal action count, negative or
  non-finite frequency, sum ≠ 1 ± 1e-6 (`LOCK_SUM_TOLERANCE`), duplicate
  lock for a node, lock on a chance node, lock into a dead flop subtree.
  The three CLI bins call it right after game construction, so a bad lock
  is a clean `solve-* error: invalid node lock: ...` exit-1 with **no
  solve started** (criterion 1). The `solve_*` functions also resolve the
  locks themselves and `expect()` on failure — an invalid lock reaching a
  solve is a caller bug; changing `solve_*` to return `Result` would have
  churned every existing call site and test for no behavioural gain.
- **Early stopping is unchanged**: with a target set, a locked solve
  whose profile can't reach the target simply runs its full iteration
  budget (the checks extract strategies through the same
  `to_node_strategy`, so a locked node contributes its lock vector to
  every intermediate measurement too).

## Where the seam lives

One uniform mechanism in all three buffer types (`NodeBuffer` in cfr.rs,
`TurnNodeBuffer` in turn.rs, `FlopNodeBuffer` in flop.rs):

- `lock: Option<Vec<f64>>` on the buffer; `set_lock()` pins
  `current_strategy` to the vector for every combo/bucket row.
- `recompute_current_strategy()` returns early on locked buffers (no
  regret matching there).
- The traversal still computes the node's counterfactual values under the
  locked strategy (parents and the checker depend on them) but skips both
  the regret update and the cumulative-strategy accumulation at locked
  nodes.
- `to_node_strategy()` returns the lock vector **verbatim** — nothing was
  accumulated, so there is no normalization rounding; this is what makes
  criterion 2 (output equals the lock exactly) hold bit-for-bit, before
  and after the output's 6-decimal serialization.
- Opponent-side traversal needs no change: reach propagation reads
  `current_strategy`, which is the pinned vector.

Wiring: `solve_river` resolves + pins before iteration 0;
`solve_turn_impl` does the same via the new
`TurnSolverState::apply_locks()`; `solve_flop_with_threads` resolves a
`FlopLockPlan` (flop-street vectors + per-subtree vectors) and applies the
subtree part through the same `apply_locks()`, so flop inherits the turn
seam for its 49×N subtrees with no second implementation. The E5a
chance-fork partitioning is unaffected (locks live inside the buffers the
fork already partitions; a locked buffer's strategy is constant, so
results stay bit-identical at any thread count).

The checker (`br.rs`) needed **no changes at all**: it consumes
`NodeStrategy` lists, and locked nodes emit the lock vector as their
strategy, so exploitability + per-player EVs for locked profiles are
computed by the identical code path as unlocked ones (criterion 4's "no
DRAFT shortcut" is structural, not a flag).

## Output / JSON

- Result structs (`SolveResult`, `TurnSolveResult`, `FlopSolveResult`)
  gained `locks: Vec<NodeLock>` (echo of the config; empty = unlocked).
- All three result formatters emit, right after `"iterations"`:
  `"locked": <bool>` and `"locks": [{"history", "player", "frequencies"}]`
  — always present (unlocked solves emit `false` / `[]`) so the schema is
  stable for consumers. Frequencies print at the house 6-decimal format,
  matching the strategy values they constrain.
- All three spot parsers accept an optional `"locks"` array
  (`"node"` aliases `"history"`; `"OOP"/"IP"` case-insensitive). Parsing
  checks shape only; semantics are validated against the built game.

## API pass-through (api/server.mjs)

The API already forwards the client spot JSON verbatim to the engine
binary, so `locks` flows end to end. Added, minimally:

- `locksFieldError()` shape validation in `POST /api/solves` → **400** on
  a non-array field, >64 locks, missing/empty history, bad player,
  non-finite/negative frequencies, or frequencies not summing to 1
  (±1e-6). Semantic failures (unknown node etc.) surface as the job's
  `error` with the engine's message, like any other engine rejection.
- `locked: true/false` recorded on the job record (derived from the spot
  in `submitJob`, so the catalog-queue path gets `false` for free) and in
  the library `.meta.json`, so surfaces can badge LOCKED without opening
  the result JSON.
- Docs: header comment in server.mjs + a "Nodelocked solves" section in
  api/README.md.
- The catalog queue / local runner never generates locks (catalog spots
  carry none); a runner-produced locked solve ingested via
  `/api/library/ingest` keeps its result-JSON badge, but the ingest meta
  does not currently mirror `locked` — noted as a gap below.

## Tests (written, not run — coordinator gates on a host)

`engine/crates/plo-solve/tests/nodelock_validation.rs`, 8 tests:

1. `lock_validation_rejects_bad_specs_river` — criterion 1 (unknown node,
   wrong player, bad sum, wrong length, negative, duplicate) + a
   well-formed lock validating.
2. `lock_validation_rejects_bad_specs_turn_and_flop` — chance-node lock,
   wrong player, unknown flop history, subtree key below a non-closing
   flop line.
3. `locked_node_output_equals_lock_vector_river` — criterion 2: two
   simultaneous locks (root + IP-after-check), exact `f64` equality per
   combo in the result, plus the JSON badge and 1e-6 post-serialization
   equality.
4. `locked_node_output_equals_lock_vector_turn` — turn root lock + a
   river node inside the turn game (history learned from an unlocked
   solve), exact equality.
5. `locked_node_output_equals_lock_vector_flop` — flop root lock (exact
   in `flop_strategies`) + a turn-subtree node locked via its output
   history key, verified through the formatted JSON (the Explorer's
   contract); also asserts unlocked output carries `"locked": false`.
6. `equilibrium_lock_reproduces_root_evs_river` — criterion 3 on the
   textbook polar-vs-bluff-catcher game: IP's single-combo node facing
   the all-in bet is locked to the unlocked solve's own average strategy
   there; 20,000 iterations both sides; asserts root EVs within 0.5
   chips, the free opponent's best-response gain < 0.25 chips, and the
   locked player's best-response gain fully attributable to the locked
   node (single-node swap decomposition). The brief's original
   whole-profile Nash bound (< 0.25%) was removed as mathematically
   unattainable for a single-node lock — see the gate finding below.
7. `bad_lock_raises_measured_exploitability_river` — criterion 4:
   always-check at the root with the polar range; asserts Nash distance
   rises by > 5 points over the unlocked solve, OOP EV drops > 10 chips,
   and locked EVs still sum to the pot.
8. `locks_json_parse_and_shape_errors` — `"locks"` parses on all three
   spot types (incl. the `"node"` alias), four malformed specs are
   `JsonError`s, and a JSON-driven locked solve round-trips the badge.

## Gate finding (2026-11-17): criterion 3's Nash bound was a test-premise defect

The first host gate failed exactly one test: this one, at the Nash
assertion (measured 8.2263%). Diagnosis on the VPS (single-test
reproduction, bit-identical number) priced the source profile, the
locked profile, and surgical hybrids with the checker itself:

- The lock source is sound: the unlocked 20k profile prices at 0.0268%
  Nash (EVs 74.989 / 25.011), and the lock vector taken from it is IP's
  equilibrium mix at BAI(100): fold 0.5001 / call 0.4999.
- The locked profile's EVs reproduce (75.002 / 24.998, drift 0.013
  chips) and OOP's best-response gain against it is 0.0033 chips — the
  lock hands the free opponent nothing, and the seam prices exactly
  the profile it solved (locked IP nodes + unlocked OOP averages
  re-price at 0.0268%, the unlocked figure).
- IP's entire best-response gain (8.2229 chips) is attributable to the
  locked node alone: swapping only that node's vector to always-call
  raises IP's EV from 24.9978 to 33.2211 (+8.2233, matching the full
  gain to ~0.001 chips).
- Mechanism: with IP's call frequency pinned at 50%, nothing punishes
  OOP for bluffing the all-in more, so OOP's re-solved average drifts
  (air all-in frequency 49.9% unlocked -> 66.4% at 20k -> 99.9% at
  200k). Against the drifted range the pinned mix is genuinely
  exploitable, and more iterations make the measured Nash distance
  WORSE (24.9628% at 200k): the constrained solve converges to the
  constrained game's equilibrium, which is not an equilibrium of the
  full game. A single-node equilibrium lock therefore cannot promise
  a whole-profile Nash bound; it promises value preservation, no free
  gain for the opponent, and a price attributable to the pinned node.
  The test now asserts exactly those three properties. No engine or
  checker code changed: the failure was the criterion, not the seam.

## Deferred / gaps

- **UI lock editor** — follow-up ticket per the brief; the UI gains
  nothing here beyond the result-JSON fields to badge from.
- **Ingest meta `locked`** — `/api/library/ingest` does not mirror the
  flag into `.meta.json` for runner-produced solves (the result JSON
  itself carries it). One-line follow-up if library badging wants it.
- **Per-combo locks** — out of scope in v1 by the brief; the buffer seam
  would support them (pin per-row vectors) if a v2 wants them.

## Risks for the host gate

- **First compile is the gate's** (lane rule: no cargo on this VM). The
  riskiest spots, in order: (a) `locks.rs` iterator/lifetime plumbing
  (`NodeView` alias + `impl Iterator` returns) — written to mirror the
  existing per-game accessor patterns, but it is new code; (b) the
  `DcfrConfig` `Copy` removal — I grepped every construction/consumption
  site (all struct-update literals or `&` borrows; the only full literal
  is the updated `Default` impl), but a missed by-value reuse would
  surface as a move error; (c) brace balance in the flop traverse edits.
- **Criterion-3 tolerances** (0.5 chips EV, 0.25 chips opponent gain,
  0.05 chips decomposition equality at 20k iterations on the textbook
  game) were calibrated at the 2026-11-17 gate: measured values were
  0.013 / 0.0033 / 0.0004 chips respectively, so each bound carries
  roughly an order of magnitude of headroom. The original 0.25% Nash
  assertion was removed as a proven test-premise defect (see the gate
  finding above), not widened.
- **Flop test runtime**: the flop test solves a 2×2-combo Exact spot
  three times at 5 iterations — far below the existing flop suite's
  8–14-combo, 60–150-iteration spots, but flop iterations traverse all
  49 subtrees × 48 runouts, so it is the slowest new test by construction.
- `node --check api/server.mjs` passes (syntax only; the API's own test
  files were not extended — the multiway.test.mjs pattern would be the
  model if the coordinator wants an API-level locks test).
