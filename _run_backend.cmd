@echo off
title VOTION Backend (port 5000)
cd /d "%~dp0"
set PGPORT=5433
set PGUSER=votion
set PGHOST=localhost
npx tsx server\index.ts
exit /b
