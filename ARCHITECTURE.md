# Dagster Designer - Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (User Interface)                    │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Component   │  │    Graph     │  │  Property    │              │
│  │   Palette    │  │   Editor     │  │    Panel     │              │
│  │              │  │              │  │              │              │
│  │  - Search    │  │ - React Flow │  │ - Dynamic    │              │
│  │  - Filter    │  │ - Drag/Drop  │  │   Forms      │              │
│  │  - Drag      │  │ - Connections│  │ - Schema     │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Project Manager (Top Bar)                       │   │
│  │  New | Open | Save | Preview | Export                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
                                │ HTTP/REST API
                                │ (axios, React Query)
                                │
┌───────────────────────────────┴───────────────────────────────────────┐
│                        FastAPI Backend Server                          │
│                          (Port 8000)                                   │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │                     API Layer (FastAPI Routers)                │   │
│  │                                                                 │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │   │
│  │  │Components│  │ Projects │  │   Git    │  │ Codegen  │     │   │
│  │  │   API    │  │   API    │  │   API    │  │   API    │     │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │                    Services Layer (Business Logic)             │   │
│  │                                                                 │   │
│  │  ┌───────────────┐  ┌──────────────┐  ┌────────────────┐     │   │
│  │  │  Component    │  │   Project    │  │   Git Service  │     │   │
│  │  │   Registry    │  │   Service    │  │                │     │   │
│  │  │               │  │              │  │  - Clone       │     │   │
│  │  │ - Scan pkgs   │  │ - CRUD ops   │  │  - Commit      │     │   │
│  │  │ - Extract     │  │ - JSON store │  │  - Push        │     │   │
│  │  │   schemas     │  │              │  │                │     │   │
│  │  └───────────────┘  └──────────────┘  └────────────────┘     │   │
│  │                                                                 │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │          Codegen Service                               │   │   │
│  │  │                                                         │   │   │
│  │  │  - Graph → YAML conversion                            │   │   │
│  │  │  - Project structure generation                        │   │   │
│  │  │  - pyproject.toml creation                            │   │   │
│  │  │  - definitions.py generation                           │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────┬──────────────────────────┬────────────────────────┘
                      │                          │
                      │                          │
        ┌─────────────┴──────────┐   ┌──────────┴─────────────┐
        │                        │   │                        │
        │  File System Storage   │   │  Dagster Component     │
        │                        │   │      Ecosystem         │
        │  ┌──────────────────┐  │   │                        │
        │  │ Projects         │  │   │  ┌──────────────────┐  │
        │  │ - *.json files   │  │   │  │ dagster_dbt      │  │
        │  └──────────────────┘  │   │  │ dagster_fivetran │  │
        │                        │   │  │ dagster_sling    │  │
        │  ┌──────────────────┐  │   │  │ dagster_dlt      │  │
        │  │ Git Repos        │  │   │  │ ... (extensible) │  │
        │  │ - Cloned repos   │  │   │  └──────────────────┘  │
        │  └──────────────────┘  │   │                        │
        │                        │   │  (Pydantic schemas)    │
        └────────────────────────┘   └────────────────────────┘
```

## Component Flow

### 1. Component Discovery Flow
```
Startup
  ↓
ComponentRegistry.initialize()
  ↓
Scan installed Dagster packages
  ↓
Find classes inheriting from Component
  ↓
Extract Pydantic schemas via model_json_schema()
  ↓
Cache component metadata
  ↓
Expose via /api/v1/components endpoint
  ↓
Frontend fetches and displays in palette
```

### 2. Project Creation Flow
```
User clicks "New Project"
  ↓
Frontend: ProjectManager shows dialog
  ↓
User enters project name
  ↓
POST /api/v1/projects
  ↓
Backend: ProjectService.create_project()
  ↓
Generate UUID, create Project model
  ↓
Save as {uuid}.json in projects/ directory
  ↓
Return project to frontend
  ↓
Frontend: Load project into editor
  ↓
Initialize empty React Flow graph
```

### 3. Drag-and-Drop Component Flow
```
User drags component from palette
  ↓
onDragStart: Store component data in dataTransfer
  ↓
User drops on canvas
  ↓
onDrop: Extract component data
  ↓
Calculate drop position (x, y)
  ↓
Create new Node object
  ↓
Add to React Flow nodes array
  ↓
Trigger graph update
  ↓
PUT /api/v1/projects/{id} with updated graph
  ↓
Backend saves updated JSON
```

### 4. Property Editing Flow
```
User clicks component node
  ↓
GraphEditor.onNodeClick()
  ↓
Set selectedNodeId state
  ↓
PropertyPanel receives nodeId prop
  ↓
Fetch component schema via /api/v1/components/{type}
  ↓
Render dynamic form based on schema
  ↓
User edits field values
  ↓
Update local formData state
  ↓
User clicks "Save"
  ↓
Update node.data.attributes
  ↓
Trigger graph save
  ↓
Backend persists changes
```

### 5. Code Generation Flow
```
User clicks "Export"
  ↓
POST /api/v1/codegen/generate
  ↓
Backend: CodegenService.generate_dagster_yaml()
  ↓
Create temp directory
  ↓
For each node in graph:
  │  Create {component_name}.yaml
  │  Write type, attributes, translation
  ↓
Generate pyproject.toml
  ↓
Generate definitions.py
  ↓
Generate dagster.yaml (instance config)
  ↓
Generate workspace.yaml
  ↓
Create ZIP archive
  ↓
Return as file download
  ↓
User receives dagster_project.zip
```

## Data Models

### Frontend Types (TypeScript)

```typescript
interface ComponentSchema {
  name: string;              // "DbtProjectComponent"
  module: string;            // "dagster_dbt"
  type: string;              // "dagster_dbt.DbtProjectComponent"
  description?: string;      // Docstring
  schema: JSONSchema;        // Pydantic JSON schema
  category: string;          // "dbt", "fivetran", etc.
  icon?: string;             // Icon identifier
}

interface GraphNode {
  id: string;                // Unique node ID
  type: string;              // "component"
  data: {
    label: string;           // Display name
    component_type: string;  // Full type path
    attributes: object;      // Configuration
    translation?: object;    // Asset customization
    post_processing?: object;// Post-processing rules
  };
  position: { x: number; y: number };
}

interface Project {
  id: string;
  name: string;
  description?: string;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  created_at: string;
  updated_at: string;
  git_repo?: string;
  git_branch: string;
}
```

### Backend Models (Pydantic)

```python
class ComponentSchema(BaseModel):
    name: str
    module: str
    type: str
    description: str | None
    schema: dict[str, Any]
    category: str
    icon: str | None

class GraphNode(BaseModel):
    id: str
    type: str
    data: dict[str, Any]
    position: dict[str, float]

class Project(BaseModel):
    id: str
    name: str
    description: str | None
    graph: PipelineGraph
    created_at: datetime
    updated_at: datetime
    git_repo: str | None
    git_branch: str
```

## State Management

### Frontend State (Zustand)

```typescript
interface ProjectStore {
  currentProject: Project | null;
  projects: Project[];

  // Actions
  loadProject(id: string): Promise<void>;
  loadProjects(): Promise<void>;
  createProject(name: string): Promise<Project>;
  updateGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<void>;
  saveProject(): Promise<void>;
}
```

### Backend State

- **In-Memory**: Component registry cache
- **File System**:
  - Projects: `./projects/{uuid}.json`
  - Git repos: `./data/repos/{repo_name}/`

## API Request Flow Example

**Create a project with a dbt component:**

```
1. POST /api/v1/projects
   Body: { name: "Analytics Pipeline" }
   Response: { id: "abc-123", name: "Analytics Pipeline", graph: { nodes: [], edges: [] } }

2. GET /api/v1/components/dagster_dbt.DbtProjectComponent
   Response: {
     name: "DbtProjectComponent",
     schema: { properties: { project: { type: "string" }, ... } }
   }

3. PUT /api/v1/projects/abc-123
   Body: {
     graph: {
       nodes: [{
         id: "dbt-1",
         type: "component",
         data: {
           label: "Transform",
           component_type: "dagster_dbt.DbtProjectComponent",
           attributes: { project: "/path/to/dbt" }
         },
         position: { x: 100, y: 100 }
       }],
       edges: []
     }
   }
   Response: Updated project

4. GET /api/v1/codegen/preview/abc-123
   Response: {
     files: {
       "analytics_pipeline/analytics_pipeline_defs/transform.yaml": "type: dagster_dbt.DbtProjectComponent\nattributes:\n  project: /path/to/dbt\n",
       ...
     }
   }
```

## Security Boundaries

```
┌──────────────────────────────────────────────┐
│  Frontend (Browser)                          │
│  - No secrets stored                         │
│  - API calls over HTTP(S)                    │
│  - CORS restricted                           │
└──────────────────┬───────────────────────────┘
                   │
                   │ HTTPS (in production)
                   │
┌──────────────────┴───────────────────────────┐
│  Backend API                                 │
│  - Input validation (Pydantic)               │
│  - No authentication (local dev)             │
│  - Git tokens in memory only                 │
└──────────────────┬───────────────────────────┘
                   │
       ┌───────────┴─────────────┐
       │                         │
┌──────┴─────┐          ┌────────┴──────┐
│ File System│          │  Git (GitHub) │
│ - Projects │          │  - With token │
│ - Repos    │          │  - HTTPS only │
└────────────┘          └───────────────┘
```

## Extension Points

### Adding New Component Libraries

1. **Install package**: `pip install dagster-airbyte`
2. **Register in registry**: Add to `_scan_module()` calls
3. **Add icon mapping**: Update frontend icon map
4. **Deploy**: Restart backend, components auto-discovered

### Custom Field Types

1. **Backend**: Add to `_extract_schema()` in component_registry.py
2. **Frontend**: Add case to `renderField()` in PropertyPanel.tsx

### New Export Formats

1. Create new method in `CodegenService`
2. Add endpoint in `codegen.py` router
3. Wire up in frontend `ProjectManager.tsx`

## Performance Characteristics

### Backend
- **Startup time**: ~2 seconds (component scanning)
- **Component list**: < 100ms (cached)
- **Project load**: < 50ms (JSON read)
- **Project save**: < 100ms (JSON write)
- **Code generation**: < 500ms (small projects)
- **Git operations**: Variable (network dependent)

### Frontend
- **Initial load**: ~1 second
- **Component rendering**: 60 FPS (React Flow)
- **Form rendering**: < 100ms (dynamic fields)
- **Graph updates**: Debounced 500ms

## Scalability Considerations

### Current Limits
- Projects: Limited by disk space
- Components: ~100 (discovery performance)
- Nodes per graph: ~1000 (React Flow optimized)
- Concurrent users: 1 (local development)

### To Scale
- Add database (PostgreSQL/MongoDB)
- Add caching layer (Redis)
- Add message queue (Celery)
- Add authentication/multi-tenancy
- Deploy to cloud with auto-scaling
