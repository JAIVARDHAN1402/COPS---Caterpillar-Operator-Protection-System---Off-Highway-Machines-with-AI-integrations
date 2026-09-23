@echo off
REM One-click start: API on :8000, web app on :5173
cd /d "%~dp0"
if not exist backend\.venv (
  python -m venv backend\.venv
  backend\.venv\Scripts\python -m pip install -r backend\requirements.txt
)
if not exist frontend\node_modules (
  pushd frontend && call npm install && popd
)
start "COPS API" cmd /k backend\.venv\Scripts\python -m uvicorn app.main:app --app-dir backend --port 8000
start "COPS Web" cmd /k npm --prefix frontend run dev
timeout /t 5 >nul
start http://localhost:5173
