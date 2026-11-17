# Ship 2 — Redesign implementation notes

Branch `ship2-redesign` on top of main `bd2890a` (Ship 1 redesign + Multiway
Lens). UI only: no changes under `engine/` or `api/`. Built to the approved
Figma file "PLO GTO Study — Redesign 2026-11" (frames: Preflop, Quiz
Trainer), reusing the Ship 1 design system (navy base, table green #2E9E6B,
amber #F5A623, existing components). Nothing rendered is fabricated: every
number comes from data the app already loads, as detailed per element below.

## Commits

- `210e00c` Preflop matrix drill-down (lib helpers + page)
- `c9b11c1` Type the preflop matrix cells map
- `e87eab2` Suitedness chips render inert when the class table is not loaded
- `d80615b` Explorer deep-link support (store `setPath`, quiz path helpers)
- `808144c` Quiz trainer presentation (stage, feedback banner, session rail)

## 1) Preflop matrix drill-down — `ui/src/pages/Preflop.tsx`, `ui/src/lib/preflop.ts`

A "Set view / Matrix view" toggle sits under the (unchanged) range summary;
the amber CONSTRUCTED badge and the full provenance block stay visible in
both views, and the pair-rank summary + class list are untouched in Set view.

Matrix view contents and their data sources:

- **13×13 rank-pair grid** (ranks A–2 on both axes, full mirrored grid like
  the Figma frame). Cell (hi, lo) aggregates every hand class in the loaded
  set whose cards contain both ranks; the diagonal cell of a rank is every
  class holding a pair or better of it. A class therefore touches several
  cells — this is a drill-down, not a partition (the panel copy says so,
  adapted from the Figma note). Colour = the selected action's
  combo-weighted frequency inside the cell, in that action's existing
  ACTION_COLOR. Sources: set document `hands` (per-class action
  frequencies) + class multiplicities (class table when loaded, else the
  suit-permutation orbit computed from the key — the existing
  `multiplicityOf` fallback). Helpers: `matrixCells`, `matrixFilteredTotal`,
  `matrixClasses`, `classRankValues` in `lib/preflop.ts`.
- **Suitedness filter chips**: Any / Double suited / Single suited / Triple
  suited / Monotone / Rainbow, mapped onto the class table's exact
  `features.suitedness` values (`double`, `single`, `three` = triple
  suited, `four` = monotone/all-one-suit, `rainbow`). Filters reshape the
  grid and the drill-down. They need the class table: when it is not
  loaded, the chips render inert (dimmed, non-interactive) with a note,
  and the grid runs unfiltered from the set document alone — no fake
  filtering.
- **Drill-down panel** for the selected cell (default AA, as in the Figma
  frame): "{pair} selected → N combos · {Action} X%", the selection's
  share of the (filtered) set total, and a class table (cap 100 rows,
  strongest action frequency first) with class key, feature tags, combo
  count, and the action frequency bar — all from the same set document +
  class table.
- The action selector pills in Matrix view drive the same page-level
  `action` state as Set view, so switching views keeps the action.

## 2) Quiz trainer presentation — `ui/src/pages/Quiz.tsx`, `ui/src/lib/quiz.ts`, `ui/src/store/useStore.ts`

Question screens are now a two-column layout (stage + right rail at `lg`),
for both spot and heuristic questions. Grading code is untouched:
`gradeSpotAnswer` / `gradeHeuristicAnswer` unmodified, the EV-lost path
still fires only when a solve carries `combo_action_evs`, and the feedback
copy still names the mode ("Graded by frequency match" / "Graded by EV
lost" / "Graded by recall").

- **Stage**: green felt panel (table-dark + table ring) with the pot (and
  to-call when > 0), the board, the reconstructed line (`lineSteps` output
  already on the question), and the hero hand with position/street. All
  fields come straight off the existing `SpotQuestion`. The app's CardChip
  tiles are reused (dark tiles) rather than the Figma frame's light tiles —
  design-system consistency over pixel-matching the mock.
- **Instant-feedback banner**: appears the moment an answer is graded,
  tinted by grade band (solid green / partial amber / miss red). Headline:
  "✓ Check — the solver checks 72.3% here" — the chosen action plus the
  solver's stored frequency for that action with this exact combo
  (`q.frequencies[pickedAction]`). Below it, the grader's own headline,
  score, and the unchanged honesty detail text; "Next hand" advances.
- **Session rail** (Figma right panel):
  - HANDS = graded answers this session; ACCURACY = their mean grade
    score (the same number the summary screen already reported as
    "Average score"), labelled "avg grade score".
  - STREAK = trailing run of "solid" grades (score ≥ 0.85, the existing
    `bandForScore` threshold), shown with 🔥 when ≥ 1.
  - AVG EV LOSS row renders **only** when at least one answer was
    actually EV-graded (per-action EVs present). The Figma mock shows
    this stat unconditionally, but in frequency mode the data cannot
    support it, so it is omitted rather than fabricated.
  - ACCURACY BY TOPIC bars from the same `weakTopics` data the home
    screen used (synced progress topics, or this session's local topics
    when not synced), weakest first, green ≥ 70% / amber below. The home
    screen's topic chips were converted to the same bars.
  - HISTORY: this session's graded answers, newest first — band icon,
    hero combo + street (or heuristic topic), score % (or EV lost in
    chips when EV-graded), and **Open in Explorer** for spot rows.
  - Footer: "Due for review: N cards (spaced repetition)" when progress
    is synced (the existing `dueCount`).
- **Open in Explorer**: reloads the question's solve through the existing
  API fetches (`fetchLibrarySolve` / `fetchSampleSolve`), loads it into
  the shared store, then rebuilds the path to the exact node the question
  came from. The node history is recovered from the question's itemKey
  (`nodeHistoryOf`) and replayed against the tree with the same matching
  logic as `lineSteps` (`explorerPathFor` in `lib/quiz.ts`); the new
  store action `setPath` additionally refuses any step that does not
  resolve in the loaded solve. If a step cannot be resolved, the solve
  opens at its root — the link never lands on a wrong node. Heuristic
  questions have no solve/node, so their history rows carry no link
  (the data does not support one). The summary screen's spot rows got
  the same link.

## Deferred / caveats

- **No local typecheck or build**: this VM has no `node_modules` in `ui/`
  and installs/builds are out of lane scope (same caveat as Ship 1). The
  coordinator's gate (tsc + vite build on a host) is the first real
  compile of these commits; brace/paren balance and a full read-through
  were done locally instead.
- The Figma Quiz frame's "Why? →" affordance is not replicated as a
  separate element: the explanation surface is the Explorer's Explain
  panel, reachable via the new Open in Explorer links.
- The Figma Preflop frame's left column shows hand-class groupings
  ("AAxx double suited" style rollups) in the set view; that grouping
  predates this ship and was out of scope — Set view is unchanged.

## Files changed

- `ui/src/lib/preflop.ts` — matrix helpers (cells, filtered total, drill-down rows, rank parsing, suitedness filter table)
- `ui/src/pages/Preflop.tsx` — view toggle, matrix grid + chips + drill-down panel
- `ui/src/lib/quiz.ts` — `nodeHistoryOf`, `explorerPathFor` (no grading changes)
- `ui/src/store/useStore.ts` — `setPath` action (validated deep-link path)
- `ui/src/pages/Quiz.tsx` — stage, FeedbackBanner, SessionRail, TopicBars, Open in Explorer, home topic bars
- `SHIP2-NOTES.md` — this file
