#!/bin/bash

# Dagster Designer - Backend Startup Script

echo "Starting Dagster Designer Backend..."

cd backend

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install/update dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# Create necessary directories
mkdir -p data projects

# Start the server
echo "Starting FastAPI server on http://localhost:8000..."
# Exclude projects/ from reload to prevent restarts during project creation
uvicorn app.main:app --reload --reload-exclude="projects/*" --host 0.0.0.0 --port 8000
