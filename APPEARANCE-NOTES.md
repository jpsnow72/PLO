# Appearance + hotkeys — rebrand slice 13 (issue #25)

Reference: captures gtw2-f74–f80 (Appearance Colours / Cards / Other,
Hotkeys Global / Trainer) in the 2026-11-17 capture pass, and the
slice-13 row of the rebrand gap analysis. Built in three commits on
base 7e185c6: token variants → preference store + Settings page →
Explorer hotkeys.

## Token mechanics (the whole design)

Every colour this slice touches was already a CSS custom property, so
an "appearance choice" is a **data attribute on `<html>`** that swaps
token values — no theme engine, no forked renderers:

- `index.css` `:root` holds the shipped look and is the single source
  for it. New tokens: `--ink-on-{suit}` (print colour on a tile),
  `--suit-glyph-{suit}` (suit colour as text on dark panels),
  `--cardback-{bg,line,ring,edge}`, `--felt-{hi,lo}`.
- Variant blocks: `html[data-deck='classic']`,
  `html[data-cardback='green-lattice'|'amber-lattice']`,
  `html[data-felt='navy'|'charcoal']`.
- `lib/appearance.ts` loads/saves the preference and sets the
  attributes. A field at its default **removes** its attribute.
  `main.tsx` calls `initAppearance()` before the first render, so a
  saved choice never flashes the default look.
- Renderers unchanged in structure: `CardChip` (tile ink now reads
  `--ink-on-*`), `CardBack` (palette now reads `--cardback-*`),
  `TableView` (felt gradient now reads `--felt-*`).

## Options offered

- **Deck colours** — Four-colour (default: spades grey / hearts red /
  diamonds blue / clubs green) and **Classic two-colour** (hearts +
  diamonds share the red; spades + clubs share a near-black tile
  `#252c35` printed with light ink `#e9eff7` — per-suit ink tokens
  exist precisely so this stays high-contrast). One wrinkle the
  tokens had to solve: the card picker and the Blockers heatmap use
  the suit colour as *text* on navy, where the classic dark suits
  would vanish — those two labels now read `SUIT_GLYPH_COLOR`
  (`--suit-glyph-*`), which equals the tile colours in the
  four-colour deck and lightens the dark suits (to `--text-dim`
  slate) under classic. Tiles everywhere else are untouched logic.
- **Card backs** — one lattice pattern, three palettes: Navy lattice
  (default, the shipped look), Green lattice, Amber lattice.
- **Table felt** — Table green (default), Deep navy, Charcoal. Only
  the felt gradient was tokenised; the navy rim and layout are
  unchanged.

Settings previews render through the real components (`CardRow` of
four aces, live `CardBack`s, felt swatches), so what you see in
Settings is what the Explorer shows.

## Persistence scope

`localStorage` key `plo-appearance`, this browser only — applied
app-wide, **not** synced to the account or the API (there is no
cross-device preference store in the app; the reference stores these
locally too). Each stored field is validated independently on load;
a corrupt entry falls back per-field to the defaults. If storage is
unavailable (private mode), choices still apply for the session.
The Settings page says all of this in plain text.

## Hotkeys (Explorer)

Bound by `lib/useExplorerHotkeys.ts`, documented in one list
(`EXPLORER_HOTKEYS` in `lib/hotkeys.ts`) that both the Settings page
and the Explorer's **?** popover render — they cannot drift.

| Key | Action |
|---|---|
| ← | Step back one move along the line |
| → | Step forward again — only through moves you stepped back over |
| 1–5 | Take the 1st–5th action listed at this node |
| Esc | Close the card picker / stop drawing — **bound by CardPicker and DrawingOverlay themselves**, deliberately not re-bound here (a second binding would fire both) |

Forward needed a mechanism: the store's path is a truncating stack
(`goToStep` drops later steps; there is no redo state). The hook
keeps a local redo stack — ← parks the removed step, → re-applies
it via `setPath` (which validates the steps resolve in the loaded
solve). **Any** other navigation (clicking an action, the node
strip, Reset, a Quiz deep link, loading another solve) clears the
forward stack, browser-style; a path watcher distinguishes
hook-caused navigation from the rest.

Guards: keys never fire while typing in an input/textarea/select or
a contentEditable, while an `aria-modal` dialog (the card picker,
including the Blockers hand picker) is open, or with Ctrl/Alt/Meta
held. Number keys are inert while a runout choice is outstanding or
the line has ended. The popover is a plain toggle panel, not a
modal, so it never traps or swallows keys itself.

## Omissions vs the captures (with reasons)

- **Appearance — Colours (f74): themes, colour presets,
  export/import of colours, action/range/player colour editors.**
  Not built. This slice recolours cards, backs, and felt only; the
  app's navy/green/amber theme stays fixed, as it has since the
  Figma redesign. (The wider slice text also mentioned
  action-colour adjustments — same status: not built here.)
- **Appearance — Other (f76): unit display (bb / chips / % of pot),
  number grouping, loading tips.** Not built. Amounts still render
  in solve units everywhere; a unit toggle would have to thread
  through every number in the app and belongs in its own slice
  rather than being faked in Settings.
- **Card faces beyond colour** (f75's numbered Card Style / Card
  Back Style galleries): we offer colour schemes for the one face
  design and one lattice back design we ship — not a gallery of
  face artworks. Their artwork is theirs; ours is the slice-1
  design in three palettes.
- **Trainer hotkeys (f78)**: not built — the brief scoped hotkeys
  to the Explorer. The Quiz keeps its button flow.
- **Languages (f79)**: skipped by design (gap-analysis decision).
- **Account / Subscription pages (f72/f73)**: untouched — Login and
  Admin already exist; the Settings page links to them in prose
  rather than duplicating them. The old Settings stub's other
  placeholder bullets (engine host config, default accuracy tier)
  were aspirational text for other tickets, not features, and were
  not carried over.
