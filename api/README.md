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

| Var                   | Default                                   | Meaning                                   |
| --------------------- | ----------------------------------------- | ----------------------------------------- |
| `PORT`                | `8787`                                    | Listen port                               |
| `HOST`                | `127.0.0.1`                               | Bind address                              |
| `ENGINE_BIN`          | `../engine/target/release` (relative)     | Directory containing `solve-river` / `solve-turn` / `solve-flop` |
| `DATA_DIR`            | `./data`                                  | Jobs + library storage                    |
| `PREFLOP_DIR`         | `../data/preflop` (relative)              | Preflop range-set data (index, sets, class table) |
| `JOB_TIMEOUT_MS`      | `1800000` (30 min)                        | Per-solve wall-clock cap                  |
| `ADMIN_PASSWORD_HASH` | *(unset — auth DISABLED, see below)*      | scrypt hash of the admin password, from `node hash-password.mjs` |
| `ALLOWED_ORIGIN`      | *(unset)*                                 | Exact origin allowed to make credentialed cross-origin calls (e.g. the Pages site origin) |
| `INGEST_MAX_MB`       | `512`                                     | Max body size for `POST /api/library/ingest` (flop trees are big) |
| `CATALOG_PATH`        | `../data/library/spot-catalog.json`       | Spot catalog for `GET /api/catalog` and the queue                 |
| `UI_DIR`              | `../ui/dist` (relative)                   | Built UI served same-origin for non-API GET paths (SPA fallback to `index.html`); ignored when no build exists there |
| `QUEUE_ENABLED`       | *(unset — queue worker off)*              | `1` starts the catalog queue worker + upload retries              |
| `QUEUE_RANGE_MODE`    | `top`                                     | Catalog range-cap mode: `top` or `sample`                         |
| `QUEUE_RANGE_SEED`    | *(unset)*                                 | Optional salt for per-spot sampling seeds                         |
| `QUEUE_MAX_ITERATIONS`| `2000000`                                 | Iteration ceiling for catalog solves                              |
| `QUEUE_SMOKE_MAX_ITERATIONS` | *(unset)*                          | Smoke override for the above (coordinator verification)           |
| `QUEUE_UPLOAD_RETRY_MIN` | `15`                                   | Minutes between upload retries for done-but-not-uploaded items (`0` disables the timer; startup retry still runs) |

## Endpoints

| Method | Path                    | Behaviour                                                                 |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/solves`           | **[admin]** Body = engine spot JSON. Returns `202` + job record. Board with 5 cards → `solve-river`, 4 cards → `solve-turn`, 3 cards → `solve-flop`. |
| GET    | `/api/solves/:id`       | Job record: `status` (`queued`/`running`/`done`/`error`), `nash_distance_pct` + `iterations` when done, `error` when failed. |
| GET    | `/api/solves/:id/result`| The finished solve JSON (engine output, verbatim). `409` until done.     |
| GET    | `/api/jobs`             | All job records known to this process.                                    |
| GET    | `/api/library`          | Finished solves in `DATA_DIR/library` (id, board, kind, Nash distance, iterations, size). |
| GET    | `/api/library/:id`      | One library solve JSON, verbatim.                                         |
| POST   | `/api/library/ingest`   | **[admin]** Body = `{ spot, result }` (see "Ingesting finished solves"). Stores a solve produced elsewhere (the local runner) in the library. Idempotent per (spot id, result). |
| GET    | `/api/preflop/index`    | The preflop range-set index (`data/preflop/index.json`), verbatim.        |
| GET    | `/api/preflop/sets/:id` | One range set file, verbatim. The id must match an index entry (the served path comes from the index, never from the request), so there is no path traversal. |
| GET    | `/api/preflop/class-table` | The per-class feature/equity table (`data/preflop/class-table.json`), verbatim. `404` with an explanatory error until `build-ranges` has generated it on a host. |
| GET    | `/api/catalog`          | The spot catalog, each entry annotated with `library_status` (`present`/`absent` in the local library, by spot id) and `queue_status` / `queue_upload_status`. |
| GET    | `/api/queue`            | `{ items, concurrency, paused, enabled }` — the persistent catalog queue. |
| POST   | `/api/queue`            | **[admin]** Body = `{ spot_ids: [...] }`. Unknown ids → `400` listing them. New spots are appended; already queued/running/done ids are reported in `skipped`, not duplicated; re-adding a `failed` spot resets it to `queued` (the retry path). |
| POST   | `/api/queue/control`    | **[admin]** Body = `{ action: "pause" \| "resume" \| "remove", spot_id? }` or `{ action: "set_concurrency", value: 1..8 }`. Removing a `running` item is refused (`409`). |
| POST   | `/api/auth/login`       | Body = `{ password }`. On success: `200 { admin: true }` + `plo_admin` session cookie. Wrong password: generic `401` after a small constant delay. |
| POST   | `/api/auth/logout`      | Deletes the session (if any) and clears the cookie. Always `200`.          |
| GET    | `/api/auth/me`          | `200 { admin: true, auth_enabled }` with a valid session (or when auth is disabled), else `401`. |
| GET    | `/api/runner/status`    | `{ queue_enabled, concurrency, paused, upload_configured, central_url }` for the admin runner UI. `central_url` is the configured central base URL from `runner-config.json` (or `null`); the session cookie is never exposed. |
| GET    | `/api/health`           | `{ ok, engine_bin, data_dir, preflop_dir, auth_enabled }`.                |
| GET    | *(any non-API path)*    | The built UI from `UI_DIR` when a build exists there, with SPA fallback to `index.html` for client-side routes; JSON `404` otherwise. |

**[admin]** = requires an admin session when auth is enabled (`401` JSON
otherwise). All GET endpoints stay public.

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

**Capped expansion (RUN-1):** adding any of `<side>_range_cap` (positive
integer), `<side>_range_mode` (`top` | `sample`), `<side>_range_seed`,
`<side>_range_action`, `<side>_range_base_set` or
`<side>_range_base_action` switches that side to the capped expander
(`api/ranges-expand.mjs`):

- `top` keeps the highest-weight combos (deterministic tie-break);
  `sample` draws a deterministic seeded weighted sample **without
  replacement** across the full weighted combo list — the same
  spot/mode/seed yields the same range on any machine.
- `<side>_range_action` names the set slice explicitly, which is how
  `sb_play` (raise), `vs_rfi` three_bet slices and `vs_three_bet` (call)
  sides are loaded deliberately instead of by the v1 context rule.
- `<side>_range_base_set` (with `<side>_range_base_action`, default
  `raise`) makes combo weights the **product** base-freq × action-freq —
  required for the v1.1 continuation sets, whose frequencies are
  conditional on opening.
- When a cap removes combos, the kept weights are renormalised to the
  full action mass (relative frequencies unchanged); the job record's
  `range_expansion` summary stores kept/total combos and the exact
  `coverage_pct` (kept weight ÷ total weight, the catalog's formula).

Jobs run through a small internal scheduler: **one at a time** normally
(solves are CPU-bound), or up to the queue's `concurrency` at once when
`QUEUE_ENABLED=1`. A finished job's result is copied into the library, so
the library survives restarts; the job registry itself is in-memory
(plus a `job.json` audit file per job under `DATA_DIR/jobs/<id>/`).

Spot JSON format is the engine's own — see `engine/crates/plo-solve/examples/sample_spot.json`
and `engine/crates/plo-solve/src/json.rs` (`parse_spot_json` / `parse_turn_spot_json` /
`parse_flop_spot_json`). Flop spots are solved exactly unless the spot JSON requests
bucketing (`buckets` / `bucket_config` / `bucket_count`); flop solves can run far longer
than river/turn jobs, so raise `JOB_TIMEOUT_MS` for wide ranges.

## Admin auth

Adding solves is admin-only; reading is public. There is exactly one
admin account (the password), intended for the owner; further accounts
can be layered on later.

Setup:

```bash
cd ../api
node hash-password.mjs
# -> prompts for the password (no echo) and prints a scrypt$... string
ADMIN_PASSWORD_HASH='scrypt$...' node server.mjs
```

How it works:

- The password exists only as a **scrypt hash** in the server's
  environment. Verification uses `node:crypto` scrypt with a
  constant-time comparison. Failed logins get a generic `401` plus a
  small constant delay — no hint about what failed.
- A successful login creates an opaque 32-byte random **session token**,
  sent to the browser as the `plo_admin` cookie (`HttpOnly`,
  `SameSite=Lax`, `Secure` when the request is HTTPS or arrives with
  `X-Forwarded-Proto: https`). Sessions live server-side in
  `DATA_DIR/auth-sessions.json`, keyed by the token's SHA-256 hash (the
  raw token is never stored), and expire after 30 days.
- **Auth disabled state:** if `ADMIN_PASSWORD_HASH` is unset, auth is
  DISABLED and every write endpoint is open. That is local dev mode only:
  the server prints a loud warning banner at startup, and
  `GET /api/auth/me` reports `{ admin: true, auth_enabled: false }` so
  the UI can warn too. If the variable is set but malformed, the server
  fails **closed** (writes stay gated, all logins fail) and logs an error.

## Ingesting finished solves

`POST /api/library/ingest` (admin) is how the local PC runner adds
finished solves to the library:

```json
{
  "spot":   { "id": "srp-btn-vs-bb-a-high-dry-flop", "matchup": "BTN vs BB",
              "board": "As 7d 2c", "…": "catalog metadata: ranges provenance, cap + coverage, tier" },
  "result": { "…": "the engine solve JSON, verbatim" }
}
```

- Validation: `spot.id` must be a safe id string; `result` must carry
  `board`, `exploitability.nash_distance_pct` and `iterations`.
- The entry is stored exactly like a job-produced one
  (`DATA_DIR/library/<spot.id>.json` + `.meta.json`, same meta fields the
  Explorer already reads), plus `source: "local-runner"`, the full
  `spot` metadata, and a `content_hash`.
- **Idempotent:** the content hash covers `spot.id` + the result.
  Re-ingesting the identical solve returns `200 { status: "exists" }`
  without touching the stored files; the same spot id with a different
  result overwrites and returns `{ status: "updated" }`; a new spot
  returns `201 { status: "created" }`.
- Bodies are capped at `INGEST_MAX_MB` (default 512 MB — flop trees are
  large); larger requests get `413`. The body is buffered in memory, so
  don't raise the cap casually on a small host.

## Admin auth, CORS and cookies

The hosted UI (Cloudflare Pages) and this API are **different origins**.
For v1:

- The UI sends every API call with `credentials: 'include'`, so the
  session cookie travels whenever the browser allows it.
- When the request's `Origin` exactly matches the `ALLOWED_ORIGIN` env
  var, the API echoes that origin with
  `Access-Control-Allow-Credentials: true` (otherwise it keeps the
  historical `Access-Control-Allow-Origin: *`, which browsers will not
  combine with credentials).

The honest limit: the session cookie is `SameSite=Lax`, so browsers will
not attach it to cross-site fetches from the Pages origin to a
*different-site* API host — the credentialed flow works when the API is
reached same-site (a Pages rewrite/proxy in front of the API, a sibling
subdomain, the Vite dev proxy, or localhost), not by calling a bare
cross-site API URL from the page. Wiring the public page to the VPS API
same-site is a separate deployment step; until then the deployed page
runs in its public read/sample mode. The local runner is unaffected: it
logs in against the API it pushes to (its local API, or the VPS API over
the private network) where the cookie is same-site/first-party.

## Local runner queue

The runner is this same service, started on Justin's PC with
`QUEUE_ENABLED=1`. It works the persistent queue of catalog spots:

```bash
QUEUE_ENABLED=1 node server.mjs
```

- **Picking work:** `POST /api/queue { spot_ids }` (admin) appends spots
  from `GET /api/catalog`. The worker translates each catalog entry into
  an engine spot (ranges capped per the entry, sizes from its menu, tier
  → target Nash %) and submits it through the same job path as
  `POST /api/solves`. Up to `concurrency` spots (1–8, default 1) solve at
  once; `POST /api/queue/control` pauses/resumes/removes and sets it.
- **Persistence:** every queue transition is written to
  `DATA_DIR/queue.json` (temp file + rename, so a crash mid-write cannot
  corrupt it).
- **Crash-recovery contract:** an item is `done` only when its result
  exists in the **local** library. If the machine freezes, sleeps or the
  server is killed, items that were `running` revert to `queued` on the
  next start and solve again from scratch — a partial solve is never
  ingested anywhere. `done` items stay done forever.
- **Auto-upload:** when a `runner-config.json` exists (below), each done
  item is pushed to the central library's ingest endpoint. Ingest is
  idempotent by content hash, so retries are safe. Failed uploads record
  the reason on the item and retry on server start and every
  `QUEUE_UPLOAD_RETRY_MIN` minutes.
- **Offline contract:** with **no** `runner-config.json`, uploads are
  `skipped` and the queue still completes everything locally — offline
  is a first-class state, not an error. Logging in later (below) makes
  the retry loop pick the skipped items up.

### Runner login (central upload credentials)

```bash
node api/runner-login.mjs --central http://<central-host>:8787
# prompts for the central admin password (no echo on a TTY)
```

This POSTs to the central server's `/api/auth/login` and stores
`{ central_url, session_cookie }` in `DATA_DIR/runner-config.json`
(`DATA_DIR` from `--data-dir`, the env var, or `./data`). The file holds
a **live session cookie — treat it like a password** (`chmod 600` it on
POSIX; sessions expire after 30 days, then re-run the login). A `401`
from the central ingest means the session died: the item records that,
and re-running the login + the retry loop recovers it.

## Security note

With `ADMIN_PASSWORD_HASH` set, the write surface is gated by the admin
session described above; reads stay public by design (the library is
meant to be browsable). Still run the service on localhost or a private
network (e.g. the VPS's Tailscale interface) unless the deployment has
been deliberately set up for public access — it holds no other accounts,
rate limits, or audit trail yet.
