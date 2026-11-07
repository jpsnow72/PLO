# ADM1-NOTES — Admin login + solve ingest (ADM-1)

Build-only lane deliverable. Nothing was run on the Muse VM beyond
`node --check` on the three API files (all pass). The coordinator
verifies on a host with the commands in §6.
Branch: `admin-auth-ingest` (based on `ranges-constructed-v1` @ 8843aed,
the verified UI-2 state).

## 1. What was built

| Piece | Location |
| --- | --- |
| Auth primitives: scrypt hash/verify, file-backed session store, cookie helpers | `api/auth.mjs` (new) |
| Password-hash CLI | `api/hash-password.mjs` (new) |
| Login/logout/me routes, write gating, ingest endpoint, credentialed CORS | `api/server.mjs` |
| Auth + ingest documentation, env vars | `api/README.md` |
| UI client: `fetchAuthMe / login / logout`, `credentials: 'include'` on all API calls | `ui/src/lib/api.ts` |
| `AuthState` type | `ui/src/lib/types.ts` |
| Store: `isAdmin / authEnabled / probeAdmin / setAdmin` | `ui/src/store/useStore.ts` |
| App: one-shot session probe on load, conditional Admin nav item, `/admin` route | `ui/src/App.tsx` |
| Login page: real admin password login (+ the pre-existing local display name, kept separate) | `ui/src/pages/Login.tsx` |
| Admin page (new): session state, real library stats, runner placeholder | `ui/src/pages/Admin.tsx` |
| Solver: a 401 on submit becomes a "Log in to add solves" prompt, not a raw error | `ui/src/pages/Solver.tsx` |
| Dashboard sample-slot fix (see §4) | `ui/src/pages/Dashboard.tsx` |

## 2. Auth design (as implemented)

- **Password**: `node api/hash-password.mjs` (password via no-echo TTY
  prompt, piped stdin, or `ADMIN_PASSWORD` env) prints
  `scrypt$16384$8$1$<salt b64>$<key b64>` — node:crypto scrypt, 16-byte
  random salt, 32-byte key. The brief sketched `scrypt$<salt>$<hash>`;
  the implemented format additionally embeds the cost parameters so
  they can be raised later, and the parser also accepts the 3-field
  form with default parameters. The server reads the string from
  `ADMIN_PASSWORD_HASH`. Verification derives with the embedded params
  and compares with `timingSafeEqual`.
- **Sessions**: login creates a 32-byte random token (base64url). Only
  its SHA-256 hash is stored, in `DATA_DIR/auth-sessions.json`
  (`{created_at, expires_at}`, 30-day expiry, pruned on load, persisted
  via temp-file + rename). Cookie `plo_admin`: HttpOnly, SameSite=Lax,
  `Secure` iff the request is HTTPS or `X-Forwarded-Proto: https`.
  Logout deletes the server-side record (not just the cookie).
- **Failures**: wrong password → generic `401 {"error":"Invalid password"}`
  after a constant 250 ms delay. No distinction between "no such
  account / bad hash / wrong password" anywhere.
- **Gating**: `POST /api/solves` and `POST /api/library/ingest` call
  `requireAdmin` before reading the body. (The brief's conditional
  `POST /api/library/import` does not exist in this codebase — nothing
  to gate there.) All GETs stay public. Job records and job-produced
  library meta are written exactly as before (byte-compatible);
  authenticated flows change nothing about solve behaviour.
- **Disabled auth — LOUD, per the brief**: with `ADMIN_PASSWORD_HASH`
  unset, auth is DISABLED and the writes are OPEN. Three surfaces say
  so: (1) a boxed `WARNING: ADMIN AUTH IS DISABLED …` banner in the
  server startup log; (2) `GET /api/auth/me` returns
  `{admin:true, auth_enabled:false}` and the Admin page renders an
  amber alert with the same message; (3) `api/README.md` documents the
  state and its local-dev-only intent. Login attempts in this mode get
  a `400` explaining there is nothing to log in to. A *malformed* hash
  value fails CLOSED instead (writes gated, all logins fail, error
  logged) — a typo can never silently open the service.

## 3. Ingest design (as implemented)

`POST /api/library/ingest` (admin-gated):

- Body `{spot, result}`. `spot` must be an object whose `id` matches
  `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (it becomes the library file name —
  no traversal). `result` must carry `board` (string),
  `exploitability.nash_distance_pct` (number) and `iterations`
  (number); envelope problems are `400`, solve-shape problems `422`.
- Body cap: `INGEST_MAX_MB` env, default 512 → `413` beyond it
  (checked against Content-Length up front and again while streaming;
  the body is buffered in memory — noted in the README).
- Storage: `DATA_DIR/library/<spot.id>.json` holds the result JSON;
  the `.meta.json` mirrors the job-produced meta fields (`id, name,
  kind, street, board, oop_range_set, ip_range_set, nash_distance_pct,
  iterations, finished_at`) and adds `source: "local-runner"`, the
  full `spot` object, and `content_hash`. The existing library list /
  get / Explorer paths read it unchanged.
- Idempotency: `content_hash = sha256(spot.id + "\n" + JSON.stringify(result))`.
  Same id + same hash → `200 {status:"exists"}` and the stored files
  are not touched. Same id + different result → overwrite,
  `200 {status:"updated"}`. New id → `201 {status:"created"}`.
- Name fallback: `spot.name` if a non-empty string, else
  `Solve · <board>`; kind from `spot.kind` when valid, else derived
  from the board.

## 4. The Dashboard wart — what it actually was

Root cause found by comparing the two sample paths and by fetching the
live deployment:

- The sample file itself is fine: `GET https://plo-gto.pages.dev/sample-river-solve.json`
  returns the valid 12-node fixture, and the identical `fetchSampleSolve`
  + `parseSolve` pair powers the Explorer's working sample.
- The Dashboard only fetched the sample as a *fallback*, chained inside
  the `catch` of the library/jobs probe — and rendered the Library slot
  from a single nullable `sampleCard` state. `offline` flips true the
  moment the API probe fails, but the sample fetch (a second, sequential
  request) resolves later, so for the entire window in between the slot
  rendered **"Sample unavailable."** — i.e. the failure text doubled as
  the loading state. Worse, the fallback's `catch {}` swallowed any
  real failure silently, so a slow or failed fetch was indistinguishable
  from a missing sample. (On the coordinator's text snapshot of the
  deployed page, that window is exactly what got captured.)

Fix: the sample now has an explicit lifecycle in the Dashboard
(`sampleState: idle | loading | ready | error`, plus the retained error
message). The slot shows "Loading the bundled sample…" while fetching,
the card when ready, and an honest "could not be loaded (<reason>)"
only after a settled failure. No text claims unavailability while a
load is in flight, and failures are no longer swallowed.

## 5. CORS / cookie note (v1 position, also in api/README.md)

The Pages site and the VPS API are different origins. Implemented:
the UI sends `credentials: 'include'` on every API call; the API echoes
`Access-Control-Allow-Credentials` only when the request `Origin`
exactly matches `ALLOWED_ORIGIN` (otherwise the historical `*`).
Documented limit, deliberately not papered over: a `SameSite=Lax`
cookie is not attached to cross-site fetches, so the credentialed flow
works when the API is reached same-site (Pages rewrite/proxy, sibling
subdomain, Vite dev proxy, localhost) — public-page→VPS wiring remains
a separate deployment step, and the local runner (which logs in against
the API it pushes to) is unaffected.

## 6. Coordinator verification commands (on a host, from the tree root)

```bash
# Syntax + UI build:
node --check api/server.mjs && node --check api/auth.mjs && node --check api/hash-password.mjs
cd ui && npm install && npm run build && cd ..

# Test hash (env route — no interactive prompt needed):
cd api
ADMIN_PASSWORD='test-pass-123' node hash-password.mjs   # copy the scrypt$... line

# Start with auth enabled, scratch data dir:
ADMIN_PASSWORD_HASH='<paste the scrypt$... line>' DATA_DIR=/tmp/plo-adm1-test PORT=8789 node server.mjs &
sleep 1
curl -s localhost:8789/api/health
# -> { ..., "auth_enabled": true }

# Writes gated, /me is 401:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8789/api/solves -H 'Content-Type: application/json' -d '{}'
# -> 401
curl -s -o /dev/null -w '%{http_code}\n' localhost:8789/api/auth/me
# -> 401

# Wrong password -> generic 401, no Set-Cookie:
curl -s -i -X POST localhost:8789/api/auth/login -H 'Content-Type: application/json' -d '{"password":"nope"}'
# -> 401 {"error":"Invalid password"}

# Right password -> 200 + HttpOnly cookie; session works:
curl -s -i -c /tmp/adm1-cookies.txt -X POST localhost:8789/api/auth/login -H 'Content-Type: application/json' -d '{"password":"test-pass-123"}'
# -> 200 {"admin":true} with Set-Cookie: plo_admin=...; HttpOnly; SameSite=Lax
curl -s -b /tmp/adm1-cookies.txt localhost:8789/api/auth/me
# -> {"admin":true,"auth_enabled":true}

# Authenticated solve submission (narrow river spot JSON — reuse the
# known 6-combo smoke spot from earlier verifications):
curl -s -b /tmp/adm1-cookies.txt -X POST localhost:8789/api/solves -H 'Content-Type: application/json' -d '<spot json>'
# -> 202 job record; poll GET /api/solves/<id> until done

# Ingest the bundled sample solve, twice:
cd ..   # tree root
python3 -c "
import json
result = json.load(open('ui/public/sample-river-solve.json'))
payload = {'spot': {'id': 'adm1-smoke-sample', 'name': 'ADM-1 smoke sample', 'board': result['board']}, 'result': result}
json.dump(payload, open('/tmp/adm1-ingest.json', 'w'))
print('payload written')
"
curl -s -b /tmp/adm1-cookies.txt -X POST localhost:8789/api/library/ingest -H 'Content-Type: application/json' --data-binary @/tmp/adm1-ingest.json
# -> 201 {"status":"created","id":"adm1-smoke-sample", ...}
curl -s -b /tmp/adm1-cookies.txt -X POST localhost:8789/api/library/ingest -H 'Content-Type: application/json' --data-binary @/tmp/adm1-ingest.json
# -> 200 {"status":"exists", ...}
curl -s localhost:8789/api/library | grep -o adm1-smoke-sample | head -1
curl -s localhost:8789/api/library/adm1-smoke-sample | head -c 120
# Unauthenticated ingest:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8789/api/library/ingest -H 'Content-Type: application/json' -d '{}'
# -> 401

# Logout kills the server-side session (not just the cookie):
curl -s -b /tmp/adm1-cookies.txt -c /tmp/adm1-cookies.txt -X POST localhost:8789/api/auth/logout -H 'Content-Type: application/json' -d '{}'
curl -s -b /tmp/adm1-cookies.txt -o /dev/null -w '%{http_code}\n' -X POST localhost:8789/api/solves -H 'Content-Type: application/json' -d '{}'
# -> 401
curl -s -b /tmp/adm1-cookies.txt localhost:8789/api/auth/me
# -> 401

# Disabled-auth mode (second instance): banner + open writes + me reports it:
DATA_DIR=/tmp/plo-adm1-open PORT=8790 node server.mjs &
# startup log shows the WARNING: ADMIN AUTH IS DISABLED banner
curl -s localhost:8790/api/auth/me
# -> {"admin":true,"auth_enabled":false}
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8790/api/auth/login -H 'Content-Type: application/json' -d '{"password":"x"}'
# -> 400 (explains auth is not enabled)

# Oversize guard:
INGEST_MAX_MB=1 ADMIN_PASSWORD_HASH='<paste>' DATA_DIR=/tmp/plo-adm1-big PORT=8791 node server.mjs &
# repeat the ingest with the step-5 cookie jar against :8791 (log in there first)
# with a body padded past 1 MB -> 413
```

UI click-through (against the auth-enabled API on :8789, via the Vite
dev proxy or a preview server): /login with a wrong password shows the
generic error; the right password returns you to the previous screen;
the nav gains **Admin**; /admin shows the session card, real library
counts/storage (including the ingested smoke sample), and the runner
placeholder; log out, submit in the Solver → the "Log in to add solves"
prompt appears instead of a raw error; take the API down and reload the
Dashboard → "Loading the bundled sample…" resolves to the sample card,
never "Sample unavailable".

## 7. What could not be verified statically

- TypeScript compilation — no `tsc`/Vite run here (no installs allowed).
  Types were written conservatively (runtime guards on auth responses,
  no `any` on parsed JSON), but `npm run build` on the host is the real
  check.
- All runtime auth behaviour: scrypt verify round-trip, session
  persistence/pruning across restarts, Set-Cookie attributes in real
  responses, the 250 ms failure delay, CORS echo with credentials, and
  the 413 path. The code was reviewed line-by-line but only
  `node --check` was executed.
- React rendering of the new Login/Admin pages and the Solver prompt
  (no browser here) — the click-through list in §6 covers it.
- Whether the Dashboard loading state is *perceptible* on the real
  Pages deployment (the sample is 5.6 KB; on a fast connection the
  loading text may never paint — which is fine; the guarantee is that
  "unavailable" can no longer appear before a settled failure).
