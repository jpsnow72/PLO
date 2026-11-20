# Preflop completion — rebrand slice 12 (issue #24)

Brings the Preflop page to the captured GTO Wizard preflop pattern
(gtw2-f01..f13): scenario navigation in their shape (table size →
scenario → hero position → the other actor), a Compare view across
positions, a Breakdown histogram, and a per-class detail panel behind
every class row. Pure UI — every number comes from the served set
documents and the class table; nothing is computed from data the sets
do not carry, and nothing is presented as solver output.

Base for this lane: main 7e185c6 (113 sets: 63 v1/v1.1/v1.2 sets +
50 8-max v1.3 sets; contexts rfi / sb_play / vs_rfi / vs_three_bet).

## Per-capture verdicts

- **f01 Strategy (scenario navigation)** — ADDED the missing scenario.
  The page already navigated table size → rake variant → context group
  → position (→ opener for vs RFI). The v1.1 continuation sets
  (`vs_three_bet`, 12 of the 113) were in the index but unreachable
  from this page. New third context group "vs 3-bet" with a 3-bettor
  selector, mirroring the vs-RFI opener pattern exactly (the bettor is
  parsed from the set id slug — index entries carry no context_detail).
  Headline action for continuations is Call; the action menu gains
  `four_bet` ("4-bet", #9d5fd0, ordered after 3-bet). The selector row
  states the honest coverage: continuations exist at 6-max and 8-max
  only, so 9-max shows the standard no-match empty state. The rake
  toggle applies unchanged — both variants carry continuations, so
  8-max behaves identically under Raked and No-rake.
- **f02 Matrix** — HAVE (shipped earlier: rank-pair grid, suitedness
  filter chips from the class table's exact `features.suitedness`).
  This lane adds class-row clicks inside it (see f03).
- **f03 Matrix drill-down (AA)** — COMPLETED. Drill rows in the matrix
  aside and rows in the Set view's class table are now clickable and
  open a shared per-class detail panel (`ClassDetail`): graphical
  cards (CardRow over `parseCombo`), the class's FULL action split
  (every action in the set document's `hands[key]`, not just the
  displayed action), its concrete combo count and the combos
  themselves (`classCombos` — the suit-permutation orbit), and, when
  the class table is loaded, everything it carries for the class:
  feature tags, `equity_vs_random`, `equity_vs_reference`, the
  construction `score`, and the four score components
  (`pair_component`, `suitedness_component`,
  `connectedness_component`, `high_card_component`). Without the class
  table the panel shows split + combos and says features are
  unavailable. The selection clears when a different set loads.
- **f04 Double-suited filter** — HAVE (suitedness chips incl.
  Double suited; disabled with an explanation when the class table is
  missing, since filtering reads exact features).
- **f05 Ranges tab** — OMITTED by design. In the reference this tab is
  itself a postflop-only prompt on a preflop spot; there is no
  postflop range behind a preflop set to show.
- **f06 Breakdown** — ADDED, in the form our data supports. The
  reference's preflop Breakdown is literally a postflop-only prompt
  ("Select a postflop spot to see Breakdown"); the slice asked for a
  breakdown histogram, and constructed sets genuinely carry one: the
  mixing profile of the displayed action. New Breakdown section in Set
  view: a combo-weighted histogram over six frequency bands (Never
  0% / Mixed 1–24 / 25–49 / 50–74 / 75–99 / Pure 100%) — each bar is
  the share of all combos whose class sits in that band for the
  selected action (`frequencyBreakdown` in lib/preflop.ts; works from
  the set document alone). The section states in plain text that it is
  a frequency breakdown, never an EV histogram, because constructed
  sets carry no per-combo EV. Companion Categories block: the same
  action's combo-weighted frequency by suitedness class
  (`suitednessSummary`, class-table features), beside the existing
  pair-rank categories.
- **f07/f08 Compare** — ADDED as a third view tab. For the current
  scenario family (table size + rake + group; vs-RFI fixed to the
  chosen opener, vs-3bet to the chosen 3-bettor), every position's set
  document is fetched and its combo-weighted action totals
  (`actionTotals`) shown as a card: position, headline-action total,
  and the full action split as bars. A final Combined card weights
  each position's totals by its set's combo count. Clicking a card
  selects that position and returns to Set view. A position whose
  document fails to load renders as an unavailable card rather than
  breaking the comparison. (The reference compares per-position
  matrices; our matrix is one click further — open the position —
  and the totals comparison is the part with study value at a
  glance.)
- **f09 Strategy Table / Categories** — HAVE + extended. The class
  table (per-class frequency, all-actions text split, equity vs
  random, feature tags) already shipped; Categories are the pair-rank
  summary plus the new suitedness summary (f06 block above). The
  reference's EV column is OMITTED: in their own preflop captures it
  displays 0 for every hand, and our class table carries no EV —
  equity vs random is the honest column, already shown.
- **f10 Strategy Graph** — OMITTED. Empty in the reference's preflop
  section as well; no per-position EV series exists in our data to
  graph.
- **f11 Strategy Overview** — HAVE. The Range summary panel (headline
  frequency, combos in range, class count, total combos, per-action
  bars, notes, rake note) is the overview; unchanged.
- **f12 vs open** — HAVE (vs-RFI group with opener selector).
- **f13 vs 3-bet** — ADDED (see f01).

## Provenance and honesty marks

- The CONSTRUCTED badge, per-set provenance block (method, config,
  cross-check sources), derivation line for derived sets (8-max), and
  rake notes are untouched and render for continuation sets exactly as
  for RFI sets — the summary header labels them "vs 3-bet (continue)"
  via the existing `setLabel` path, and the set document's own notes
  (displayed in the summary) describe the construction ("built from
  the opener's constructed RFI set and the three-bettor's constructed
  three_bet slice").
- Solver-wizard compatibility copy follows the existing rule:
  `solveActionForContext` returns null for `vs_three_bet`, so
  continuation sets correctly read "Not loadable into solves".
- No set is ever badged GTO; no number appears that is not in the set
  document or the class table.

## Omitted (one line)

Per-combo/per-class EV and any EV histogram (constructed sets carry none — the reference's own preflop EV column shows 0), limp ranges (no limp sets are constructed; SB first-in is raise-or-fold by design), straddle/ante games (no such sets exist), the Ranges and Strategy Graph tabs (postflop-only/empty in the reference itself), and 9-max vs-3bet continuations (no such sets — the data, not the UI, is the limit).

## Files

- `ui/src/lib/preflop.ts` — `threeBettorOf` (id-slug parse),
  `frequencyBreakdown` (combo-weighted frequency-band histogram),
  `suitednessSummary` (Categories by `features.suitedness`).
- `ui/src/pages/Preflop.tsx` — vs-3bet context group + 3-bettor
  selector, `four_bet` label/colour/order, Compare view tab,
  Breakdown section (histogram + suitedness categories), `ClassDetail`
  panel wired to class rows in both Set and Matrix views, header copy
  now names 8-max.
- StartingHands study mode untouched: it deliberately excludes
  `vs_three_bet` sets from its drill pool (lib/preflopStudy.ts), and
  its entry points (set preselection hand-off) are unaffected — the
  Preflop page is now the one place continuations are browsable.
