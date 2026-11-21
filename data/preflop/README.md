# Preflop range data

This directory holds the *plumbing* for preflop starting ranges: a schema,
an index, and a CSV importer. It intentionally contains **no hand data yet**.

## Rules for adding data

- Entries are added **only** from sources whose licence / terms have been
  verified to permit transcription and use in this personal tool. A separate
  research lane is identifying candidate sources; until a source is cleared,
  nothing from it is typed in here — no ranges are invented, reconstructed
  from memory, or scraped from solver-library sites.
- Every range-set document records its provenance (`source.name`, `url`,
  `licence`, `retrieved`) so any chart can be traced back and re-checked.
- One document = one source chart for one table size, one position, one
  decision context, one stack depth. Never merge two sources into one file.

## Constructed sets (method `constructed-equity-v1`)

Alongside transcribed charts, this directory holds range sets **constructed
by our own tool** (`build-ranges` in the engine's `plo-solve` crate) from
exact card features plus seeded Monte Carlo equities, fitted to documented
target frequencies in `ranges-config-v1.json`. Constructed sets:

- are labelled CONSTRUCTED in their `notes` and are **never GTO data**;
- carry a `provenance` block (method, tool + version, config version and
  hash, cross-check `sources`) instead of a transcribed chart's `source`;
  the schema was amended 2026-11-07 to allow exactly this shape, and a
  provenance with an empty `sources` list must state its `derivation`;
- cite **cross-check sources only** — published totals our construction was
  validated against. No range data from any source is transcribed into a
  constructed set. Current cross-check sources: PLO.com's published solver
  totals (free to cite with a link back), the owner-provided Upswing
  Advanced PLO Preflop Guide (personal use), and GTO Wizard solution
  totals viewed under the owner's subscription (cEV no-rake for the
  no-rake family; PLO100 raked as an additional informational anchor for
  the raked family — see the v1.2 section below). ThinkGTO totals were compared
  in research notes only — its terms prohibit copying/derivative works, so
  it is never recorded as a source here;
- 9-max constructed sets are **derived-by-mapping** from the 6-max targets
  (no published 9-max chart exists) and say so in `provenance.derivation`
  with an empty `sources` list;
- live under `sets/`, are catalogued in `index.json` with their provenance,
  and are regenerated (not hand-edited) by re-running `build-ranges`.

**v1.1 continuation sets (method `constructed-equity-v1.1`)** extend the
constructed family: for three 6-max matchups (BTN vs BB 3-bet, BTN vs SB
3-bet, CO vs BTN 3-bet) they give the *opener's* continuation range after
facing a 3-bet (context `vs_three_bet`), built from the opener's RFI set
and the three-bettor's `three_bet` slice by the same machinery. Their
continuation-rate targets are **internal construction parameters** —
fractions of the opener's raising range in the config's
`continuations_v11` section — because no published cross-check anchor for
continuation rates exists. They therefore carry an empty provenance
`sources` list, state the construction and the two input set ids in
`provenance.derivation`, and must never be presented as externally
validated. See `RANGES-V11-NOTES.md` at the repository root.

**v1.2 rake variants (config `ranges-config-v1.2.json`)**: every
constructed set records a `rake` field — which game's published totals
its targets describe. Construction models no rake in either variant
(the equities are rake-free); the dimension is about the targets:

- `rake: "raked"` — the v1/v1.1 family (6-max and 9-max). Targets
  anchored on raked-game totals (PLO.com, Upswing guide; see above).
- `rake: "no-rake"` — a 6-max-only sibling family (ids
  `constructed-v1.2-6max-norake-…`) built by the same machinery from the
  config's `norake_6max` section. Its anchors are **GTO Wizard Cash
  6-max Classic cEV (no-rake) totals** collected 2026-11-17 (aggregate
  action totals only, cited as cross-check targets under the owner's
  subscription; no range data transcribed). No-rake defense calls run
  far wider than the raked anchors (e.g. BB vs BTN call 45.6% vs 30%) —
  that gap is the reason both variants exist. Entries without a GTO
  Wizard anchor are labelled `interpolated` in the config with their
  derivation stated there. The SB first-in set-point applies the v1
  raise-or-fold reconciliation to the limp-inclusive cEV totals
  (raise 28.4% + 0.5 × limp 26.4% = 41.6%). Its continuation sets reuse
  the v1.1 internal parameters against the no-rake input sets.

**v1.3 8-max families (config `ranges-config-v1.3.json`)**: 8-max sets
for **both** rake variants (ids `constructed-v1.3-8max-…` and
`constructed-v1.3-8max-norake-…`), 25 per variant: RFI for the seven
non-BB seats, responses (BB vs all seven opens, SB vs the six non-blind
opens, BTN vs HJ/CO), and the three v1.1 continuation matchups against
the variant's own 8-max sets. **No published 8-max PLO4 chart exists
and no solver library offers a standard 8-max cash set** (GTO Wizard:
Straddle / Straddle+Ante only, verified 2026-11-17), so there is no
cross-check target: every 8-max target is **derived-by-mapping** from
the same variant's 6-max targets by the players-behind seat mapping
(8-max MP takes the 6-max UTG values, HJ the MP values, CO/BTN/SB carry
over; UTG and UTG+1 take the values the 9-max derivation assigned to
the same players-behind counts in the raked variant, and the raked
curve's ratio steps down from the no-rake UTG anchor in the no-rake
variant). Like the 9-max sets, the 8-max sets cite no source — empty
`sources`, the mapping stated in `provenance.derivation` — and every
set records its `rake` variant. See `PREFLOP-8MAX-NOTES.md` at the
repository root for the full mapping tables and the regeneration
runbook.

**v1.5 retarget (config `ranges-config-v1.5.json`)**: no new family —
three raked 6-max construction targets adopt the **GTO Wizard PLO100
raked totals** that v1.2 recorded as informational anchors (owner
decision 2026-11-21, after the 2026-11-20 cross-check found them to be
the family's only >1pp misses): BTN RFI 49% → 42.6% (the old target
matched the *no-rake* anchor although this family describes the raked
game), BB vs UTG call 16.3% → 24.2%, BB vs BTN call 30% → 32.2%.
Three-bet targets already matched and do not move. Every other
family's targets are literals in the config (the seat-mapping
derivations were applied at authoring time, not at generation time),
so no other family moves; within the raked 6-max family, SB vs BTN
and the two BTN continuation sets follow the retargeted BTN range.
Set ids are unchanged — only the config version/hash in each set's
provenance moves. See `RETARGET-NOTES.md` at the repository root.

Regenerate with the v1.5 config (the canonical one — a run with an
older config rewrites `index.json` without the newer entries):

```
cargo run --release -p plo-solve --bin build-ranges -- --check   # validate only
cargo run --release -p plo-solve --bin build-ranges              # regenerate all sets
```

`class-table.json` (generated) records, for every one of the 16,432
canonical hand classes, its combo multiplicity, Monte Carlo equities,
playability features and construction score, so any constructed set can be
audited back to its inputs.

## Files

- `rangeset.schema.json` — JSON Schema (draft 2020-12) for a range-set
  document.
- `ranges-config-v1.json` — all tunables of the constructed-range builder
  (weights, target frequencies with provenance tags, Monte Carlo settings).
- `ranges-config-v1.2.json` — everything in v1 (the raked family,
  unchanged) plus the `norake_6max` section (the no-rake family's GTO
  Wizard cEV targets).
- `ranges-config-v1.3.json` — everything in v1.2 plus the `eightmax`
  section (the 8-max families for both rake variants, derived by seat
  mapping).
- `ranges-config-v1.4.json` — everything in v1.3 plus the
  `deep200_6max` section (the 200bb no-rake 6-max family).
- `ranges-config-v1.5.json` — the canonical builder config: everything
  in v1.4 with three raked 6-max targets retargeted to the GTO Wizard
  PLO100 raked anchors (BTN RFI 42.6%, BB vs UTG call 24.2%, BB vs BTN
  call 32.2%). `build-ranges` defaults to it.
- `sets/` — generated constructed range sets, one JSON file per set.
- `class-table.json` — generated per-class features/equities/scores.
- `index.json` — catalogue of the range sets present in this directory.
  Starts empty (`"rangesets": []`). When a set is added, append an entry
  with its `id`, file `path`, `table_size`, `position`, `context`,
  `stack_bb`, and a copy of its `source` block. Constructed entries are
  **regenerated by `build-ranges`** (never hand-edited; foreign,
  non-constructed entries are preserved verbatim by the rewrite) and
  additionally carry `rake` and a `provenance` summary.
- `<id>.json` — one range-set document per added chart (created by the
  importer or by hand, validated against the schema's rules).
- `import-csv.mjs` — dependency-free CSV → range-set JSON converter.

## Range-set documents

Required fields: `schema_version` (1), `id` (slug), `table_size`
(`6max` | `8max` | `9max`), `position`, `context`, `stack_bb`, `rake_note`,
`source {name, url, licence, retrieved}`, and `hands`. Constructed sets
additionally record `rake` (`raked` | `no-rake`, the v1.2 dimension) and
a `provenance` block; transcribed charts predate `rake` and may omit it.

Positions — 6max: `UTG MP CO BTN SB BB`. 8max: `UTG UTG+1 MP HJ CO BTN
SB BB`. 9max: `UTG UTG+1 UTG+2 LJ HJ CO BTN SB BB`.

Contexts and the actions allowed in each:

| context     | meaning                                   | actions                    |
| ----------- | ----------------------------------------- | -------------------------- |
| `rfi`       | first in (unopened pot)                   | `fold`, `raise`            |
| `vs_rfi`    | facing one open raise                     | `fold`, `call`, `three_bet` |
| `three_bet` | facing a three-bet                        | `fold`, `call`, `four_bet` |
| `sb_play`   | small blind first-in / completion play    | `fold`, `call`, `raise`, `three_bet` |
| `vs_three_bet` | opener's continuation after facing a 3-bet (constructed v1.1 sets) | `fold`, `call`, `four_bet` |

`context_detail` (optional) carries what the enum cannot — e.g. which
position opened, for `vs_rfi` — transcribed from the source, never guessed.

## Hand keys: canonical representative combos

A hand key is the canonical representative of a suit-isomorphism class:
four cards, ranks in non-increasing order, single spaces, e.g.
`As Ah Kd Qc`. Suit letters are canonicalised by first occurrence — the
first distinct suit is `s`, the next `h`, then `d`, then `c` — so two
spellings of the same class collapse to one key, and any non-canonical
spelling is rejected rather than silently reinterpreted. Source-specific
shorthand (e.g. `AAKKds`) is **not** accepted by the importer: convert the
source's notation to representative combos in a separate, reviewable step
so transcription mistakes stay visible.

## Importer

```
node import-csv.mjs \
  --input rows.csv --output <id>.json \
  --id <slug> --table-size 6max --position BTN --context rfi \
  --stack-bb 100 --rake-note "<rake assumption from the source>" \
  --source-name "<publisher>" --source-url "https://…" \
  --source-licence "<licence / terms basis>" --retrieved 2026-11-07
```

CSV format: header `hand,action,frequency`, then one row per
hand × action. Frequencies are fractions (`0.75`) or percents (`75%`);
a bare number greater than 1 is rejected as ambiguous. Behaviour:

- validates card syntax, distinctness, rank order, and canonical suits;
- rejects duplicate hand+action rows and actions outside the context's set
  (aliases `3bet`/`3-bet`, `4bet`/`4-bet`, `open` are normalised);
- if a hand's listed frequencies sum to less than 1, the remainder is
  assigned to `fold` and reported on stdout — in these preflop contexts
  the unlisted mass is the fold mass. Sums above 1 are rejected.
- validates the assembled document against the schema's rules (fields,
  enums, position/table compatibility, source URL and date) and writes
  nothing if validation fails.

The importer checks *form*, not *truth*: it cannot verify that a chart is
accurate or that its licence really permits use. That verification happens
before any CSV for a source is prepared.
