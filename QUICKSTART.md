# Quick Start Guide

Get Dagster Designer up and running in 5 minutes!

## Prerequisites

- Python 3.10 or higher
- Node.js 18 or higher
- npm (comes with Node.js)

## Step 1: Start the Backend

**On macOS/Linux:**
```bash
./start-backend.sh
```

**On Windows:**
```bash
start-backend.bat
```

The backend will:
1. Create a Python virtual environment
2. Install all dependencies
3. Start the API server on `http://localhost:8000`

## Step 2: Start the Frontend

**In a new terminal:**

**On macOS/Linux:**
```bash
./start-frontend.sh
```

**On Windows:**
```bash
start-frontend.bat
```

The frontend will:
1. Install Node dependencies
2. Start the dev server on `http://localhost:5173`

## Step 3: Create Your First Pipeline

1. **Open your browser** to `http://localhost:5173`

2. **Create a new project**:
   - Click "New" button
   - Enter a project name (e.g., "My First Pipeline")
   - Click "Create"

3. **Add components**:
   - Browse components in the left sidebar
   - Drag a component (e.g., dbt or Fivetran) onto the canvas
   - Drop it anywhere on the graph

4. **Configure the component**:
   - Click on the component node
   - The property panel opens on the right
   - Edit the configuration fields
   - Click "Save"

5. **Connect components** (optional):
   - Drag from the right handle of one component
   - Drop onto the left handle of another component
   - This creates a dependency relationship

6. **Preview generated code**:
   - Click "Preview" in the top menu
   - Review the generated YAML files
   - See how your visual design translates to Dagster code

7. **Export your project**:
   - Click "Export" in the top menu
   - Download the ZIP file
   - Extract and use as a Dagster project

## What's Next?

### Understand Components vs Assets

**Key Concept:** Components with the 🏭 badge are **asset factories** - they generate multiple Dagster assets at runtime.

- A **dbt component** might generate 50+ assets (one per model)
- A **Fivetran component** might generate 100+ assets (one per table)
- A **Snowflake SQL component** typically creates 1 asset

You design at the **component level**, but Dagster executes at the **asset level**. See [COMPONENT_ASSET_MODEL.md](COMPONENT_ASSET_MODEL.md) for details.

### Explore Components

The designer includes these Dagster component types:
- **dbt**: Transform data with dbt models (🏭 generates multiple assets)
- **Fivetran**: Sync data from external sources (🏭 generates multiple assets)
- **Sling**: Replicate data between databases (🏭 generates multiple assets)
- **dlt**: Load data from various sources (🏭 generates multiple assets)

### Use Template Variables

In any text field, use template variables for dynamic values:
```yaml
api_key: "{{ env.FIVETRAN_API_KEY }}"
database: "{{ env.DATABASE_URL }}"
```

### Git Integration

To push your pipeline to GitHub:

1. Get a GitHub Personal Access Token:
   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Generate a token with `repo` scope

2. Use the Git API endpoints (see README for details)

### Deploy Your Pipeline

The exported ZIP contains a complete Dagster project:

```bash
# Extract the ZIP
unzip my_first_pipeline.zip
cd my_first_pipeline

# Install the project
pip install -e .

# Run Dagster
dagster dev -f my_first_pipeline_defs/definitions.py
```

## Troubleshooting

**Port already in use?**
- Backend (8000): Change port in `start-backend.sh` or `.bat` file
- Frontend (5173): Change port in `frontend/vite.config.ts`

**Components not showing?**
- Make sure the backend is running
- Check backend terminal for errors
- Some components require additional packages (they're included in requirements.txt)

**Need help?**
- Check the full README.md for detailed documentation
- Review API docs at `http://localhost:8000/docs`

## Example Workflow

Here's a complete example workflow:

1. Create project "Sales Analytics"
2. Add a Fivetran component to sync Salesforce data
3. Configure Fivetran with your account credentials
4. Add a dbt component for transformations
5. Configure dbt with your project path
6. Connect Fivetran → dbt (showing dependency)
7. Preview to see the generated YAML
8. Export and deploy to production

Enjoy building with Dagster Designer!
