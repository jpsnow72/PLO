# Preflop Strategy columns (issue #40) — build notes

## Before

The Preflop page's Strategy view led with aggregates and one combined
class table:

- A "frequency by pair rank" aggregate section for a single selected
  action (action pills + `pairRankSummary` bars).
- A "Hand classes" table for that same single action: filter + sort
  (frequency / equity vs random / construction score / hand A–Z), one
  row per class with the class key as **plain text**, a Combos column,
  the selected action's frequency bar, an "All actions" text split,
  equity vs random, and feature tags. Capped at 200 rows.

To see a second action's hands you changed the action pill and the
whole table re-sorted — there was no side-by-side per-action view of
the kind GTO Wizard's preflop Strategy view shows (one column per
action, hands as graphical card tiles).

## Now

Strategy is one column per action for the selected set, in the
reference's shape:

- **Columns come from the set's own data.** The column list is
  `orderedActions(actionTotals(doc))` — the union of the action keys
  the set document records, in the page's existing menu order. Nothing
  is hardcoded per context: RFI sets render Fold / Raise, vs-RFI sets
  Fold / Call / 3-bet, vs-3bet continuations Fold / Call / 4-bet, and
  SB-play sets whatever actions they record.
- **Column header**: action name, the action's combo-weighted total
  frequency % (`actionTotals`, the same totals the set header and
  position strip already use), and its combo count. The count is the
  combo-weighted count (Σ multiplicity × frequency, rounded) computed
  over the *unfiltered* classes, so it always agrees with the header %
  — the same pairing the reference shows (82.7% ↔ 224K of 270.7K).
- **Rows**: every class with frequency > 0 for that action, densest
  first (frequency, then multiplicity, then key). A mixed class
  appears in each column it participates in, at that action's
  frequency — the set document's per-class action map is used as-is.
  Each column caps at 200 rows with a "densest N of M — filter to
  narrow" footer; the Filter input (kept from the old view) applies to
  all columns at once.
- **Row contents**: the hand rendered with the shared graphical
  card-tile component (see Reused), Freq % (the class's raw frequency
  for that action — the same number the class detail panel shows), and
  Weight. Clicking a row still opens the existing per-class detail
  panel (full action split, concrete combos, features).
- **Weight definition**: the class's concrete combo count (its
  multiplicity) — the only weight a constructed class carries, and the
  exact number the existing class detail panel prints ("N concrete
  combos"). The column header carries that definition as a tooltip,
  and each cell's tooltip also gives the class's share of the set's
  total combos as a percentage. No share column is printed: at
  270,725 combos a class's share is 0.00–0.01%, which reads as noise.
- **No EV / EV Diff columns.** Constructed ranges have no per-hand EV;
  none was invented. The intro copy says so on the page.
- **Header colours** are the theme's own action tokens from
  `index.css`: fold = `--action-fold` (slate), call = `--accent-green`
  (card-table green), raise / 3-bet / 4-bet = `--action-raise` (muted
  red family). An action the map does not name falls back to the fold
  slate. The in-column frequency bars keep the page's existing
  `ACTION_COLOR` hexes, like every other bar on the page.
- The amber CONSTRUCTED badge, the set summary header and the
  provenance panel are untouched.

## Where the aggregates went

The pair-rank aggregate section moved from Strategy to the
**Breakdown** tab, below the existing frequency-mix histogram and the
suitedness summary (both already lived there — nothing is duplicated;
Breakdown's action pills drive all three). Breakdown's tab blurb now
names the aggregates. Strategy's old sort control (equity / score /
hand) went away with the table it sorted: column order is spec'd
(densest first), and equity/score remain visible in the class detail
panel.

The Ranges tab is unchanged except one line of footer copy that
pointed at Strategy for "the full class list" — it now points at the
per-action columns.

## Reused (nothing new built)

- `CardRow` / `CardChip` from `ui/src/components/CardChip.tsx` — the
  one graphical card renderer from rebrand slice #13, at its `xs`
  size; hands parsed with the existing `parseCombo` (`ui/src/lib/cards.ts`),
  with a plain-text fallback if a key ever fails to parse.
- `actionTotals`, `orderedActions`, `multiplicityOf`,
  `combosInAction` (header counts elsewhere), `pairRankSummary`,
  `frequencyBreakdown`, `suitednessSummary` — all existing
  `ui/src/lib/preflop.ts` / page helpers, unchanged.
- `FrequencyBar` + `pctText` for row frequency bars; `ClassDetail`
  for the click-through panel, unchanged.

## Data-model notes / surprises

- Set documents really do key every class by a per-action frequency
  map, and mixed classes are common (a class can sit in two or three
  columns at once) — the per-column listing follows the map directly,
  so column class counts sum to more than the set's class count. The
  page copy says this out loud.
- Verified against the shipped data (one set per context, all 16,432
  classes each): RFI keys = fold/raise; vs-RFI = fold/call/three_bet;
  vs-3bet continuations = fold/call/four_bet; **SB-play sets record
  only fold/raise today** — there is no limp or call key in the data,
  so SB play renders two columns. If a future set family records a
  limp, it gets a column automatically (slate fallback header, raw
  key as its label until ACTION_LABEL learns the name). Between 342
  and 740 classes per set mix across actions at positive frequency.
- `actionTotals` can in principle surface an action key whose total is
  0 (present in class maps at frequency 0 everywhere); such a column
  would render with a 0.0% header and no rows. No shipped set does
  this today.
- The old Strategy table's "Equity vs random" and "Features" columns
  are not in the new columns (the reference has EV columns there; ours
  honestly cannot). Both remain one click away in the class detail
  panel.

## Verification

Build-only lane: no local compile was run (the tree has no
`node_modules`; `npx tsc` cannot resolve the project's TypeScript —
an environment limit, noted per the lane rules). First compile is the
coordinator gate's, as with previous Preflop lanes.
