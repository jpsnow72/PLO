# SHIP-1 notes — design tokens + Explorer restyle + Solver quick setups / PPT paste

Branch `ship1-redesign` on top of main `3711f2c`. UI only; nothing under
`engine/` or `api/` was touched.

## Files changed

Design tokens (commit "ship1: design tokens from the Figma redesign"):

- `ui/tailwind.config.ts` — navy ramp re-pointed at the Figma values:
  950 `#0A1628` (page bg), 900 `#12233C` (panel), 850 `#102138` (inset
  wells), 800 `#182C49` (panel-2), 700 `#24405F` (borders), 600 `#31598C`.
  Ink: `#E9EFF7` / dim `#93A5BC` / faint `#5F748E`. Table green `#2E9E6B`
  and accent amber `#F5A623` unchanged. Existing class names kept, so
  every page inherits the new palette.
- `ui/src/index.css` — rewritten around the same palette as semantic CSS
  vars (`--bg-base`, `--bg-panel`, `--bg-panel2`, `--bg-line`,
  `--text-primary`, `--text-dim`, action colours, standard suit colours)
  plus a `.num` tabular-numerals utility. `components/actionStyle.ts`
  reads these vars, so action colours (check green, bet red, call blue,
  fold grey, raise orange) propagate without edits there.
- `BRIEF-SHIP1.md` — the brief itself, committed with the lane.

Explorer restyle (commit "ship1: Explorer restyle …"):

- `ui/src/components/NodeStrip.tsx` (new) — horizontal strip replacing
  `PathBar` in Explorer: board card, then one card per path node (street,
  player to act, step label, pot / to call from the node payload),
  current node outlined green, click any card to jump (`goToStep`). A
  dashed amber "pick a card" card appears while a runout is pending and
  reopens the picker. `PathBar` itself is untouched (Quiz still uses it).
- `ui/src/components/StrategyTables.tsx` (new) — one table per action:
  header bar in the action colour with aggregate % and combo count;
  columns Hand / Freq / EV (solve) / EV Diff / Weight; rows are the
  node's live combos with frequency > 0 for that action, sortable by
  Frequency or EV, capped at 50 rows with a show-all toggle; clicking a
  row selects the combo into Hand detail. Frequencies come from the
  node's strategy entries; EV is the payload's per-combo whole-solve EV.
- `ui/src/components/CardPicker.tsx` (new) — the card-picker modal:
  4 suit rows × ranks A–2 in standard suit colours, dead cards dimmed and
  disabled, selected cards ringed amber, Escape / backdrop click closes,
  Clear + Randomize (+ optional Apply) footer. Used for Explorer runouts
  (only runouts present in the solve are enabled) and the Solver board.
- `ui/src/components/CardChip.tsx` — `SUIT_COLOR` is now exported (the
  picker reuses the app's standard suit colours).
- `ui/src/pages/Explorer.tsx` — new layout: header (solve name, meta,
  AccuracyBadge) → NodeStrip full width → centre column with the action
  chooser, then Strategy | Matrix view tabs (Strategy = per-action
  tables; Matrix = colour-by-action chips + the existing RangeGrid) →
  right rail (360px): Node overview (OOP/IP position chips showing the
  solve's effective stack, board incl. turn/river cards, street, to act,
  pot, to call, pot odds derived as to_call/(pot+to_call) from the node's
  own figures, whole-solve range EV), Accuracy section with the
  certification badge prominent, Hand detail, Link-to-heuristic, Explain
  panel, and the badges legend. Runout choice is now the CardPicker
  modal; dismissing it leaves the pending state in place (a banner and
  the strip's pending card reopen it) instead of discarding the chance
  node. No other behaviour changed: path/store logic untouched.

Solver + libs (commit "ship1: Solver quick setups, PPT range paste …"):

- `ui/src/pages/Solver.tsx` — Quick Setup cards row (below); RangeField
  live inline parse feedback (errors listed under the textarea as you
  type/paste, parsed-combo count when clean); board "Pick cards" button
  opening the CardPicker (toggle up to 5, Clear, Randomize = 5 random
  cards, Apply commits the board text); street chips (Flop/Turn/River)
  restyled and derived from the board; range helper text documents PPT.
- `ui/src/lib/spot.ts` — `parseRangeText` accepts PPT entries (below),
  mixed freely with the existing shapes; malformed entries produce
  errors, never silent drops.
- `ui/src/lib/preflop.ts` — guard fix (below).

## Category data: NOT present in the payload — section omitted

The brief's Categories section (category name, freq %, EV, EV diff per
category) requires hand-category data. The solve payload has none:
`RawSolveNode.strategy` entries are `{ combo, frequencies }` only, and
the only EV maps (`oop_evs` / `ip_evs`) are per-combo, whole-solve.
There is no category field, category grouping, or category EV anywhere
in `ui/src/lib/types.ts` / the API responses. Per the brief ("if the
payload has no category data, state that in SHIP1-NOTES.md and omit the
section — fabricating categories is forbidden"), the Categories section
is **omitted** from the Explorer right rail. Nothing was invented.

## EV Diff: rendered as an em dash (honest absence)

Same root cause: per-action EVs do not exist in the payload — only
whole-solve per-combo EVs. The strategy tables therefore show the real
"EV (solve)" column and render **EV Diff as "—"** for every row, with a
footnote under the tables explaining that per-action EVs are not in the
solve payload. The per-action column structure is in place for when the
engine emits per-action EVs.

## Quick-setup set ids used

All sets are the constructed 6-max 100bb preflop sets; stacks 100 on
every card.

| Card | OOP set | IP set | Pot |
|---|---|---|---|
| Single-raised pot (BTN vs BB) | `constructed-v1-6max-bb-vs-btn` (BB call range vs BTN open) | `constructed-v1-6max-btn-rfi` (BTN raise-first-in) | 7.5 |
| 3-bet pot (CO vs BTN) | `constructed-v1-6max-co-rfi` (CO raise-first-in) | `constructed-v1-6max-btn-vs-co` (BTN vs CO open) | 22 |
| 4-bet pot (BTN vs BB) | `constructed-v1-6max-bb-vs-btn` | `constructed-v1-6max-btn-rfi` | 48 |
| Heads-up custom | — (clears both to manual) | — | 100 |

Caveats, stated plainly:

- Single-raised pot is the exact brief match (BB's continue range is a
  vs-RFI set, which the API's uncapped expansion loads by call
  frequency).
- 3-bet pot: the *true* CO continue-vs-3-bet set exists
  (`constructed-v1.1-6max-co-vs-btn-3bet`, context `vs_three_bet`) but
  the API only expands `vs_three_bet` through its capped path, which
  needs an explicit base set + cap the wizard does not emit; BTN's 3-bet
  slice is likewise not a loadable range. The card therefore loads the
  closest solve-compatible sets (CO's RFI range OOP, BTN's vs-CO-open
  range IP) with the 3-bet pot geometry. The ranges are the opener /
  responder ranges, not literal 3-bet continue ranges.
- 4-bet pot: no 4-bet sets exist in the library at all; the card reuses
  the BTN-vs-BB pairing with a 4-bet-sized pot (48). Same honesty note
  as the 3-bet card.

## Preflop guard fix (`vs_three_bet`)

While wiring the quick setups, a pre-existing bug surfaced: the API
serves `data/preflop/index.json` as-is, and the index contains three
v1.1 sets whose context is `vs_three_bet` — but the UI's `SetContext` /
`CONTEXTS` in `lib/preflop.ts` did not include it, so
`isPreflopIndex` / `isPreflopSetDoc` rejected the **entire** index and
preflop set mode silently never loaded (Solver set dropdowns empty,
Preflop page empty) whenever the API was up. Fix: `vs_three_bet` added
to the type, the guard list, and `setLabel`; `solveActionForContext`
still returns null for it, so it stays out of the Solver's
solve-compatible dropdowns (matching the API rule). Verified against
the real index + a v1.1 set document in `data/preflop/`.

## PPT parsing — worked examples

`parseRangeText` now treats any entry containing `@` as PPT: the part
after `@` must be a percent 0–100 and becomes weight = percent / 100;
the combo may be compact (`AsKsQsTh`) or spaced (`As Ks Qs Th`).

1. `AsKsQsTh@100` → 1 entry: combo `As Ks Qs Th`, weight **1.00**. No errors.
2. `AsKsQsJh@52` → 1 entry: combo `As Ks Qs Jh`, weight **0.52**. No errors.
3. Mixed input `Ts 9s 3c 4c:0.5, AsKsQsTh@100` + newline `Jd Td 8h 9h` →
   3 entries: `Ts 9s 3c 4c` @ **0.50** (existing `:weight` shape),
   `As Ks Qs Th` @ **1.00** (PPT), `Jd Td 8h 9h` @ **1.00** (bare combo).
   No errors.

Error handling (never silent): `AsKsQsTh@150` → error
`Bad PPT weight in "AsKsQsTh@150" (@ must be a percent 0-100)`;
`AsKsQs@100` → error `Not a valid 4-card combo: "AsKsQs@100"`. In both
cases the entry is excluded and the error is shown inline in the Solver
and blocks submit via the existing validation path.

## Typecheck

**Could not run.** `ui/node_modules` does not exist in this tree (and no
TypeScript is installed anywhere on this machine), so the brief's
permitted check — `cd ui && NODE_OPTIONS="--max-old-space-size=256" npx
tsc --noEmit` — resolves to npx's placeholder `tsc` package, not the
TypeScript compiler. Per the brief, the coordinator should run the
typecheck / build gate on a server. The code was written against the
existing typed helpers (`solveTree`, `cards`, `spot`, store) and
re-read for strict-mode issues, but it is **not** compiler-verified.

## Anything unverified / notes for the coordinator

- No local build, dev server, or test suite was run (brief rule). All
  rendering behaviour is unverified at runtime; the gate should include
  the UI build plus a click-through of: Explorer sample solve (node
  strip navigation, strategy tables, matrix tab, runout modal on the
  flop sample), Solver quick-setup cards, PPT paste in a range field,
  and the board card picker.
- `RunoutPicker` and `PathBar` components still exist; Explorer no
  longer uses RunoutPicker (Quiz still uses PathBar). Left in place —
  removing them is a separate cleanup call.
- The heads-up quick-setup card counts as "active" whenever both range
  sets are cleared, including the page's initial state — it describes
  the manual-entry mode rather than a template.
- Pot odds in the node overview are derived from the node's own pot /
  to-call (call ÷ (pot + call)); the payload carries no pot-odds field.
- Position chips show the solve's `effective_stack` for both seats (the
  payload's only stack figure); they are labelled as solve stacks.
