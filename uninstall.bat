@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

if not defined NODE_EXE (
  for %%D in (
    "%ProgramFiles%\DeepSeek Harness"
    "%LOCALAPPDATA%\Programs\DeepSeek Harness"
    "%LOCALAPPDATA%\DeepSeek Harness"
  ) do (
    if not defined NODE_EXE (
      set "P=%%~D\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
      if exist "!P!" set "NODE_EXE=!P!"
    )
  )
)

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js not found. Install Node.js 20+ or ask the lab admin.
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Lab AI Gateway - DSH Plugin Uninstaller
echo ==================================================
echo.

"!NODE_EXE!" "bin\setup.mjs" --uninstall
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
