#!/bin/bash

# Dagster Designer - Frontend Startup Script

echo "Starting Dagster Designer Frontend..."

cd frontend

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the dev server
echo "Starting Vite dev server on http://localhost:5173..."
npm run dev
