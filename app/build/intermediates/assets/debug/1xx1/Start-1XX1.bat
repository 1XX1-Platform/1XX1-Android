@echo off
title 1XX1 Platform v1.0.0
color 0B

echo.
echo ╔══════════════════════════════════════════╗
echo ║          1XX1 PLATFORM v1.0.0            ║
echo ║   Merkeziyetsiz . Reklamsiiz . Acik      ║
echo ╚══════════════════════════════════════════╝
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadi!
    echo Lutfen https://nodejs.org adresinden indirin.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -e "process.stdout.write(process.versions.node)"') do set NODE_VER=%%i
echo [OK] Node.js %NODE_VER% bulundu

cd /d "%~dp0"
echo [BASLATILIYOR] 1XX1 cekirdegi...

timeout /t 3 /nobreak >nul
start "" http://localhost:1331

node --experimental-strip-types main.ts
pause
