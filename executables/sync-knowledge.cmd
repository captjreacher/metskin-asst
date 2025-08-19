@echo off
setlocal enabledelayedexpansion

REM ------------------------------------------------------------
REM Metamorphosis Assistant – Notion → Vector Store local sync
REM Usage: double-click or run from shell
REM Requires: Node in PATH, .env in repo root
REM ------------------------------------------------------------

REM cd to project root (this .cmd lives in root\executables)
pushd "%~dp0.."

if not exist "scripts\sync_knowledge_from_notion_files.mjs" (
  echo [ERROR] Could not find scripts\sync_knowledge_from_notion_files.mjs in %CD%
  goto :fail
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node or open a Node-enabled shell.
  goto :fail
)

echo [INFO] Running Notion sync with dotenv...
node -r dotenv/config "scripts\sync_knowledge_from_notion_files.mjs"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo [FAIL] Sync script exited with %EXITCODE%.
  popd
  exit /b %EXITCODE%
)

echo [OK] Sync completed successfully.
popd
exit /b 0

:fail
popd
exit /b 1
