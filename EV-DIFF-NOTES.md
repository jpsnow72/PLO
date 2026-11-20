# EV-DIFF-NOTES — rebrand slice 7, UI half (issue #19)

Binds the surfaces that showed an honest dash while the payload had no
per-action EVs, now that the engine emits them (issue #8). Companion to
EV-OUTPUT-NOTES.md (the engine half).

## The field

Every node of a #8 solve payload carries `combo_action_evs`:
`{ [combo]: number[] }`, aligned with the node's `actions`, values in
chips (whole-hand net). Only the player to act at a node has action EVs
there — their combos, their actions.

All reads go through one defensive reader, `comboActionEvs` in
`ui/src/lib/solveTree.ts`, which mirrors the quiz grader's
`actionEvsFor` (quiz.ts) check for check: plain object, row present,
row length == `actions.length`, every value a finite number. Anything
else reads as "not available". Derived helpers in the same module:

- `comboNodeEv(node, combo)` — Σ freq × action EV over the combo's own
  strategy row at the node (null for absent data or a non-live row).
- `comboEvDiff(node, combo)` — the main-line Diff (below).
- `actionEvDiff(node, combo, actionIdx)` — one action's Diff (below).
- `nodeHasActionEvs(node)` — at least one readable row at the node;
  surfaces use it to switch headers/footnotes.

`RawSolveNode` (types.ts) documents the optional field; runtime
validation stays in the reader, so a malformed table reads as absent.

## The two Diff definitions

There are two, because the rows they sit on mean different things.
Both are <= 0, and both are 0 when the relevant action is a best
action for the combo.

- **Main-line Diff** (Hand detail, Matrix combo list): EV of the
  solver's *most-taken* action for the combo minus the EV of its
  *best* action at this node. It prices the solver's main line for
  the hand: how much, if anything, the mix's centre of mass gives up
  against the best action. 0 when the strategy is pure on the best
  action. Shown in chips, with % of pot alongside (stat box / cell
  tooltip).
- **Per-action Diff** (Strategy tables): each action's table shows
  that action's EV for the combo minus the combo's best action EV.
  The row already lives inside one action's table, so the table's
  action is the subject; 0.00 throughout the best action's table.

## Per-surface bindings

- **Hand detail** (`HandDetail.tsx`): each action row gains its EV
  for the selected combo ("EV 12.34", brightest on a best action),
  and the stat grid gains an **EV Diff (main line)** box — chips plus
  % of pot — with a footnote stating the definition. This is also
  where the full per-action EV list for a selected combo lives,
  which is what the Strategy tables point to by design (below).
- **Matrix combo list** (`RangeGrid.tsx`): the Diff column shows the
  main-line Diff per combo; its header tooltip and the list footnote
  state the definition. The column widens (w-8 -> w-12) only when the
  node carries the field, so rows stay aligned and old payloads keep
  the exact original column.
- **Strategy tables** (`StrategyTables.tsx`): the EV Diff column —
  drawn dashed since ship 1 — shows the per-action Diff, with the
  action's absolute EV for the combo in the cell tooltip. The tables
  have no per-combo action list (rows are combos inside one action),
  so the column *is* the natural place for per-action EV here; the
  complete action-by-action EV list for a selected combo is one click
  away in Hand detail, unchanged from how the surfaces already divide
  labour.
- **Ranges tab** (`RangesView.tsx`): the EV chart stays whole-solve
  (labelled, unchanged — it is a distribution of solve EVs). The
  acting player's Hands-by-EV table gains an **EV (node)** column:
  `comboNodeEv`, the combo's value at this node. The non-acting
  player has no actions at this node and so no node EVs — their table
  is unchanged. A footnote sentence names the column's basis when it
  is shown.
- **EV Buckets rail** (`RailInsights.tsx`): **stays on whole-solve
  EV** — see the decision below. When the node carries per-action
  EVs, the footnote now says the buckets are whole-solve *by design*
  and why, instead of promising per-node buckets.
- **Trainer**: verified by reading, no changes. `quiz.ts` already
  grades in EV mode whenever a question's node carries
  `combo_action_evs` (`gradeSpotAnswer` fires `'ev'`, computes
  `evLostChips` against the best action), and `Quiz.tsx` already
  renders `evLostChips` in feedback, history and stats wherever the
  grade carries it. Solves with the field light all of it up by
  themselves; grading code and copy are untouched.

## EV Buckets basis decision

**Buckets keep the whole-solve basis at every node.** The band rule
cuts at fractions of the live range's reach-weighted mean EV (with a
max-fraction fallback when the mean is not positive). Node EVs are
whole-hand-net conditional values: chips a combo has already
committed on the line are sunk into them, so the live range's
node-EV mean drops mechanically as a line develops and is
non-positive in many facing-a-bet spots. On node values the rule
would therefore cut from the mean at some nodes and from the max at
others — the same Best/Good/Weak/Trash labels would mean different
things from node to node, and bucket shares would not be comparable
along a single line walk. Whole-solve EV is one basis everywhere,
and at the root it *coincides* with node EV (a root combo's
strategy-weighted action EVs are its whole-solve EV), so the buckets
lose nothing at the one node where the reference's are defined. The
rail's label already states the whole-solve basis; the footnote now
states the reasoning when the payload carries the field.

## Fallbacks

A payload without `combo_action_evs` (every solve produced before
#8) renders every surface above **exactly as shipped before this
slice**: the same dashes, the same header titles, the same footnote
sentences, the same column widths, no EV Diff stat box, no EV (node)
column. Presence is decided per node, so nothing about a legacy solve
changes anywhere in the app.

## Not in this slice

- **EV-difference combo filter** (Matrix) and **EV-weighted blocker
  ranking** (Blockers): both are #8-dependent per the gap analysis
  but are features of their own, not dash bindings; the Blockers
  footnote still describes the ranking as unbuilt. Follow-ups.
- **Explain panel**: its copy states it never quotes an EV gap
  between actions because per-action EVs were not stored. Teaching
  the explainer to use them is a change to `lib/explain.ts`'s
  grounding rules, not a surface binding — left for its own ticket.
- **Breakdown tab past the root** (gap analysis, slice 7): no
  Breakdown surface exists in the app yet to bind.
