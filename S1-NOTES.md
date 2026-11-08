# S1 — Heuristics Log + Quick Review (ticket notes)

Branch `study-qr-heuristics`, base main `2fcb6a3`. Build-only lane: no
builds were run on the dev machine beyond `node --check` on the .mjs
files (passed). The coordinator verifies on a host (see the battery at
the bottom).

## What was built

### API — new file `api/study.mjs`, wired into `api/server.mjs`

All study endpoints are gated by the existing admin session
(`requireAdmin`), **reads included** — heuristics and review outcomes are
personal data, unlike the public-read library. With auth disabled
(local dev mode) the gate is open exactly like the other writes.

Heuristics (persisted in `DATA_DIR/heuristics.json`):

| Method | Path | Behaviour |
| ------ | ---- | --------- |
| GET | `/api/heuristics` | `{ heuristics: [...] }`, oldest first |
| POST | `/api/heuristics` | Create → `201` + record. `text` required (non-empty, ≤2000 chars) |
| PUT | `/api/heuristics/:id` | Partial update → record; `404` unknown id |
| DELETE | `/api/heuristics/:id` | `200 { deleted: true, id }`; `404` unknown id |

Record shape (unknown input fields stripped; ids server-generated):

```json
{
  "id": "uuid", "text": "…",
  "source": "manual" | "ai-suggested" | "mined",
  "tags": { "texture"?, "street"?, "spot_type"? },
  "linked_spot_ids": ["id", …],
  "status": "active" | "retired",
  "support_n"?, "mean_freq"?, "spread"?,      // only when supplied valid
  "created_at": "…", "updated_at": "…"
}
```

Validation: `source`/`status` are enums; tag values are free strings
(≤60 chars, empty dropped — the server enforces types, not a taxonomy);
`linked_spot_ids` entries must match the ingest id pattern
(`^[A-Za-z0-9][A-Za-z0-9_-]*$`), deduped, ≤200; support stats must be
finite numbers in range (`support_n` non-negative int, `mean_freq` in
[0,1], `spread` ≥ 0); on PUT a support field sent as `null` clears it.

Quick Review outcomes (persisted in `DATA_DIR/study-progress.json`):

| Method | Path | Behaviour |
| ------ | ---- | --------- |
| POST | `/api/study/review-events` | `{ events: [...] }` (≤100/post) → `201 { recorded, total }`; each event stamped with server `recorded_at`; store capped at the newest 10,000 events |
| GET | `/api/study/progress` | `{ total_events, got, missed, sessions, last_session_at, by_street }` |

This is an event log + aggregate only — **no SRS engine** (the Quiz lane
owns spaced repetition, per the ticket split).

Persistence mirrors the queue: in-memory state, saves serialised through
a promise chain, atomic temp + rename, missing/corrupt file starts empty
and is logged. `server.mjs` also gained `PUT, DELETE` in its CORS
`Access-Control-Allow-Methods` (OPTIONS + JSON responses) so the CRUD
works in the credentialed cross-origin deployment too.

### UI

- `ui/src/lib/study.ts` (new) — Heuristic/StudyProgress types + runtime
  guards (same defensive-parsing discipline as `runner.ts`), the
  ReviewCard builder over a parsed solve, and the card "why" generator.
- `ui/src/lib/api.ts` — `fetchHeuristics`, `createHeuristic`,
  `updateHeuristic`, `deleteHeuristic`, `postReviewEvents`,
  `fetchStudyProgress`.
- `ui/src/pages/Heuristics.tsx` (new, replaces the stub) — full CRUD:
  create/edit forms (text, source, texture/street/spot-type tags,
  linked spot ids), filters (status/texture/street/source), retire /
  reactivate, two-step delete. Source badges are visually distinct:
  mined = solid green, AI-suggested = amber outline, hand-written =
  neutral chip. Support stats render **only** when the record carries
  them. Linked spot ids that exist in this service's library render as
  buttons that open the solve in the Explorer; others render as plain
  id chips labelled as not-in-this-library.
- `ui/src/pages/QuickReview.tsx` (new, replaces the stub) — phone-first
  flash cards in a `max-w-[430px]` frame: board + hero hand + spot
  context up front, tap to reveal the solver's per-combo action mix
  (bars), the range aggregate, and the one-line why; Got it / Missed it
  self-grades; ≤10 cards per session with a progress bar + elapsed
  clock; summary screen lists missed cards with the solver's main play.
  Outcomes are POSTed at session end (or on "End session early");
  save failures are reported honestly (401 → "log in to keep your
  history", network → "not saved").
- `ui/src/components/LinkToHeuristic.tsx` (new) + Explorer hook — a
  "Link to heuristic" panel in the Explorer's right column attaches the
  loaded solve's id to a chosen active heuristic. Supporting plumbing:
  the store now tracks `solveId` (`loadRawSolve(raw, name, source, id?)`;
  Dashboard/Solver/SpotPicker pass library/job ids). The bundled sample
  has no id — the panel says so instead of inventing one.
- `ui/src/pages/Stubs.tsx` — QuickReview/Heuristics stubs removed
  (Quiz + Settings stubs remain). `ui/src/App.tsx` imports updated.
- `api/README.md` — endpoint table rows + a "Study layer" section.

## Data-source honesty calls

1. **Deck source order**: newest library solves first (up to 3 solves,
   up to 2 hero combos per decision node, 10 cards per session). Only
   when the library is unreachable/empty/card-less does the page fall
   back to the **bundled sample solve**, and every card + the session
   footer then say "Bundled sample". If the sample also fails, the page
   shows the empty state pointing at the Solver/Runner — no fabricated
   cards anywhere.
2. **The "why" line never claims a per-action EV gap.** The engine
   reports EV per combo for the whole solve only (the Explorer already
   discloses this), so the why is assembled from: the hero combo's
   dominant action + frequency, the *frequency* gap to the runner-up
   action, whether the combo follows or deviates from the node's range
   aggregate, and the combo's whole-solve EV (labelled as such). The
   ticket's "EV gap between best and second action" is not computable
   from engine output today; if per-action EVs ever land, `cardWhy` in
   `lib/study.ts` is the one place to upgrade.
3. **Support stats are pass-through only** — no mining pipeline exists
   yet, so no record created from this UI will carry them unless a
   caller supplies them via the API. The UI renders them verbatim when
   present.
4. Quick Review hero combos are picked deterministically (highest range
   weight at the node) *before* the deck is shuffled — the sample's
   3-combo ranges make early sessions repetitive; that's real data, and
   it improves as the library grows.

## Left out, deliberately

- **Spot-of-the-day / daily queue** (notebook wording for Quick Review):
  sessions are on-demand decks from the current library; a daily-queue
  scheduler belongs with the Quiz/SRS lane's study-queue work.
- **Streak counter** — the stub itself listed it as a V2 item.
- **Node-level heuristic links**: `linked_spot_ids` links solves, per
  the ticket's record shape. Linking a specific node history would need
  a second field; the Explorer panel links the solve.
- No changes to quiz code (none exists) and no shared-file conflicts
  with the parallel Quiz lane beyond `api.ts`/`App.tsx` import blocks.

## Coordinator verification battery

API (server with `ADMIN_PASSWORD_HASH` set + a scratch `DATA_DIR`):

```bash
# unauthenticated: everything study-related is 401
curl -s -o /dev/null -w '%{http_code}\n' $B/api/heuristics            # 401
# log in (cookie jar), then:
curl -s -b jar $B/api/heuristics                                      # {"heuristics":[]}
curl -s -b jar -X POST $B/api/heuristics -H 'Content-Type: application/json' \
  -d '{"text":"Paired boards: check back more nut-heavy hands","tags":{"texture":"paired","street":"flop"},"bogus":1}'
#   -> 201, record has NO "bogus" field, source defaults to "manual"
curl -s -b jar -X POST $B/api/heuristics -d '{"text":"  "}'           # 400 (empty text)
curl -s -b jar -X POST $B/api/heuristics -d '{"text":"x","source":"mined","support_n":12,"mean_freq":0.63,"spread":0.21}'
#   -> 201 with the three support fields stored verbatim
ID=<id from a create>
curl -s -b jar -X PUT $B/api/heuristics/$ID -d '{"status":"retired"}' # 200, status retired, updated_at bumped
curl -s -b jar -X PUT $B/api/heuristics/nope -d '{"status":"retired"}' # 404
curl -s -b jar -X DELETE $B/api/heuristics/$ID                        # {"deleted":true,...}
curl -s -b jar -X POST $B/api/study/review-events \
  -d '{"events":[{"grade":"got","session_id":"s1","street":"river","source":"sample"}]}'  # 201 {recorded:1,total:1}
curl -s -b jar $B/api/study/progress                                  # totals reflect the event
# restart the server: heuristics + progress survive (files in DATA_DIR)
```

UI: `cd ui && npm run build` (tsc + vite). Then click-through:
`/heuristics` logged out → login prompt; logged in → create/filter/
retire/delete round-trip; `/quick-review` with an empty library → cards
from the bundled sample, labelled as sample; finish a session → summary
counts match the grades and (logged in) `/api/study/progress` totals
move; Explorer on a library solve → "Link to heuristic" adds the solve
to the chosen heuristic's supporting spots.
