# Matrix completion — rebrand slice 3 (issue #15)

Brings the Explorer's Matrix view to the captured GTO Wizard pattern
(gtw2-f20/f21/f22): split frequency bars in every cell, suit/flush
filter chips, a locked class with its combo list beside the grid, and
a sub-matrix drill-down over the locked class's remaining two cards.
Pure UI — every number comes from the loaded solve payload.

## What existed vs what was added

### Explorer Matrix (RangeGrid)
- **Existed:** 13×13 grid of canonical classes (a combo's two highest
  ranks), each cell filled with ONE user-chosen action's frequency
  (colour-by-action chips above the grid); clicking a class listed its
  combos *below* the grid with that one action's frequency per combo.
- **Added/changed:**
  - **Split bars in every cell.** The colour-by-action chips are gone.
    Each cell's fill is now the class's full action split at the node:
    one segment per action, width = share, coloured with the shared
    action colours (`actionStyle.ts` → the `--action-*` tokens, the
    exact colours Strategy/FrequencyBar already use). A shared
    `SplitBar` component (in `FrequencyBar.tsx`) renders the segments
    in cells, the locked-class header, and each combo row.
  - **Legend row** replacing the chips: every action at the node with
    its range-aggregate frequency (`aggregateFrequencies`, the same
    numbers the ActionList shows), plus a live "N of M combos shown"
    count when filters are active.
  - **Suitedness filter chips** — the preflop matrix's exact chips and
    vocabulary (`SUITEDNESS_FILTERS` from lib/preflop.ts: Any suits /
    Double suited / Single suited / Triple suited / Monotone /
    Rainbow), computed per combo from its own cards
    (`comboSuitedness` in lib/cards.ts, same shape vocabulary as the
    class table's `features.suitedness`).
  - **Flush-relation filter chips** — Any / Flush made / Flush draw /
    No flush, computed per combo against the board as it stands at
    the node (`flushRelation` in lib/cards.ts, Omaha rules: a flush
    uses exactly two hole cards, so "made" = a suit with ≥3 board
    cards and ≥2 hole cards; "draw" = ≥2 and ≥2 without being made).
    The row only renders when the board holds 2+ cards of some suit;
    on a rainbow board every combo is 'none', so the row is omitted
    rather than offered dead.
  - **Locked class panel beside the grid** (was: combo list below the
    grid). Header = class key, combo count, the class's aggregate
    split bar + percentages, and its share of the range by weight.
    Layout mirrors the preflop matrix's grid+aside arrangement.
  - **Sub-matrix drill-down.** Under the header, a second 13×13 grid
    over the locked class's *remaining two cards* (the AAxx pattern):
    each cell aggregates the class's combos whose other two cards
    have those ranks (`remainingClass` in lib/cards.ts), rendered with
    the same split-bar cells. Clicking a sub-cell narrows the combo
    list to those combos; clicking again (or "show all") clears it.
  - **Combo list** in the panel: graphical cards (CardRow), a per-combo
    split bar, **EV (solve)** = the combo's stored whole-solve EV
    (labelled, exactly as StrategyTables), **Diff** = "—", and range
    weight. Sorted by whole-solve EV descending (the reference tool's
    locked-panel order), capped at 60 rows with a show-all toggle
    (StrategyTables' pattern). Clicking a combo still selects it for
    Hand detail / Explain in the right rail.

### Shared code
- `lib/cards.ts`: `comboSuitedness`, `flushRelation`, `remainingClass`
  (pure card math, unit-testable, no payload assumptions).
- `components/FrequencyBar.tsx`: `SplitBar` + `SplitSegment`.
- Filter chips use the preflop matrix's Pill styling verbatim (same
  control, same look) — defined locally in RangeGrid as `FilterChip`.

### Preflop matrix
- Untouched. Its cells keep the single-action fill (its data model is
  per-class action frequencies for a chosen action, and its drill-down
  semantics differ — see below). The harmonisation is in rendering
  language: shared action colours, split-segment fills, identical
  filter chips and vocabulary, grid+aside layout.

## Aggregation math and payload source

All from the node's own strategy rows in the solve JSON
(`node.strategy[combo]` = per-action frequencies aligned with
`node.actions`), weighted by the combo's range weight
(`data.weights[player]`, from the payload's `*_evs` lists):

- Cell split for action a = Σ w·freq_a / Σ w over the cell's combos
  that pass the active filters.
- Class aggregate and sub-cell aggregate: the same formula over the
  locked class's / the sub-cell's passing combos.
- Combo rows show the combo's own frequency row unmodified.
- "Share of range by weight" = the group's Σw / Σw over all live
  combos at the node.

Grouping semantics are unchanged from the shipped Explorer grid: a
combo's class is its two highest ranks, so every combo sits in
exactly one cell and cell counts sum to the range. (The preflop
matrix deliberately differs — a class touches every rank-pair cell
its cards span — and was left as shipped.)

Filters are applied per combo *before* aggregation: a filtered-out
combo contributes to no cell, sub-cell, or list. Unparseable combo
strings (never expected from the engine) match no active filter.

Walking the tree re-aggregates everything: RangeGrid is keyed by
node history in Explorer, so lock/filter state resets per node, and
the flush relation is computed against the node's own board (flop +
dealt turn/river cards from the node record).

## Omitted, and why

- **Per-action EV / EV Diff numbers.** The payload carries no
  per-action EVs (issue #8). The panel shows the stored whole-solve
  EV, labelled "EV (solve)" exactly as the Strategy tables do, and
  Diff as an honest dash — never an estimate.
- **Flush filters on rainbow boards.** Impossible for any combo to
  make or draw a flush there; the row is hidden instead of showing
  chips that can only empty the grid.
- **Drawing mode / paint-to-select on the matrix** (capture f82) —
  that is slice 8's scope, not this slice.
- **Combo search box** (the reference's side panel has one) — not in
  this slice's brief; the filters + sub-matrix cover the narrowing
  workflows here.
