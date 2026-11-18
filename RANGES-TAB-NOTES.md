# RANGES-TAB-NOTES — Explorer Ranges tab (rebrand slice 4, issue #16)

> Named `RANGES-TAB-NOTES.md`, not `RANGES-NOTES.md`: that file already
> exists at the repo root and documents the constructed preflop ranges
> v1 feature — a different subject, left untouched.

A fourth Explorer display: both players' ranges at the current node, in
the pattern of the captured reference (gtw2-f23: Ranges — Comparison,
Categories, EV chart, hand tables by EV). Built entirely from the
loaded solve's payload — no engine, API, or payload changes. Like the
other tabs it is keyed by node history and re-derives everything when
the user walks the tree.

## Files

- `ui/src/components/RangesView.tsx` — the view (new): Comparison,
  Categories, Range EV chart, Hands by EV.
- `ui/src/lib/solveTree.ts` — new exported derivation `liveRange`
  (per-combo reach at a node). `rangePresence` was refactored to share
  the extracted `comboReach` core, so the Table view's aggregates and
  this tab's per-combo rows are the same math by construction;
  `rangePresence`'s results are unchanged.
- `ui/src/lib/handCategories.ts` — the made-hand classifier (new).
- `ui/src/pages/Explorer.tsx` — `ExplorerView` gains `'ranges'`; one
  tab entry and one render branch. Strategy, Matrix, Table, the
  certification badge and the right rail are untouched.

## The one derivation everything binds to

A player's range at a node is their starting range **reach-weighted
down the line taken**: a combo's reach is its starting weight (from
the payload's `*_evs` lists) times, for each of that player's decision
nodes along the path, the stored frequency of the action the line
actually took. Combos containing a dealt board card are impossible
and drop out; for the player to act, combos whose row at the current
node is all-zero (card-blocked) drop out too. This is exactly the
Table view's `rangePresence` math, exposed per combo as `liveRange`.

## Section by section: bindings and sources

### Comparison (side-by-side panels, one per player)

| Element | Source |
|---|---|
| "To act" pill | `node.player` |
| EV (whole solve) | `rangeEv()` — the starting-weight average of the payload's per-combo EVs; the same figure the right rail shows as "Range EV (whole solve)" and the same pair of numbers the reference headlines (their 45.85 / 54.15) |
| Live combos "X of Y" | `liveRange().length` of `data.weights[player].size` |
| Share of range | Total reach ÷ total starting weight (the `rangePresence` share) |
| Mean EV, live | Reach-weighted mean of the live combos' whole-solve EVs |
| Action split bar + summary (acting player only) | `aggregateFrequencies()` over the node's own `strategy` rows — identical numbers to the Strategy and Matrix tabs at the same node |

The non-acting player has **no action split at this node** — they do
not act here, and the payload holds no strategy row for them at this
node. Their panel says so in words instead of showing a borrowed or
estimated split; their split appears when the line reaches one of
their decision nodes. (Per-category strategy bars below are likewise
the acting player's only.)

### Categories

- Each live combo is classified by `classifyOmahaHand` in
  `lib/handCategories.ts`: its best five-card made hand over every
  exactly-two-hole + three-board subset (Omaha rules), enumerated from
  the cards themselves. Categories, strongest first: Straight Flush,
  Four of a Kind, Full House, Flush, Straight, Set, Two Pair, Pair,
  No Made Hand — the reference's vocabulary (f23).
- "Weight" per player = the category's reach ÷ the player's total
  live reach, shown with the live combo count — the reference's
  Weight columns.
- "{OOP|IP} strategy" column = the acting player's action split
  inside the category, aggregated from the node's `strategy` rows
  weighted by starting range weight (the Matrix tab's convention),
  rendered as a `SplitBar` with the full summary as its tooltip.
- Only categories at least one player actually holds are listed.

Included / omitted, with reasons:

- **Included:** all nine made-hand categories. Every one is decidable
  from hole cards + board, which the payload carries in full.
- **"Set" covers all three of a kind.** A pocket pair meeting a board
  card and a board pair met by one hole card are the same strength
  class; the reference's Categories use the single "Set" row, and the
  tab's footnote says the row covers all three of a kind.
- **Omitted: draw categories** (flush draws, straight draws/wraps,
  combo draws). They are not made hands, the reference's Categories
  list is made-hand only, and the flush half of that ground is already
  covered by the Matrix tab's flush-relation filters (slice 3). The
  footnote under the table points there.
- **Omitted: per-category rows for the non-acting player's strategy**
  — no such data exists at this node (see Comparison).

### Range EV chart

- Per player, 10 equal-width EV bands spanning the **shared**
  min–max of both players' live combos' whole-solve EVs, so the two
  charts use one axis and are directly comparable. Bar height is the
  band's reach, normalised to the largest band across both players;
  each bar's tooltip gives the band range and its share of the live
  range. OOP bars use the table green, IP bars the amber accent (the
  app palette).
- If the payload carried no EVs for the live ranges, the chart is
  replaced by a sentence saying so — never an empty axis.

### Hands by EV (one table per player)

- Rows: the player's live combos, sorted by whole-solve EV
  descending with EV-less combos last (the StrategyTables
  convention), then reach descending. 60-row cap with show-all, per
  player, as in the Matrix combo list.
- Columns: Hand (`CardRow`, graphical cards), EV (solve), Weight
  (starting range weight), Reach (the combo's share of the player's
  live range at this node), and — acting player only — Split (the
  combo's own action split at this node as a compact `SplitBar`).
  The non-acting player's table has no Split column, for the same
  reason as in Comparison.
- Row click selects the combo, feeding the right rail's Hand detail
  exactly like the Strategy and Matrix views.

## The whole-solve EV labelling decision

Every EV in this tab — Comparison header and mean, the chart, the
hand tables — is the combo's **whole-solve EV** from the payload's
`*_evs` lists: the engine reports EV per combo for the whole tree,
not per action and not per node. The tab labels it "EV (solve)" /
"whole-solve EV" everywhere, matching the Strategy tables' existing
label, and each section carries a footnote saying the figures are
whole-solve EVs, not node EVs. Nothing is differenced, discounted or
re-weighted into a fake node EV. True per-node / per-action EVs are
issue #8; when that lands, the hand tables' sort and the chart become
node-accurate by swapping the EV source, and the labels must change
in the same pass.

## Deliberately not built

- **Breakdown / Compare** (the reference's neighbouring tabs) — not
  this slice; the gap analysis schedules them separately.
- **A Categories right-rail section** — slice 5's scope, not this
  tab's; the classifier written here is the shared piece it needs.
- **EV Diff** — impossible without per-action EVs (#8); unlike the
  Strategy tables this tab has no Diff column at all, rather than a
  column of dashes.
