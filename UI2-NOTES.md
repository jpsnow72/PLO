# UI2-NOTES — Preflop Ranges screen + wizard range loading

Build-only lane deliverable. Nothing in this tree was compiled or run on
the Muse VM (checks limited to `node --check`, JSON parsing, grep, git,
and offline Python verification of the combo math — see §4). The
coordinator verifies on a host with the commands in §6.
Branch: `ui-preflop-ranges` (based on `ranges-constructed-v1` @ a96ee9a).

## 1. What was built

| Piece | Location |
| --- | --- |
| API: 3 preflop endpoints + set-mode solve submission | `api/server.mjs` |
| API docs (endpoints, expansion rule, env `PREFLOP_DIR`) | `api/README.md` |
| UI data layer: types, runtime shape guards, combo math, totals, feature tags, pair-rank summary | `ui/src/lib/preflop.ts` |
| UI API client: `fetchPreflopIndex / fetchPreflopSet / fetchPreflopClassTable` | `ui/src/lib/api.ts` |
| Preflop Ranges screen (replaces the stub) | `ui/src/pages/Preflop.tsx`; stub removed from `ui/src/pages/Stubs.tsx`; route import updated in `ui/src/App.tsx` |
| Solver wizard: per-side "Load from preflop library" picker + set mode | `ui/src/pages/Solver.tsx`, set-mode support in `ui/src/lib/spot.ts` (`WizardForm.oopRangeSet / ipRangeSet`, `buildSpot` emits `<side>_range_set`) |
| Job/library records surface the set ids used | `api/server.mjs` (job record + library meta + library list), `ui/src/lib/types.ts` (optional fields), Solver jobs list |

Dashboard (brief item 5): the Dashboard has **no** preflop placeholder —
its Coverage card counts solves in the library, not preflop sets — so per
the brief's condition, nothing was changed there.

## 2. The set-expansion rule (as implemented, server-side in `expandRangeSet`)

A set document maps canonical hand-class keys (a representative combo
whose suits are labelled by first occurrence, e.g. `As Ah Ks Kh`) to
per-action frequencies. Expansion for a solve:

1. Pick the set's **solve action** from its context (see §3).
2. For every class whose frequency for that action is > 0, enumerate the
   class's concrete combos: apply all 24 permutations of the suits to the
   representative, normalise each image by sorting its cards
   (rank descending, then suit in s/h/d/c order), and dedupe. The number
   of distinct images is the class multiplicity.
3. Emit one engine range entry per concrete combo,
   `"<combo>:<frequency>"`, with the class frequency as the weight
   (6-decimal rounding, matching the data's precision).

The job record (and the library meta) stores `oop_range_set` /
`ip_range_set`; the `*_range_set` keys are stripped from the spot before
it is written, so the engine only ever sees ordinary range arrays (the
job's `spot.json` audit file therefore contains the full expanded range —
good for reproducibility). Sending both a raw range and a set id for the
same side is a `400`; an unknown set id is a `400`.

## 3. v1 restrictions (which set contexts can feed solves, and why)

| Set context | Solve action | Status |
| --- | --- | --- |
| `rfi` | `raise` | ✅ loadable — the opening range is well-defined |
| `vs_rfi` | `call` | ✅ loadable — the continuing (calling) range vs an open is well-defined |
| `sb_play` | — | ❌ `422` — SB first-in sets mix the raise-or-fold model with completion decisions; no single continuing range |
| `three_bet` | — | ❌ `422` — the response-to-3-bet range is not the range a postflop spot starts from |

For `vs_rfi` sets the 3-bet slice is deliberately **not** used: it is a
different, narrower range than the calling range, and silently
substituting it would mislabel the solve. The UI applies the identical
rule (`solveActionForContext` in `ui/src/lib/preflop.ts`) so the wizard
only offers sets the API will accept, and the Preflop screen badges
loadable sets. The rejection message names the context and the rule.

## 4. Combo math — verified offline (no project code was run)

The expansion rule was checked against the real set files with an
independent Python implementation of the same algorithm:

- Summing orbit sizes over all 16,432 keys of a set yields exactly
  **270,725** combos, and combo-weighted totals reproduce the sets' own
  stated achieved totals to 4 decimals: 6-max BTN RFI raise **49.0%**;
  6-max BB vs BTN call **30.0%** / three_bet **9.0%**; 9-max UTG RFI
  **11.5%**; 6-max SB play raise **37.0%**.
- A brute-force canonicalisation of all 270,725 combos (independent
  implementation) produces exactly 16,432 classes, every set key is a
  canonical representative, and class sizes equal the orbit sizes.
- One trap worth recording: dedupe must happen **after** normalising each
  image's card order — equal-rank cards can swap positions under a suit
  permutation, and naive string dedupe overcounts (298,480 instead of
  270,725).

## 5. Schema / data surprises (brief vs reality)

1. **`class-table.json` is not in the base tree at all**, and not under
   `sets/`: `build-ranges` writes it to `data/preflop/class-table.json`
   (the data-dir root) at generation time, and the P1 lane did not commit
   it. `GET /api/preflop/class-table` serves exactly that path and
   returns a `404` with an explanatory error until a host run generates
   it. The UI treats the table as an enhancement: frequencies, totals and
   combo counts are computed from the set documents alone; equity/feature
   columns and the pair-rank summary show an explicit "not generated yet"
   state instead of fake data.
2. **The class table contains no combo lists** (the brief said it does).
   None are needed: combos are derivable from the representative keys by
   suit permutation (§2/§4). Its actual per-class fields are `hand`,
   `multiplicity`, `equity_vs_random`, `equity_vs_reference`, `score`,
   and `features {pair_kind, top_pair_rank, suitedness, rundown_len,
   *_component}` — the UI guards and tags are built on those.
3. **Set documents store frequencies under `hands`** as an object keyed
   by canonical representative (all 16,432 classes, actions summing to 1
   per class) — not an `entries` array. Guards mirror that shape.
4. **No opener field exists** on vs_rfi sets or index entries. The opener
   lives in the set document's `context_detail` (`"vs BTN open
   (constructed response set)"`) and in the id slug
   (`...-sb-vs-utgplus1`). The Preflop screen groups openers from the id
   slug at index level and displays `context_detail` via the loaded
   document; `openerOf()` in `preflop.ts` parses the document form.
5. **SB first-in sets use context `sb_play`** (not `rfi`). The screen's
   "RFI / first-in" group includes them (they are first-in decisions);
   the API still rejects them for solve loading per the brief's rule.
6. Index entries carry a **reduced** provenance (`method`,
   `config_version`, `config_hash` only); full provenance (sources with
   licences, derivation) lives in the set documents, which is where the
   screen reads it from.

## 6. Coordinator verification commands (on a host, from the tree root)

```bash
# UI build (type-check + bundle):
cd ui && npm install && npm run build && cd ..

# Engine not required for the preflop endpoints; start the API:
cd api && node server.mjs &   # listens on 127.0.0.1:8787
cd ..

# The three new endpoints:
curl -s localhost:8787/api/preflop/index | head -c 300
curl -s localhost:8787/api/preflop/sets/constructed-v1-6max-btn-rfi | head -c 300
curl -s localhost:8787/api/preflop/class-table
#   -> the generated table once build-ranges has run on the host
#      (cd engine && cargo run --release -p plo-solve --bin build-ranges -- --data-dir ../data/preflop),
#      otherwise 404 {"error":"Class table not generated yet: ..."}
# Unknown id and traversal safety:
curl -s localhost:8787/api/preflop/sets/nope            # -> 404
curl -s "localhost:8787/api/preflop/sets/..%2Findex"    # -> 404 (id must match an index entry)

# Set-mode solve smoke. NOTE: a set-mode range is wide by nature (the
# narrowest call set below is ~16% of all combos), so smoke on a RIVER
# board with a tiny iteration cap — a full-range flop solve is a library
# job, not a smoke test. Expected: 202, job finishes "done", the job
# record shows "oop_range_set": "constructed-v1-6max-bb-vs-utg", and
# DATA_DIR/jobs/<id>/spot.json contains the expanded oop_range array
# (its length = combos with call freq > 0 in that set, computable from
# the set file via the §2 rule; exactly 49,541 entries for this set —
# 44,128 combo-weighted, i.e. the published 16.3% call total).
curl -s -X POST localhost:8787/api/solves -H 'Content-Type: application/json' -d '{
  "board": "As Ks Qs 7d 2c",
  "oop_range_set": "constructed-v1-6max-bb-vs-utg",
  "ip_range": ["Jh Th 8d 9d:1.0", "8s 6s 3h 4h:1.0", "3s 4s 5d 6d:0.5"],
  "pot": 100.0, "stacks": 100.0,
  "bet_sizes": [0.75], "raise_sizes": [1.0], "max_raises": 2,
  "max_iterations": 25, "target_exploitability_pct": 0.0
}'
# Negative checks:
curl -s -X POST localhost:8787/api/solves -H 'Content-Type: application/json' \
  -d '{"board":"As Ks Qs 7d 2c","oop_range_set":"constructed-v1-6max-sb-sbplay","ip_range":["Jh Th 8d 9d:1.0"],"pot":100,"stacks":100,"max_iterations":25}'
#   -> 422 (sb_play cannot feed a solve in v1)
curl -s -X POST localhost:8787/api/solves -H 'Content-Type: application/json' \
  -d '{"board":"As Ks Qs 7d 2c","oop_range_set":"nope","ip_range":["Jh Th 8d 9d:1.0"],"pot":100,"stacks":100,"max_iterations":25}'
#   -> 400 (unknown set id)
curl -s -X POST localhost:8787/api/solves -H 'Content-Type: application/json' \
  -d '{"board":"As Ks Qs 7d 2c","oop_range_set":"constructed-v1-6max-btn-rfi","oop_range":["As Ah Kd Qc:1.0"],"ip_range":["Jh Th 8d 9d:1.0"],"pot":100,"stacks":100,"max_iterations":25}'
#   -> 400 (both range and range_set for one side)

# UI click-through: open the app, go to Preflop (CONSTRUCTED badge +
# provenance visible, 6-max BTN RFI headline = 49.0%), then Solver ->
# load the 6-max BB vs UTG set for OOP (call 16.3%), submit the river
# spot above, and confirm the job list shows the set id.
```

## 7. What could not be verified statically

- That the TypeScript compiles (no `tsc` run here). Care was taken with
  strict-mode pitfalls (explicit empty-range type in `buildSpot`, guarded
  parsing everywhere, no `any` on parsed JSON), but the host
  `npm run build` is the real check.
- That the API serves the endpoints (only `node --check` was run). The
  expansion code path was verified algorithmically in Python (§4), not by
  executing `server.mjs`.
- Performance of set-mode expansion and of the UI's totals computation on
  the largest sets (BTN RFI expands to 135,358 range entries; the wizard's
  set stats fall back to orbit computation when the class table is
  absent, which is noticeably slower than the table lookup — both are
  one-shot per selection, not per render).
- The Preflop screen's class browser caps rendering at 200 rows
  (filter/sort operate on the full set); whether that cap feels right in
  the real UI is a coordinator/Justin call.
