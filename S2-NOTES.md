# S2 — Quiz Trainer + AI Explain-Why panel (build-only lane notes)

Branch `study-quiz-explain`, base main `2fcb6a3`. Built by the S2 lane;
nothing was built/run on the build machine beyond `node --check` on the
API files (the UI has no `node_modules` in this tree, so `tsc` could not
run — see "Coordinator verification" below).

## Files changed

New:
- `api/quiz.mjs` — quiz progress store (SRS ladder + per-topic accuracy),
  persisted to `DATA_DIR/quiz-progress.json`.
- `ui/src/lib/quiz.ts` — question generation, line reconstruction,
  grading, progress types/parsers.
- `ui/src/lib/heuristics.ts` — defensive types/parsers for the S1
  heuristics API.
- `ui/src/lib/explain.ts` — deterministic node explainer.
- `ui/src/components/ExplainPanel.tsx` — Explorer "GTO Insight &
  Rationale" panel with the candidate-heuristic save flow.
- `ui/src/pages/Quiz.tsx` — the Quiz Trainer (replaces the stub).
- `S2-NOTES.md` — this file.

Changed:
- `api/server.mjs` — `GET /api/quiz/progress` + `POST /api/quiz/answer`
  routes (both behind `requireAdmin`), store created + loaded at
  startup, header comment updated.
- `api/README.md` — endpoint rows + a "Quiz progress (S2)" section.
- `ui/src/lib/api.ts` — `fetchHeuristics`, `createHeuristic`,
  `fetchQuizProgress`, `recordQuizAnswer` (all defensive-parsed).
- `ui/src/pages/Explorer.tsx` — Explain panel mounted in the right
  column under Hand detail, per the approved design.
- `ui/src/pages/Stubs.tsx` — `QuizPage` stub removed.
- `ui/src/App.tsx` — `/quiz` now imports the real page.

## Grading honesty design (the important part)

The engine's solve JSON stores, per decision node, each combo's action
**frequencies**, plus one **whole-solve** EV per combo. It does **not**
store per-action EVs at a node. Therefore the EV cost of a quiz answer
at a node **cannot be computed from today's data**, and this build never
shows one. The grader (`gradeSpotAnswer` in `ui/src/lib/quiz.ts`) has
two modes and always reports which fired, in code and in UI copy:

- **`frequency`** — the mode that fires for every solve the current
  engine produces. Score = the frequency with which the solver takes
  the chosen action with the exact combo asked about (0..1). The result
  panel and the quiz home both say, in plain words, that grading is by
  frequency match and *why* no EV-loss figure is shown.
- **`ev`** — fires only when a solve node carries a per-combo
  per-action EV table (`combo_action_evs`, a hypothetical future engine
  field, read defensively and alignment-checked). Score = EV lost vs
  the combo's best action, mapped linearly: 0 chips lost → 1.0, a loss
  of 25% of the pot → 0 (`EV_SCORE_SPAN_POT_FRACTION`). No shipped solve
  has this field, so this path is dormant until the engine grows it.
  The 25%-of-pot span is a stated, arbitrary-but-documented mapping,
  not a measured constant.

Heuristic questions grade as **`match`** (picked the heuristic tagged
for the spot type, or not) — labelled "recall" in the UI; no solver EV
is implied. Every recorded answer stores its `grading` mode server-side
so the history cannot be misread later.

Score bands feed the SRS ladder: ≥ 0.85 "solid", 0.40–0.85 "partial",
< 0.40 "miss" (`bandForScore`, mirrored in `api/quiz.mjs`).

## SRS ladder (api/quiz.mjs)

Intervals in days by level: `[0, 1, 2, 4, 7, 15, 30]`.

- solid (≥ 0.85): level +1 (capped), due at now + interval[new level].
- partial (0.40–0.85): level unchanged, due in 1 day.
- miss (< 0.40): level resets to 0, due **immediately**; the client
  also re-asks a missed item once at the end of the same session.

Item keys: spot questions `"<solveId>|<node history>|<combo>"`;
heuristic questions `"heuristic|<heuristic id>"`. Topic key:
`"<texture>|<street>|<spot_type>"`, where texture = the primary board
family at the node (`boardFamilies` order: paired, flush-heavy,
connected, dry), street = the node's street, spot_type = `facing-bet`
(to_call > 0) or `first-to-act`. Per-topic accuracy (mean score) is
shown as chips on the quiz home, weakest first, amber below 70%.

Persistence: `DATA_DIR/quiz-progress.json`, atomic temp+rename writes
serialised through a promise chain (same pattern as the queue), corrupt
or missing file starts empty. Both endpoints require the admin session
(`requireAdmin`); signed-out clients get 401 and the quiz runs with
session-local tallies only, saying so.

## Question generation

- **Spot questions**: every (node, combo) pair in a loaded solve where
  the node offers ≥ 2 actions and the combo is live (frequency row sums
  to ~1). Sources: library solves via `GET /api/library` +
  `/api/library/:id` (capped at 12), plus the bundled sample solve —
  always attempted, always labelled "bundled sample". Unparseable or
  unloadable solves are skipped, never replaced with invented content.
  If nothing loads, the home view shows an honest empty state.
- **Line context**: `lineSteps()` replays the node's `history` against
  the tree, matching each token to the action label of the node it was
  taken at, so the acting player shown is the node's own `player`
  field. Chance segments render as "Turn card · As" etc. Unresolvable
  steps truncate the line rather than guessing.
- **Heuristic questions**: "which heuristic applies here?" — active
  heuristics only (`status === 'active'`), needs ≥ 2 to run. Context is
  a real loaded spot matching the heuristic's tags (street + texture +
  spot_type) when one exists; otherwise the context is the tag
  description itself and says no matching solved spot is loaded.
  Options: the matching heuristic + up to 3 others, shuffled.
- **Endpoint defence**: `GET /api/heuristics` is parsed tolerantly
  (bare array or `{ heuristics: [...] }`; entries without id/text are
  dropped). On 404/network error the quiz states heuristics quizzes are
  unavailable and runs on solver spots only; on 401 it says the log
  needs an admin sign-in.

## Explainer factor list (ui/src/lib/explain.ts)

Each factor names its computation. Nothing else is claimed.

| Factor | Computed from |
| --- | --- |
| Dominant line | `aggregateFrequencies` (strategy rows weighted by range weights): argmax action + share |
| Mix concentration | the dominant share, banded (≥ 0.9 / ≥ 0.6 / ≥ 0.4 / below) into plain wording |
| This hand | the selected combo's own strategy row: its argmax action/share, agreement with the range's dominant action |
| This hand's solve EV | `comboEv` — whole-solve per-combo EV, explicitly labelled whole-solve |
| Range EV (whole solve) | `rangeEv` for OOP/IP from `*_evs`; shown only when the split exceeds 0.005 chips, labelled solve-level |
| Price being offered | `node.pot` / `node.to_call` arithmetic (break-even equity when facing a bet) |
| Blockers | selected combo's cards vs the opponent's weight-table combos: count + weight share removed |
| Accuracy | `exploitability.nash_distance_pct` of the loaded solve |

Explicitly **not** computed, because the stored data cannot support
them: per-action EV gaps at the node, hand-strength/nut-share (no
evaluator ships in the UI), equity-vs-range for a specific combo.

The candidate heuristic follows the spec format with the dominant
share as the measured factor, e.g. "On paired boards in on the river,
facing a bet of 75, Bet 75 is favoured because the solver takes it
with 62% of this range (measured at this node of a solve certified to
0.123% Nash)." It is badged CANDIDATE (amber, via `ApproximationBadge`)
with copy stating it is a pattern from one node. "Save to heuristics"
POSTs `{ text, tags, linked_spot_ids: [], source: "ai-suggested" }`.

## Gaps left, and why

1. **`linked_spot_ids` is always empty on save.** The Explorer store
   (`useStore.loadRawSolve`) does not retain the library item id of the
   loaded solve — only its display name and source. Rather than invent
   an id, saves send an empty list. Follow-up: thread the library id
   through `loadRawSolve` (SpotPicker and Solver already know it).
2. **EV grading is dormant** until the engine emits per-action EVs
   (the known engine gap already noted in the Explorer). The code path,
   labels and score mapping are in place and unit-reviewable.
3. **Quick Review and Heuristics pages remain stubs** — sibling
   tickets (S1 builds the heuristics page + API; Quick Review is S3 in
   the parent plan). The Quiz consumes the S1 endpoint defensively in
   the meantime.
4. **Progress requires the admin session.** By design (personal study
   state under the one login). Signed-out use still works session-local.
5. **Texture for a node uses the board as it stands at that node**;
   `boardFamilies` returns the first matching family in its fixed order
   as "primary". A board can be both paired and flush-heavy; the topic
   records only the primary. Documented here rather than hidden.
6. No client-side tests were added (this repo's UI has no test runner
   configured); the pure modules (`quiz.ts`, `explain.ts`, `quiz.mjs`)
   are written to be testable as-is.

## Coordinator verification steps

1. API syntax + smoke (already `node --check`-clean):
   - `node api/quiz.mjs` is imported by `server.mjs`; start the server
     with a scratch `DATA_DIR`, no `ADMIN_PASSWORD_HASH` (dev mode):
     - `GET /api/quiz/progress` → `{ items: {}, topics: {}, intervals_days: [0,1,2,4,7,15,30] }`
     - `POST /api/quiz/answer` with
       `{"item_key":"sample|root|Ts 9s 3c 4c","kind":"spot","topic":{"texture":"flush-heavy","street":"river","spot_type":"first-to-act"},"score":0.2,"grading":"frequency"}`
       → 200; item level 0, `due_at` ≈ now (miss → immediate); topic
       `flush-heavy|river|first-to-act` attempts 1.
     - Repeat with `score: 0.95` → level 1, `due_at` ≈ +1 day.
     - Malformed bodies (bad kind, missing score, oversized item_key)
       → 400. With a password hash set and no session → 401 on both.
     - Restart the server → progress survives (file persisted).
2. UI build on the verify host: `cd ui && npm install && npm run build`
   (runs `tsc --noEmit` first) — must be clean.
3. UI behaviour against the smoke server + bundled sample:
   - `/quiz` loads in sample mode; home shows > 0 spot questions from
     "Bundled sample river solve", heuristics card says unavailable
     (endpoint 404) unless S1 has landed.
   - Answering a spot question shows frequency bars, the
     "Graded by frequency match" badge and the honesty text; a miss
     re-appears at the end of the session; the summary lists
     "frequency-match grading".
   - `/explorer` (sample loaded): the "GTO Insight & Rationale" panel
     shows the dominant line, factors and a CANDIDATE-badged heuristic;
     selecting a combo in the grid adds "This hand" / "Blockers"
     factors. With S1 absent, the save area shows the
     "heuristics service is not running" note and no enabled button.
   - With S1 present: save posts the candidate; the entry appears in
     `GET /api/heuristics` with `source: "ai-suggested"`, and active
     saved heuristics start appearing as quiz questions.
