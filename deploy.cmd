@echo off
node "%~dp0scripts\deploy.mjs" %*
exit /b %errorlevel%
