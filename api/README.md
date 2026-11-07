# PLO GTO Study — job service (`api/`)

A thin job service around the Rust engine. Node.js standard library only —
no dependencies to install.

## Run

```bash
# 1. Build the engine once (on the verification/solve host):
cd ../engine && cargo build --release

# 2. Start the service:
cd ../api && node server.mjs
# -> plo-api listening on http://127.0.0.1:8787
```

Configuration (environment variables):

| Var              | Default                                   | Meaning                                   |
| ---------------- | ----------------------------------------- | ----------------------------------------- |
| `PORT`           | `8787`                                    | Listen port                               |
| `HOST`           | `127.0.0.1`                               | Bind address                              |
| `ENGINE_BIN`     | `../engine/target/release` (relative)     | Directory containing `solve-river` / `solve-turn` / `solve-flop` |
| `DATA_DIR`       | `./data`                                  | Jobs + library storage                    |
| `PREFLOP_DIR`    | `../data/preflop` (relative)              | Preflop range-set data (index, sets, class table) |
| `JOB_TIMEOUT_MS` | `1800000` (30 min)                        | Per-solve wall-clock cap                  |

## Endpoints

| Method | Path                    | Behaviour                                                                 |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/solves`           | Body = engine spot JSON. Returns `202` + job record. Board with 5 cards → `solve-river`, 4 cards → `solve-turn`, 3 cards → `solve-flop`. |
| GET    | `/api/solves/:id`       | Job record: `status` (`queued`/`running`/`done`/`error`), `nash_distance_pct` + `iterations` when done, `error` when failed. |
| GET    | `/api/solves/:id/result`| The finished solve JSON (engine output, verbatim). `409` until done.     |
| GET    | `/api/jobs`             | All job records known to this process.                                    |
| GET    | `/api/library`          | Finished solves in `DATA_DIR/library` (id, board, kind, Nash distance, iterations, size). |
| GET    | `/api/library/:id`      | One library solve JSON, verbatim.                                         |
| GET    | `/api/preflop/index`    | The preflop range-set index (`data/preflop/index.json`), verbatim.        |
| GET    | `/api/preflop/sets/:id` | One range set file, verbatim. The id must match an index entry (the served path comes from the index, never from the request), so there is no path traversal. |
| GET    | `/api/preflop/class-table` | The per-class feature/equity table (`data/preflop/class-table.json`), verbatim. `404` with an explanatory error until `build-ranges` has generated it on a host. |
| GET    | `/api/health`           | `{ ok, engine_bin, data_dir, preflop_dir }`.                              |

### Loading a preflop range set into a solve

A `POST /api/solves` body may carry `oop_range_set` and/or `ip_range_set`
(a range-set id from the preflop index) **in place of** the raw
`oop_range` / `ip_range` array for that side (sending both for one side is
a `400`). The server expands the set into ordinary per-combo engine range
entries before the job is queued, and the job record (and library meta)
notes the set ids used.

Expansion rule (v1): a set document maps canonical hand-class keys to
per-action frequencies. The concrete combos of a class are the distinct
suit-permutation images of the representative key (all 24 suit
permutations, each image normalised by sorting its cards rank-descending,
then suit s/h/d/c, and deduped) — the count of those images is the class
multiplicity, so a set's combo-weighted totals reproduce exactly from the
expansion. Each combo gets the class's frequency for the set's solve
action; classes at zero frequency for that action are omitted. The solve
action depends on the set's context, and only the contexts whose
continuing range is well-defined are supported:

| Set context | Solve action | Continuing range |
| ----------- | ------------ | ---------------- |
| `rfi`       | `raise`      | The opening range. |
| `vs_rfi`    | `call`       | The calling range vs an open (the set's 3-bet slice is a different range and is not substituted). |

Any other context (`sb_play`, `three_bet`, …) is rejected with `422` and a
message explaining the restriction. An unknown set id is a `400`.

Jobs run **one at a time** (solves are CPU-bound). A finished job's result
is copied into the library, so the library survives restarts; the job
registry itself is in-memory (plus a `job.json` audit file per job under
`DATA_DIR/jobs/<id>/`).

Spot JSON format is the engine's own — see `engine/crates/plo-solve/examples/sample_spot.json`
and `engine/crates/plo-solve/src/json.rs` (`parse_spot_json` / `parse_turn_spot_json` /
`parse_flop_spot_json`). Flop spots are solved exactly unless the spot JSON requests
bucketing (`buckets` / `bucket_config` / `bucket_count`); flop solves can run far longer
than river/turn jobs, so raise `JOB_TIMEOUT_MS` for wide ranges.

## Security note

There is **no authentication** in this slice, by design: the service is
meant to run on localhost or a private network (e.g. the VPS's Tailscale
interface) for a single user. Do not expose it to the public internet
until the login/sync ticket adds real auth.
