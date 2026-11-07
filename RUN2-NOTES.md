# RUN2-NOTES — Admin runner UI + Windows packaging (RUN-2)

Build-only lane deliverable. On the Muse VM: `node --check api/server.mjs`
(pass) and `bash -n` on all four shell scripts (pass) — no server was
started, nothing was installed or built, and the .bat files cannot
execute here (documented line-by-line in §4 instead). The coordinator
verifies on hosts with §6.
Branch: `runner-ui-packaging` (based on RUN-1 `local-runner` @ f7f7da3).

## 1. What was built

| Piece | Location |
| --- | --- |
| Runner page (`/admin/runner`): status strip, queue panel, catalog browser | `ui/src/pages/Runner.tsx` (new) |
| Runner data layer: types + runtime guards + display helpers | `ui/src/lib/runner.ts` (new) |
| API client: fetchCatalog / fetchQueue / fetchRunnerStatus / enqueueSpots / queueControl | `ui/src/lib/api.ts` |
| Route `/admin/runner`; Admin page's runner section now links to it (placeholder copy replaced) | `ui/src/App.tsx`, `ui/src/pages/Admin.tsx` |
| `GET /api/runner/status` (read-only; see gap #2) | `api/server.mjs` |
| Static UI serving from `UI_DIR` + SPA fallback (see gap #1) | `api/server.mjs` |
| Docs for both | `api/README.md` (env table + endpoint table) |
| Windows engine cross-compile script | `packaging/build-windows-engine.sh` |
| Portable Node download + checksum verification | `packaging/fetch-node-win.sh` |
| Package assembly | `packaging/assemble-package.sh` |
| Package templates: start.bat, setup.bat, start.sh, INSTALL.md, runner-settings.txt | `packaging/templates/` |
| `.gitattributes` keeping .bat/.cmd at CRLF in git | `packaging/.gitattributes` |

No new dependencies anywhere (UI uses existing React/zustand/router;
server and scripts are Node stdlib / bash only).

## 2. The runner page (Part A)

- **Gating** mirrors `/admin` exactly: session probe on arrival
  (`fetchAuthMe` → store), "checking" state while unknown, locked panel
  with a login link (return target `/admin/runner`) when not admin.
  When the server has auth disabled, the page works and says so in the
  status strip (local-dev warning, same posture as Admin).
- **Status strip** polls `GET /api/runner/status` together with the
  queue: queue worker enabled/disabled, concurrency, paused, and
  uploads — "Configured · <central_url>" or "Not configured — finished
  solves stay in the local library". When the worker is disabled the
  strip explains that spots can be listed but nothing solves until the
  server runs with `QUEUE_ENABLED=1`. When a poll fails, the strip
  says the connection was lost and the page is showing last-known state.
- **Queue panel** polls `GET /api/queue` every 2 s. Items render in
  queue order with state; a running item shows "solving… · elapsed
  <time>" (a 1 s local clock ticks the elapsed display between polls)
  and **nothing else — no progress bar, no invented percentage**: RUN-1
  items only gain `nash_distance_pct` / `iterations` at completion, and
  those are shown for done items along with duration, the upload chip
  (Uploaded · created/exists/updated / Upload pending / Upload skipped
  (offline) / ⚠ Upload failed) and `upload_error` / item `error` text
  where present. Controls: Pause/Resume, concurrency stepper (1–8,
  bounds disabled at the ends, POSTs `set_concurrency`), per-item
  Remove for every non-running item (the API refuses `running` with
  409), and **Clear finished**, which loops the existing per-item
  `remove` action over done items — the API has no bulk action, and
  none was invented (see gap #3).
- **Catalog browser** fetches `GET /api/catalog` on mount and on
  Refresh only (not on the 2 s poll — RUN-1 flagged that handler's
  per-request library scan; see gap #4). Table columns exactly per the
  brief: spot (matchup · board, id, family/line), group, table, street,
  tier, coverage OOP/IP (formatted to 3 significant digits — real
  values are fractions of a percent), est. core hours ("5–9 h", or "—"
  where the catalog gives no per-entry bound), status chip
  (In library / Queued / Running / Done / ⚠ Failed / Not queued,
  derived library-first except that live queue states and failure win
  over a stale library annotation). Filters: group (options from the
  data), table size, street, status, text search (id/matchup/board/
  family). Row checkboxes + "Select all N filtered" + "Clear
  selection"; **Add selected to queue** POSTs once and reports
  `added`/`skipped` verbatim from the response, then refreshes queue +
  catalog. Entries whose catalog `status` is not `ready` cannot be
  selected and show their `status_reason` (all 300 shipped entries are
  `ready`; the guard is for future catalogs).
- **401 handling:** any queue POST answered 401 raises the Solver-style
  banner ("Queue changes are admin-only… Log in as admin", return
  target `/admin/runner`); other API errors surface the server's
  message; network failures show a generic could-not-reach notice.
  Offline-with-no-session renders the locked view, exactly like /admin.

## 3. API gaps found (and what was done about each)

1. **The API never served the UI.** `api/server.mjs` answered every
   non-API path with a JSON 404, so the packaged `start.bat` flow in
   the brief (`http://localhost:8787/admin/runner`) could not work at
   all: there would be no page to open. *Minimal fix, stdlib only:*
   non-API GET/HEAD paths are served from `UI_DIR` (env, default
   `../ui/dist` relative to `api/`) with a fixed content-type table,
   path resolution confined to `UI_DIR` (traversal → 400), an SPA
   fallback to `index.html` for extensionless paths (client routes),
   honest 404 for missing file-like paths, and — when no build exists
   in `UI_DIR` — behaviour byte-identical to before (JSON 404). One
   process, one origin: the admin cookie needs no CORS arrangement in
   the package.
2. **Upload configuration was not observable.** `/api/health` exposes
   no upload fields, so per the brief's own fallback clause a tiny
   read-only endpoint was added: `GET /api/runner/status` →
   `{ queue_enabled, concurrency, paused, upload_configured,
   central_url }`, built from `loadRunnerConfig(DATA_DIR)` (already a
   server import). It returns the configured central base URL and a
   boolean — **never** the session cookie.
3. **No bulk "clear finished" control action.** Actions are exactly
   RUN-1's (`pause`, `resume`, `remove`, `set_concurrency`); `remove`
   accepts any non-running item, including `done`. The UI therefore
   implements Clear finished as sequential per-item removes and
   reports the count. No server behaviour was invented.
4. **Catalog read cost (RUN-1's flag, worked around, not fixed):**
   `GET /api/catalog` re-reads the whole library per request. The page
   fetches it on mount/manual refresh and after queue mutations only;
   the 2 s poll touches `/api/queue` + `/api/runner/status`, both
   in-memory. A server-side annotation cache is a future optimisation,
   deliberately not bundled into this lane.
5. **No mid-solve progress exists to show.** RUN-1 queue items carry
   no iterations/Nash until the job settles. The UI shows elapsed time
   for running items and says why in INSTALL.md. (If live progress is
   ever wanted, the engine would have to stream iteration counts into
   the job record — an engine/API ticket, not a UI one.)

## 4. What the .bat files do, line by line

The .bat files **cannot be executed on this VM** (no Windows); the
walkthrough below is from careful reading, and §6 includes an
on-Windows smoke. Both files are stored with CRLF line endings
(`packaging/.gitattributes` pins `eol=crlf`): cmd.exe's `goto`/label
handling is unreliable in LF-only batch files. Both use `setlocal`
(no environment leaks), `cd /d "%~dp0"` (anchor to the script's own
folder — this is what makes paths with spaces work), quoted paths
throughout, and no delayed expansion (so `!` in values is inert).

### start.bat (87 lines)
- Lines 1–15: comment header — purpose, "keep this window open",
  crash pointer to INSTALL.md.
- `setlocal`, `cd /d "%~dp0"`: isolate env; work from the package folder.
- Range-mode block: defaults `QUEUE_RANGE_MODE=top`; if
  `runner-settings.txt` exists, a `for /f "tokens=1* delims=="` loop
  picks the `QUEUE_RANGE_MODE=` line. `tokens=1*` splits only at the
  first `=`, so values keep any later `=` intact; `#` comment lines
  never match the key comparison.
- local-env block: same loop over `local-env.txt` for
  `ADMIN_PASSWORD_HASH=` (written by setup.bat). The value is a scrypt
  string `scrypt$N$r$p$<base64>$<base64>`; base64 has no `%`, quotes or
  spaces, so it survives batch parsing; padding `=` survives via
  `tokens=1*`.
- If the hash is undefined: a loud WARNING block (open endpoints, run
  setup.bat) and startup continues in the server's local dev mode —
  the server prints its own matching banner.
- Runtime env block: `ENGINE_BIN=%~dp0engine-win`,
  `DATA_DIR=%~dp0local-data`, `PREFLOP_DIR`, `CATALOG_PATH`,
  `UI_DIR=%~dp0ui\dist`, `PORT=8787`, `HOST=127.0.0.1`,
  `QUEUE_ENABLED=1`, and `JOB_TIMEOUT_MS=86400000` (24 h — the server
  default of 30 min would kill real flop solves; RUN-1 flagged this).
- Creates `local-data` if absent; refuses to start (with `pause` and a
  plain-language reason) when `node-win\node.exe` or
  `engine-win\solve-river.exe` is missing, instead of letting the
  server fail obscurely later.
- Browser open: `start "" /b cmd /c "timeout /t 4 /nobreak >nul 2>&1 &
  start http://localhost:8787/admin/runner"` — a background helper
  waits ~4 s, then opens the default browser. Known quirk, accepted:
  `timeout` refuses to wait when its stdin is redirected (it then
  opens the browser immediately, possibly before the server is up —
  a refresh fixes it; INSTALL.md says to open the URL manually if the
  page fails).
- Runs `"%~dp0node-win\node.exe" "%~dp0api\server.mjs"` in the
  foreground; when it exits, prints where the solves live and
  `pause`s so the final messages stay readable.

### setup.bat (97 lines)
- Header comments: what is stored (hash only), the hidden-entry
  mechanism, and the honest limitation — passwords containing `%` or
  `"` cannot be carried safely by batch files, so INSTALL.md advises
  avoiding those two characters.
- `setlocal`, `cd /d "%~dp0"`; sets `DATA_DIR` to `local-data`
  (created if absent) — exported so the later `runner-login` call
  stores `runner-config.json` in the same place start.bat's server
  reads.
- Fails early with a clear message when `node-win\node.exe` is absent.
- Step 1 prompt loop (`:askpw`): reads the password twice via
  `powershell -NoProfile -Command "$s = Read-Host '...' -AsSecureString;
  [Marshal]::PtrToStringAuto([Marshal]::SecureStringToBSTR($s))"`
  captured with `for /f "delims="` (PowerShell 5.1 ships with Windows
  10/11; nothing is installed). Empty → re-ask; mismatch → message and
  re-ask via `goto askpw`.
- Hashing: puts the password in the `ADMIN_PASSWORD` env var (the
  input mode `api/hash-password.mjs` already supports), runs the
  bundled node + `api\hash-password.mjs` capturing **stdout only**
  (`2^>nul` hides the helper's stderr instructions, which would
  confuse here), then immediately clears the password and hash
  variables. The plaintext exists only in this process's environment
  for that one call and is never written to disk.
- Writes exactly one line, `ADMIN_PASSWORD_HASH=<hash>`, to
  `local-env.txt` (overwrite — re-running setup.bat is the documented
  password-reset path).
- Step 2: `set /p` for the central URL (blank skips). When given, runs
  `node-win\node.exe api\runner-login.mjs --central "<url>"` — the CLI
  itself prompts for the **central** password with echo disabled and
  stores the session cookie; `if errorlevel 1` prints a retry hint
  instead of failing setup. Ends with a summary + `pause`.

## 5. Package layout (packaging/dist/plo-runner/ after assembly)

```
plo-runner/
  start.bat  setup.bat  start.sh  INSTALL.md  runner-settings.txt
  api/            server.mjs auth.mjs hash-password.mjs ranges-expand.mjs
                  runner-login.mjs uploader.mjs README.md package.json
  ui/dist/        the built web app (copied from ui/dist)
  engine-win/     solve-river.exe solve-turn.exe solve-flop.exe
                  (+ libwinpthread-1.dll when the mingw sysroot had one)
  engine-linux/   solve-river solve-turn solve-flop (host release build)
  node-win/       node.exe (official portable Node, SHA-256 verified)
  data/preflop/   index.json, sets/, class-table.json, schema, config
  data/library/   spot-catalog.json
  local-data/     README.txt placeholder; at runtime: queue.json,
                  jobs/, library/, runner-config.json, auth-sessions.json
```

Script behaviours worth knowing:
- `build-windows-engine.sh` builds **only** the three binaries the API
  invokes (`solve-river/turn/flop` — from `server.mjs`'s kind→binary
  mapping; `build-ranges`/`measure-flop` are tools, excluded). It
  checks rustup/cargo, then the mingw linker — missing linker = exit 1
  with the exact apt line (`sudo apt-get install -y
  gcc-mingw-w64-x86-64`) **before** any compilation, so no partial
  output. It adds the rust target (idempotent), builds with
  `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER` set and
  `-static-libgcc -static-libstdc++` link args, copies the three .exe
  files out, and copies `libwinpthread-1.dll` alongside if the sysroot
  provides one (belt-and-braces; see "unverified" below).
- `fetch-node-win.sh` pins `NODE_VERSION="22.11.0"` in one variable at
  the top (Node 22 LTS, matches the hosts' runtime). Downloads the
  official `node-v22.11.0-win-x64.zip` + `SHASUMS256.txt` from
  nodejs.org, verifies the zip's SHA-256 via the sums file (hard fail
  on mismatch or missing line), extracts **only** `node.exe`, and
  refuses to package a suspiciously small result (<10 MB).
- `assemble-package.sh` hard-stops with instructions when `ui/dist`
  or the Linux engine binaries are missing; warns-but-continues when
  the Windows .exe files are absent (the Linux variant remains
  testable, and the final summary repeats that `engine-win/` is
  empty). It copies an explicit API file list (never `api/data` or
  other local state), the preflop data and catalog, the templates,
  and calls fetch-node-win.sh into the package. The `rm -rf` of the
  previous package is guarded by a case-check on the exact path.

## 6. Coordinator verification commands

```bash
# 0. Syntax (already run on the Muse VM; repeat anywhere):
node --check api/server.mjs
for f in packaging/*.sh packaging/templates/start.sh; do bash -n "$f"; done

# 1. UI build (type-check is the real test of Runner/runner/api changes):
cd ui && npm install && npm run build && cd ..

# 2. Windows engine cross-compile (on the VPS; root for the apt install):
sudo apt-get install -y gcc-mingw-w64-x86-64
packaging/build-windows-engine.sh
file packaging/dist/engine-win/*.exe
# -> each: "PE32+ executable (console) x86-64, for MS Windows"

# 3. Assemble (needs the engine built for the host too):
cd engine && cargo build --release && cd ..
packaging/assemble-package.sh

# 4. Boot the LINUX variant end-to-end, from a path WITH SPACES:
mkdir -p "/tmp/plo runner test" && cp -r packaging/dist/plo-runner "/tmp/plo runner test/"
cd "/tmp/plo runner test/plo-runner"
ADMIN_PASSWORD='smoke-pass-123' node api/hash-password.mjs   # copy the scrypt$... line
printf 'ADMIN_PASSWORD_HASH=<paste>\n' > local-env.txt
QUEUE_SMOKE_MAX_ITERATIONS=25 ./start.sh > /tmp/run2-server.log 2>&1 &
 sleep 2
curl -s http://127.0.0.1:8787/api/health          # ok: true, queue_enabled: true
curl -s http://127.0.0.1:8787/api/runner/status   # upload_configured: false, central_url: null
curl -s http://127.0.0.1:8787/ | head -c 120      # the UI's index.html (gap-#1 fix)
curl -s http://127.0.0.1:8787/admin/runner | head -c 120   # SPA fallback -> same index.html
curl -s http://127.0.0.1:8787/assets/does-not-exist.js     # 404 JSON (file-like path)
curl -s http://127.0.0.1:8787/api/queue | head -c 200      # items: [], enabled: true
# Log in, enqueue one narrow river spot, watch it solve + finish:
curl -s -c /tmp/run2-cookies.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"smoke-pass-123"}'
curl -s -b /tmp/run2-cookies.txt -X POST http://127.0.0.1:8787/api/queue \
  -H 'Content-Type: application/json' \
  -d '{"spot_ids":["6max-co-vs-btn-3bet-as-4d-3c-6s-8s-river"]}'
watch -n 2 "curl -s http://127.0.0.1:8787/api/queue | head -c 400"
# -> state "done", nash_distance_pct + iterations set, upload_status "skipped"
#    (no central configured); local-data/library holds the solve.
# UI click-through: open http://127.0.0.1:8787/admin/runner, log in,
# confirm catalog rows (300), filters, pause/resume, stepper 1..8,
# Clear finished, and a Remove; kill + restart start.sh mid-queue and
# confirm the RUN-1 crash contract from the page's point of view.

# 5. Windows smoke (on Justin's PC, cannot be done here): unzip the
# package into a path with spaces, e.g. "C:\Users\<you>\My Games\plo-runner",
# run setup.bat (set a password; skip or do the central connect), then
# start.bat; confirm the browser opens /admin/runner, login works, a
# river spot solves, and local-env.txt holds one scrypt$ line.
```

## 7. What could not be verified statically

- **No TypeScript compile.** The UI was written against the existing
  strict tsconfig patterns (guards for every payload, no `any` on
  parsed JSON), but `npm run build` in §6.1 is the first real check.
- **The server changes were not executed** (`node --check` only). The
  static-serving branch is new code on the request path: §6.4 covers
  its index/SPA/404 behaviour and confirms API routes are untouched
  (the branch only fires for non-`/api/` GET/HEAD paths).
- **The .bat files were never run.** Risks that survive reading:
  PowerShell `Read-Host -AsSecureString` output capture under
  `for /f` (standard pattern, but console-codepage dependent);
  passwords with characters outside the documented `%`/`"` exclusions
  (e.g. a trailing space is silently dropped by the prompt round-trip);
  the `timeout` browser-open quirk noted in §4. §6.5 is the real test.
- **Windows runtime DLL needs are inferred, not proven.** The engine
  is pure Rust, but the gnu target links mingw runtimes; static
  libgcc/libstdc++ link args plus the conditional libwinpthread copy
  are the mitigation. Whether the three .exe files run on a clean
  Windows install with **no** mingw DLLs present is only settled by
  §6.5 (or `objdump -p solve-river.exe | grep "DLL Name"` on the VPS).
- **fetch-node-win.sh was not run** (no downloads in this lane): the
  SHASUMS grep pattern, the unzip member path
  (`node-v22.11.0-win-x64/node.exe`) and the version pin are from the
  documented Node dist layout; §6.3 exercises it for real.
- **Catalog `est_core_hours` shape** was taken from the shipped
  catalog file (object with minimum/maximum on flop entries, null on
  turn/river entries) and parsed tolerantly; if a future catalog adds
  other shapes the guard degrades that column to "—" rather than
  failing the page.
