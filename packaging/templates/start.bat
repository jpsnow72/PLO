@echo off
rem ============================================================
rem  PLO GTO Study - local solve runner (Windows)
rem
rem  Starts the job service with the catalog solve queue enabled
rem  and opens the runner page in your default browser. Keep this
rem  window open while solving: closing it (or pressing Ctrl+C)
rem  stops the server. Finished solves are safe either way - see
rem  INSTALL.md ("If the computer stops or freezes").
rem
rem  Everything is read from files next to this script, so the
rem  package works from any folder, including paths with spaces,
rem  and needs no admin rights.
rem ============================================================
setlocal
cd /d "%~dp0"

rem --- Range mode from runner-settings.txt (QUEUE_RANGE_MODE) ---
rem Default "top" when the file or the setting is absent.
set "QUEUE_RANGE_MODE=top"
if exist "%~dp0runner-settings.txt" (
  for /f "usebackq tokens=1* delims==" %%A in ("%~dp0runner-settings.txt") do (
    if "%%A"=="QUEUE_RANGE_MODE" set "QUEUE_RANGE_MODE=%%B"
  )
)

rem --- Admin password hash written by setup.bat (local-env.txt) ---
rem The stored value is a scrypt hash whose base64 parts may end in
rem '=' padding; tokens=1* splits only at the FIRST '=', so the
rem remainder of the line reaches %%B intact.
if exist "%~dp0local-env.txt" (
  for /f "usebackq tokens=1* delims==" %%A in ("%~dp0local-env.txt") do (
    if "%%A"=="ADMIN_PASSWORD_HASH" set "ADMIN_PASSWORD_HASH=%%B"
  )
)
if not defined ADMIN_PASSWORD_HASH (
  echo.
  echo  WARNING: no admin password is set yet.
  echo  The queue and solve endpoints will be OPEN to anyone who can
  echo  reach this computer's port 8787. Run setup.bat once to set a
  echo  password. Continuing in local dev mode for now...
  echo.
)

rem --- Runtime configuration ---
set "ENGINE_BIN=%~dp0engine-win"
set "DATA_DIR=%~dp0local-data"
set "PREFLOP_DIR=%~dp0data\preflop"
set "CATALOG_PATH=%~dp0data\library\spot-catalog.json"
set "UI_DIR=%~dp0ui\dist"
set "PORT=8787"
set "HOST=127.0.0.1"
set "QUEUE_ENABLED=1"
rem Library flop solves run for hours: 24 h per-solve cap (the
rem server's 30-minute default would kill them).
set "JOB_TIMEOUT_MS=86400000"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

if not exist "%~dp0node-win\node.exe" (
  echo ERROR: node-win\node.exe is missing - this package is incomplete.
  echo Re-download the package, or rebuild it with packaging\assemble-package.sh.
  pause
  exit /b 1
)
if not exist "%ENGINE_BIN%\solve-river.exe" (
  echo ERROR: the Windows engine files are missing from engine-win\.
  echo This package was assembled before the Windows engine was built.
  echo Re-download the package, or build the engine with
  echo packaging\build-windows-engine.sh and assemble again.
  pause
  exit /b 1
)

rem --- Open the runner page once the server has had time to start ---
start "" /b cmd /c "timeout /t 4 /nobreak >nul 2>&1 & start http://localhost:8787/admin/runner"

echo Starting the PLO solve runner...
echo   Runner page: http://localhost:8787/admin/runner
echo   Keep this window open while solving. Press Ctrl+C to stop.
echo.
"%~dp0node-win\node.exe" "%~dp0api\server.mjs"

echo.
echo The server has stopped. Finished solves are saved in local-data\library.
pause
endlocal
