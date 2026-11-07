# RUN1-NOTES — catalog queue engine + auto-upload (RUN-1)

Build-only lane deliverable. On the Muse VM: `node --check` on all four
API files (pass), plus ONE offline module-level verification of the new
expansion module against the catalog data (§5) — no server was started,
nothing was installed or built. The coordinator verifies end-to-end on a
host with the two-instance smoke in §6.
Branch: `local-runner` (based on ADM-1 `admin-auth-ingest` @ f255bf9).

**Data swap (per the brief):** the base tree's `data/preflop` predated
ranges v1.1, so `data/preflop` (44 sets + index + class-table) and
`data/library/spot-catalog.json` (300 entries, all `ready`) were taken
from `~/workspace/plo-catalog-tree`. The catalog's tools/ and notes were
not copied.

## 1. What was built

| Piece | Location |
| --- | --- |
| Capped set expansion (`expandRangeSetCapped`), legacy uncapped expansion, orbit enumeration, mulberry32 + FNV-1a | `api/ranges-expand.mjs` (new) |
| Uploader: runner-config load/save, ingest push | `api/uploader.mjs` (new) |
| Runner login CLI (password prompt, stores session cookie) | `api/runner-login.mjs` (new) |
| Server: expander refactor, internal job scheduler, capped solve submissions, catalog + queue endpoints, queue worker, upload retries | `api/server.mjs` |
| Docs: queue env vars, capped expansion, runner section, offline/crash contracts | `api/README.md` |

No new dependencies (Node stdlib only; the uploader uses global `fetch`).

## 2. Translation mapping (catalog entry → engine spot)

Implemented in `translateCatalogEntry` (server.mjs):

| Catalog entry field | Engine spot / job field |
| --- | --- |
| `board` | `board` (3/4/5 cards route to solve-flop/turn/river as before) |
| `pot_chips` / `stacks_chips` | `pot` / `stacks` (the entry's values are already the root state after its declared `line`) |
| `<side>_set` + `range_action_<side>` + `cap_per_side` | `expandRangeSetCapped({ setId, action, cap, mode, seed, base })` → `<side>_range` |
| 3-bet continuation side (set context `vs_three_bet`) | product base: the opener's RFI set, action `raise` (table below) |
| `size_menu[<street>]` for every street present | `<street>_bet_sizes`, `<street>_raise_sizes`, `<street>_max_raises` = 2, `<street>_include_all_in` |
| `size_menu[<root street>]` | also the generic `bet_sizes` / `raise_sizes` / `max_raises` / `include_all_in` fallbacks |
| `tier` | `balanced` → `target_exploitability_pct` 0.3; `precise` → 0.1 |
| (env) | `max_iterations` = `QUEUE_SMOKE_MAX_ITERATIONS` if set, else `QUEUE_MAX_ITERATIONS` (default 2,000,000) |
| — | job meta: `name` = `Catalog · <spot id>`, `spot_id`, both range-set ids, and the per-side `range_expansion` summary (set, action, cap, mode, seed, kept/total combos, coverage %, base) — also written into the library `.meta.json` |

Range mode comes from `QUEUE_RANGE_MODE` (default `top`; Justin's
top-vs-sample decision is still open — `sample` is fully supported).
Seed = FNV-1a(`spot id`), salted with `QUEUE_RANGE_SEED` when set, so a
spot's sampled range is stable across runs and machines.

**3-bet base-set mapping** (derived generically: same table size, the
continuation set's own `position`, that position's `rfi` set — exactly
the catalog generator's pairings):

| Continuation set (action `call`) | Base set (action `raise`) |
| --- | --- |
| `constructed-v1.1-6max-btn-vs-bb-3bet` | `constructed-v1-6max-btn-rfi` |
| `constructed-v1.1-6max-btn-vs-sb-3bet` | `constructed-v1-6max-btn-rfi` |
| `constructed-v1.1-6max-co-vs-btn-3bet` | `constructed-v1-6max-co-rfi` |

The 3-bettor's own side needs no base: it is the `three_bet` slice of a
`vs_rfi` set, expanded plainly.

## 3. Coverage formula (as implemented)

Identical to the catalog generator's (see the `ranges-expand.mjs`
header): every concrete combo of a class carries the class's frequency
for the chosen action — or, with a base set, the **product** of the base
class frequency and the conditional class frequency.
`coverage_pct = 100 × (sum of kept combo weights) ÷ (sum of all
positive combo weights)`, computed **before** renormalisation. When a
cap removes combos, kept weights are scaled by `total ÷ kept` so the
kept range carries the full action mass (relative frequencies unchanged;
the engine normalises range weights, so the scale is solve-invariant).
Uncapped expansions are NOT scaled — byte-compatible with ADM-1 output.

Modes: `top` ranks by (weight desc, combo string asc). `sample` is
Efraimidis–Spirakis weighted sampling without replacement
(key = u^(1/w), u from mulberry32(seed)) over the combo list sorted by
combo string — same inputs → same sample on any machine.

## 4. Queue, worker, uploader — behaviour notes

- **Endpoints:** `GET /api/catalog` (public; entries annotated with
  `library_status` present/absent **by spot id** and `queue_status`),
  `GET /api/queue` (public), `POST /api/queue` and
  `POST /api/queue/control` (admin-gated like the other writes).
  Enqueue validates against the catalog: one unknown id fails the whole
  request with `400` + the `unknown` list. Duplicates are reported in
  `skipped` with their state; re-adding a `failed` item resets it to
  `queued` (documented retry path — the brief's item lifecycle has no
  other way to retry a failure).
- **Persistence:** `DATA_DIR/queue.json`, temp-file + rename on every
  transition, saves serialised through a promise chain.
- **Crash contract:** on startup, `running` → `queued` (job id/started
  cleared); `done` untouched. The worker marks an item done **only**
  after its job is `done` AND `DATA_DIR/library/<job id>.json` exists;
  a job that reports done without a library entry fails the item with an
  explicit error instead. Failed jobs mark the item `failed` with the
  engine error. Partial results are never ingested (ingest only ever
  sends a finished job's `result.json`).
- **Job scheduling:** the ADM-1 promise chain became a small scheduler.
  Limit is 1 when the queue is disabled (historical behaviour) and the
  queue's `concurrency` (1–8) when enabled — direct `POST /api/solves`
  submissions share the pool.
- **Uploader:** after an item completes, and on startup + every
  `QUEUE_UPLOAD_RETRY_MIN` (default 15) minutes, done-but-not-uploaded
  items are pushed to `{central_url}/api/library/ingest` with the stored
  `plo_admin` cookie. `created`/`exists`/`updated` → `uploaded` (the
  ingest status is kept in `upload_detail`); network/401/5xx → `failed`
  with the reason on the item (a 401 message tells the operator to
  re-run `runner-login`). No `runner-config.json` → `skipped`, logged as
  a state, never an error; if a config appears later the retry loop
  picks skipped items up.
- **runner-login:** `node api/runner-login.mjs [--central <url>]
  [--data-dir <dir>]`; password via no-echo TTY prompt (piped stdin
  reads the first line, for scripted smokes); stores
  `{ central_url, session_cookie }` atomically and reminds about file
  permissions (it does not chmod — Windows ACLs differ).

## 5. Offline verification actually performed here

A throwaway `node --input-type=module` script imported ONLY
`ranges-expand.mjs` (no server) and cross-checked the capped expander
against the shipped catalog:

- **All 600 catalog range sides** (300 entries × 2, top mode, catalog
  caps, product bases for continuation sides): `coverage_pct` and
  `kept_combos` match the catalog's published values **exactly — 0
  mismatches**. This pins the coverage formula, the orbit enumeration,
  and the 3-bet product convention against an independent (Python)
  implementation.
- **Sampling determinism:** seed 42 twice → byte-identical range;
  seed 43 → different range; BTN RFI sample coverage 0.2248% vs top
  0.2262% at cap 300 (sane: a representative draw, not the peak slice).
- **Legacy path:** uncapped BTN RFI expansion = 135,358 combos, action
  `raise` (matches the catalog's `source_action_combos_ip`).
- One bug found and fixed by this check: the expander now normalises
  its preflop dir with `path.resolve` (a relative dir broke the
  path-traversal guard's prefix test).

Performance note: a full-range capped expansion enumerates ~271k combos
and takes roughly 0.25 s per side in Node on this VM — fine once per
solve; the 600-side sweep took ~2.5 min only because it expands
everything.

## 6. Coordinator smoke commands (on a host, from the tree root)

Prereqs: engine built (`cd engine && cargo build --release`), the API
files syntax-checked (`node --check api/*.mjs` — the glob expands to
auth/hash-password/ranges-expand/runner-login/server/uploader).

```bash
cd api
# Central instance (8790) WITH admin auth:
ADMIN_PASSWORD='central-pass-123' node hash-password.mjs   # copy the scrypt$... line
ADMIN_PASSWORD_HASH='<paste>' DATA_DIR=/tmp/plo-run1-central PORT=8790 \
  node server.mjs > /tmp/run1-central.log 2>&1 &
# Runner instance (8791), queue on, tiny iteration cap:
DATA_DIR=/tmp/plo-run1-runner PORT=8791 QUEUE_ENABLED=1 \
  QUEUE_SMOKE_MAX_ITERATIONS=25 JOB_TIMEOUT_MS=600000 \
  node server.mjs > /tmp/run1-runner.log 2>&1 &
sleep 1
curl -s localhost:8790/api/health   # auth_enabled: true
curl -s localhost:8791/api/health   # queue_enabled: true

# Queue writes are gated on the RUNNER too (when its own hash is set);
# for the smoke the runner runs in local dev mode (no hash) — note the
# WARNING banner in /tmp/run1-runner.log. Enqueue one narrow river spot:
SPOT=6max-co-vs-btn-3bet-as-4d-3c-6s-8s-river
curl -s localhost:8791/api/catalog | head -c 300; echo
curl -s -X POST localhost:8791/api/queue -H 'Content-Type: application/json' \
  -d "{\"spot_ids\":[\"$SPOT\"]}"
# -> {"added":["6max-co-vs-btn-3bet-...-river"],"skipped":[], ...}
curl -s -X POST localhost:8791/api/queue -H 'Content-Type: application/json' \
  -d '{"spot_ids":["nope"]}'
# -> 400 {"error":"Unknown catalog spot id(s): nope","unknown":["nope"]}

# Log the runner in to the central (piped password route):
printf 'central-pass-123\n' | DATA_DIR=/tmp/plo-run1-runner \
  node runner-login.mjs --central http://127.0.0.1:8790
# -> "Runner login saved to /tmp/plo-run1-runner/runner-config.json"
chmod 600 /tmp/plo-run1-runner/runner-config.json

# Watch the item go queued -> running -> done -> uploaded
# (25 iterations on capped 1,500-combo river ranges: allow a few minutes):
watch -n 2 "curl -s localhost:8791/api/queue | head -c 600"
curl -s localhost:8791/api/queue
# -> item state "done", upload_status "uploaded", nash_distance_pct set

# The central library gained the spot, filed under the SPOT id:
curl -s localhost:8790/api/library | grep -o "$SPOT" | head -1
curl -s localhost:8790/api/library/$SPOT | head -c 120; echo

# Crash recovery: enqueue a second spot, wait until it shows "running",
# then kill the runner mid-solve and restart it:
curl -s -X POST localhost:8791/api/queue -H 'Content-Type: application/json' \
  -d '{"spot_ids":["6max-co-vs-btn-3bet-ah-5d-2c-7s-9s-river"]}'
pkill -f 'PORT=8791' ; pkill -f 'node server.mjs'  # or kill by PID
DATA_DIR=/tmp/plo-run1-runner PORT=8791 QUEUE_ENABLED=1 \
  QUEUE_SMOKE_MAX_ITERATIONS=25 JOB_TIMEOUT_MS=600000 \
  node server.mjs > /tmp/run1-runner2.log 2>&1 &
grep recovered /tmp/run1-runner2.log
# -> "queue: recovered 1 interrupted item(s) back to queued"
curl -s localhost:8791/api/queue
# -> first spot still "done"/"uploaded" (done stays done);
#    second spot back to "queued" (then running again)

# Controls:
curl -s -X POST localhost:8791/api/queue/control -H 'Content-Type: application/json' -d '{"action":"pause"}'
curl -s -X POST localhost:8791/api/queue/control -H 'Content-Type: application/json' -d '{"action":"set_concurrency","value":2}'
curl -s -X POST localhost:8791/api/queue/control -H 'Content-Type: application/json' -d '{"action":"resume"}'
curl -s -X POST localhost:8791/api/queue/control -H 'Content-Type: application/json' -d '{"action":"set_concurrency","value":9}'
# -> 400 (value must be 1..8)

# Offline contract: stop the runner, delete runner-config.json, restart,
# enqueue the third river spot — it completes with upload_status
# "skipped"; restore the login and it uploads on the retry (restart or
# QUEUE_UPLOAD_RETRY_MIN).
```

UI click-through is RUN-2's surface; the API shapes above are what it
consumes (`GET /api/catalog`, `GET /api/queue`, the two POSTs).

## 7. What could not be verified statically

- **No server was started here** (per the brief), so: the queue worker
  loop end-to-end, scheduler concurrency against real engine processes,
  the settle path's library-existence check, upload + retry against a
  live central, `runner-login` against a live login endpoint (including
  `getSetCookie` behaviour of this Node version's fetch), and the
  startup recovery path are all code-reviewed but unexecuted. §6 covers
  each of them.
- **`fetch` availability** assumes a modern Node (≥18) on the runner PC
  — the same assumption the coordinator smokes will exercise.
- **Translation spot fields vs the engine parsers** were mapped from
  `json.rs` / `spot.ts` readings (per-street `<street>_bet_sizes` etc.
  with generic fallbacks), not by running a catalog spot through a
  binary here. The §6 smoke's river spot exercises turn/river parsing; a
  flop catalog spot (e.g. `6max-btn-vs-bb-3bet-9s-8d-7c-flop`) is the
  follow-up check for the flop parser + the 3-bet product ranges at
  solve time.
- **JOB_TIMEOUT_MS vs library-scale solves:** queue jobs inherit the
  server-wide `JOB_TIMEOUT_MS` (30 min default). Real flop catalog
  solves run for hours — the runner's start command must raise it
  (RUN-2 packaging should set it to days). Noted, not changed: the env
  already exists and the queue adds no second timeout.
- **Queue/catalog read cost:** `GET /api/catalog` calls `listLibrary()`
  per request (reads every library file's JSON). Fine at smoke scale;
  if the library grows to hundreds of multi-MB flop trees the RUN-2 UI
  polling may want a lighter annotation — flagged, not optimised.
