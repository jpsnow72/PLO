# BRIEF SHIP-1 — Redesign implementation, part 1 (UI only)

You are building in the git repo at ~/workspace/plo-ship1-tree
(branch `ship1-redesign`, base = main 3711f2c). React+Vite+TS+Tailwind UI in
ui/, Node API in api/, Rust engine in engine/ (DO NOT touch engine/ or api/).

HARD RULES (local lane)
- Stay inside this tree for ALL reads/writes.
- BUILD-ONLY: no git push, no PRs. Local commits on `ship1-redesign` only.
- NO local builds: do not run npm build/vite/dev servers or test suites on
  this machine. The ONLY permitted check is a typecheck:
  `cd ui && NODE_OPTIONS="--max-old-space-size=256" npx tsc --noEmit`
  (node_modules may not be installed; if tsc cannot run for that reason,
  note it in SHIP1-NOTES.md and proceed — the coordinator gates on a server).
- Do not change solver behaviour, routes, or API contracts. Restyle and
  extend presentation only, plus the two Solver additions below.
- When done: write SHIP1-NOTES.md in the tree root (files changed, decisions,
  anything unverified), commit everything, and stop.

DESIGN (from the approved Figma redesign "PLO GTO Study — Redesign 2026-11";
essentials inline so you do not need Figma access)

1) DESIGN TOKENS (follow the codebase's existing theme pattern in
   ui/src/index.css / tailwind config):
   --bg-base #0A1628; --bg-panel #12233C; --bg-panel2 #182C49;
   --bg-line #24405F; --text-primary #E9EFF7; --text-dim #93A5BC;
   --accent-green #2E9E6B; --accent-amber #F5A623; --action-bet #B4463F;
   --action-call #3E7CB1; --action-fold #5B7290; suit colours: spade #C7D0DC,
   heart #E05B4B, diamond #4E9BE0, club #43B581. Apply across the app shell
   (nav, panels, tables) so every page inherits it. Radius 8px panels,
   compact tabular type, right-aligned numerics.

2) EXPLORER RESTYLE (ui/src/pages/Explorer.tsx + components):
   a. Node strip: horizontal strip of node cards replacing the current
      history display — a street/board card, then one card per decision node
      (position, stack, action summary). Clicking a card jumps to that node
      (the store already tracks the path). Selected node: green outline.
      A pending street card opens the card picker (c).
   b. Strategy view: one table per action at the current node. Header bar
      coloured by action (check = green, fold = slate, bet/raise = red
      family, call = blue) with aggregate % and combo count. Columns: Hand
      (existing card tiles), Freq %, EV, EV Diff (vs the best action for
      that combo; green + / red -), Weight. Sortable by EV and Freq. Data:
      the solve JSON already carries per-combo strategies and per-combo EVs
      (oop_evs/ip_evs); EV Diff is computed in the UI. If a field is absent
      for a node, render an em dash — never invent numbers.
   c. Card picker modal: 4 suit rows x ranks A-2, dead cards (board + known
      cards) dimmed/disabled, Clear and Randomize buttons, click applies.
      Use for turn/river selection in Explorer AND wire into the Solver
      board selector if the current Solver board input is text-only.
   d. Right rail: restyle existing panels to the Figma layout — node
      overview (position chips with stacks, pot, pot odds if already
      computed), Categories section ONLY IF category data already exists in
      the solve payload; if not, omit it and say so in SHIP1-NOTES.md
      (fabricating categories is forbidden). Keep the certification badge
      (Nash % + tier) prominent, the Explain panel, and the Multiway Lens
      slot as-is.
   e. View tabs (Strategy / Matrix / Ranges) only where they map to existing
      views; the current range grid becomes the "Matrix" tab. Do NOT build
      Breakdown/Compare.

3) SOLVER ADDITIONS (ui/src/pages/Solver.tsx):
   a. Quick Setup cards: "Single-raised pot" (BTN vs BB constructed preflop
      sets, pot 7.5, stack 100), "3-bet pot" (CO vs BTN, pot 22, stack 100),
      "4-bet pot" (pot 48, stack 100), "Heads-up custom" (clears to manual).
      Use the existing range-set plumbing (oop_range_set/ip_range_set ids
      from the preflop data); if a named set does not exist, use the closest
      existing constructed set and note the choice in SHIP1-NOTES.md.
   b. PPT range paste: range text inputs must ALSO accept PPT format
      "AsKsQsTh@100, AsKsQsJh@52" (@ = weight percent 0-100 -> weight/100)
      alongside existing formats. Parse in ui/src/lib. Invalid entries give
      a clear inline error, never a silent drop. Note 3 worked examples in
      SHIP1-NOTES.md.
   c. Street selector for custom solves (flop/turn/river) already exists —
      keep it, restyle to the Figma chips.

ACCEPTANCE
- tsc --noEmit clean (or the node_modules caveat noted).
- All existing pages still compile/render with the new palette (Dashboard,
  Spot Picker, Preflop, Quiz, QuickReview, Heuristics, Login, Admin, Runner).
- SHIP1-NOTES.md lists: files changed, the category-data decision (2d),
  quick-setup set ids used, PPT parse examples, typecheck result.
