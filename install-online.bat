@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Lab AI Gateway - Online Installer

set "REPO=Deliver0/dsh-labai-gateway"
set "ZIPURL=https://github.com/%REPO%/archive/refs/heads/main.zip"
set "ZIP=%TEMP%\labai-plugin.zip"
set "UNZIP=%TEMP%\labai-unzip"

echo.
echo ==================================================
echo   Lab AI Gateway - Online Installer
echo   Downloading the plugin from GitHub...
echo ==================================================
echo.

if exist "%ZIP%" del /f /q "%ZIP%" >nul 2>nul
if exist "%UNZIP%" rmdir /s /q "%UNZIP%" >nul 2>nul

curl.exe -fsSL --max-time 90 "%ZIPURL%" -o "%ZIP%"
if errorlevel 1 goto :dlerr

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%UNZIP%' -Force" >nul
if errorlevel 1 goto :dlerr

set "INSTALLER="
for /f "delims=" %%i in ('dir /s /b "%UNZIP%\install.bat" 2^>nul') do if not defined INSTALLER set "INSTALLER=%%i"
if not defined INSTALLER goto :dlerr

echo   Downloaded. Starting installer...
echo.
call "!INSTALLER!"
exit /b %ERRORLEVEL%

:dlerr
echo.
echo [ERROR] Cannot download the plugin from GitHub.
echo   Check the campus network / VPN and try again.
echo   Alternative: open https://github.com/%REPO%
echo   click Code - Download ZIP, unzip, then double-click install.bat.
echo.
pause
exit /b 1
