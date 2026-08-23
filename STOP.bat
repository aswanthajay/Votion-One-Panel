@echo off
setlocal
title VOTION Proxmox Dashboard - STOP
cd /d "%~dp0"

echo ============================================================
echo   VOTION Proxmox Dashboard - STOP
echo ============================================================
echo.

:: Kill backend and frontend processes (by listening port owners)
echo [1/3] Stopping Backend + Frontend ....
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo       done
netstat -ano | findstr ":5000.*LISTENING" >nul 2>&1
if errorlevel 1 ( echo       port 5000 closed ) else ( echo       WARNING: port 5000 still busy )
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if errorlevel 1 ( echo       port 3000 closed ) else ( echo       WARNING: port 3000 still busy )

:: Stop PostgreSQL
echo [2/3] Stopping PostgreSQL ..........
if exist "pgsql\bin\pg_ctl.exe" (
    "pgsql\bin\pg_ctl.exe" stop -D "pgdata" >nul 2>&1
    if exist "pgdata\postmaster.pid" del /f "pgdata\postmaster.pid" >nul
    echo       done
)
netstat -ano | findstr ":5433 .*LISTENING" >nul 2>&1
if errorlevel 1 ( echo       port 5433 closed ) else ( echo       WARNING: port 5433 still busy )

echo.
echo ============================================================
echo   All services stopped. Double-click START.bat to run again.
echo ============================================================
echo.
timeout /t 3 >nul
exit /b
