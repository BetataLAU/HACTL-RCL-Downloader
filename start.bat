@echo off
cd /d "%~dp0"
title HACTL RCL Auto-Download

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies, please wait...
  echo  - requires internet connection, may take 1-2 minutes
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Please check your internet connection and run this file again.
    pause
    exit /b 1
  )
)

echo.
echo =============================================
echo   HACTL RCL Auto Download Tool
echo   Open http://localhost:3090 in your browser
echo   (the browser should open automatically)
echo   Close this window or press Ctrl+C to stop
echo =============================================
echo.
node "%~dp0server.js"
pause