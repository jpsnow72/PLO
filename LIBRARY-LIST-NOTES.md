# Library list from the meta sidecar (issue #55)

## Problem

`listLibrary()` (`api/server.mjs`) read and `JSON.parse`d **every** solve
file in the library directory to extract `board`,
`exploitability.nash_distance_pct`, and `iterations` — all of which already
live in each entry's ~1 KB `.meta.json` sidecar (the old code even fell back
to the sidecar per field). With 17 turn solves of 165–261 MB landed on
2026-11-23 (~3.5 GB total), one uncontended `GET /api/library` took **76.6 s**
at the origin and 502s through Cloudflare Pages. The Library page and
`GET /api/catalog` (which also calls `listLibrary`) were effectively down,
and concurrent calls wedged the API process (116% CPU, ~2 GB RSS observed).

## The change

`listLibrary()` is now meta-first:

- A sidecar is **usable** iff `<id>.meta.json` reads and parses to a plain
  object (not null, not an array, not a scalar). A usable sidecar builds the
  list item **alone**; the solve file is only `fs.stat`ed for `size_bytes`.
- Otherwise the entry keeps the **historical behaviour verbatim**: read +
  parse the solve document with the meta treated as `{}`.
- Both paths sit inside the same per-entry try/catch: any failure skips just
  that entry, exactly as before. The `finished_at`-descending sort is
  unchanged, as is the item's field set and key order.

The two sidecar writers now record the fields only the document carried:

- Job publish (`runJob`): the sidecar gains `starting_pot` and
  `effective_stack`, copied from the engine result it already parsed.
- Ingest (`POST /api/library/ingest`): the sidecar gains `starting_pot`,
  `effective_stack`, and `locked`, copied from the posted result.

No other endpoint changes; the solve-file format is untouched.

## Field audit

| Item field | Before | After (meta path) | Gap / handling |
| --- | --- | --- | --- |
| `id` | filename | filename | none |
| `name` | `meta.name ?? Solve · ${result.board ?? id}` | `meta.name ?? Solve · ${meta.board ?? id}` | both writers always set `name`; the fallback reads the board from the sidecar instead of the document — both sidecars carry `board`. Equivalent |
| `kind` | `meta.kind ?? meta.street ?? kindForBoard(result.board) ?? 'river'` | same chain over `meta.board` | both writers set `kind` and `street`; the chain tail is dead in practice. Equivalent |
| `board` | `result.board ?? ''` | `meta.board ?? ''` | ingest sidecars copy `result.board` verbatim; job-publish sidecars carry `job.board` = the submitted `spot.board`, which the engine echoes as `result.board` (board format is canonical end-to-end). Equivalent by construction |
| `oop_range_set`, `ip_range_set` | meta | meta | none — already meta-sourced |
| `spot_id` | `meta.spot_id ?? meta.id ?? null` | identical expression | ingest sidecars carry no `spot_id` field, but their `id` **is** the catalog spot id, so the `?? meta.id` step yields the same value |
| `nash_distance_pct` | `result.exploitability… ?? meta…` | meta | job-publish copies the value from the same result at publish time; ingest copies it from the posted result. Identical values |
| `iterations` | `result… ?? meta…` | meta | same copying as above |
| `finished_at` | meta | meta | none |
| `size_bytes` | `fs.stat` of the solve file | `fs.stat` of the solve file | unchanged (a stat, never a parse) |
| `starting_pot` | `result.starting_pot` (number-guarded) | `meta.starting_pot` (number-guarded) | **GAP for legacy sidecars** — see below |
| `effective_stack` | `result.effective_stack` (number-guarded) | `meta.effective_stack` (number-guarded) | **GAP for legacy sidecars** — see below |
| `locked` | `result.locked === true \|\| meta.locked === true` | `meta.locked === true` | job-publish sidecars always carried `locked` (from the spot's locks — the only lock source — and the engine echo agrees). Ingest sidecars did **not** carry it; ingest now writes it from the result. A legacy *ingested* nodelocked solve would list `locked: false` until backfill; no such entry exists in the production library (the catalog burn solves carry no locks) |
| `range_expansion` | meta | meta | none — already meta-sourced. (Ingest-written entries carry `null` here before and after: the upload protocol posts `{spot, result}` and the expansion record never reaches the ingest handler. Unchanged by this fix) |

### The one real behaviour change: legacy geometry

`starting_pot` / `effective_stack` genuinely **cannot be sourced from
existing sidecars** — neither writer recorded them, and the job-publish
sidecar carries nothing they could be derived from (no pot/stacks fields;
the ingest sidecar's embedded catalog `spot` has `pot_chips`/`stacks_chips`,
but identifying those with the engine's `starting_pot`/`effective_stack`
was not verified, so this change does not guess). Rather than silently
dropping the fields, the list now renders `null` for entries whose sidecar
lacks them — including all 26 production solves at ship time — until the
sidecar is backfilled. The solve documents are untouched and still hold the
values; the solve detail views are unaffected. New solves (both writers)
record the fields from the result, so their list entries are identical to
before.

**Recommended follow-up (one-time backfill):** read each legacy solve
document once, copy `starting_pot`, `effective_stack`, and `locked` into
its `.meta.json`. After backfill, the list payload matches the pre-fix
payload exactly for every entry.

### Sparse hand-written sidecars

A sidecar that parses but omits fields (e.g. test fixtures) now renders
those fields from the sidecar alone (nulls / meta-derived fallbacks) instead
of doc-sourced values. Production sidecars come only from the two writers
above, both complete modulo the disclosed gaps. The bundled sample solve
ships without a sidecar in the repo data dir, so it takes the fallback path,
unchanged.

## Gate must verify

1. Full api suite green with the glob invocation in a built tree:
   `node --test api/*.test.mjs` — including the new
   `api/library-meta-list.test.mjs` and the untouched `library-sampled`,
   `progress`, and `target-override` suites.
2. **Timed before/after**: scratch `DATA_DIR` whose library holds one very
   large bogus solve file (~300 MB of invalid bytes) with a valid complete
   meta, plus a few normal entries. On base (556dbd24), `GET /api/library`
   blocks on the large file and the entry is absent (invalid JSON). On this
   branch it returns in well under a second **with** the large entry listed
   from its meta. Record both timings.
3. **Response-shape diff**: capture `GET /api/library` from a scratch
   library of realistic entries (complete metas + valid docs) on base vs
   this branch. Payloads must be identical **except** entries whose metas
   lack `starting_pot`/`effective_stack` (values before, `null` after) —
   enumerate exactly those in the gate log.
4. **New-write check**: run one smoke solve to completion and confirm the
   published `.meta.json` carries `starting_pot` + `effective_stack`; POST
   one `/api/library/ingest` with a locked result and confirm its sidecar
   carries `locked: true` + both geometry fields. Then corrupt the stored
   document and re-list: the entry still lists (meta path); restore.
5. **Production spot check after deploy**: all 26 live entries still list;
   the ferried turns, rivers, and bb7a4d03 show `null`
   `starting_pot`/`effective_stack` (legacy sidecars — expected until the
   backfill follow-up is run).
6. `GET /api/catalog` still returns 200 (it calls `listLibrary`) with its
   per-spot library annotations unchanged.
