# NODELOCK-UI-NOTES — Visual node-lock editor (issue #9)

**Date:** 2026-11-21 · **Ticket:** #9 (follow-up to the engine ticket #1,
NODELOCK-NOTES.md) · **Base:** GitHub main `84865b3f` content (retarget-v15
tip; preflop data files untouched) · **Branch:** `nodelock-editor`

Builds the visual editor the engine ship deferred: pick a node on a
solved tree, set the acting player's overall action frequencies, and
re-solve around them. The engine and API needed **no changes** — both
already accept `locks` (verified in `engine/crates/plo-solve/src/locks.rs`
and `api/server.mjs` `locksFieldError` before designing anything).

## The GTW gap list worked from

From the coordinator's GTO Wizard review + the 2026-11-17 captures:

- **gtw2-f28 (Set Range Frequencies)** — the model dialog: "Set the
  overall action frequencies of your entire range"; one slider +
  percentage per action (Check 66% / B33 32% / B75 1% / B100 1% —
  whole percents summing to 100); **Reset to GTO** restores the
  solver's own frequencies; Cancel / Apply. → Mirrored directly: our
  editor is range-level, sliders + numeric inputs, whole percents,
  "Reset to solver frequencies" (we do not call our numbers GTO —
  the button restores the loaded solve's own aggregate), Add/Update
  lock as the Apply.
- **gtw2-f27 (Edit Node / Edit Bet Sizes)** — node-level editing is
  entered from the solved tree's node, not from the solve-setup
  dialog. → Mirrored: the editor mounts in the Explorer on the
  current node ("Edit node" button beside Practice this spot); the
  Solver's fieldset manages staged locks only (below).
- **Range-level, not per-hand** — their editor sets each action's
  OVERALL percentage; per-hand splits remain the solver's job. → Our
  editor is range-level too (see the expansion mapping + the engine
  gap it exposes).
- **Lock the line** — the review's one feature to mirror beyond the
  dialog: locking the earlier nodes on the current line along with
  the edited node. → Built: the "Lock the line to this node" toggle
  pins every earlier decision node on the path at the solver's own
  frequencies (exact aggregate vectors from the loaded solve), via
  `assembleLineLocks`. Our engine already accepts a lock list, so
  this is purely editor-side, as the review predicted.
- **Slider behaviour** — the captures show whole percents summing to
  100 but cannot show whether a drag rebalances or merely flags.
  Chosen and documented in the component: slider drags rebalance the
  other actions proportionally (largest-remainder rounding, total
  always exactly 100); typed numeric inputs never rewrite each other
  — an off-100 total is flagged and Add/Update is disabled.

## The expansion mapping (percentages -> per-combo)

`expandActionPercentages` in `ui/src/lib/nodelocks.ts` implements the
GTW redistribution as a pure, unit-tested function: given the user's
per-action percentages, produce per-combo rows such that (a) each
action's range-weighted overall total equals the user's percentage,
(b) every combo's row sums to 1, and (c) the solver's relative
per-hand splits are preserved (zeros stay zero; cross-ratios between
combos are invariant). Method: iterative proportional fitting
(Sinkhorn) over the solver's live rows — alternately scale actions
to the target totals and rows to sum 1. Fallbacks: an action the
solver never takes anywhere but the user targets above 0 has no
split to preserve, so it is seeded uniformly across live combos
before fitting; a combo entirely zeroed by the targets receives the
target vector itself. When a node has no existing solve to take
splits from there is nothing to expand — the editor only exists on
loaded solves, and the Solver's staged mode edits percentages
directly (no expansion is claimed there).

**Engine gap found (flagged, not fixed — outside this lane):** the
brief for this lane described the engine's lock format as a full
per-combo frequency vector. The shipped engine (locks.rs, verified
firsthand) takes ONE vector per node and holds **every combo** to it
("Whole-node semantics", NODELOCK-NOTES.md); the API shape-validates
that same flat array, so a per-combo payload would be rejected. The
editor therefore submits exactly the contract's format — the user's
range-level percentages as fractions (`lockToPayload`) — and the
editor copy says plainly that every combo at the node is held to the
same mix. The expansion above is the tested mapping ready for the
engine's documented v2 seam ("Per-combo locks — out of scope in v1;
the buffer seam would support them"). Until that lands, our range
totals match what the user set, but per-hand redistribution inside
the node is the one GTW behaviour we cannot yet reproduce — stated
here rather than papered over.

**API gap found (flagged, not fixed):** a job's spot JSON is stored
server-side (`DATA_DIR/jobs/<id>/spot.json`) but no endpoint returns
it, and a solve payload does not record its bet-size menus. So an
Explorer re-solve cannot be byte-faithful to the original spot. The
hand-off therefore rebuilds the spot from what the payload DOES
carry (board, both full ranges from the solve's weights, pot,
stacks) plus the wizard's current size menus, and the Explorer panel
says so in plain copy before the user runs it: if the original menus
differed, a lock's node may not exist in the new tree — the engine
rejects the job and the error is shown in the jobs list. No lock is
ever silently dropped (the Solver also blocks submit on an invalid
lock total with its reason).

## Where the editor mounts

- **Explorer** (`ui/src/pages/Explorer.tsx`): "Edit node" button in
  the node header (disabled at single-action nodes) opens the editor
  panel for the current node. Locks are per-solve state; walking to
  another node drops line locks (they named the old line) and keeps
  hand-set node locks. "Run locked solve in the Solver" stages the
  spot + locks via the store's one-shot `lockHandoff` (the
  trainerFocus pattern) and navigates to the Solver.
- **Solver** (`ui/src/pages/Solver.tsx`): the #21 disabled "Node
  locks" fieldset is replaced by the same shared component in
  staged mode — staged locks can be re-edited (pick one from the
  list), removed, or cleared; on submit their payloads are attached
  to the built spot as `locks`. New locks are not authored here:
  a lock names a node in a solved tree, so authoring stays in the
  Explorer, and the fieldset copy routes the user there.
- **Shared component**: `ui/src/components/NodeLockEditor.tsx`;
  logic in `ui/src/lib/nodelocks.ts`. Styling strictly from existing
  tokens/patterns (navy panels, `accent-[#2E9E6B]` controls, the
  amber LOCKED chip treatment copied from the Library rows).

## Locked-solve rendering (reused, not reinvented)

Finished locked solves already carried the badge path: Library rows
badge LOCKED (amber) and show the Nash figure as plain text, never
the certified badge. This lane extends the same treatment to the two
surfaces that were missing it: the Explorer header gains the LOCKED
chip and its Accuracy section explains a locked number is the
checker pricing the locked profile as played — not an equilibrium,
never certified — and the Solver's jobs list badges locked jobs
(`JobRecord.locked`, which the API already recorded). `RawSolve`
now types the engine's `locked` / `locks` echo.

## Tests (written, not run — coordinator gates on a host)

`ui/tests/nodelocks.test.ts` (run route in its header: esbuild
bundle -> CJS -> `node --test`, the sampled suite's route):
expansion totals/row-sums/cross-ratio + zero preservation on a
fabricated two-node river solve; line-lock assembly (earlier node at
the solver's exact 60/40 aggregate, user lock last verbatim);
validation (bounds, sums, payload renormalisation); slider
rebalancing (moved action wins, others scale, total exactly 100).

## Deliberately NOT built

- **Per-combo lock payloads** — the engine cannot accept them yet
  (gap above); building UI that pretends otherwise would be a lie
  in the interface.
- **Lock authoring in the Solver against an unsolved spot** — node
  histories and action menus do not exist before a solve; GTW
  authors locks on solved trees too (f27/f28 are Explorer-side).
- **Editing bet sizes from the Edit Node panel** (the other half of
  f27's dialog) — sizes are frozen at solve time by design in our
  product (a flop solve stores its full tree under its own menu);
  the wizard's street editors already own size changes, which mean
  a new solve either way.
- **Persisting draft locks** across sessions — locks are study
  state for one solve, like the Drawing overlay; nothing is stored
  until a locked solve itself lands in the library with its badge.
