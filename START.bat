@echo off
setlocal
title VOTION Proxmox Dashboard - Launcher
cd /d "%~dp0"
set "LAUNCH_DIR=%~dp0"

echo ============================================================
echo   VOTION Proxmox Dashboard - START
echo   Double-click this file to launch everything.
echo ============================================================
echo.

:: ---------- 1. PostgreSQL (embedded, port 5433) ----------
echo [1/3] PostgreSQL (port 5433) .....
if not exist "pgsql\bin\pg_ctl.exe" (
    echo       [!] pgsql not found - skipping database.
    goto SKIP_PG
)
if not exist "pgdata\PG_VERSION" (
    echo       initializing embedded database ...
    if not exist "pgdata" mkdir "pgdata"
    "pgsql\bin\initdb.exe" -D "pgdata" -U votion -A trust --encoding=UTF8 > "pg_init.log" 2>&1
    if errorlevel 1 (
        echo       [!] database initialization failed - see pg_init.log
        goto SKIP_PG
    )
)
netstat -ano | findstr ":5433.*LISTENING" >nul 2>&1
if errorlevel 1 (
    if exist "pgdata\postmaster.pid" del /f "pgdata\postmaster.pid" >nul
    start "" /min "pgsql\bin\pg_ctl.exe" start -D "pgdata" -l "pg_log.txt" -o "-p 5433"
    for /l %%i in (1,1,15) do (
        "pgsql\bin\pg_isready.exe" -h localhost -p 5433 -U votion >nul 2>&1 && goto PG_READY
        timeout /t 1 >nul
    )
    echo       [!] database did not become ready on port 5433
    goto SKIP_PG
) else (
    echo       already running - skipped
)
:PG_READY
"pgsql\bin\createdb.exe" -h localhost -p 5433 -U votion votion_proxmox_db >nul 2>&1

:SKIP_PG

:: ---------- 2. Backend API (Express, port 5000) ----------
echo [2/3] Backend API (port 5000) ......
netstat -ano | findstr ":5000.*LISTENING" >nul 2>&1
if errorlevel 1 (
    start "VOTION Backend" /min cmd /k "%LAUNCH_DIR%_run_backend.cmd"
    echo       started
) else (
    echo       already running - skipped
)

:: ---------- 3. Frontend UI (Vite, port 3000) ----------
echo [3/3] Frontend UI (port 3000) ......
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if errorlevel 1 (
    start "VOTION Frontend" /min cmd /k "%LAUNCH_DIR%_run_frontend.cmd"
    echo       started
) else (
    echo       already running - skipped
)

echo.
echo ============================================================
echo   All services are up!
echo     Dashboard : http://localhost:3000
echo     API       : http://localhost:5000
echo     Database  : localhost:5433
echo.
echo   To stop: close the "VOTION Backend" and "VOTION Frontend"
echo   windows. To stop the database: delete pgdata\postmaster.pid
echo   and run:  pgsql\bin\pg_ctl.exe -D pgdata stop
echo ============================================================
echo.
timeout /t 3 >nul
start "" "http://localhost:3000"
exit /b
