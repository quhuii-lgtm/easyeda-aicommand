@echo off
rem ============================================================
rem  AI Command Proxy launcher (invoked via ai-command-proxy://
rem  URL scheme or manually). Pure ASCII - do not add CJK text.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
    set "NODE=node"
) else if exist "D:\Programs\Kimi\resources\resources\runtime\node.exe" (
    set "NODE=D:\Programs\Kimi\resources\resources\runtime\node.exe"
) else (
    echo [ERROR] Node.js not found. Please install Node.js 22 LTS.
    pause
    exit /b 1
)

rem If proxy already running, do nothing
curl -s -m 2 http://127.0.0.1:49720/health >nul 2>nul
if %errorlevel%==0 (
    echo AI Command Proxy is already running.
    timeout /t 3 >nul
    exit /b 0
)

rem The proxy needs the "ws" package from ai-command-engine\node_modules
"%NODE%" "%~dp0command-proxy.mjs"
