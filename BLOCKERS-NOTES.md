# BLOCKERS-NOTES — Explorer Blockers tab (rebrand slice 6, issue #18)

A fifth Explorer display, in the pattern of the captured reference
(gtw2-f31 Blockers "Your hand" card picker · f32 Blockers Ranked List ·
f33 Blockers Deck Heatmap): pick your hand, see its effect on the
opponent's range at this node. Built entirely from the loaded solve's
payload — no engine, API, or payload changes; the gap analysis
(2026-11-17) established the core view is pure range-removal math over
stored frequencies + weights, and this slice is exactly that.

## Files

- `ui/src/lib/blockers.ts` — the removal math (new): `buildBlockerModel`
  (per-card impacts over villain's live range) and `analyseHand`
  (a picked hand's union removal + strategy shift).
- `ui/src/components/BlockersView.tsx` — the view (new): hand picker,
  removal summary, ranked list, deck heatmap.
- `ui/src/pages/Explorer.tsx` — `ExplorerView` gains `'blockers'`; one
  tab entry and one render branch. Strategy, Matrix, Table, Ranges,
  the certification badge and the right rail are untouched.

## Who is who, and why

The player **to act** at the current node is the range under study
("villain" in the code): they are the only player with strategy rows
at this node, so their action split — and how it shifts when combos
are removed — is stored data, never a model. The user picks a hand as
the **other** player ("hero"): those cards are simply known dead
cards, and every villain combo containing one is impossible. This is
the bettor's blocker question — "my hand is out there; what does it
do to the range that has to act against it?" — and it is the only
framing in which the split shift is exact at this node.

## The removal math and its payload sources

Villain's range at the node is `liveRange` from `lib/solveTree.ts`
(the Ranges tab's derivation): each combo's **reach** is its starting
weight (from the payload's `oop_evs` / `ip_evs` lists) times, for each
of villain's decision nodes along the viewed path, the stored
frequency of the action the line took. Combos containing a dealt
board card are already excluded by that derivation.

- **Single card** (ranked list + heatmap): a card removes every live
  combo containing it. Removed share = removed reach ÷ total live
  reach. One pass over the live combos accumulates, per card, the
  removed reach, the removed combo count, and the removed
  action-frequency totals (`node.strategy` rows weighted by reach).
- **Continuing split** for a card = villain's reach-weighted action
  split re-aggregated over the surviving combos: (whole-range
  weighted totals − removed weighted totals) ÷ surviving reach.
  Null when nothing survives, and the UI says so in words.
- **Picked hand** (`analyseHand`): the **union** removal — a combo
  holding any picked card is removed once. The summary shows combos
  removed/surviving and reach removed/surviving, the split before vs
  after (with a delta line for actions moving ≥ 0.5pt), and a
  per-card breakdown. Per-card figures are each card's solo effect and
  **overlap** (a combo holding two picked cards counts under each);
  the UI states this next to the table.
- **Board cards** are excluded from the ranked list and dimmed in the
  heatmap: they are dead for every combo already, so their removal is
  zero by construction, not a finding.

## Ranking definition (one line)

Cards rank by the **reach-weighted share of villain's live range at
this node that holding the single card removes** (ties: more combos
removed, then card label) — stated verbatim in the tab's footnote.

## Interactions

- The existing `CardPicker` modal is reused for "Your hand"
  (free-pick mode, board cards as dead cards, picks apply immediately,
  click again to remove). The deck heatmap and the ranked list's card
  chips toggle the same hand state, so all three stay in sync.
- The view is keyed by **solve** in Explorer, not by node history
  (the one deliberate deviation from the sibling tabs): hero's hand is
  a holding for the whole hand, so it survives walking the tree while
  every number re-derives per node from props. Switching tabs
  unmounts it like the other views; a new solve starts with an empty
  hand. A partial hand (1–3 cards) is analysed as-is and labelled by
  its picked cards.

## Relation to the Explain panel's blocker note

`lib/explain.ts` already prints a one-sentence blocker note for a
selected combo: the share of the **opponent's starting range** (by
starting weight) that combo's cards remove. This tab is the full
view, and the denominators differ on purpose: here everything is
measured against villain's **live range at this node** by reach —
what can actually be held here, after the line taken — which is the
number a blocker decision at this node turns on.

## What waits on issue #8

An **EV-weighted ranking** — "which blocker is worth the most EV" —
needs the EV of each action for each combo at this node. The payload
carries only whole-solve per-combo EVs, so that ranking cannot be
computed honestly today and is **not shown**: the tab ranks by range
share removed and says so in its footnote. When #8 lands, the
follow-on is a second ranking (and an EV column) beside this one; no
part of the removal math changes.
