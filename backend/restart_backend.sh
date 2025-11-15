#!/bin/bash

# Force restart the backend (useful after updating project-specific components)
echo "Force restarting backend..."

# Kill any existing processes on port 8000
PIDS=$(lsof -ti:8000 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "Killing processes: $PIDS"
    kill -9 $PIDS
    sleep 1
    echo "Backend stopped. Start it again with ./start_backend.sh"
else
    echo "No backend process found on port 8000"
fi
