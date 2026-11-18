# Drawing mode — rebrand slice 8 (issue #20)

Freehand annotation over the Explorer's Table view, in the pattern of the
captured reference's drawing mode (capture gtw2-f82): turn drawing on, mark
up the table, turn it off and keep studying the line underneath.

## What shipped

- **Draw toggle** in the Table view toolbar (`DrawingToolbar`), above the
  table. While on, the tool controls appear: pen colours, pen widths,
  Pen/Eraser, and — whenever strokes exist — Undo and Clear all.
- **Overlay**: a single absolutely-positioned SVG covering the seats + felt
  block (`DrawingOverlay` inside `TableView`). It renders the strokes at
  all times but only captures the pointer while drawing mode is on; off,
  it is `pointer-events-none` and the table interacts exactly as before.
- **Tools** (following the captured pattern):
  - Pen in five colours from our own palette — amber `#F5A623` (default),
    table-light green `#3FBF82`, hearts red `#E05B4B`, diamonds blue
    `#4E9BE0`, white. (The felt is the darker table green `#2E9E6B`, so
    the light green is the visible "green" on it.)
  - Three widths (S/M/L = 0.6/1.1/2.0 viewBox units, ≈4/7/13 px on a
    640 px-wide table).
  - Eraser = **stroke removal**: the eraser deletes any stroke whose
    polyline passes within its half-width + a small radius of the
    pointer (hit test in `lib/drawing.ts`). Chosen over canvas
    `destination-out` because strokes are SVG paths, not pixels —
    removal keeps the stroke model clean (undo still works per stroke,
    no raster layer, no partial-erase fragments).
  - Undo (last stroke), Clear all, **Esc** exits drawing mode.
  - Picking a colour switches the tool back to Pen (standard paint-tool
    behaviour).

## Tech choices

- **SVG paths, not canvas.** Strokes are stored as point lists and
  rendered as `<path>` with midpoint-quadratic smoothing
  (`strokePathD` in `lib/drawing.ts`), round caps/joins. No new
  dependencies; resolution-independent at any table size; a tap with
  no drag renders as a dot.
- **Coordinates** are stored in a 0..100 viewBox mapped from the
  rendered box (`preserveAspectRatio="none"`), so a stroke replays
  proportionally if the table resizes. A viewBox unit is slightly
  wider than it is tall on the real table, so strokes stretch a
  little with the box — acceptable for annotation, and noted in the
  lib header.
- **Pointer events** with pointer capture on the SVG, so a stroke
  continues smoothly if the pointer leaves the table mid-drag.
  Points are thinned (min step 0.35 units) to keep stroke arrays
  small. The in-progress stroke is component-local and only commits
  to the store on pointer-up, so a half-drawn line never hits Undo.
- **Touch**: the overlay takes `touch-none` (touch-action: none)
  only while drawing mode is on, so drawing on a phone doesn't
  scroll the page; with the mode off, touch/scroll are untouched.

## State scope

- Strokes, the active flag, and the current tool/colour/width live in
  the **zustand store** (`useStore` drawing slice), not in the Table
  view — the Explorer remounts that view per node, and annotations
  must survive walking the tree within a solve (annotating a line is
  the point).
- Strokes belong to the **loaded solve**: `loadRawSolve` clears them
  (and exits drawing mode) when another solve loads.
- **Session-local only**: nothing is persisted (no localStorage, no
  API), nothing is sent anywhere. The toggle's tooltip and the
  toolbar hint say so in the UI ("Annotations are kept for this
  solve only, in this session — they are never saved or sent
  anywhere").

## Omissions vs the capture, and why

- **No paint-to-select combos on the Matrix.** The capture's drawing
  mode is entangled with combo selection on their matrix (see the
  gap analysis, slice 8 discussion). This slice implements the
  freehand table annotation the brief specified; painting as a
  combo-selection gesture belongs with the nodelock range editor
  (issue #9), which will define what a painted selection *means*
  before we build the gesture.
- **No shapes / arrows / text tools, no opacity control.** The
  capture shows a freehand-first toolset; shapes and text are a
  second annotation vocabulary we don't need yet.
- **No persistence or sharing of annotations.** Deliberate: study
  markup is scratch work. If saved annotations are ever wanted,
  they belong with the heuristics log, designed as their own item.
- **Overlay covers the Table view only** (seats + felt), not the
  Strategy/Matrix/Ranges/Blockers tabs — the table is the surface
  the capture annotates, and each other tab is a dense data grid
  where freehand marks would obscure the numbers they exist to show.
