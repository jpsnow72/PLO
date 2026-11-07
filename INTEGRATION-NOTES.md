# INTEGRATION-NOTES — Phase 2 integration lane (branch `integrate-phase2`)

What this tree is: the UI-1 tree (`ui-phase2-explore` @ `9507b41`) with the
accepted E4 engine swapped in wholesale, plus the integration work that wires
flop solving end to end (engine binary → API → Explorer), a minimal Explorer
extension for three-street trees, and the preflop data plumbing (schema +
importer, **no hand data**).

**Nothing in this lane was compiled or run.** Per the standing rule, no
`cargo build/test` or `npm install/build` ran on the Muse VM; checks were
limited to `node --check` (API server + importer), JSON parsing of the new
schema/index, grep, and git. All code is written to compile by construction
against the verified E3/E4 APIs (names checked against the sources). The
coordinator verification commands are at the bottom — treat this tree as
UNVERIFIED until they pass on a host.

## 1. Engine (P1)

Base: `engine/` replaced wholesale with the accepted E4 tree (from
`plo-e4-tree.tgz`; no `target/` in the archive). E4 deltas vs E3: `flop.rs`,
`buckets.rs`, `src/bin/measure-flop.rs`, `tests/flop_validation.rs`,
`LANE-NOTES-E4.md`, and extensions to `br.rs`, `turn.rs`, `lib.rs`,
`Cargo.toml`, `README.md`.

Added on top:

- **`src/bin/solve-flop.rs`** — CLI mirroring `solve-turn.rs` exactly
  (positional / `--input` / `--output` paths or stdin/stdout, same error
  shape, `solve-flop error: …` prefix). Registered as a `[[bin]]` in
  `crates/plo-solve/Cargo.toml`. Pipeline: `parse_flop_spot_json` →
  `FlopGame::new` → `solve_flop` → `format_flop_solve_result_json`.
- **`json.rs` — flop parser** (`parse_flop_spot_json`): board (3 cards,
  string or array), ranges (`oop_range`/`ip_range` or `ranges:[oop, ip]`,
  same selection as the turn parser), `pot`/`stacks` via the shared helper,
  per-street tree configs (`flop_*` / `turn_*` / `river_*`), DCFR config
  incl. `check_interval`. **Bucket config defaults to `Exact`** (the
  coordinator's measurement verdict: exact at normal range sizes). Opt in
  via any of: `"buckets": 200`, `"buckets": "exact"`, `"buckets": "k:200"`,
  `"bucket_config": {"k": 200}` / `{"count": …}` / `{"exact": true}`,
  `"bucket_count": 200`. Zero / non-integer counts are errors.
- **`json.rs` — flop formatter** (`format_flop_solve_result_json`): same
  document shape as the river/turn formatters — `board`, `starting_pot`,
  `effective_stack`, `iterations`, `exploitability` (identical fields,
  including measured `nash_distance_pct` from the exact best-response check
  in the unabstracted game), `oop_evs` / `ip_evs`, and **one flat `nodes`
  array** (see §2). Flop-street strategies are emitted through
  `expand_bucket_strategies`, i.e. combo-level — the exact profile the
  checker evaluated — even when a K-bucket solve was requested. Subtree
  nodes use each subtree TurnGame's own (turn-card-filtered) combos.
  `decision_id` / `node_id` are made globally unique by offsetting each
  live subtree's local ids past the flop tree's counts plus all earlier
  live subtrees; histories are the authoritative navigation keys anyway.
  Subtree `pot` values are the subtree nodes' own `current_pot`, which
  already includes both players' flop commitments (the subtree games are
  constructed that way), so displayed pots are true global pots.
- **`street_config_from_json` extension** (shared by all parsers): after
  the legacy global `include_all_in`, a street-specific
  `{prefix}_include_all_in` overrides both all-in flags for that street,
  and `{prefix}_include_all_in_bet` / `_raise` override individually.
  Backwards-compatible: old spots carrying only the global flag behave as
  before. This removes the former "one all-in flag covers both streets"
  engine limitation the wizard used to work around by OR-ing toggles.
- **`lib.rs`**: exports `parse_flop_spot_json` +
  `format_flop_solve_result_json`.
- **Test**: `flop_json_roundtrip_namespaces_subtree_histories` appended to
  `tests/flop_validation.rs` (modelled on the turn JSON roundtrip test):
  narrow 3×3 spot from the E4 loss-spot ranges, no-raise menus, 20
  iterations; asserts exact-by-default, `"buckets": 2` → `BucketConfig::K(2)`,
  output parses, node count = flop decision nodes + live-subtree decision
  nodes, histories unique, at least one `|t:` turn root and one `|r:` river
  node present, every strategy row sums to ~1.

## 2. Flop history-key scheme (the navigability contract)

One flat node list; `history` strings form a single walkable tree:

- Flop nodes: native flop histories — `root`, `X`, `B(75)`, `B(75)/C`, …
- A flop action that closes the flop street has no direct child. Instead,
  one **turn subtree root** per turn card:
  `{flopHistory}|t:{Card}` (e.g. `X|t:As`, `B(75)/C|t:As`).
- Inside a subtree, the TurnGame's local histories are appended:
  - local `root` → the subtree root itself;
  - local turn path `X/B(75)` → `{flopHistory}|t:{T}/X/B(75)`;
  - local river histories split at the first `|r:`:
    `{closedTurn}|r:{R}` → `{flopHistory}|t:{T}/{closedTurn}|r:{R}`,
    with `root` turn history collapsing (`…|t:{T}|r:{R}`), and deeper river
    actions preserved after the card (`…|r:{R}/B(75)`).

Node records additionally carry `street` (`flop`/`turn`/`river`),
`turn_card` (subtree nodes), and `river_card` (river nodes), all null where
not applicable — the same convention turn solves established, extended by
one field.

## 3. UI parser extension (P1 fallback, kept minimal)

`ui/src/lib/solveTree.ts`:

- `SolveData.kind` gains `'flop'`; kind is now detected from board length
  (3 → flop, 4 → turn, 5 → river), falling back to the old street-field
  heuristic for malformed boards.
- `SolveNode.streetName` gains `'flop'` (taken from the node's `street`).
- `RunoutOption` gains `street: 'turn' | 'river'`. `resolveStep` now tries
  both chance markers in order — `|t:` (turn deal) then `|r:` (river deal)
  — collecting subtree **roots only** (remainder contains no `/` and no
  `|`), reading the card from `turn_card` / `river_card` respectively.
  River/turn solve behaviour is unchanged (the `|r:` path is the old code,
  generalised).

Supporting UI edits:

- `types.ts`: `RawSolveNode.turn_card?: string | null` added; comments
  updated for the third binary.
- `useStore.chooseRunout`: breadcrumb label uses the option's street
  (`Turn card · …` / `River card · …`) instead of hardcoding River.
- `RunoutPicker.tsx`: wording is driven by the options' street (Turn card
  after the flop, River card after the turn); no visual/layout changes.
- `Explorer.tsx`: header label `Flop solve (flop + turn + river tree)`;
  the current line's turn card renders beside the board with a green ring
  (river card keeps its accent ring).
- `Dashboard.tsx`: flop count is real now (library `kind === 'flop'`);
  coverage text updated.
- `Solver.tsx`: footer copy updated — flop spots run; exact by default;
  wide flop ranges can take a long time and land in the library as jobs.
- `spot.ts` (`buildSpot`): non-river spots now also emit per-street
  `flop_include_all_in` / `turn_include_all_in` / `river_include_all_in`
  alongside the legacy global flag, so each street's all-in toggle is
  honoured individually (parser support in §1); stale "flop is future /
  422" comments fixed.

## 4. API (P2) — `api/server.mjs`, `api/README.md`

- The 422 flop rejection is **removed**. `kindForBoard` already mapped
  3 cards → `flop`; `runJob` now selects the binary by kind
  (`solve-river` / `solve-turn` / `solve-flop`). Spot JSON passes through
  unchanged (the wizard already builds flop keys). Serial queue and
  `JOB_TIMEOUT_MS` behaviour untouched.
- Library metadata: the `.meta.json` written on completion now records
  `kind`, `street` (same value), `nash_distance_pct`, and `iterations` in
  addition to the previous fields; `listLibrary` prefers
  `meta.kind ?? meta.street` and falls back to meta Nash/iterations when a
  result file lacks them. (Previously Nash came only from the result body;
  flop results carry it identically, so library rows for flop jobs show
  measured Nash like river/turn rows.)
- README endpoint table and `ENGINE_BIN` description updated.

## 5. Preflop data plumbing (P3) — `data/preflop/` (NO hand data)

- `rangeset.schema.json` — draft 2020-12 schema for one range-set document:
  `table_size` (6max|9max), `position` (per-table enums via if/then),
  `context` (rfi|vs_rfi|three_bet|sb_play) with per-context action sets
  enforced in-schema, `stack_bb`, `rake_note`, `source {name, url,
  licence, retrieved}`, and `hands`: canonical hand key → action →
  frequency ∈ [0, 1]. `three_bet` is defined as *facing* a three-bet;
  3-betting an opener lives in `vs_rfi` as the `three_bet` action.
  `context_detail` (optional) carries e.g. the opener's position.
- **Hand keys are canonical representative combos** (`As Ah Kd Qc`): ranks
  non-increasing, suit letters relabelled by first occurrence (s, h, d, c).
  This is a deliberate design decision: source shorthand (`AAKKds` etc.) is
  NOT accepted, so transcription from any source stays explicit and
  reviewable. The Gemini research lane should note this input format.
- `index.json` — starts **empty** (`{"schema_version": 1, "rangesets": []}`).
- `README.md` — rules: entries are added only from licence-verified
  sources, one source chart per document, provenance recorded in every
  document; index entry format; importer behaviour.
- `import-csv.mjs` — dependency-free Node importer. Input CSV header
  `hand,action,frequency` (quoted fields supported). Frequencies as
  fractions (`0.75`) or percents (`75%`); a bare number > 1 is rejected as
  ambiguous. It validates card syntax / distinctness / rank order /
  canonical suits, rejects duplicate hand+action rows and out-of-context
  actions (aliases `3bet`, `4bet`, `open` normalised), assigns any
  unlisted remainder to `fold` (reported on stdout — in these contexts the
  unlisted mass is the fold mass), rejects sums > 1, validates the
  assembled document against the schema's rules (fields, enums,
  position/table compatibility, source URL/date), and writes nothing on
  failure. It refuses to overwrite an existing output without `--force`.
  It validates form, not truth: accuracy and licence checks happen before
  a CSV is prepared. **Not executed in this lane** (`node --check` only) —
  run it once on a scratch CSV in /tmp during verification.

## 6. Coordinator verification (run on a host — finch-gate or the VPS)

```bash
cd <tree>/engine
cargo test --release            # includes flop_json_roundtrip_namespaces_subtree_histories
cargo build --release           # must produce target/release/solve-flop (+ solve-river, solve-turn, measure-flop)

cd <tree>/ui
npm install
npm run build

# API end-to-end with the quick spot in §7 saved as /tmp/flop-spot.json:
cd <tree>/api
ENGINE_BIN=<tree>/engine/target/release DATA_DIR=/tmp/plo-api-test PORT=8787 node server.mjs &
curl -s -X POST http://127.0.0.1:8787/api/solves -H 'content-type: application/json' -d @/tmp/flop-spot.json
# -> 202 + job id; poll GET /api/solves/<id> until "status": "done",
# then GET /api/library must list the job with kind "flop" and a numeric nash_distance_pct.
# Open the result in the UI (library -> Explore) and walk: flop line ->
# close the street -> Turn card picker -> turn line -> River card picker.

# Importer smoke test (form only, synthetic rows — not real chart data):
printf 'hand,action,frequency\nAs Ah Kd Qc,raise,1.0\n' > /tmp/rows.csv
node <tree>/data/preflop/import-csv.mjs --input /tmp/rows.csv --output /tmp/test-rangeset.json \
  --id smoke-test --table-size 6max --position BTN --context rfi --stack-bb 100 \
  --rake-note "smoke test" --source-name "smoke test" --source-url "https://example.com" \
  --source-licence "n/a - smoke test only" --retrieved 2026-11-07
```

## 7. Quick end-to-end flop spot (~a minute or less)

Narrow ranges (6 combos/side, disjoint, no board conflicts), bet-only menus
(75% pot, no raises, no all-ins) on all streets, pot 100 / stacks 150 —
modelled on the E4 validation spots. E4 measured an 18×17-combo spot at
4,000 iterations in ~59 s; this 6×6 spot at 2,000 iterations should finish
well inside a minute on finch-gate-class hardware (not measured in this
lane — nothing ran here).

```json
{
  "board": "9c 8d 3h",
  "oop_range": [
    "As Ah Kd Qc:1.0", "Ts Js Qh Kh:1.0", "7s 6s 5d 4d:1.0",
    "Ac Ad Tc Jd:1.0", "Qs Qh Td Jh:1.0", "6h 5h 4s 3s:1.0"
  ],
  "ip_range": [
    "Ks Kc Qd Jc:1.0", "Th 9s 9h 9d:1.0", "8s 8h 7d 7c:1.0",
    "5c 4c 3d 2s:1.0", "8c 7h 6d 6c:1.0", "5s 4h 2h 2d:1.0"
  ],
  "pot": 100.0,
  "stacks": 150.0,
  "flop_bet_sizes": [0.75],
  "turn_bet_sizes": [0.75],
  "river_bet_sizes": [0.75],
  "flop_raise_sizes": [],
  "turn_raise_sizes": [],
  "river_raise_sizes": [],
  "include_all_in": false,
  "max_iterations": 2000,
  "target_exploitability_pct": 0.0
}
```

## 8. Gaps and honest limitations

1. **Unverified build.** Everything above is compiling-by-construction.
   The riskiest new code is the ~450-line flop section of `json.rs` and
   the new roundtrip test; if the coordinator's `cargo test` trips on
   either, the fixes should be small and local (names were grep-verified
   against `flop.rs` / `turn.rs` / `game.rs`, but types were not
   compiler-checked).
2. **No early stop for flop solves.** `solve_flop` runs exactly
   `max_iterations` (engine design; `target_exploitability_pct` is
   recorded, not acted on, flop-side). Wide flop jobs can exceed the API's
   default `JOB_TIMEOUT_MS` (30 min) and be SIGKILLed — raise
   `JOB_TIMEOUT_MS` for library build-out jobs. Documented in
   `api/README.md`.
3. **Flop result size.** A flop solve emits the full three-street tree
   (49 turn subtrees × their river subtrees) as one JSON document; library
   files for wide ranges will be large and the Explorer loads them whole.
   No paging/streaming was added — fine for narrow spots, a real
   consideration for the ~300-solve library.
4. **Explorer edge (cosmetic).** If a flop street closes but *every* turn
   subtree under that line is dead (all combos blocked by the turn card),
   `resolveStep` returns terminal and the Explorer shows its generic
   showdown message rather than "no live combos". Same behaviour class as
   turn solves today; not fixed here.
5. **UI not click-tested.** The flop Explorer path (two stacked runout
   pickers, breadcrumb labels, turn-card board display) is verified by
   construction only. The coordinator's live pass in §6 is the first real
   exercise; the Cloudflare Pages deploy for visual review is a separate,
   already-known blocker (Justin's token edit).
6. **`UI-NOTES.md` is stale about flop** (it records UI-1's state: API 422,
   "flop solver is E4"). It is that lane's record and was left untouched;
   this file supersedes those statements.
7. **Preflop: plumbing only, by design.** No range data, no index entries,
   no source claims. The importer has not been executed (see §5). The
   schema cannot express frequency-sum or canonical-suit rules; those are
   enforced by the importer and stated in the schema description — a
   hand-written range-set file bypasses them, so hand-written files need
   the same review discipline as imported ones.
8. **Dashboard history.** Flop counts read the library fresh each load;
   library entries written before this change have no `street` field in
   meta — handled by the `meta.kind ?? meta.street ?? board-derived`
   fallback.
