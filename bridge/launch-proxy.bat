@echo off
rem ============================================================
rem  AI Command Proxy launcher (invoked via ai-command-proxy://
rem  URL scheme or manually). Pure ASCII - do not add CJK text.
rem ============================================================
rem Run npm ci and resolve node_modules from the repository root.
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js 20.17.0 or newer was not found on PATH. Install a supported Node.js version and reopen this launcher.
    pause
    exit /b 1
)

call node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 17) ? 0 : 1)"
if errorlevel 1 (
    echo [ERROR] Node.js 20.17.0 or newer is required. Update Node.js on PATH and reopen this launcher.
    pause
    exit /b 1
)

if not exist "%~dp0..\node_modules\ws\package.json" (
    echo [ERROR] The ws dependency is missing. From this repository root, run: npm ci
    pause
    exit /b 1
)

rem Skip startup when port 49720 responds; this is not a proxy health check.
call curl -s -m 2 http://127.0.0.1:49720/health >nul 2>nul
if %errorlevel%==0 (
    echo Port 49720 responded. Check http://127.0.0.1:49720/health to confirm it is the proxy. No second process started.
    timeout /t 3 >nul
    exit /b 0
)

rem The proxy needs the "ws" package from the repository's node_modules.
call node "%~dp0command-proxy.mjs"
