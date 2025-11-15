#!/bin/bash

# Kill any existing processes on port 8000
echo "Checking for existing processes on port 8000..."
PIDS=$(lsof -ti:8000 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "Killing existing processes: $PIDS"
    kill -9 $PIDS
    sleep 1
fi

# Activate virtual environment
source venv/bin/activate

# Start the backend without auto-reload
# Auto-reload is disabled to prevent interrupting async background tasks (dependency installation)
# For development: manually restart the server when you change backend code
echo "Starting FastAPI backend on http://localhost:8000..."
uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8000
