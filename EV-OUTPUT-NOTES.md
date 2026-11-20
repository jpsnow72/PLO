# EV-OUTPUT-NOTES — per-action EV engine output (issue #8)

## What shipped

After a solve converges, the engine runs one exact evaluation pass over
the solved tree and emits, at **every decision node**, the EV of **each
legal action** for **every combo** of the player to act — river, turn,
and flop (flop street + every turn-card subtree). This is the field the
Explorer EV Diff column, non-root EV Buckets/Breakdown, and Trainer
EV-loss grading were waiting on.

- Engine: new module `engine/crates/plo-solve/src/action_ev.rs`
  (`compute_action_evs_river` / `compute_action_evs_turn` /
  `compute_action_evs_flop`, record type `NodeActionEvs`). Each solver
  (`solve_river`, `solve_turn`/`solve_turn_with_threads`, `solve_flop`/
  `solve_flop_with_threads`) computes it once, after the final average
  strategies are fixed, and stores it on its result struct as
  `action_evs` (flop: `FlopActionEvs { flop, subtrees }`, mirroring the
  strategy layout). Solver iteration behaviour is unchanged — the pass
  reads the finished profile only.
- Payload: `json.rs` — every node object gains a `combo_action_evs`
  block beside its `strategy` block (all three formatters; flop subtree
  nodes included).

## Payload shape

```json
"actions": ["check", "bet"],
"strategy":         { "As Ac 3h 4h": [0.500000, 0.500000] },
"combo_action_evs": { "As Ac 3h 4h": [12.340, -3.210] }
```

- Same combo keys, same row order as `strategy`; values aligned with the
  node's `actions` array; units are **chips**, net of the whole hand
  (the `oop_evs`/`ip_evs` convention: folding at the root is worth 0).
- The field name and shape are the ones the UI's quiz grader already
  reads defensively (`ui/src/lib/quiz.ts`, `actionEvsFor`) — EV-mode
  grading lights up with zero UI changes when solves carrying the field
  appear. Issue #19's Explorer surfaces read the same field.
- Per-combo **node EVs are not serialized**: they are exactly
  `sum_a freq(a) * combo_action_evs[a]` from data already in the node,
  and the root values already ship as `oop_evs`/`ip_evs`. (The Rust
  record does carry `node_evs` for tests/internal use.)

## Where the values come from (math)

The pass runs the checker's strategy-evaluation traversal (`br.rs`,
`maximize = false`) once per player and records the per-action
counterfactual values (CFVs) at the traverser's own decision nodes
before they are mixed by the traverser's frequencies. It shares the
checker's conventions exactly — terminal payoffs (fold/showdown, net of
the whole hand), card removal, hand ranks from E1's `eval_omaha`, and
chance handling (`RIVER_DEAL_PROB` / `TURN_CARD_DEAL_PROB` multiply
values, never reaches).

A recorded value is a **conditional** EV: `CFV(i, a) / Z(i)`, where
`Z(i)` is the opponent reach mass live at the node against combo `i`
(opponent combos that neither overlap `i` nor contain a card dealt on
the path to the node). Chance probabilities cancel between numerator
and denominator, so values at runout nodes are exact. Two consequences
worth knowing:

- **Flop subtrees:** values are shifted by `- committed` (the per-player
  flop commitment) — the checker's seam correction divided through by
  `Z(i)` — so every value in a subtree is net of the whole hand, not
  just of the subtree.
- **`Z(i) = 0`** (node unreachable against this combo under the profile,
  or the combo is blocked by a dealt card): the conditional value is
  undefined and the pass records `0.0`, matching the checker's treatment
  of impossible pairs. Serialized values are therefore always finite —
  which the quiz grader requires.

**Nodelocked solves** are priced as-is: the pass reads the final average
strategies, which already carry the locked frequencies, so a locked
node's action EVs are the values of deviating against the locked
profile, and its node EV is the locked action's EV. The payload already
flags such solves (`locked` / `locks`); nothing here changes that.

## Precision and size

- **Rounding:** serialized to **3 decimals in chips**
  (`fmt_action_ev` in `json.rs`; values that round to zero are
  canonicalised so the payload never carries `-0.000`). At a 100-chip
  pot that is 0.001% of pot resolution — far below any grading or
  display threshold. In-memory values are full `f64`.
- **Size:** the block duplicates the strategy block's row labels and
  carries one number per (combo × action). Measured on the bundled
  sample (`ui/public/sample-river-solve.json`: 12 nodes, 36 rows, 96
  values) by simulating the formatter over its real row/action counts:
  **+2,096 bytes on a 5,663-byte payload (+37%)**, i.e. ≈ **0.96× the
  size of the existing strategy sections** (2,184 bytes). The general
  rule: added bytes ≈ `rows × (label + ~3) + values × ~8`. A 200-combo
  river solve (~8k rows, ~24k values) adds ≈ 0.4 MB of raw JSON; library
  storage (float16 + zstd in R2) compresses the repeated labels heavily.
  The coordinator's gate run can replace the simulation with a measured
  diff on a real solve.
- **Runtime cost:** two checker-style traversals per solve (the checker
  already runs four) — negligible next to the CFR iterations.

## Version handling / back-compat

Solve payloads carry no version field; the established precedent (the
`locked`/`locks` addition) is **additive optional fields**. Accordingly:

- Old payloads simply lack `combo_action_evs` on their nodes. That
  absence is the "not available" state — the quiz grader already returns
  null for it and falls back to frequency grading, and #19's surfaces
  must do the same. Nothing crashes: current UI code reads node fields
  by name and ignores unknown keys.
- Every solve produced from this change onward carries the field on
  **every** node (no partial payloads).

## Validation (`engine/crates/plo-solve/tests/action_ev_validation.rs`)

The identities are algebraic in the solved profile, so the test spots
run few iterations — they hold for any average strategy.

1. **Root identity (checker anchor):** at every game's root,
   `sum_a freq(i, a) * ev(i, a)` equals the combo's stored whole-solve
   EV to 1e-6 — the stored EVs are the independent checker's own
   strategy combo EVs, so this anchors the pass to `br.rs`.
2. **Naive cross-validation:** a from-scratch evaluator in the test
   (forward reach propagation + per-pair terminal enumeration, sharing
   only E1 and the data definitions) recomputes every node's action EVs
   for the river and turn spots; all values agree to 1e-6. The naive
   evaluator is itself anchored to the checker at the root for **both**
   players first.
3. **Per-node identity + ordering:** at every node of every game,
   `sum_a freq * ev == node_evs` to 1e-9, and the node value lies
   between the combo's worst and best action EVs.
4. **Locked profile:** a pure-check root lock on the river spot —
   identities and the root identity hold against the locked solve's
   stored EVs, and each root combo's node EV equals its check-action EV.
5. **Flop seam:** every subtree record with flop-profile `Z(i) > 0`
   (recomputed in the test by forward reach propagation) equals the
   standalone turn pass on that subtree game shifted by exactly the
   subtree's flop commitment (1e-6), for node EVs and per-action EVs
   alike. Records at `Z(i) == 0` are excluded — their conditional
   value is undefined and both passes record the `0.0` convention —
   and counted witnesses assert the restricted comparison still
   covers ≥1,000 records, ≥500 of them in nonzero-commitment
   subtrees. See the gate finding below.
6. **Payload:** formatted outputs parse; every node carries
   `combo_action_evs` with row-for-row alignment against `strategy` and
   row lengths equal to `actions`; serialized root values match the
   engine records within the 3-decimal rounding. A byte-faithful legacy
   (pre-#8) payload parses with the field absent.

## Gate finding (2026-11-17) — flop seam test premise, engine sound

The first gate run of this branch failed exactly one test (suite
30 passed / 1 failed): `flop_action_evs_identities_and_subtree_consistency`,
panicking at the seam comparison with

```text
subtree 58 seam shift at X/X|r:4d/X combo 0: expected -75, got 0 (tol 0.000001)
```

Adjudication, verified from the sources and the spot definition
(board `9c 8d 3h`, OOP `As Ah Kd Qc / Ts Js Qh Kh / 7s 6s 5d 4d`,
IP `Ks Kh Qd Jc / Th Jh Qs Ks / 7h 6h 5s 4s`, pot 100, stacks 150,
single 75% size):

- Subtree groups are built in tree order: group 0 is flop history
  `X/X` (subtrees 0–48), group 1 is `X/B(75)/C` (subtrees 49–97).
  Subtree 58 is in group 1, so its flop commitment is 75, and its
  turn-card index is 9. Turn cards enumerate the deck minus the board
  in ascending card-id order (`id = suit*13 + rank`), which makes
  index 9 the **Qc**.
- The subtree's OOP range therefore filters out `As Ah Kd Qc` (it
  contains the turn card), leaving `Ts Js Qh Kh` and `7s 6s 5d 4d`.
  The failing node, `X/X|r:4d/X`, is IP to act on the river, and its
  combo 0 is **Ks Kh Qd Jc**.
- The normaliser `Z` for that record sums opponent reach over OOP
  combos that neither overlap the hero combo nor contain the dealt
  river card. Against Ks Kh Qd Jc with river card 4d, the candidate
  set is **empty**: `Ts Js Qh Kh` overlaps (Kh), `7s 6s 5d 4d`
  contains the 4d, and `As Ah Kd Qc` is not in the subtree game.
  So `Z = 0` *exactly, combinatorially* — independent of the solved
  profile — in both the flop pass and the standalone turn pass.
- Both passes therefore record the documented `Z = 0` convention,
  `0.0`. The test compared the flop record `0.0` against the
  standalone record shifted by the commitment, `0.0 - 75 = -75`:
  it subtracted the seam correction from a value that was never a
  conditional EV. That is a test-premise defect, not a seam defect —
  the per-node identities (which hold for convention zeros) and the
  seam comparisons in subtrees 0–57 all passed in the same run, and
  no engine code changed.

Fix (test only): the seam comparison now recomputes `Z(i)` for every
subtree record by forward reach propagation (flop tree over the
expanded profile → group entry reach → mapped into the subtree →
turn-game propagation) and compares only records with `Z > 1e-9`.
Non-vacuity witnesses assert ≥1,000 compared records overall and
≥500 in nonzero-commitment subtrees (subtrees 49–57 passing the old
unrestricted check is only possible if essentially all of their
~4.7k records were genuinely compared), and that the exclusion
engaged at least once. No tolerance was weakened and the seam check
itself is unchanged on its valid domain.
