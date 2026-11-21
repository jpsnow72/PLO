# PACKAGING-NOTES — runner package record

Living record for `packaging/` (the portable local-runner package built
by `packaging/assemble-package.sh`). RUN2-NOTES.md is the historical
RUN-2 lane record; packaging changes from #35 onward are logged here.

## 2026-11-21 — #35: package could not boot on Windows (two defects + safeguard)

Found during the first real Windows run of the v2 runner package
(plo-runner-win-v2.zip, assembled from main 83b9320) on Justin's PC.
Until that day the package had never been booted: the Nov 20 smoke had
exercised the VPS's own API instance, not the packaged server.

### Defect 1 — packaged server crashed at startup (missing modules)

`api/server.mjs` in the package died immediately with
`ERR_MODULE_NOT_FOUND` for `api/google-auth.mjs`.
`packaging/assemble-package.sh` copied a hand-maintained `API_FILES`
list that predated the study features and Google sign-in, so the
package was missing THREE runtime modules `server.mjs` imports:
`google-auth.mjs` (#27), `quiz.mjs`, and `study.mjs`.

Fix (`assemble-package.sh`):

- The API file list is now DERIVED at assemble time: every `api/*.mjs`
  except `*.test.mjs` (tests are not runtime), plus `README.md` and
  `package.json`. There is no list left to go stale.
- A completeness check runs right after the copy: every relative
  `.mjs` import specifier in the packaged `api/*.mjs` must resolve to
  a file inside the package, or assembly fails hard with the importing
  file and the missing module named.

### Defect 2 — every queue job failed on Windows (missing `.exe`)

`runJob` in `api/server.mjs` built the engine path as
`path.join(ENGINE_BIN, binaryName)` with `binaryName` =
`solve-flop` / `solve-turn` / `solve-river` — no platform branch, so on
Windows (where the files are `solve-flop.exe` etc.) every queue job
failed instantly with "Engine binary not found". The multiway-equity
invocation in the same file already branched on
`process.platform === 'win32'`; `runJob` was the only extensionless
engine-path construction left.

Fix (`api/server.mjs`): `runJob` now appends `.exe` on win32, mirroring
the multiway path. (Justin's PC copy was hot-patched with the same
change on 2026-11-21 so the library burn could proceed; the shipped
fix supersedes it.)

### Safeguard — package boot smoke (`packaging/smoke-package.sh`)

New step in the packaging flow, run AFTER assembling and BEFORE the
zip is called deliverable:

```sh
packaging/smoke-package.sh            # defaults to packaging/dist/plo-runner
SMOKE_PORT=8799 packaging/smoke-package.sh /path/to/plo-runner
```

It boots the packaged `api/server.mjs` with the system node, a scratch
`DATA_DIR`, and a test port, with `QUEUE_ENABLED=1` (mirroring
`start.sh`/`start.bat`), polls `GET /api/health` for up to 30 s, and
requires HTTP 200 with `"ok":true` and `"queue_enabled":true` in the
payload. It then kills the server and removes the scratch dir. On boot
failure it prints the packaged server's log. It runs on Linux — the
coordinator runs it on the VPS against the assembled tree.

Rule going forward: **a package that has not passed the boot smoke is
not deliverable**, no matter how the zip's contents list looks.
