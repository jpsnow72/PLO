# Preflop Stack dimension — Stack pill + selection partition (PLO issue #29, lane notes)

Branch `preflop-stack-pill`, base main `785beb9`. Build-only lane:
nothing was compiled or run on this VM (no cargo/npm/test execution
here by rule). The coordinator gates on the VPS (UI build + the test
suite route below).

## Problem

`groupSets` on the Preflop page selected by (table, rake, position,
context) with no stack dimension. The 19 deep200 no-rake 6-max sets
(`stack_bb: 200`, shipped by #28) share every one of those facets
with the v1.2 100bb no-rake sets, so each slot existed twice and
first-match selection resolved to whichever the index listed first —
the exact failure the v1.2 rake filter fixed for the rake dimension.

## What changed

| File | Change |
|---|---|
| `ui/src/lib/preflop.ts` | `DEFAULT_STACK_BB` (100), `stackOf()` (missing/non-finite → 100), `stacksIn()`, `resolveStack()` (availability fallback), pure `selectGroupSets()` carrying the filter order, `stack_bb` made optional on `PreflopSetIndexEntry`/`PreflopSetDoc` + guards relaxed to match, `setLabel` gains the stack tag. |
| `ui/src/pages/Preflop.tsx` | Real Stack pill row replacing the #26 static display chip; `stack` state (default 100bb); per-(table, rake) stack options; keep-valid fallback effect; `groupSets` now delegates to `selectGroupSets`; set header reads `stackOf(setDoc)`. |
| `ui/src/lib/preflopStudy.ts` | `StudySetOption.stack` (= `stackOf(entry)`); `DEFAULT_STUDY_STACK` exported (= 100). |
| `ui/src/pages/StartingHands.tsx` | Stack facet in the setup cascade: `stack` state, `stacksFor` options, Stack PickerRow, stack term in the spot/position/opener/chosen-option filters, keep-valid effect defaulting to 100bb, drill hand-off pins the handed-off set's stack; doc/session stack displays read `stackOf`. |
| `ui/tests/preflop-stack.test.ts` | NEW focused suite (5 tests) — see "Tests". |
| `ui/tests/node-test-shims.d.ts` | NEW ambient typings for `node:test` / `node:assert/strict` (the UI package has no @types/node). |
| `PREFLOP-STACK-NOTES.md` | This file. |

No engine, API, data, or schema file was modified. No new styling:
the Stack rows reuse the pages' existing `Pill` / `PickerRow`
components and tokens verbatim.

## The selection-order invariant

Table, rake **and stack** all filter BEFORE any position/opener
selection runs — the load-bearing order documented in
PREFLOP-LIB-NOTES for the v1.2 rake fix, now extended to the third
partition dimension. On the Preflop page the order lives in one pure
function, `selectGroupSets(index, { tableSize, rake, stack,
contexts })` in `lib/preflop.ts`, whose doc comment states the
invariant; the page's `groupSets` memo is a thin call into it, and
positions, openers, 3-bettors, the selected entry, the position
strip, and the Compare family all derive from that partitioned pool
downstream (unchanged code). After the partition, a slot
(table, rake, stack, position, context, opener) resolves to exactly
one set: e.g. 6-max/no-rake/BB vs BTN is
`constructed-v1.2-6max-norake-bb-vs-btn` at 100bb and
`constructed-v1.4-6max-deep200-bb-vs-btn` at 200bb.

## Missing `stack_bb` = 100bb; guards NOT tightened

`stackOf(entry)` returns the entry's `stack_bb` when it is a finite
number, else 100. In step with that, the type fields became optional
and the guards were *relaxed*, not tightened: `isPreflopIndex` /
`isPreflopSetDoc` now require `stack_bb` to be a number **when
present** and accept its absence — the same treatment the v1.2 `rake`
field got, for the same reason (gating on a new field's value is the
past-bug class that once silently dropped the whole index). The
served index at base already carries `stack_bb` on all 132 entries,
so this is belt-and-braces for older payloads, and a test pins both
directions (absent accepted, wrong-typed rejected).

## Availability / fallback behaviour (Preflop page)

- The pill row offers exactly the stacks present for the current
  (table, rake) pair (`stacksIn` over that subset): today **[100]**
  everywhere except 6-max no-rake, which offers **[100, 200]**. No
  dead pills are rendered; the row's caption says when only 100bb
  exists, mirroring the honest-static-chip copy it replaces.
- If the selected stack has no sets at the newly chosen table+rake
  (e.g. 200bb selected, then rake flipped to Raked), a keep-valid
  effect applies `resolveStack`: keep the current stack if it
  exists there, else fall back to the shallowest available (100bb
  whenever it exists) — the same availability rule the page's
  position/opener keep-valid effects and the Starting Hands picker
  cascade already follow. The page never sits on an empty scenario
  because of the stack facet.

## setLabel

The stack is appended only where it disambiguates: a non-100bb set
gains a `200bb` segment (`6max · BB vs BTN open · 200bb · No-rake`);
100bb labels are byte-identical to before, and legacy entries (no
rake, no stack) keep their historical label exactly. Because the
Solver wizard's range pickers also render `setLabel`, deep sets are
now distinguishable there too with no Solver change.

## Starting Hands handling

The study keeps its own selection path (the facet cascade in
`preflopStudy.ts` + `StartingHands.tsx`), so the partition was
applied there in its own idiom rather than by importing the page's
pool:

- `StudySetOption` gains `stack` (= `stackOf(entry)` — a set whose
  index entry carries no stack is a 100bb set).
- The setup cascade gains a Stack PickerRow between Variant and
  Spot, offering only stacks that exist at the chosen size+variant;
  spot/position/opener lists and `chosenOption` all filter on it, so
  the BB-vs-BTN defense slot resolves to the v1.2 set at 100bb and
  the deep200 set at 200bb, never to an index-order accident.
- The keep-valid effect defaults the facet to **100bb** (the
  library's original depth, `DEFAULT_STUDY_STACK`) whenever 100bb
  exists at the size+variant, else the shallowest on offer.
- The one exception to the 100bb default is the Quiz drill hand-off
  (#22): it names a specific set id, and the hand-off now pins that
  set's own stack, so a deep set handed off by id drills at 200bb.
- A session still loads exactly one set document, so stacks can
  never mix *within* a session; the partition governs which single
  set a session is built from.

## Tests

There was no existing preflop UI test suite in the tree (the UI is
gated by build only; the tree's JS test idiom is the api
`node:test` suites). Added a focused suite in that idiom,
`ui/tests/preflop-stack.test.ts` (outside `src/`, so `npm run
build`'s include set never sees it), pinning:

1. **Stack partition** — with deep200 entries deliberately listed
   first in the fixture index, the previously-shadowed slots
   (BB vs BTN defense, UTG RFI, BTN continuation) resolve to the
   v1.2 set at 100bb and the deep set at 200bb, exactly one per
   stack; the rake partition still applies inside a stack.
2. **Missing `stack_bb` = 100** — `stackOf` defaults (absent,
   undefined, NaN), the legacy fixture entry lands only in the
   100bb pool, and the index guard accepts a stack-less entry while
   rejecting a wrong-typed one.
3. **Availability fallback** — `stacksIn` per variant; `resolveStack`
   keeps a valid current stack, falls back 200→100 and 100→200 as
   availability dictates, and returns null for no sets.
4. **setLabel** — `200bb` tag on the deep set; 100bb and legacy
   labels byte-identical to the historical forms.
5. **Study partition** — `studySetOptions` tags the two depths, the
   page's chosen-option rule resolves one set per stack, and
   continuation sets stay excluded at both stacks.

Run route for the gate host (from `ui/`; uses only the project's
own TypeScript + Node's runner, no new dependency):

```sh
npx tsc tests/preflop-stack.test.ts tests/node-test-shims.d.ts \
  --outDir /tmp/plo-stack-test --module commonjs --target es2020 \
  --moduleResolution node --esModuleInterop --skipLibCheck
node --test /tmp/plo-stack-test/tests/preflop-stack.test.js
```

## Judgement calls

- **The pure `selectGroupSets` extraction.** The brief named the
  page's `groupSets`; the filter moved into `lib/preflop.ts` as a
  pure function (the page memo delegates) so the invariant is stated
  once, next to `stackOf`/`rakeOf`, and is directly testable. No
  behaviour beyond the added stack term changed.
- **Guard relaxation.** Making `stack_bb` optional in the types and
  guards is a (deliberate) loosening, required by the brief's
  "treat missing as 100" — a required field in the guard would
  reject any payload missing it before `stackOf` could default it.
  Present-but-wrong-typed values are still rejected.
- **Stack pill placement** follows the #26 game-bar row order
  (Table → Stack → Rake → Context): the Stack row already existed in
  that slot as a static chip, so the live selector inherits its
  place; Starting Hands inserts its Stack row between Variant and
  Spot, matching its own cascade order.
- **Fallback target is the shallowest available stack**, not
  "nearest": with only two depths in the library the two rules
  coincide, and shallowest keeps the rule identical to
  `resolveStack`'s single statement on both pages.

## Flagged — needs a product decision (NOT improvised)

- **The Solver wizard now lists deep sets as loadable ranges.**
  `isSolveCompatible` keys on context only, so the 200bb RFI /
  vs-RFI sets appear in the wizard's range pickers (now labelled
  `200bb`, so at least unambiguous). Whether a custom solve fed a
  200bb range should also default the wizard's stack field to 200bb
  is a Solver-UX decision; this lane did not touch the wizard.
- **200bb spots ↔ deep200 sets pairing** remains the open item from
  PREFLOP-200BB-NOTES (the 200bb spot catalog still references the
  v1 raked sets). Nothing in this lane changes that; the Stack pill
  only partitions the preflop library itself.
