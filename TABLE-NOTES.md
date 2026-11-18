# TABLE-NOTES — Explorer Table view (rebrand slice 2, issue #14)

A third Explorer display: the current node drawn as a poker table, in the
pattern of the captured reference (gtw2-f18: nameplates with stacks, pot in
the middle, board as graphical cards, "To Act" marker). Built entirely from
the loaded solve's payload — no engine, API, or payload changes.

## Files

- `ui/src/components/TableView.tsx` — the view (new).
- `ui/src/lib/solveTree.ts` — two new exported derivations, `lineMoney`
  and `rangePresence` (both pure functions of `SolveData` + path, ready to
  reuse — e.g. by the Ranges tab, slice 4).
- `ui/src/pages/Explorer.tsx` — `ExplorerView` gains `'table'`; one tab
  entry and one render branch added to the existing tablist. Nothing else
  in the Explorer changed; Strategy and Matrix are untouched, and the
  certification badge / right rail are exactly as before.

## What each element binds to

| Element | Source |
|---|---|
| Board (centre) | The Explorer's existing `currentBoardCards`: `solve.boardCards` + the current node's `turn_card` / `river_card`, rendered with the slice-1 `CardRow` at size `lg` |
| Pot (centre) | `node.pot` — the payload's own pot at this node |
| "To call" line (centre) | `node.to_call`, shown only when > 0; otherwise "No bet to face" |
| Street label (centre) | `node.streetName`; a pending chance node appends "· turn/river card next" |
| Seat position label | The payload's player ids, `OOP` (top) / `IP` (bottom) — solves are heads-up OOP-vs-IP, so there are no named positions (BB/UTG etc.) to show |
| To-act highlight + pill | `node.player`, suppressed when the line just taken ended the hand (`terminalAction` set) |
| Stack per seat | `lineMoney().stackBehind` = `solve.raw.effective_stack` − that player's committed-along-the-line (below) |
| "In pot" per seat | `lineMoney().committed` (below) |
| Range summary per seat | `rangePresence()`: combos still live + reach-weighted share of the player's starting range (below) |
| Face-down cards per seat | Four slice-1 `CardBack`s — a placeholder for the player's four unknown cards (PLO is always four cards). **Not** hole cards: no specific cards are ever rendered for a seat |

## The two derivations

**Committed / stack behind (`lineMoney`).** The payload carries no
per-player committed or remaining-stack fields — only each node's `pot`
and the solve-level `effective_stack`. The pot only changes when a player
acts, so the pot difference between consecutive path nodes is exactly what
the player to act at the earlier node put in with that action. This holds
for runout steps too: a street-closing action's chips land in the runout
subtree root's pot. Summing a player's deltas along the path gives their
in-tree contribution; `effective_stack − committed` is their stack behind.
No action-label amounts are parsed, so Bet/Raise/Call semantics can never
be misread. Verified by hand against the bundled sample solve
(root pot 100 → `B(33)` pot 133 → delta 33 attributed to OOP;
`X/B(75)` pot 175 = check 0 + IP bet 75).

**Range presence (`rangePresence`).** A combo's presence at the current
node is its starting weight (from the solve's `*_evs` lists) times, for
every decision node of that player along the path, the stored frequency of
the action the line actually took there. The taken action is found by
matching child histories (`childHistory`), so street-closing actions
before a runout count too. Combos containing a dealt board card are
excluded, and for the player to act the current node's own all-zero
(card-blocked) strategy rows drop out as well. The seat shows the count of
combos with presence > 0 and the reach-weighted share of the starting
range's total weight. At the root this reduces to the full range minus
board-blocked combos — the same "Combos: N (x%)" idea as the reference's
header readout.

## Deliberately left blank / not shown, and why

- **Hole cards** — never known in Explore mode (only ranges are). Seats
  show card backs + the range summary; no specific cards are invented.
- **Starting-pot split** — the starting pot is pre-solve money (blinds /
  brought-in pot). The payload does not say who contributed what, so it is
  attributed to neither player: at the root both seats read "In pot 0" and
  the full effective stack. The view's footnote says this out loud.
- **Per-street committed breakdown** — only the line total is shown; the
  payload deltas would support a per-street split, but the reference shows
  one stack figure per seat and the node strip already walks the line
  step by step.
- **Player names / avatars / dealer button** — the payload has no such
  concepts for a heads-up solve; nothing was invented to fill the seats.
- **All-in / SPR callouts** — derivable (stack behind vs pot is on the
  table already), but not in the reference's table either; left for a
  later slice rather than freelanced here.

## Behaviour

The view is keyed by `node.history` like Strategy/Matrix, so walking the
tree (ActionList, node strip, runout picker) re-renders it at the new node
with updated pot, stacks, committed amounts, board, and range summaries.
When a runout is pending it captions that the street closed; when the line
just ended the hand, no seat is highlighted and the centre names the
closing action.
