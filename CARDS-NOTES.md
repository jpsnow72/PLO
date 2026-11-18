# CARDS-NOTES — graphical cards (rebrand slice 1, issue #13)

One graphical playing-card component now renders every card in the app.
This note records the component API, the colour choices, every call site
swept, and what was deliberately left alone. Rendering only: no
interaction, state, or data flow changed anywhere in this lane.

## Component: `ui/src/components/CardChip.tsx`

The old `CardChip` was a navy tile with suit-coloured text. It was
**replaced in place** (same file, same exported names — `CardChip`,
`CardRow`, `SUIT_COLOR`) so every existing call site upgraded to the
graphical face with zero churn, and the one cross-import of `SUIT_COLOR`
(CardPicker) kept working. The gap analysis called for exactly this:
"One component change (CardChip) ripples through every surface."

### API

- `CardChip({ card, size?, className?, style? })` — one card face.
  `card` is the `Card` from `ui/src/lib/cards.ts` (`{rank, suit, label}`).
- `CardRow({ cards, size?, className? })` — a row of faces (a 4-card hand
  renders as 4 faces, a board as 3–5).
- `CardBack({ size?, className?, style? })` — face-down card (see
  "Deliberately left" for why nothing renders it yet).
- Sizes (`CardSize`): `xs` h-7 w-5 (dense lists), `sm` h-8 w-6 (tables,
  rails), `md` h-11 w-9 (default), `lg` h-14 w-11 (board / hero focus).
  `sm`/`md`/`lg` dimensions are unchanged from the old chip, so no layout
  shifted; `xs` is new for list contexts that previously used 11px text.
  `className`/`style` are passthroughs — the CardPicker uses `style` to
  stretch a tile across its grid cell.

### The face

Four-colour deck in the pattern of the captured reference (GTO Wizard,
Appearance > Cards, capture f75): **the tile carries the suit colour**,
rank + suit glyph on top.

- Tile background: the suit colour with a soft white sheen across the top
  (`linear-gradient(165deg, rgba(255,255,255,0.28), transparent 52%)`) —
  the sheen and the black/30 edge are our touches on the flat reference
  tile.
- `md`/`lg` get a real card's corner furniture: rank-over-glyph index in
  the top-left corner and the same index rotated 180° in the bottom-right.
  `xs`/`sm` are too small for corners, so they use a centred rank-over-
  glyph stack.
- Accessibility: the face is `role="img"` with `aria-label` and `title`
  set to the full card name from the new `cardName()` helper in
  `lib/cards.ts` ("Ace of spades", via the new `RANK_NAME` table). This
  also fixes the old chip's label, which read "A of s".

### Colours — kept the existing tokens, on purpose

| Suit | Hex (existing `--suit-*` token) | Reference mapping |
|---|---|---|
| Spades | `#c7d0dc` (grey) | spades grey ✓ |
| Hearts | `#e05b4b` (red) | hearts red ✓ |
| Diamonds | `#4e9be0` (blue) | diamonds blue ✓ |
| Clubs | `#43b581` (green) | clubs green ✓ |

The tokens in `ui/src/index.css` already encoded exactly the reference's
four-colour mapping, so no hex changed — restyling the tile to *carry*
the colour was the whole gap. Rank/glyph ink is the app background navy
`#0A1628` on all four tiles. Measured contrast of `#0A1628` against each
tile (WCAG relative-luminance formula): spades ≈ 11.9:1, clubs ≈ 7.2:1,
diamonds ≈ 6.3:1, hearts ≈ 5.1:1 — all pass AA for the bold rank text at
every size, and using one ink colour keeps the deck reading as one deck.
`CardBack` is ours: `--bg-panel` navy `#12233C` with a card-table-green
(`#2E9E6B` at low alpha) diamond lattice and an inset green ring.

## Call sites swept

Direct edits in this lane:

- **CardPicker** — every picker cell is now a `CardChip` tile inside the
  existing button (Explorer runout + Solver board modes). Chosen ring,
  dead-card dimming (now `opacity-35` on the tile), and hover zoom live
  on the button as before; button aria-labels now use full card names.
- **RangeGrid** (Explorer matrix drill-down) — combo rows render `xs`
  card rows instead of mono text; the frequency stays mono text.
- **MultiwayLens** — top/bottom-decile combo lists render `xs` card rows
  instead of mono text.
- **SpotPicker** — each solve row shows its board as `sm` cards instead
  of the mono board string.
- **Quiz** — session-history rows render the hero combo as `xs` cards
  next to the street name.
- **QuickReview** — "Worth another look" rows render the board and the
  hero hand as `xs` cards inline in the recap sentence.
- **Solver** — a graphical `sm` preview of the typed board now sits under
  the board input. The text input remains the source of truth (typing,
  shortcuts, and the picker are untouched); the preview is render-only.

Picked up the new face automatically (already on `CardRow`/`CardChip`):

- Explorer board (flop/turn/river, `lg`), NodeStrip board (`sm`),
  StrategyTables combo cells (`sm`), HandDetail (`sm`), RunoutPicker
  (`sm`), MultiwayLens board + hero (`sm`), Quiz question board + hero
  (`lg`), QuickReview card board + hero (`lg`).

## Deliberately left

- **Text fallbacks stay** in StrategyTables, HandDetail, RunoutPicker,
  RangeGrid, MultiwayLens, SpotPicker, Quiz, and QuickReview — each only
  renders when a string fails to parse as cards at all, i.e. it is not a
  card and a face would be a lie.
- **Preflop matrix cells and the drill-down class table** keep text
  labels ("AA", "AKQ"-style class keys with feature tags). Those are
  hand *classes*, not cards — the reference's preflop matrix uses class
  labels the same way.
- **CardPicker's suit-row header glyph** (the ♠/♥/♦/♣ row labels) stays
  coloured text on navy — it is a row label, not a card.
- **CardBack renders nowhere yet.** No current surface shows an unknown
  card (opponents are ranges, not hole cards). It ships with the
  component so the Explorer Table view (slice 2) builds on it instead of
  inventing a second back.
- **Starting Hands study page** is a separate lane and is not on this
  branch. It renders hands through its own markup today; when it composes
  onto a main that has this slice, its hand rendering should adopt
  `CardRow` in a small follow-up.
- **ExplainPanel prose** mentions combos inside generated explanation
  text; that is prose, not card rendering.
