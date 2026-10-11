@echo off
rem User-facing entry point. Pure ASCII on purpose: cmd.exe reads this file as
rem OEM/ANSI, so a non-ASCII byte here would be mangled. The project path is
rem expanded at runtime through %~dp0 and is never written into this file.
setlocal
cd /d "%~dp0.."

set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=start"

set "ENHANCER_EXE="
if exist "dist\TraeMeta.exe" set "ENHANCER_EXE=dist\TraeMeta.exe"
if defined ENHANCER_EXE goto runexe
if exist "TraeMeta.exe" set "ENHANCER_EXE=TraeMeta.exe"
if defined ENHANCER_EXE goto runexe
goto runnode

:runexe
"%ENHANCER_EXE%" %ARGS%
if errorlevel 1 pause
exit /b %errorlevel%

:runnode
where node >nul 2>nul
if errorlevel 1 goto nonode
node "scripts\service.js" %ARGS%
if errorlevel 1 pause
exit /b %errorlevel%

:nonode
echo Node.js 22 or newer is required but was not found on PATH.
echo Install Node.js, or build the portable executable first.
echo See README.md, section "Building the portable executable".
pause
exit /b 1
