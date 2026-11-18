# Starting Hands Study — build notes (lane: preflop-study, base d1c9e00)

A new in-app study mode for preflop starting hands, built around
Justin's heuristics. Route `/starting-hands`, nav entry "Starting
Hands" between Quiz and Heuristics. Presentation deliberately mirrors
the Ship 2 Quiz trainer: green stage, instant-feedback banner,
session rail (hands / accuracy / streak / per-position bars /
history), summary screen. Single column with big action buttons on
phone, stage + 340px rail on desktop.

## Flow

1. **Setup** — pickers for table size, rake variant, spot
   (First-in / vs open defense), position, and opener (defense only).
   Every picker is derived from the loaded set index: only sizes,
   variants, spots, positions and openers that actually have sets are
   offered. Known-but-absent variants (e.g. Raked when only no-rake
   sets exist) render as disabled pills labelled "· none yet" with a
   caption — the picker never invents a variant. Below the pickers: the
   chosen set's summary (label, CONSTRUCTED badge, combo-weighted
   action totals, stack depth, rake classification, the set's own
   `rake_note`) and the heuristic cards for the spot.
2. **Drill** — 12-hand sessions. Each card draws a hand class from the
   set weighted by class multiplicity (due SRS classes lead the
   session, see Persistence). The stage shows the hero hand (the class
   key IS a concrete representative combo — parsed with `parseCombo`
   and rendered with `CardRow`), the context line ("BTN — folded to
   you", "BB — facing a CO open", "SB — first in from the small
   blind"), size/variant/stack chips, and class-table feature tags
   when the table is loaded. The action menu is the set's own
   (Raise/Fold for first-in sets; Fold/Call/3-bet for defense sets;
   SB-play sets use their fold/raise menu).
3. **Feedback** — instant banner in the Quiz trainer's shape: verdict
   glyph + "this range takes it X% with this hand", a
   "FREQUENCY MATCH · CONSTRUCTED RANGE" chip, the class's FULL action
   split ("Raise 82% / Fold 18% in this range"), the grading
   explanation, and — after a miss — the heuristic for the spot. The
   action buttons stay visible, disabled, each showing its frequency
   and bar, with "your pick" / "range's main line" markers.
4. **Summary** — per-hand rows (class, pick, frequency taken, grading
   label), average score, restart on the same range or back to setup.

## Data sources (and only these)

- `GET /api/preflop/index` + `GET /api/preflop/sets/:id` via the
  existing fetchers in `ui/src/lib/api.ts`; types from
  `ui/src/lib/preflop.ts` (read-only — that file and `Preflop.tsx`
  were NOT edited, per lane rules). Set documents carry per-class
  action frequencies; all grading numbers come from them.
- `GET /api/preflop/class-table.json` for multiplicities (exact combo
  weights), feature tags, and within-group stats. If it fails to load
  the drill still runs: multiplicity falls back to the suit-orbit
  count computed from the class key (`multiplicityOf`), feature tags
  and the feature heuristic card switch off, and the setup summary
  says so.
- A class whose key does not parse into four distinct cards is
  excluded from the pool — never rendered from invented cards. (All
  16,432 keys in the current data parse; the guard is for future
  data.)
- Rake variant: read defensively in `variantOfSet` — explicit `rake`
  field on the index entry first, then the set id (generated ids
  embed e.g. `norake`), then the document's `rake` field, then its
  free-text `rake_note`. Today's v1 index carries no rake field, so
  at index level v1 sets honestly classify as "Rake not stated"; once
  a set document loads, its note ("no rake modelled in construction")
  classifies it no-rake and the summary/drill show that, noting when
  it came from the document rather than the index. When the parallel
  preflop-library lane lands explicit `rake` fields / raked sets, the
  picker picks them up with no code change.
- 8-max cannot appear yet: `lib/preflop.ts` types `TableSize` as
  `'6max' | '9max'` and that file is another lane's this week. The
  size picker derives from the index, so 8-max sets surface
  automatically once the data layer admits them.

## Grading copy (honesty)

Frequency match, exactly the Quiz trainer's frequency mode: the score
is the frequency with which the constructed range takes the picked
action with that exact class; bands reuse the Quiz thresholds
(solid ≥ 0.85, partial ≥ 0.4). The banner, the setup intro and the
grade detail all name it: "Graded by frequency match against a
constructed range… These ranges are built from hand features and
equities (constructed, not solver output), so no EV-loss figure
exists or is shown." The CONSTRUCTED badge (`ApproximationBadge`)
sits on the setup summary and the drill header. Nothing anywhere
calls this GTO or solver output.

## Heuristics — seeding, surfacing, saving

- **Seeded starters** are generated at runtime from the loaded set
  (`seededHeuristics` in `lib/preflopStudy.ts`), never hand-written
  numbers: card 1 is the range shape (combo-weighted totals, e.g.
  "BTN first-in: this constructed range raises 49% of all combos and
  folds the rest." plus a width-guidance sentence whose thresholds are
  presentation, not data); card 2 (class table only) reports how pairs
  vs no-pair rundowns take the set's main continuing action, with
  within-group rates computed from `pairRankSummary`. Cards are badged
  "SEEDED STARTER · FROM THIS SET".
- **After a miss**, the feedback banner shows the spot's heuristic:
  Justin's own matching log entry if one exists, else the seeded
  shape card (with its Save button).
- **Save to my heuristics** writes the card text through the existing
  study API (`POST /api/heuristics`, `createHeuristic`) with
  `source: 'manual'` and tags `{ texture: 'preflop', street:
  'preflop', spot_type: 'starting-hands <POSITION> <first-in|vs-open>' }`
  — the only tag keys the study store accepts. `linked_spot_ids` is
  empty: set ids contain dots, which the store's spot-id pattern
  rejects. On success the saved entry immediately joins the personal
  list (badged "FROM YOUR LOG"). When signed out, the button is
  replaced by a "Sign in (admin) to save" note; when the study
  endpoints are unreachable, saving is off and the cards say so.
- **Personal surfacing**: log entries whose tags mention `preflop` or
  `starting-hand` (any of texture/street/spot_type) are candidates;
  position matching is token-based (a rule tagged for another specific
  position is excluded; untagged-position rules count as general).
  Position match outranks spot-type match; top 3 show in the rail.

## Persistence — what syncs, what is session-only

Checked `api/quiz.mjs` before deciding: topics there are free-form
strings (`<texture>|<street>|<spot_type>`, each ≤60 chars), so
per-position preflop topics fit the existing store cleanly. The one
misfit was the item-kind whitelist, so the single minimal API change
in this lane is:

- `api/quiz.mjs`: `ITEM_KINDS` gains `'preflop'` (plus a header
  comment documenting the key/topic shapes). Client types widened to
  match (`ui/src/lib/api.ts` `QuizAnswerRecord.kind`,
  `ui/src/lib/quiz.ts` `QuizItemState.kind` + its progress parser,
  which previously would have coerced preflop items to 'spot').

With that, when signed in, every answer records
`{ item_key: 'preflop|<set id>|<class key>', kind: 'preflop',
topic: { texture: 'preflop', street: <position>, spot_type:
'first-in' | 'vs-open' }, score, grading: 'frequency' }` — so
per-position accuracy persists in topics and per-class spaced
repetition runs on the standard ladder; due classes lead the next
session on that set. Side benefit: these topics also render in the
Quiz trainer's topic bars (labelled "preflop · BTN · first in").
When signed out or the API is unreachable, answers record into
session-local topics only and the rail says "This device only".

Session-only by design: the 12-hand queue, the in-session miss
re-queue (a missed class returns once before the session ends, on top
of its SRS record — same "lite" behaviour as the Quiz trainer), and
streak/history displays.

## Files changed

- `ui/src/pages/StartingHands.tsx` (new) — the page: setup, drill,
  feedback, rail, summary.
- `ui/src/lib/preflopStudy.ts` (new) — selection facets + variant
  detection, action menu, drill pool + weighted draw, grading, seeded
  heuristic generation, personal-heuristic matching, topic helpers.
- `ui/src/App.tsx` — nav entry + route for `/starting-hands`.
- `api/quiz.mjs` — `'preflop'` item kind + documenting comment.
- `ui/src/lib/api.ts` — `QuizAnswerRecord.kind` widened.
- `ui/src/lib/quiz.ts` — `QuizItemState.kind` widened; parser
  preserves `'preflop'`.
- `PREFLOP-STUDY-NOTES.md` — this file.

No `engine/` changes; `ui/src/lib/preflop.ts` and
`ui/src/pages/Preflop.tsx` untouched.

## Data gaps / follow-ups

- No raked sets and no index-level `rake` field exist yet (parallel
  lane is building them); the variant picker is honest about it
  today and needs no change when they land.
- 8-max blocked on the data layer's `TableSize` type (other lane).
- `vs_three_bet` continuation sets are deliberately not drilled —
  they are not a starting-hands spot; the two spot types are
  first-in and vs-open defense, per the brief.
- First compile happens at the host gate (`tsc --noEmit && vite
  build`) — this lane ran no builds per the VM rules.
