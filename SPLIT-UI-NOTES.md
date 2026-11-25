# Split-solve Explorer — UI notes (issue #57, item 5)

The Explorer half of split flop storage. The API half (a separate
lane, same contract) serves a flop solve in pieces; this lane makes
those pieces explorable with lazy per-card loading. The API lane's
ingest half is what produces split solves in the first place — until
it ships, no live solve carries the marker, and every surface behaves
exactly as before (see "Zero regression surface").

## The contract consumed

- `GET /api/solves/:id` for a split flop returns a header doc shaped
  exactly like an ordinary solve doc (board, starting_pot,
  effective_stack, iterations, locks, exploitability, oop_evs,
  ip_evs) whose `nodes` array contains ONLY the flop-street nodes,
  plus `"split": { "format": 1, "turn_cards": ["As", ...] }`.
- `GET /api/solves/:id/turn/<card>` returns
  `{ "turn_card": "<card>", "nodes": [...] }` — that card's turn +
  river decision nodes, in the same node shape as a solve doc, with
  full histories (`{flopLine}|t:{Card}/...`, river roots at
  `...|r:{Card}`), matching how the engine names flop subtrees.

## Design as built

Additive layers over the existing model; solveTree's core walking is
untouched for whole-tree docs.

**Model (`lib/solveTree.ts`)**
- `parseSolve` reads the marker defensively (format 1 + a non-empty
  string array) into `SolveData.split: SplitInfo | null` —
  `{ turnCards, loadedCards: Set }`. Non-split docs get `null`.
- `nodeLookupState(data, history)` is the three-state lookup the
  brief requires: `present` (indexed), `unloaded-card` (the history's
  `|t:` segment names a card of this solve that has not been
  fetched), `absent`. The card is derived from the history itself via
  `historyTurnCard`, never from node fields.
- `resolveStep` gains one variant, `split-runout`: at a flop-street
  node, a non-Fold action whose child is absent and for which no
  loaded turn subtree root exists closed the street, but there are
  no options to offer yet — so it returns the header's card list and
  lets the caller drive the load. The flop-street guard matters: a
  TURN node inside a grafted card closing to the river must resolve
  through the normal `|r:` scan, never as a split branch (pinned by
  a test). Fold is excluded because a fold never deals a card.
- `graftTurnNodes(data, card, payload)` validates the whole payload
  first (`parseTurnPayload`: right card echoed, non-empty nodes,
  every node carrying history/player/actions/strategy, and every
  node's own `|t:` segment naming THIS card — one card's fetch can
  never graft into another's subtree), then indexes the nodes with
  the same normalisation `parseSolve` uses and marks the card
  loaded. Malformed payloads change nothing. Idempotent.

**Loader (`lib/splitSolve.ts`)**
- `TurnCardLoader` wraps a fetcher (injectable for tests; the app
  singleton calls `api.fetchSolveTurn`). `ensureCard` dedupes
  concurrent triggers per (solveId, card) through an in-flight map,
  resolves true once the card is grafted (or already was), and
  resolves false — caching NOTHING — on a network error or a
  malformed payload, so the next trigger retries cleanly.
- `prepareSplitForQuiz(data, solveId, loader?, rng?)` picks ONE
  random unloaded card and ensures it; used by the Quiz (below).

**Store (`store/useStore.ts`)**
- New state: `pendingTurnCards { baseHistory, cards }` (the
  unloaded cards offered at the outstanding chance node, alongside
  any loaded `pendingRunout` options for the same base) and
  `turnCardLoad { card, status: 'loading' | 'error', error }`.
- `chooseAction`: a `runout` step at a turn chance node merges the
  still-unloaded cards into `pendingTurnCards`; a `split-runout`
  step sets it directly. Every other navigation (action, runout
  pick, goToStep, resetPath, setPath, new solve) clears both fields.
- `chooseSplitRunout(card)`: sets the loading state, awaits the
  loader, then advances the path into the grafted subtree root
  (`{base}|t:{card}`). Two stale-completion guards: the solve object
  must be unchanged, and this load must still be the current one
  (any navigation clears it) — a late fetch grafts into the model
  cache but never moves a line the user has since walked away from.
  If the payload loaded but this line has no root under the card
  (an all-in close deals the card with no decisions left), the line
  ends with the existing terminal affordance instead of a crash.
- `loadTurnCard(card)`: the quiet programmatic variant (no
  navigation, no banner) for callers about to point the path into a
  card; bumps the solve reference on graft so subscribers re-render.

**Explorer (`pages/Explorer.tsx`)**
- The existing CardPicker offers loaded options + unloaded cards
  together (same enabled-cards mechanism); its caption changes for
  split solves to say a pick fetches that part of the tree. Picks
  route by membership: loaded → `chooseRunout`, unloaded →
  `chooseSplitRunout`. Random does the same over the merged list.
- While a card loads, an inline banner in the centre panel (the
  dismissed-picker banner's own styling) reads "Loading the {card}
  turn — fetching that part of the tree…". On failure the same
  banner pattern carries the error with **Retry** (re-runs the pick)
  and **Pick a different card** (clears the load state, reopens the
  picker). The current node and every loaded surface stay rendered
  throughout — no blank screen, no spinner takeover.
- The NodeStrip's dashed "pick a card" trailing card and the
  dismissed-picker prompt key off the merged chance state, so they
  behave identically for split and whole solves.

**Surfaces (matrix / table / ranges / rails / blockers)**
- No changes. They consume the current node + path, which by
  construction only ever contain loaded nodes: you cannot navigate
  into an unloaded card except through the pick-to-load flow, and
  every path ancestor was loaded before it could be walked. Nothing
  fabricates strategies for unloaded nodes — an unloaded card's
  content simply does not exist in the model until grafted.

**Trainer / quizzes (`pages/Quiz.tsx`)**
- Both question-generation paths (the general library pool and
  `questionsForSolve` for spot drills) run `prepareSplitForQuiz`
  after parsing a split doc: ONE random turn card is fetched, then
  `collectSpotQuestions` — which only ever iterates the loaded
  index — builds from the flop street + that card. A failed fetch
  still yields the flop-street questions.
- "Open in Explorer" for a question from a grafted card: after
  loading the header doc it reads the card out of the question's
  history and `loadTurnCard`s it before rebuilding the path, so the
  deep link lands on the exact node instead of the root fallback.

## States a user can see

1. Whole solve, or split solve on the flop street: identical to today.
2. Flop street closes, no card loaded yet: the card picker opens
   listing every available turn card (all of them are "in this
   solve" — some are just not downloaded yet; the caption says so).
3. Pick an unloaded card: picker closes, loading banner shows; the
   flop node and its surfaces remain on screen.
4. Load succeeds: the line advances into the turn subtree; walking
   (matrix/table/ranges/rails, river runouts inside the card) is
   indistinguishable from a whole solve. The card is cached — coming
   back to this chance node later offers it as a normal option.
5. Load fails: error banner with Retry / Pick a different card. The
   line has not moved; nothing is half-loaded.
6. Mixed state: some cards loaded (offered as instant options),
   others not (offered as fetch-on-pick) — both in the same picker.

## Zero regression surface

Docs without `split` take the exact existing path: `split` parses to
null, `resolveStep` never returns the new variant (its branch
requires split data), the store's new fields stay null, the picker
merge adds nothing, and the Quiz preparation is a no-op. The split
handling lives in one new lib file, one new StepResult variant, two
store fields, and the picker's merged list — no core walking code
was rewritten.

## Deliberately left for a follow-on

- **No preloading**: neighbouring cards are not speculatively
  fetched. One fetch per card, only on demand — the right default
  while each card payload is sizeable; revisit with real sizes.
- **No persistence of the graft cache** across solve loads: leaving
  and reopening a split solve re-fetches cards as needed (the
  session cache is per loaded solve, in the model object).
- **Deep links into unloaded cards from outside the Quiz** (e.g. a
  future shared link naming a turn node) still open at the root via
  the existing unresolvable-path fallback; `loadTurnCard` is the
  building block a follow-on can wire into those entry points.
- The Explorer header still describes a flop solve as "(flop + turn
  + river tree)" — true of the solve, if not of the bytes loaded so
  far. A "loaded in parts" indicator belongs with the API lane's
  library-row treatment, not snuck into this lane.

## Gate checklist

- [ ] UI suites (esbuild bundle → `node --test`): the new
      `tests/split-solve.test.ts` (lookup states, split-runout step,
      one-fetch dedupe, graft navigability incl. the river chance
      node inside a card, failed-fetch retry, malformed-payload
      rejection, quiz preparation scoping) plus the existing suites
      (nodelocks, sampled, preflop-stack) unchanged and green.
- [ ] UI build (`tsc --noEmit && vite build`) green.
- [ ] Non-split regression: open the bundled sample and one ordinary
      library turn/river solve; walk lines, open the picker at a
      chance node — byte-for-byte the old behaviour.
- [ ] **Live click-through (needs the API lane's split build live)**:
      open the real Ts9h8d flop (job 457c60e8, Nash 0.364%) in the
      Explorer; check–check the flop; in the picker choose a turn
      card and confirm (a) the loading banner appears, (b) exactly
      ONE network fetch to `/api/solves/457c60e8/turn/<card>` fires,
      (c) the turn subtree renders real strategies in Strategy and
      Matrix. Step back, close the flop again, pick a DIFFERENT turn
      card — one more fetch, strategies render. Pick the FIRST card
      again — no fetch (cached). Walk inside a card to a river
      runout and confirm the river picker works from grafted nodes.
- [ ] Failure path: with the API unreachable (or a card request
      blocked), pick an unloaded card — the error banner offers
      Retry and Pick a different card, the flop node stays rendered,
      and Retry succeeds once the API is back.
- [ ] Quiz: build a session/drill from the split flop — questions
      include turn-street spots from exactly one card; Open in
      Explorer on such a question lands on its node, not the root.
