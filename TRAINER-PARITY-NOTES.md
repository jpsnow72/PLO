# Trainer parity — rebrand slice 10 (issue #22)

Reference: GTO Wizard Trainer captures gtw2-f52..f70, f84, f85
(2026-11-17 capture pass 2) + the slice-10 section of
`files/rebrand-gap-analysis-2026-11-17.md`. Boundary held throughout:
layout patterns and poker-standard vocabulary only — none of their
data, text, or artwork. Their gamification/upsell framing (Insider
Program, subscription prompts) is omitted silently, by design.

Grading semantics are EXACTLY as before this slice: frequency match
for spot questions, recall for heuristic questions, EV mode dormant
until a solve carries per-action EVs (issue #8). Nothing in this
slice touches the grader, the SRS ladder, or what gets persisted per
answer.

## Per capture

| Capture | Surface | Verdict |
| --- | --- | --- |
| f52 | Trainer landing: preset cards, TRAINER / HISTORY / STATS menu | ADDED as the Quiz home tab bar (Train / Drills / History / Stats) + drill cards. Their preset cards are Cash / MTT fundamentals; ours are derived from our own data (Mixed, Due, by street, by spot type, by topic, preflop groups). MTT omitted — this is a heads-up cash tool with no MTT data. |
| f53–f61 | Configure Training: Solutions / Board / Gameplay / Categories / Mistake Cost / EV Buckets / Hero Cards / Suits / Custom tabs | OMITTED as a separate config screen: our drills *are* the configuration — each drill card is a one-click configured session, and a session can be saved as a drill. The filters our question data genuinely supports are topic / street / spot type. Categories filtering is not offered (quiz questions carry no category tags); Mistake Cost and EV Buckets filters wait on #8; Hero Cards / Suits filters are not offered (questions are dealt from the node's range, not filtered by hero cards). |
| f62 | Live session | HAVE (unchanged). |
| f63/f65 | Instant feedback with correct action + EV loss | HAVE (feedback banner from redesign Ship 2). The EV-loss figure in feedback waits on #8 — the grader's EV mode already exists and stays dormant. |
| f64 | Second spot in session | HAVE. |
| f66 | Stop Session dialog: hands, accuracy, avg EV loss/100, Save as drill | ADDED in substance on the results screen: hands, accuracy, solid/partial/miss split, and Save as drill. Avg EV loss joins the summary line only when the session actually contained EV-graded answers (same rule as the session rail). No mid-session stop dialog — sessions are ≤12 hands and the summary is one click past the last one. |
| f67 | Hand History by date, per hand: cards, action taken, EV loss | ADDED as the History tab: most recently graded items from synced progress (cards, topic, latest score, grading mode, attempts, date, due badge). Two honest differences, stated in the UI: the progress store keeps each item's latest grade, not the action picked, so rows show the grade rather than the pick; EV loss is not stored (waits on #8). |
| f68 | Hand detail: evaluation, action sequence, Study + Practice links | PARTIAL: History rows carry **Open in Explorer** (the Study equivalent — reloads the solve and replays the path to the exact node) and **Practice again** (a spot drill on that node). The inline evaluation/action-sequence panel is omitted: the line lives in the Explorer, one click away, and duplicating it here would fork the path-replay code. |
| f69 | Stats: volume, accuracy split (Correct/Inaccurate/Mistake/Blunder), avg EV loss per 100 moves/mistakes | ADDED as the Stats tab: graded answers, items in rotation, due now, overall accuracy, by street, by topic. The band split is per-session only — progress stores score totals per item, not a band histogram — and the tab says so. Avg EV loss stats wait on #8. |
| f70 | Stats by position | PARTIAL: postflop topics record street + texture, not the seat played, so no postflop by-position table is shown (stated in the UI). Preflop topics *do* record position, so a preflop-by-position accuracy table is shown. |
| f84 | Practice This Spot | ADDED — see the hand-off design below. |
| f85 | Drills: saved training setups, search, Create Drill | ADDED: Your drills (saved setups) + the derived drill catalogue. Save flow is f66's (save from the results screen). Search is omitted — the saved list is personal and short; noted here rather than placeholdered in the UI. |

## Practice This Spot — hand-off design

The Explorer's node header gains a **Practice this spot** button
(disabled when the node has fewer than 2 actions, or when the loaded
solve has no reloadable id). It writes a `TrainerFocus`
(`{kind: 'spot', solveId, solveName, solveSource, history}`) into the
shared store's new `trainerFocus` slot and navigates to `/quiz`.

The Quiz consumes the focus exactly once, when its home phase first
renders (a ref guards re-entry; the store slot is cleared on
consumption, so a stale focus can never re-fire). A spot focus loads
its own solve by source — library via `fetchLibrarySolve`, job via
`fetchJobResult`, sample via `fetchSampleSolve` — generates that
solve's questions with the existing `collectSpotQuestions`, filters
to the node's history, and starts a session that cycles the node's
combos (reshuffled each pass) up to 10 hands. No second drill engine:
focused sessions are ordinary session entries flowing through the
same submit/persist/repeat-on-miss path as a mixed session.

To make job solves drillable, `SpotQuestion.solveSource` (and
`SpotSource.source`) gained `'job'`, and the Quiz's Open in Explorer
gained the matching `fetchJobResult` branch. Labels for job-sourced
questions read "your solve (job)".

## Drills library

- **Derived catalogue** (`ui/src/lib/drills.ts`): street drills,
  spot-type drills, and per-topic drills counted from the questions
  the trainer actually loaded; topic drills sort weakest-first when
  synced accuracy is known. Preflop groups come from the real
  range-set index (`studySetOptions` grouped by table size + spot
  kind) and launch the Starting Hands page preselected on the group's
  first set, via the store's `preflopDrillSetId` slot (consumed and
  cleared by Starting Hands once its option list resolves the id —
  all five picker facets are set from the real study option).
- **Thin-library honesty**: when every loaded spot question comes
  from the bundled sample, the Drills tab says so in plain terms —
  the 300-spot library is unsolved, so the catalogue is short by
  reality. No catalogue entries are fabricated to fill the grid.
- **Saved drills**: a focus + a name, persisted in localStorage on
  this device (there is no server-side drill store). A saved drill
  stores the setup only; launching re-derives questions from whatever
  solves load at that moment. Saving is offered on the results screen
  of any focused session. A saved spot drill whose solve/node no
  longer resolves reports that instead of starting empty.

## History & Stats data sources

Both tabs read the existing synced quiz progress (`GET
/api/quiz/progress`): items (per-item attempts, last score, last
grading mode, last/due timestamps, topic) and topics (attempts +
score sums). Signed-out or offline, the tabs explain that history and
stats live with synced progress rather than showing session-local
inventions. No API or progress-schema change was needed — and none
was made: the surfaces deliberately fit what the store already
records, and say what it doesn't.

## What waits on #8 (per-action EVs)

- EV-loss figures in feedback (grader EV mode already built, dormant).
- Avg EV loss in the session summary as a standing element, EV-loss
  stats (per 100 moves / per 100 mistakes), EV loss in History rows.
- Trainer filters by Mistake Cost and EV Buckets.
- EV-weighted anything in drills (drill ordering is by accuracy and
  due-ness only).
