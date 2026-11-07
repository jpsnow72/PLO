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
  totals (free to cite with a link back) and the owner-provided Upswing
  Advanced PLO Preflop Guide (personal use). ThinkGTO totals were compared
  in research notes only — its terms prohibit copying/derivative works, so
  it is never recorded as a source here;
- 9-max constructed sets are **derived-by-mapping** from the 6-max targets
  (no published 9-max chart exists) and say so in `provenance.derivation`
  with an empty `sources` list;
- live under `sets/`, are catalogued in `index.json` with their provenance,
  and are regenerated (not hand-edited) by re-running `build-ranges`.

`class-table.json` (generated) records, for every one of the 16,432
canonical hand classes, its combo multiplicity, Monte Carlo equities,
playability features and construction score, so any constructed set can be
audited back to its inputs.

## Files

- `rangeset.schema.json` — JSON Schema (draft 2020-12) for a range-set
  document.
- `ranges-config-v1.json` — all tunables of the constructed-range builder
  (weights, target frequencies with provenance tags, Monte Carlo settings).
- `sets/` — generated constructed range sets, one JSON file per set.
- `class-table.json` — generated per-class features/equities/scores.
- `index.json` — catalogue of the range sets present in this directory.
  Starts empty (`"rangesets": []`). When a set is added, append an entry
  with its `id`, file `path`, `table_size`, `position`, `context`,
  `stack_bb`, and a copy of its `source` block.
- `<id>.json` — one range-set document per added chart (created by the
  importer or by hand, validated against the schema's rules).
- `import-csv.mjs` — dependency-free CSV → range-set JSON converter.

## Range-set documents

Required fields: `schema_version` (1), `id` (slug), `table_size`
(`6max` | `9max`), `position`, `context`, `stack_bb`, `rake_note`,
`source {name, url, licence, retrieved}`, and `hands`.

Positions — 6max: `UTG MP CO BTN SB BB`. 9max: `UTG UTG+1 UTG+2 LJ HJ CO
BTN SB BB`.

Contexts and the actions allowed in each:

| context     | meaning                                   | actions                    |
| ----------- | ----------------------------------------- | -------------------------- |
| `rfi`       | first in (unopened pot)                   | `fold`, `raise`            |
| `vs_rfi`    | facing one open raise                     | `fold`, `call`, `three_bet` |
| `three_bet` | facing a three-bet                        | `fold`, `call`, `four_bet` |
| `sb_play`   | small blind first-in / completion play    | `fold`, `call`, `raise`, `three_bet` |

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
