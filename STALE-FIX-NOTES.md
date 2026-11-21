# STALE-FIX-NOTES — issue #42: stale cached app shells vs moved preflop API

## Symptom

A browser holding a cached old app shell shows "Preflop library
unavailable — Not found" on the Preflop page, while a fresh browser is
fine. The first Preflop UI fetched `GET /api/preflop/` (index) and
`GET /api/preflop/set/<id>` (singular); the API later moved to
`/api/preflop/index` and `/api/preflop/sets/<id>`, so the old shell's
requests fell through to the API catch-all 404 (`{ error: 'Not found' }`).
The Pages HTML shipped with no `Cache-Control`, so heuristic caching let
browsers keep the retired shell long past the deploy that replaced it.

## Fix 1 — API legacy aliases (`api/server.mjs`)

Both legacy paths now route into the *same* handler code as their modern
counterparts — no file-serving logic is duplicated:

- **Index:** the modern route's condition was widened from
  `url.pathname === '/api/preflop/index'` to also accept
  `url.pathname === '/api/preflop/'`. Same `sendJsonFile(.../index.json)`
  call, so status and body are byte-identical by construction.
- **Set:** the parts-based route's condition now accepts
  `parts[2] === 'sets' || parts[2] === 'set'`. The id is `parts[3]` in
  both shapes, so the existing lookup (`findPreflopSetEntry`), the
  `Unknown preflop range set id "<id>"` 404 body, the unsafe-path 500,
  and the file serving are all shared verbatim.

Both routes are also listed in the route table in the `server.mjs`
header comment, marked as legacy aliases (#42).

## Fix 2 — Pages cache headers (`ui/public/_headers`)

The Pages project root is `ui/` with build output `ui/dist`
(see WIRE-NOTES.md); Vite copies `ui/public/` into the dist root on
build, so `ui/public/_headers` lands at `ui/dist/_headers`, where
Cloudflare Pages reads it. (Verified against the repo layout: `ui/`
holds `vite.config.ts`, `index.html`, `public/`, and the `functions/`
directory Pages already picks up from the same root.)

Rules:

- `/`, `/index.html`, and every SPA route from `ui/src/App.tsx`
  (`/explore`, `/explorer`, `/solver`, `/preflop`, `/starting-hands`,
  `/quick-review`, `/quiz`, `/heuristics`, `/settings`, `/login`,
  `/admin`, `/admin/runner`) → `Cache-Control: no-cache`. The shell is
  revalidated on every load, so a deploy's new shell (and its new API
  paths) is picked up immediately instead of being heuristically cached.
- `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`.
  Vite fingerprints these filenames, so a changed asset is a new URL.
- Nothing for `/api/*`: the Pages Function (`ui/functions/api/[[path]].js`)
  owns those responses.

Maintenance note: the SPA routes are enumerated one block per route
(Pages `_headers` has no multi-path block), so a new client route should
get a matching `no-cache` block here when it ships.

## Tests (`api/preflop-legacy-paths.test.mjs`)

New file in the existing api suite (`node --test api/*.test.mjs`),
following the `library-sampled.test.mjs` pattern: boots the real server
against a scratch `PREFLOP_DIR` seeded with a one-set index
(`test-btn-rfi`), plus a scratch `DATA_DIR`. Three cases, each comparing
the legacy and modern paths directly:

1. `GET /api/preflop/` vs `GET /api/preflop/index` — both 200, bodies
   byte-identical, and the body is the seeded index.
2. `GET /api/preflop/set/test-btn-rfi` vs `GET /api/preflop/sets/test-btn-rfi`
   — both 200, bodies byte-identical, and the body parses to the seeded
   set doc.
3. Unknown id `no-such-set` on both shapes — both 404 with identical
   bodies (the shared `Unknown preflop range set id` error).

No existing tests were touched. Local verification on the build VM was
limited to `node --check` on both touched JS files (clean); the full
suite run is the coordinator gate's, per the lane brief.
