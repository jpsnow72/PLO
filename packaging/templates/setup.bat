@echo off
rem ============================================================
rem  PLO GTO Study - one-time setup (Windows)
rem
rem  Step 1: you choose the admin password for THIS computer's
rem          runner. Only its scrypt hash is stored (in
rem          local-env.txt, read by start.bat). The password
rem          itself is never written to disk.
rem  Step 2 (optional): connect this runner to your central
rem          library, so every finished solve uploads there
rem          automatically. Skipping is fine: solves then stay
rem          in the local library until you connect later.
rem
rem  Password entry is hidden (PowerShell Read-Host with
rem  -AsSecureString; PowerShell ships with Windows).
rem  Batch files cannot safely carry the characters % and "
rem  inside a password - please avoid those two.
rem ============================================================
setlocal
cd /d "%~dp0"

set "DATA_DIR=%~dp0local-data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

set "NODE=%~dp0node-win\node.exe"
if not exist "%NODE%" (
  echo ERROR: node-win\node.exe not found - this package is incomplete.
  echo Re-download the package before running setup.
  pause
  exit /b 1
)

echo.
echo Step 1 of 2 - admin password for this runner
echo ----------------------------------------------
echo This password unlocks the runner page on THIS computer
echo ^(queueing solves, changing settings^). Pick one you will remember;
echo there is no recovery - but re-running setup.bat sets a new one.

:askpw
set "PW1="
set "PW2="
for /f "delims=" %%P in ('powershell -NoProfile -Command "$s = Read-Host 'Admin password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set "PW1=%%P"
for /f "delims=" %%P in ('powershell -NoProfile -Command "$s = Read-Host 'Repeat it     ' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set "PW2=%%P"
if "%PW1%"=="" (
  echo Please enter a non-empty password.
  goto askpw
)
if "%PW1%" NEQ "%PW2%" (
  echo Those did not match - try again.
  goto askpw
)

rem hash-password.mjs reads the password from the ADMIN_PASSWORD
rem environment variable and prints ONLY the scrypt hash to stdout.
set "ADMIN_PASSWORD=%PW1%"
set "PW1="
set "PW2="
set "HASH="
for /f "delims=" %%H in ('"%NODE%" "%~dp0api\hash-password.mjs" 2^>nul') do set "HASH=%%H"
set "ADMIN_PASSWORD="
if not defined HASH (
  echo ERROR: could not generate the password hash.
  pause
  exit /b 1
)
> "%~dp0local-env.txt" echo ADMIN_PASSWORD_HASH=%HASH%
set "HASH="
echo Saved: local-env.txt now holds the password HASH ^(not the password^).

echo.
echo Step 2 of 2 - connect to your central library ^(optional^)
echo -----------------------------------------------------------
echo If your library also lives on a server ^(for example the one
echo behind your web app^), enter its base URL below and log in with
echo the CENTRAL server's admin password when asked. Every finished
echo solve will then upload there automatically.
echo Just press Enter to skip - you can connect at any time later by
echo running:  node-win\node.exe api\runner-login.mjs
echo.
set "CENTRAL="
set /p "CENTRAL=Central library URL (blank to skip): "
if defined CENTRAL (
  "%NODE%" "%~dp0api\runner-login.mjs" --central "%CENTRAL%"
  if errorlevel 1 (
    echo.
    echo The central login did not complete - no problem, the runner
    echo still works locally. Retry later with:
    echo     node-win\node.exe api\runner-login.mjs
  )
)

echo.
echo Setup is done. From now on, just run start.bat whenever you
echo want to solve, and log in with the password from step 1.
pause
endlocal
