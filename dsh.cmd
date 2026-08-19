@echo off
rem dsh CLI launcher.
rem Uses the standalone Node runtime kept in .tools (does not touch the system Node),
rem and runs the BUILT dsh CLI (apps/cli/lib/bin.js). Requires `pnpm run build` to
rem have been run once. Usage: dsh web | dsh --help | dsh --profile <name> ...
setlocal
set "DHS_ROOT=%~dp0"
set "TOOLS_NODE="
for /d %%D in ("%DHS_ROOT%.tools\node-*") do set "TOOLS_NODE=%%D"
if not defined TOOLS_NODE (
  echo [dsh] No standalone Node runtime found under %DHS_ROOT%.tools\node-*.
  echo [dsh] Download Node 22.x to .tools\ manually, or re-run the setup steps.
  exit /b 1
)
if not exist "%TOOLS_NODE%\node.exe" (
  echo [dsh] node.exe missing in %TOOLS_NODE%.
  exit /b 1
)
if not exist "%DHS_ROOT%apps\cli\lib\bin.js" (
  echo [dsh] Built CLI not found at apps\cli\lib\bin.js. Run: pnpm run build
  exit /b 1
)
set "PATH=%TOOLS_NODE%;%PATH%"
node "%DHS_ROOT%apps\cli\lib\bin.js" %*
set "EXIT=%ERRORLEVEL%"
endlocal & exit /b %EXIT%
