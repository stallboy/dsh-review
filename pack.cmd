@echo off
setlocal EnableExtensions DisableDelayedExpansion

if not "%~2"=="" goto invalid
if /i "%~1"=="--help" goto usage
set "DSH_PACK_SCRIPT=pack:local"
if "%~1"=="" goto pack
if /i "%~1"=="local" goto pack
if /i not "%~1"=="plugin" goto invalid
set "DSH_PACK_SCRIPT=pack:plugin"

:pack
pushd "%~dp0" || exit /b 1
if not exist "node_modules\.bin\tsc.cmd" (
    call npm.cmd ci
    if errorlevel 1 goto finish
)
call npm.cmd run %DSH_PACK_SCRIPT%

:finish
set "DSH_PACK_STATUS=%errorlevel%"
popd
exit /b %DSH_PACK_STATUS%

:invalid
call :usage
exit /b 2

:usage
echo pack.cmd [local^|plugin]
exit /b 0
