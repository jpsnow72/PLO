# Google sign-in with admin allowlist — issue #27

Lets the owner sign in with his Google account and become admin,
alongside (not instead of) the existing password login. Both paths mint
the **same** `plo_admin` session through the same `SessionStore`.

## Configuration (public facts)

- OAuth client id: `555991794361-un38k7efq4m5g3vn5vftqmgmuo79hn6p.apps.googleusercontent.com`
- Authorized JavaScript origin: exactly `https://plo-gto.pages.dev`.
- The consent app is in **Testing** mode with `jpsnow72@gmail.com` and
  `finchlearn@gmail.com` as test users — sign-in works for those two
  accounts (which are also the intended allowlist seed). Any other
  Google account is refused by Google itself while Testing mode lasts,
  before our allowlist is even consulted.
- Server env (see `api/README.md`): `GOOGLE_CLIENT_ID` (the id above)
  and `ADMIN_EMAILS=jpsnow72@gmail.com,finchlearn@gmail.com`.
- **There is no client secret in this system and none may be
  introduced.** The flow is the GIS ID-token flow; authenticity comes
  from verifying the token's signature, not from a shared secret.

## Design

### API (`api/`)

- **`api/google-auth.mjs`** (new) — `verifyGoogleIdToken(token, aud)`:
  parses the JWT, requires `alg: RS256`, fetches Google's JWKS
  (`https://www.googleapis.com/oauth2/v3/certs`) with a 5 s timeout,
  caches keys per the response's Cache-Control (default 1 h, cap 24 h),
  refetches **once** on an unknown `kid` (rotation), imports the JWK
  with `createPublicKey({ format: 'jwk' })` and verifies with
  `node:crypto` — no new dependencies. Claim checks: `iss` ∈
  {`accounts.google.com`, `https://accounts.google.com`}, `aud` equals
  `GOOGLE_CLIENT_ID` (array-valued `aud` accepted if it contains it),
  `exp` in the future, `email_verified === true`, non-empty `email`.
  Every failure throws `GoogleTokenError` with a detail message that is
  only ever logged server-side. Also exports `parseAdminEmails`
  (comma-separated, trimmed, lowercased, blanks dropped).
- **`POST /api/auth/google`** `{ credential }`:
  - `GOOGLE_CLIENT_ID` unset → **503** (feature off, never a crash,
    checked before the body is even read).
  - Auth disabled (no `ADMIN_PASSWORD_HASH`) → **400**, the same
    contract and message as the password login (nothing to log in to).
  - Body not JSON / `credential` not a non-empty string → **400**.
  - Verification failure of any kind → **401** `{ error: "Google
    sign-in failed" }` — generic on purpose; the failing check is in
    the server log (`console.error`), never in the response.
  - Verified but email not in `ADMIN_EMAILS` (case-insensitive) →
    **403** with a clear not-on-the-allowlist message. No session, no
    partial state — v1 has no non-admin accounts.
  - Allowlisted → `sessionStore.create({ email, provider: "google" })`,
    `200 { admin: true }` + the usual `Set-Cookie`.
- **`GET /api/auth/config`** (public, always answers) →
  `{ google_client_id: <env value or null> }`, so the UI needs no
  rebuild when the id changes; the env value is the single source for
  both this response and the `aud` check.
- **`SessionStore`** (`api/auth.mjs`): records gain optional `email` /
  `provider` fields — written by `create(identity)`, preserved by
  `load()` (only when non-empty strings), returned by the new `get()`
  accessor. `has()` now delegates to `get()`. Password sessions pass no
  identity and their stored records are byte-identical to before.
- **`GET /api/auth/me`**: with a live session it answers as before plus
  `email` / `provider` **when the record carries them** — password
  sessions' response shape is unchanged (additive fields only).
- Startup log: when auth is enabled and a client id is set, the server
  prints the allowlist size, and warns when the allowlist is empty
  (every Google login would 403).

### UI (`ui/`)

- `lib/api.ts`: `fetchAuthConfig()` (fails soft to
  `{ googleClientId: null }` — offline or feature-off simply means no
  button) and `loginWithGoogle(credential)` (mirrors `login()`; the
  server's error message, including the 403 allowlist text, surfaces
  via `ApiError`). `fetchAuthMe()` now also parses `email`/`provider`.
- `lib/googleSignIn.ts` (new): one-shot loader for
  `https://accounts.google.com/gsi/client` + minimal typings for the
  `google.accounts.id` slice we use (`initialize`, `renderButton`).
- `lib/types.ts`: `AuthState` gains optional `email` / `provider`.
- `store/useStore.ts`: `authEmail` / `authProvider` state; `setAdmin`
  takes an optional identity third argument (all probe call sites —
  store probe, Login, Admin, Runner — pass the `AuthState` through, so
  a Google email survives page-level refreshes; signing out clears it).
- `pages/Login.tsx`: when config yields a client id, the GIS script
  loads and the official "Sign in with Google" button renders under an
  "or" divider in the admin form; its callback posts the credential,
  then refreshes auth state and navigates exactly like the password
  login. No client id → the button never appears and the password form
  is byte-for-byte the old behaviour. The signed-in panel now reads
  "You're signed in as admin as <email> (via Google)." for Google
  sessions.
- `App.tsx`: the nav footer account link shows `Admin · <email>` for
  identity-carrying sessions (previously just `Admin · signed in`).

## Failure modes

| Situation | Result |
| --- | --- |
| `GOOGLE_CLIENT_ID` unset | Config reports `null`; no button; `POST /api/auth/google` → 503 |
| Google/JWKS unreachable at verify time | 401 generic (detail logged); password login unaffected |
| Token forged / wrong `aud` / expired / unverified email | 401 generic (detail logged) |
| Verified Google account, not allowlisted | 403 with the allowlist message; no session |
| Account not a consent-app test user (Testing mode) | Google refuses in its own UI; our API never sees a token |
| GIS script blocked (ad-blocker etc.) | Button never renders; password login unaffected |
| Auth disabled on server (dev mode) | Google endpoint 400, same as password login |
| Old session files (no identity fields) | Load unchanged; `/api/auth/me` answers without identity fields |

## Verification steps (for the host gate)

Static (no Google account needed):

1. Server with `GOOGLE_CLIENT_ID` **unset**: `GET /api/auth/config` →
   `{ "google_client_id": null }`; `POST /api/auth/google` with any
   body → 503.
2. Server with both env vars set: `GET /api/auth/config` returns the
   client id above.
3. `POST /api/auth/google` with `{ "credential": "not-a-jwt" }` → 401
   `{ "error": "Google sign-in failed" }`, and the server log names the
   parse failure. A well-formed but unsigned/forged JWT → also 401.
4. Password login still works end-to-end; its `/api/auth/me` response
   has **no** `email`/`provider` keys; write endpoints still gate on
   the session exactly as before.
5. UI build: with the API down or config returning `null`, the login
   page shows the password form only, no errors.

Live (needs Justin at the browser, Testing-mode consent):

6. On https://plo-gto.pages.dev (the authorized origin), the Google
   button appears; signing in as jpsnow72@gmail.com lands as admin,
   the nav footer shows `Admin · jpsnow72@gmail.com`, and
   `/api/auth/me` returns `email` + `provider: "google"`.
7. A Google account outside the test-user list cannot get past
   Google's own consent screen; an allowlist miss (test user whose
   email is removed from `ADMIN_EMAILS`) yields the 403 message on the
   login form and no session.

## Decisions worth noting

- **Allowlist check is post-verification and separate from it**: a 401
  means "this token is not genuine/valid", a 403 means "genuine Google
  account, not authorized here". Neither mints partial state.
- **No failure delay** on the Google route (unlike password login):
  there is no guessable secret to slow down; failures are signature
  failures, not password attempts.
- **Dev-mode parity**: with auth disabled the endpoint refuses with
  the password login's 400 rather than minting nominal sessions, so
  "auth disabled" keeps one meaning across both front doors.
