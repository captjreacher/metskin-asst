@echo off
setlocal EnableExtensions

REM === Metamorphosis: trigger Notion → Vector Store sync (template) ===
REM Copy this file to: sync-knowledge-remote.cmd
REM Set ADMIN_API_TOKEN in your environment before running.

set "BASE=https://metamorphosis.assist.maximisedai.com"

if "%ADMIN_API_TOKEN%"=="" (
  echo [ERR] ADMIN_API_TOKEN not set.
  echo Set it with:  setx ADMIN_API_TOKEN "YOUR_TOKEN"   (persists for new shells)
  echo Or for current shell only:  set ADMIN_API_TOKEN=YOUR_TOKEN
  exit /b 1
)

echo == Calling %BASE%/admin/sync-knowledge ==
curl.exe -s -i -X POST "%BASE%/admin/sync-knowledge" ^
  -H "Authorization: Bearer %ADMIN_API_TOKEN%"

endlocal
