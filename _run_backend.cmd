@echo off
title VOTION Backend (port 5000)
cd /d "%~dp0"
set PGPORT=5433
set PGUSER=votion
set PGHOST=localhost
if "%TOKEN_SECRET%"=="" (
    if not exist ".runtime" mkdir ".runtime"
    if not exist ".runtime\token_secret" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); [IO.File]::WriteAllText('.runtime\\token_secret', [Convert]::ToBase64String($bytes))"
    )
    set /p TOKEN_SECRET=<".runtime\token_secret"
)
npx tsx server\index.ts
exit /b
