@echo off
REM Dagster Designer - Backend Startup Script (Windows)

echo Starting Dagster Designer Backend...

cd backend

REM Check if virtual environment exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
echo Activating virtual environment...
call venv\Scripts\activate.bat

REM Install/update dependencies
echo Installing dependencies...
pip install -r requirements.txt

REM Create necessary directories
if not exist "data" mkdir data
if not exist "projects" mkdir projects

REM Start the server
echo Starting FastAPI server on http://localhost:8000...
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
