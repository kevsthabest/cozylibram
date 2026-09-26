@echo off
rem Spicy Shelves - double-click to start the local server
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [Spicy Shelves] Python not found.
  echo.
  echo Install "Python 3.12" free from the Microsoft Store,
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo [Spicy Shelves] Starting at http://localhost:8000 ...
echo Keep this window open while using the app. Close it to stop.
echo.
if not exist server-config.json (
  echo [Spicy Shelves] No server-config.json found.
  echo To auto-share your Hardcover token with home-network devices:
  echo   copy server-config.example.json to server-config.json and paste your token.
  echo.
)
timeout /t 2 /nobreak >nul
start http://localhost:8000
python server.py
