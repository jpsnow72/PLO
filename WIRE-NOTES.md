# WIRE-1 (repo half) — Pages Function proxy for `/api/*`

Issue #6. This is the repo half of the wiring: it makes the deployed
Cloudflare Pages site reach the VPS API **same-site**, which is the
deployment step `api/README.md` ("Admin auth, CORS and cookies") calls
out as required for the credentialed flow. The origin half (Caddy +
`plo-api.finchlearn.com` in front of `api/server.mjs` on the VPS) is
separate coordinator/host work; this change assumes that origin exists
and serves the API described in `api/README.md`.

## What changed

- **Added `ui/functions/api/[[path]].js`** — a Cloudflare Pages Function
  (catch-all under `/api/`) that forwards every API request to the API
  origin and returns the response untouched.
- **`ui/src/lib/api.ts`: no change.** The client already calls only
  same-origin relative paths (`/api/...`) with `credentials: 'include'`
  and parses `{ error }` JSON bodies into `ApiError`. There was no
  hardcoded base URL or env mechanism to adjust — production becomes
  same-origin purely by adding the Function.

## Routing design

- The Pages project root is `ui/` (build output `ui/dist`), so the
  `functions/` directory beside it is picked up automatically on deploy;
  no wrangler config or `_routes.json` is needed. Only `/api/*` is
  intercepted — every other path keeps serving the static SPA exactly
  as before.
- The Function builds the target as `ORIGIN + pathname + search` from
  the incoming URL (path and query preserved verbatim), forwards the
  method and headers, and streams the request body (`duplex: 'half'`)
  rather than buffering it — `POST /api/library/ingest` payloads can be
  hundreds of MB.
- `Host` and `Content-Length` are stripped from the forwarded headers:
  fetch sets Host from the target URL, and Content-Length is recomputed
  from the streamed body (a copied value can go stale).
- Redirects are **not** followed inside the proxy (`redirect: 'manual'`)
  — an origin redirect, if one ever occurs, reaches the browser as-is.
- Response headers pass through unchanged, with one defensive fix:
  `Set-Cookie` values are re-appended individually via
  `headers.getSetCookie()` when the runtime offers it, because a single
  comma-joined `Set-Cookie` header is unparseable (cookie `Expires`
  values contain commas) and would silently break login.
- No cache headers are added on either leg and no response is cached;
  the origin's own headers are what the browser sees.
- If the origin is unreachable, the Function answers `502` with
  `{ "error": "API origin unreachable" }` — the API's own error shape —
  so the client falls into its existing "engine offline" state instead
  of surfacing a bare Pages 500.
- The origin defaults to `https://plo-api.finchlearn.com` and can be
  overridden per Pages environment with the `API_ORIGIN` variable
  (e.g. previews pointing at a staging box).

## Cookie reasoning

The admin session cookie (`plo_admin`) is `HttpOnly; SameSite=Lax`
(`Secure` on HTTPS). Browsers will not attach a `SameSite=Lax` cookie
to a cross-site `fetch`, so calling a different-site API host directly
from `plo-gto.pages.dev` could never carry the session — that is the
limit documented in `api/README.md`. With this proxy, the browser only
ever talks to the Pages origin: the cookie is set by a first-party
response and sent on first-party requests, and the Function relays it
to the origin as an ordinary `Cookie` header. The API's `ALLOWED_ORIGIN`
CORS path is therefore unnecessary in production (it remains available
for other consumers, unchanged).

## Dev vs prod behaviour

- **Local dev is untouched.** `npm run dev` (Vite) proxies `/api` to
  `http://localhost:8787` per `ui/vite.config.ts`; Pages Functions do
  not exist in that setup, and nothing in the client changed.
- **Production:** `plo-gto.pages.dev/api/*` → this Function →
  `https://plo-api.finchlearn.com/api/*` → Caddy → `api/server.mjs`.
- The Function file is plain `.js` outside `ui/src`, so the gate build
  (`tsc --noEmit && vite build`, tsconfig includes only `src/`) is
  unaffected by it.

## What the coordinator must verify end-to-end after deploy

1. `GET https://plo-gto.pages.dev/api/health` → `200` with the API's
   health JSON (proves proxy + origin + Caddy TLS in one shot).
2. `GET /api/preflop/index` and `GET /api/library` via the Pages origin
   → `200`, real data (not the bundled sample).
3. Cookie round-trip: `POST /api/auth/login` with the admin password
   via the Pages origin → `200` and a `Set-Cookie: plo_admin=...`
   response header that is **not** comma-merged; then
   `GET /api/auth/me` with the cookie → `{ admin: true }`. A wrong
   password → generic `401`.
4. `POST /api/solves` without a session → `401` JSON (auth gate intact
   through the proxy); with a session → `202` + job record.
5. A gated study endpoint (`GET /api/heuristics`) with the session →
   `200`; without → `401`.
6. Non-API paths unaffected: `/`, a client-side route (e.g. `/quiz`),
   and `/sample-river-solve.json` still serve the SPA/static assets.
7. Origin-down behaviour (optional, if it can be staged safely): stop
   the origin briefly and confirm the site shows its "engine offline"
   state and `GET /api/health` via Pages returns the `502` JSON above.
