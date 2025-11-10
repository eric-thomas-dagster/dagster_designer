# Dagster Designer

A visual pipeline designer for Dagster with drag-and-drop component editing, inspired by Kestra, Flowable, and dbt Cloud.

**Build Dagster pipelines visually** - Design data pipelines with a drag-and-drop interface, manage assets with custom lineage, and deploy with full Dagster CLI integration.

## Features

### 🎨 Visual Design & Editing
- **Drag-and-Drop Graph Editor**: Visual pipeline designer powered by React Flow
- **Dual View Modes**:
  - **Component View**: Design component orchestration
  - **Asset View**: Visualize the full asset lineage graph with custom lineage support
- **Smart Arrange Groups**: Auto-organize assets by groups in a grid layout
- **Custom Lineage**: Draw dependencies between any assets to inject custom lineage at runtime
- **Interactive Nodes**: Click to edit, drag to reposition, connect with handles
- **Node Selection**: Multi-select assets with CMD/CTRL+click for bulk operations

### 🏭 Component Management
- **Built-in Component Library**: Support for all major Dagster components:
  - dbt (DbtProjectComponent)
  - Fivetran (FivetranAccountComponent)
  - Sling (SlingReplicationCollectionComponent)
  - dlt (DltLoadCollectionComponent)
  - Snowflake SQL, Python assets, and more
- **Custom Components**: Create your own components with visual templates
- **Component Discovery**: Automatic schema introspection from Pydantic models
- **Dynamic Forms**: Auto-generated configuration UI based on component schemas

### 💻 Code Editor & Primitives
- **Integrated Code Editor**: Built-in Monaco Editor (VS Code) for editing:
  - Python assets with syntax highlighting
  - SQL queries
  - Component YAML definitions
  - Any project file
- **Primitives Manager**: Visual UI for creating and managing:
  - Jobs (asset selection, schedules, execution)
  - Schedules (cron expressions with visual builder)
  - Sensors (filesystem, webhook, database, S3, email)
  - Asset Checks (data quality validation)
- **Python Asset Creator**: Quick-create Python assets with templates

### 🔄 Project Import & Export
- **Import Existing Projects**: Automatically discover and import existing Dagster projects
  - Scans for defs folders and components
  - Preserves existing structure
  - Generates visual graph from definitions.py
- **Export as ZIP**: Download complete Dagster project ready to deploy
- **Live Preview**: See generated YAML and Python code in real-time
- **File Browser**: Navigate and edit project files directly in the UI

### ⚙️ Dagster CLI Integration
- **Embedded Dagster Web UI**: Launch and manage Dagster dev server from the designer
- **Asset Introspection**: Automatic discovery of assets and their dependencies from running projects
- **Component Validation**: `dg check` and `dg list defs` integration
- **Asset Materialization**: Trigger materializations from the UI with multi-select support
- **Real-time Status**: See which assets are materialized/stale

### 🔗 Custom Lineage & Dependencies
- **Visual Dependency Editing**: Draw edges between assets to create custom lineage
- **Dynamic Injection**: Dependencies are injected at runtime via `map_resolved_asset_specs()`
- **Cross-Component Dependencies**: Link assets from different components (dbt, Python, etc.)
- **Self-loop Prevention**: Automatic validation to prevent invalid dependencies
- **dbt Model Support**: Smart detection to avoid conflicts with dbt's native dependencies

### 🌐 Environment & Resources
- **Environment Variables Manager**:
  - Create and edit .env files
  - Secure credential storage
  - Use `{{ env.VAR_NAME }}` templates in configs
- **Resource Configuration**: Configure database connections, API keys, and other resources
- **Multi-Environment Support**: Separate configs for dev/staging/prod

### 🔌 Git Integration (Basic)
- **Clone on Create**: Import projects from Git repositories when creating new projects
- **API Endpoints**: Backend support for clone, commit, push, pull, and status operations
- **Example Templates**: Pre-configured Git URLs for common projects (Jaffle Shop, etc.)
- **Note**: Full visual Git UI (commit dialog, branch management) is planned for future release

### 📊 Asset Visualization
- **Asset Metadata Display**: View descriptions, groups, owners, tags, and checks
- **Dependency Graph**: Interactive visualization of asset dependencies
- **Source Component Badges**: See which component generated each asset
- **Group Organization**: Color-coded groups with visual indicators
- **IO Type Indicators**: Show DataFrames and other output types

### 🎯 Code Generation
- **YAML Components**: Generate Dagster component YAML files
- **definitions.py**: Auto-generate with custom lineage support
- **Asset Customizations**: Override group names and descriptions
- **Custom Component Registration**: Automatic import of designer components

## Understanding Components vs Assets

**Important:** This designer works at the **component level**, not the individual asset level.

### What are Components?

**Components are asset factories** - they generate multiple Dagster assets at runtime:

- **dbt Component** → Generates one asset per dbt model in your project (could be 50+ assets)
- **Fivetran Component** → Generates one asset per table in each connector (could be 100+ assets)
- **Sling Component** → Generates assets based on replication configs
- **dlt Component** → Generates assets for each dlt resource

### What You See in the Designer

The visual graph shows **component-level orchestration**:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Fivetran   │────▶ │     dbt     │────▶ │  Snowflake  │
│  Component  │      │  Component  │      │     SQL     │
└─────────────┘      └─────────────┘      └─────────────┘
  (100 assets)         (50 assets)           (1 asset)
```

Components marked with a 🏭 factory badge will generate multiple assets dynamically.

### What Dagster Executes

The actual **asset lineage graph** is much more detailed and is computed by Dagster when it loads your component definitions. Asset dependencies are determined by:
- dbt's `ref()` and `source()` relationships
- Fivetran sync configurations
- Explicit asset key dependencies in `post_processing` rules

For a complete explanation, see [COMPONENT_ASSET_MODEL.md](COMPONENT_ASSET_MODEL.md).

## Technical Highlights

### Custom Lineage Injection
Custom lineage is injected at runtime using Dagster's `map_resolved_asset_specs()` API:

```python
# Generated in definitions.py
defs = defs.map_resolved_asset_specs(
    func=lambda spec: spec.merge_attributes(deps=source_keys),
    selection=target_asset  # Only modify specific assets
)
```

This allows you to:
- Add dependencies between any assets (Python, dbt, etc.)
- Preserve dbt's native dependencies
- Avoid conflicts with component-generated assets

### Component Auto-Discovery
The component registry automatically discovers Dagster components:

```python
# Scans installed packages
self._scan_module("dagster_dbt", "dbt")
self._scan_module("dagster_fivetran", "fivetran")

# Introspects Pydantic schemas
schema = component_type.get_schema()
# Generates UI forms automatically
```

### Project Import Intelligence
When importing projects:
1. Scans for `defs/` folders and component YAML files
2. Introspects `definitions.py` for existing components
3. Runs `dg list defs` to discover all assets
4. Builds dependency graph from asset specs
5. Preserves custom lineage from `custom_lineage.json`

### State-Backed Components
Custom components (Jobs, Schedules, Sensors) are "state-backed":
- Stored in project JSON, not YAML
- Generate component YAML at codegen time
- Full UI for configuration
- No manual YAML editing required

See [STATE_BACKED_COMPONENTS.md](STATE_BACKED_COMPONENTS.md) for details.

## Architecture

### Backend (Python/FastAPI)
- Component registry with automatic Pydantic schema introspection
- Project management with JSON storage
- Code generation service (graph → YAML)
- Git operations (clone, commit, push)
- RESTful API

### Frontend (React/TypeScript)
- React Flow for graph visualization
- Component palette with search/filter
- Dynamic property panel
- Project manager
- Code preview & export

## Prerequisites

- Python 3.10+
- Node.js 18+
- npm or yarn

## Quick Start

### 1. First Time Setup

**Backend:**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**Frontend:**
```bash
cd frontend
npm install
```

### 2. Start the Application

**Using Start Scripts (Recommended):**

```bash
# Start backend (from project root)
./start-backend.sh      # On macOS/Linux
start-backend.bat       # On Windows

# Start frontend (from project root)
./start-frontend.sh     # On macOS/Linux
start-frontend.bat      # On Windows
```

The backend API will be available at `http://localhost:8000`
The frontend will be available at `http://localhost:5173`

**Alternative - Manual Start:**

Backend:
```bash
cd backend
source venv/bin/activate  # On Windows: venv\Scripts\activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:
```bash
cd frontend
npm run dev
```

## Key Workflows

### 🚀 Quickstart: Creating Your First Pipeline

1. **Launch the App**
   - Start backend: `./start-backend.sh` (or `.bat` on Windows)
   - Start frontend: `./start-frontend.sh` (or `.bat` on Windows)
   - Open `http://localhost:5173`

2. **Create a New Project**
   - Click "New Project"
   - Enter a name and click "Create"

3. **Add Components**
   - Switch to "Component View" in the top-right
   - Drag a dbt component from the palette
   - Configure your dbt project path
   - Add other components (Fivetran, Sling, etc.)

4. **View Asset Lineage**
   - Switch to "Asset View"
   - Click "Regenerate Assets" to discover all assets
   - See the full asset dependency graph

5. **Add Custom Lineage**
   - In Asset View, drag from one asset to another
   - Custom dependencies are injected at runtime

6. **Launch Dagster**
   - Click the Dagster icon in the top bar
   - Start the dev server
   - Open Dagster UI to materialize assets

### 📥 Import Existing Dagster Project

1. **Click "Import Project"**
2. **Browse to your Dagster project directory**
   - Must have a `dg.toml` or `pyproject.toml`
   - Must have a `defs/` folder or definitions.py
3. **Designer automatically**:
   - Scans for components
   - Discovers assets and dependencies
   - Generates visual graph
   - Preserves your existing code

### ✏️ Create Custom Components

1. **Click "Templates" in the sidebar**
2. **Create New Component**
   - Choose a base type (Python, SQL, etc.)
   - Configure inputs/outputs
   - Add custom logic
3. **Use in Projects**
   - Drag from "Custom Components" section
   - Configure like any other component

### 🎯 Manage Primitives

1. **Click "Primitives" in the sidebar**
2. **Create Jobs**
   - Select assets to include
   - Configure execution settings
   - Add schedules or sensors
3. **Create Schedules**
   - Use the visual cron builder
   - Link to jobs or asset selections
4. **Create Sensors**
   - Choose sensor type (filesystem, webhook, etc.)
   - Configure trigger conditions

## Usage

### Creating a Pipeline

1. **Create a New Project**
   - Click "New" in the top menu
   - Enter a project name
   - Click "Create"

2. **Add Components**
   - Browse the component palette on the left
   - Drag components onto the canvas
   - Connect components by dragging from output handles to input handles

3. **Configure Components**
   - Click a component node to open the property panel
   - Edit configuration values
   - Use template variables like `{{ env.API_KEY }}` for secrets
   - Click "Save" to apply changes

4. **Preview Generated Code**
   - Click "Preview" to see the generated YAML files
   - Review the Dagster component configuration

5. **Export Project**
   - Click "Export" to download a ZIP file
   - Extract and use as a Dagster project

### Component Types

The designer supports these Dagster component libraries:

**Asset Factory Components** (generate multiple assets):
- **dbt**: `dagster_dbt.DbtProjectComponent` - One asset per dbt model
- **Fivetran**: `dagster_fivetran.FivetranAccountComponent` - One asset per connector table
- **Sling**: `dagster_sling.SlingReplicationCollectionComponent` - Assets per replication config
- **dlt**: `dagster_dlt.DltLoadCollectionComponent` - Assets per dlt resource

**Direct Asset Components** (typically 1:1 with assets):
- **Snowflake SQL**: `dagster_snowflake.SnowflakeSQLComponent` - Creates specific table asset
- Other custom SQL or Python components

## Project Structure

```
dagster_designer/
├── backend/
│   ├── app/
│   │   ├── api/           # API endpoints
│   │   ├── core/          # Configuration
│   │   ├── models/        # Pydantic models
│   │   ├── services/      # Business logic
│   │   └── main.py        # FastAPI app
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── hooks/         # Custom hooks
│   │   ├── services/      # API client
│   │   ├── types/         # TypeScript types
│   │   └── App.tsx        # Main app
│   └── package.json
└── README.md
```

## API Documentation

Once the backend is running, visit:
- API docs: `http://localhost:8000/docs`
- OpenAPI spec: `http://localhost:8000/openapi.json`

### Key Endpoints

- `GET /api/v1/components` - List available components
- `GET /api/v1/projects` - List projects
- `POST /api/v1/projects` - Create project
- `PUT /api/v1/projects/{id}` - Update project
- `GET /api/v1/codegen/preview/{id}` - Preview generated code
- `POST /api/v1/codegen/generate` - Export project as ZIP

## Development

### Backend Development

```bash
cd backend

# Run with auto-reload
uvicorn app.main:app --reload

# Run tests (if available)
pytest
```

### Frontend Development

```bash
cd frontend

# Run dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint
npm run lint
```

## Deployment

### Local Development
The current setup is optimized for local development with hot-reloading.

### Production Deployment

**Backend**:
```bash
# Build a production image
cd backend
pip install gunicorn
gunicorn app.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

**Frontend**:
```bash
cd frontend
npm run build
# Serve the dist/ directory with your web server
```

### Docker (Future)
A `docker-compose.yml` can be added for containerized deployment.

## Configuration

### Backend Configuration

Create `backend/.env` to customize settings:

```env
# API
API_TITLE="Dagster Designer API"
API_VERSION="0.1.0"

# CORS
CORS_ORIGINS=["http://localhost:5173","http://localhost:3000"]

# Storage
DATA_DIR="./data"
PROJECTS_DIR="./projects"

# Git
DEFAULT_BRANCH="main"
```

### Frontend Configuration

The frontend proxies API requests to `http://localhost:8000` in development.

For production, update `vite.config.ts` to point to your backend URL.

## Extending

### Adding Custom Components

1. Install the Dagster component library in the backend:
   ```bash
   pip install dagster-your-component
   ```

2. Register in `backend/app/services/component_registry.py`:
   ```python
   self._scan_module("dagster_your_component", "your_category")
   ```

3. Add an icon mapping in the frontend components

### Adding Custom Fields

The property panel automatically generates form fields based on Pydantic schemas. Supported types:
- `string` → Text input
- `number`/`integer` → Number input
- `boolean` → Checkbox
- `array` → Textarea (one item per line)
- `object` → JSON editor

## Troubleshooting

**Backend won't start**:
- Ensure Python 3.10+ is installed
- Check that all dependencies are installed: `pip install -r requirements.txt`
- Verify port 8000 is not in use

**Frontend won't start**:
- Ensure Node.js 18+ is installed
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`
- Check that port 5173 is available

**Components not loading**:
- Ensure Dagster component libraries are installed in the backend
- Check backend logs for import errors
- Verify the component registry initialization

**Graph not saving**:
- Check browser console for errors
- Verify the backend API is running
- Check backend logs for save errors

## What's Included

✅ **Component orchestration** - Visual design of Dagster components
✅ **Asset lineage visualization** - Full asset graph with custom lineage
✅ **Code editor** - Built-in Monaco editor for Python/SQL/YAML
✅ **Primitives manager** - Jobs, schedules, sensors, asset checks
✅ **Project import** - Discover and import existing Dagster projects
✅ **Dagster CLI integration** - Embedded webserver, materialization, validation
✅ **Environment variables** - Secure credential management
✅ **Git clone support** - Import projects from Git repositories
✅ **Custom components** - Create your own component templates
✅ **Custom lineage injection** - Runtime dependency modification
✅ **Multi-select operations** - Bulk asset materialization
✅ **Group management** - Organize and arrange asset groups

## Roadmap

### High Priority
- [ ] **Partitioned Assets** - Support for time-based and static partitioned assets with partition mapping
- [ ] **Job Submission UI** - Submit and trigger job runs directly from the designer with parameter configuration
- [ ] **Run Config Editor** - Visual editor for setting run configuration, tags, and operational parameters
- [ ] **Type-Aware Lineage** - Smart dependency validation based on input/output types (e.g., DataFrame → DataFrame connections only)
- [ ] **Asset Sensors & Automation Conditions** - Support for asset sensors and declarative automation conditions for asset-driven orchestration

### Features
- [ ] **Git UI** - Visual commit/push dialog, branch management, diff viewer
- [ ] **Docker deployment** - Containerized setup with docker-compose
- [ ] **More component libraries** - Airbyte, Meltano, etc.
- [ ] **Dagster Cloud integration** - Deploy directly to Dagster Cloud
- [ ] **Real-time collaboration** - Multi-user editing with presence indicators
- [ ] **Version history** - Time-travel and rollback for projects
- [ ] **Testing framework** - Built-in asset testing and validation
- [ ] **Template marketplace** - Share and discover component templates
- [ ] **Advanced scheduling** - Visual scheduling with calendar view
- [ ] **Observability** - Built-in monitoring and alerting
- [ ] **Data catalog** - Browse and search assets across projects

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built with [Dagster](https://dagster.io/)
- Powered by [React Flow](https://reactflow.dev/)
- UI inspired by [Kestra](https://kestra.io/), [Flowable](https://www.flowable.com/), and [dbt Cloud](https://www.getdbt.com/product/dbt-cloud)
