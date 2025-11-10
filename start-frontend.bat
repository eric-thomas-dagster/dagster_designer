@echo off
REM Dagster Designer - Frontend Startup Script (Windows)

echo Starting Dagster Designer Frontend...

cd frontend

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

REM Start the dev server
echo Starting Vite dev server on http://localhost:5173...
npm run dev
