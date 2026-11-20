# Preflop layout restructure — rebrand slice 14 (issue #26)

Rearranges the Preflop page into the GTO Wizard preflop screen's shape
(Justin's 2026-11-20 request): a top game bar, a position strip under
it, and the five tabs Strategy | Matrix | Ranges | Breakdown | Compare
under that. This is restructure/navigation only — every panel is a
#24 (or earlier) component moved, not rebuilt; the one new panel
(Ranges) reads only data the set documents already carry. Base for
this lane: preflop-completion ba0f87d (issue #24).

Page order is now: header → game bar → position strip → set summary
(label, CONSTRUCTED badge, totals, notes, provenance — unchanged,
always visible above the tabs) → tab bar → tab panel.

## Per-element verdicts

- **Game bar (f01 navigation, top)** — KEPT + one row added. Table
  size and the rake variant toggle are exactly as before (same state,
  same semantics — the rake filter still selects which set family
  loads, it is not cosmetic). New Stack row: a static 100bb chip (the
  selected set's own `stack_bb`), captioned "Every set in the library
  is 100bb — no other stack exists to select." It is a display, not a
  selector; no other stack option is offered, disabled or otherwise,
  because no other stack data exists — faking a choice would be the
  one dishonest option. Scenario switching stays with the game bar:
  the context-group pills (RFI / first-in, vs RFI, vs 3-bet) and the
  opener / 3-bettor selector rows from #24 are unchanged.
- **Position strip (new)** — the Position pill row is replaced by one
  card per position in the current scenario family, in seat order
  (`POSITION_ORDER` via `sortPositions`). Each card shows the position
  name, its headline action and % (Raise for first-in, Call for the
  vs-* families — the same headline rule the set header uses), the
  combo count, and a stacked split bar (`SplitBar`, shared action
  colours) with a one-line Raise/Call/Fold-style split summary.
  Clicking a card selects that position's set below; from the Compare
  tab it also returns to Strategy, mirroring the Compare cards' own
  click behaviour. Data: the per-family document fetch the Compare
  view already did (one set document per position, combo-weighted
  `actionTotals`) now runs when the family changes rather than only
  when Compare opens, and feeds both the strip and the Compare tab;
  the selected position's card prefers the already-loaded set
  document's own totals so it can never disagree with the summary
  panel. A position whose document fails to load shows "Set document
  unavailable" on its card instead of breaking the strip — the same
  degrade-don't-break rule #24 set for Compare.
- **Strategy tab** — the former Set view minus the Breakdown section:
  the pair-rank summary (with its action pills) and the full hand-class
  table (filter/sort, ClassDetail on row click), unchanged. The set
  summary panel above the tabs still carries the per-action split bars
  and totals, so the tab opens on the same numbers as before.
- **Matrix tab** — the existing 13×13 rank-pair matrix, unchanged
  (grid, suitedness chips, drill-down aside, ClassDetail wiring).
- **Ranges tab** — NEW, as the honest equivalent. #24 omitted this
  tab because in the reference (f05) it is a postflop-only prompt on a
  preflop spot — there is no postflop range behind a preflop set, and
  that is still true. But Justin named the tab explicitly, and a
  preflop set does carry range data of its own: one range per action.
  The tab shows exactly that, labelled as such in its intro line: a
  stacked composition bar of the whole set by action, then one card
  per action with its combo-weighted share (`actionTotals`), the
  concrete combos that take it at some frequency (`combosInAction`),
  and its classes strongest-first (capped at 50 per action, with a
  pointer to the Strategy tab's full table). Class rows open the same
  ClassDetail panel. Nothing postflop is presented or implied.
- **Breakdown tab** — #24's Breakdown section promoted verbatim (the
  combo-weighted frequency-band histogram + the suitedness Categories
  block, with its "frequencies — never an EV histogram" copy), plus
  one addition the promotion required: its own action pill row. In
  the old Set view the section silently followed the action chosen in
  the pair-rank section above it; as a standalone tab it needs the
  selector the Matrix tab already had. The pair-rank Categories stay
  in Strategy (their f09 home); the Breakdown tab's Categories are
  the suitedness block that physically lived in #24's section.
- **Compare tab** — #24's Compare view unchanged (per-position cards
  + Combined card), now reading the shared family fetch; its cards
  still click through to the position's set, landing on Strategy.

## Preserved exactly

- CONSTRUCTED badge, provenance block (method/config/sources),
  derivation line, rake notes, and set notes — all render in the
  summary panel as before, for every context including continuations.
- Solve-compatibility behaviour: `solveActionForContext` is untouched,
  so continuation sets still read "Not loadable into solves".
- Rake toggle semantics and all data guards: `ui/src/lib/preflop.ts`
  is not modified by this slice at all.
- Starting Hands: untouched — it shares `lib/preflop.ts` and
  `lib/preflopStudy.ts`, neither of which changed, and its drill pool
  and set preselection hand-off behave as before.
- The action state is shared across Strategy/Matrix/Breakdown exactly
  as the old Set/Matrix views shared it; switching tabs never resets
  the displayed action, the matrix cell, or the class selection
  (the selection still clears when a different set loads).

## Omitted (one line)

Stack selection (only 100bb sets exist — displayed, never faked),
per-combo/per-class EV anywhere on the page (constructed sets carry
none), limp/straddle/ante scenarios (no such sets), and any postflop
content on the Ranges tab (a preflop set has none — see the tab's own
intro line).

## Files

- `ui/src/pages/Preflop.tsx` — game bar gains the Stack display row;
  Position pills replaced by the position strip; the family fetch
  generalized (`compareData` → `familyData`, runs on family change);
  view state becomes the five tabs; Breakdown promoted to its own tab
  with an action selector; new Ranges tab (per-action ranges from
  `actionTotals`/`combosInAction` over the set document); new
  module-level `orderedActions` helper for split displays.
- `PREFLOP-LAYOUT-NOTES.md` — this file.
