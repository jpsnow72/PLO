# RAIL-NOTES — Explorer right rail: Categories + EV Buckets (rebrand slice 5, issue #17)

Two new sections in the Explorer's right rail, in the pattern of the
captured reference's rail tabs (gtw2-f23 Categories, gtw2-f30 EV
Buckets) but as rail sections, following this rail's own section
conventions (same panel chrome and uppercase headings as Node
overview / Accuracy / Hand detail). Built entirely from the loaded
solve's payload — no engine, API, or payload changes. Both sections
re-derive on every node walk, like the rest of the rail.

## Files

- `ui/src/components/RailInsights.tsx` — the two sections (new):
  `CategoriesRail` and `EvBucketsRail`.
- `ui/src/pages/Explorer.tsx` — one import; the two sections are
  placed between Node overview and Accuracy. Nothing else in the
  Explorer changes: Strategy / Matrix / Table / Ranges tabs, the
  certification badge, Hand detail, the multiway lens and the study
  tools are untouched.

## Bindings

Everything binds to derivations that already exist:

- **Range at a node** — `liveRange` (solveTree.ts, slice 4): a
  player's starting range reach-weighted down the line taken, with
  per-combo starting weight, reach weight and whole-solve EV.
  Card-blocked combos never appear.
- **Categories** — `classifyOmahaHand` + `HAND_CATEGORIES`
  (handCategories.ts, slice 4): the shared Omaha made-hand
  classifier (best five-card hand over exactly-two-hole +
  three-board subsets). The rail reuses it rather than classifying a
  second way, so the rail and the Ranges tab can never disagree.
  A category's share is its combos' reach over the player's total
  live reach; only categories with live reach are listed, strongest
  first. The acting player's per-category strategy split uses the
  Matrix convention (slice 4): combos' frequencies at this node
  summed over starting range weights.
- **EV Buckets** — the acting player's live combos' stored
  whole-solve EVs (`LiveCombo.ev`, the payload's `*_evs` lists — the
  same "EV (solve)" the Strategy tables show), reach-weighted.

## Categories section

Both players, acting player first. One row per made-hand category
with live reach: category name, reach-weighted share of the player's
live range, live combo count, and one bar whose total width is the
whole live range — the filled part is the category's share. For the
acting player the fill is split by their strategy inside the
category (the f23 segmented-bar pattern, in the shared action
colours); for the other player the fill is solid in their chart
colour (OOP table green, IP amber — the Ranges EV chart's coding),
since they have no strategy at this node. This is the glanceable
summary; the full per-category table stays in the Ranges tab.

## EV Buckets section — the band rule

The reference splits a range into Best / Good / Weak / Trash by EV
(f30: 25.5 / 3.5 / 20.4 / 50.6 at the captured spot). Those shares
vary from spot to spot, which rules out fixed percentile cuts: a cut
at the 75th percentile would hand "Best" ≈25% of the reach at every
spot, whatever the hands are worth. The reference's thresholds are
therefore EV-relative, and ours are defined the same way, from the
distribution of the acting player's live combos:

- Let μ be the **reach-weighted mean whole-solve EV** of the acting
  player's live combos that carry a stored EV.
- **Best**: EV ≥ μ · **Good**: EV ≥ 0.75μ · **Weak**: EV ≥ 0.25μ ·
  **Trash**: EV < 0.25μ.

In words: a hand is Best when it is worth at least the average hand
in the range, Good down to three-quarters of average, Weak down to
a quarter, and Trash below that. On a skewed distribution (a few
monster combos, a long low tail — the usual postflop shape) this
yields a small elite Best band, a thin Good band where the
distribution has a gap, and the bulk in Weak/Trash, matching the
reference's shape without copying any unpublished threshold.

Fallbacks, so the rule never inverts or fabricates:

- If μ ≤ 0 (fractions of a non-positive mean would invert the
  bands), the same shape is taken from the best live EV instead:
  Best ≥ 0.75·max, Good ≥ 0.5·max, Weak ≥ 0.25·max. The section
  footnote says which basis was used and prints the actual cuts.
- If no live combo carries an EV, the section shows one sentence
  saying so instead of bands. If every live combo's EV is ≤ 0, it
  likewise says the buckets would not separate the range.
- Combos without a stored EV are left unbucketed; if they are more
  than a rounding share of the live range, the footnote states the
  uncovered percentage. Shares are reach-weighted throughout.

## Whole-solve labelling

Every EV in the Buckets section is a **whole-solve** EV: the payload
stores one EV per combo for the whole solved tree, so at a deep node
the buckets describe how the combos that survived to this node were
worth over the whole solve — not what they are worth from this node.
The section header and footnote say exactly that. True per-node
buckets need per-action EVs in the payload (issue #8); when that
lands, the band rule above applies unchanged to node EVs and the
labelling should be updated. (The gap analysis makes the same call:
root-accurate today from stored EVs, per-node values after #8.)

## Deliberately not done

- No "Cards" rail section (the third reference rail tab): slice 5's
  scope is Categories + EV Buckets; the rail already carries Hand
  detail for the selected combo.
- No collapse toggles: the rail's summary sections (Node overview,
  Accuracy) don't collapse, and these follow them. Only the multiway
  lens collapses, because it is an interactive tool, not a summary.
