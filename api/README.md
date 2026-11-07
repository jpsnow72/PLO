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
| `ENGINE_BIN`     | `../engine/target/release` (relative)     | Directory containing `solve-river` / `solve-turn` |
| `DATA_DIR`       | `./data`                                  | Jobs + library storage                    |
| `JOB_TIMEOUT_MS` | `1800000` (30 min)                        | Per-solve wall-clock cap                  |

## Endpoints

| Method | Path                    | Behaviour                                                                 |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/solves`           | Body = engine spot JSON. Returns `202` + job record. Board with 5 cards → `solve-river`, 4 cards → `solve-turn`, 3 cards → `422` (flop solver is ticket E4, not in the engine yet). |
| GET    | `/api/solves/:id`       | Job record: `status` (`queued`/`running`/`done`/`error`), `nash_distance_pct` + `iterations` when done, `error` when failed. |
| GET    | `/api/solves/:id/result`| The finished solve JSON (engine output, verbatim). `409` until done.     |
| GET    | `/api/jobs`             | All job records known to this process.                                    |
| GET    | `/api/library`          | Finished solves in `DATA_DIR/library` (id, board, kind, Nash distance, iterations, size). |
| GET    | `/api/library/:id`      | One library solve JSON, verbatim.                                         |
| GET    | `/api/health`           | `{ ok, engine_bin, data_dir }`.                                           |

Jobs run **one at a time** (solves are CPU-bound). A finished job's result
is copied into the library, so the library survives restarts; the job
registry itself is in-memory (plus a `job.json` audit file per job under
`DATA_DIR/jobs/<id>/`).

Spot JSON format is the engine's own — see `engine/crates/plo-solve/examples/sample_spot.json`
and `engine/crates/plo-solve/src/json.rs` (`parse_spot_json` / `parse_turn_spot_json`).

## Security note

There is **no authentication** in this slice, by design: the service is
meant to run on localhost or a private network (e.g. the VPS's Tailscale
interface) for a single user. Do not expose it to the public internet
until the login/sync ticket adds real auth.
