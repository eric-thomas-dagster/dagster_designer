# Dagster Designer

A visual pipeline designer for Dagster with drag-and-drop component editing, inspired by Kestra, Flowable, and dbt Cloud.

## Features

- **Visual Graph Editor**: Drag-and-drop interface powered by React Flow
- **Component Library**: Built-in support for Dagster components (dbt, Fivetran, Sling, dlt)
- **Dynamic Property Editor**: Auto-generated forms based on Pydantic schemas
- **Code Generation**: Export projects as Dagster YAML component files
- **Git Integration**: Clone, commit, and push to GitHub repositories
- **Local & Cloud Ready**: Run locally or deploy to cloud infrastructure

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

### 1. Backend Setup

```bash
cd backend

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The backend API will be available at `http://localhost:8000`

### 2. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Run the dev server
npm run dev
```

The frontend will be available at `http://localhost:5173`

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

### Git Integration

To use Git features:

1. Create a GitHub Personal Access Token with `repo` scope
2. In your project, configure the Git repository URL
3. Use the Git operations API or UI to:
   - Clone a repository
   - Commit generated files
   - Push changes to GitHub

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

## Roadmap

- [ ] Add more Dagster component libraries (Airbyte, etc.)
- [ ] Implement asset dependency validation
- [ ] Add collaboration features (multi-user editing)
- [ ] Integrate with Dagster Cloud deployment
- [ ] Add pipeline testing/validation
- [ ] Support for custom Python components
- [ ] Version control integration (branch management)
- [ ] Real-time collaboration

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
