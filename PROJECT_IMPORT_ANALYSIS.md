# Dagster Designer - Project Management Analysis

## Executive Summary

The Dagster Designer currently supports creating **new** Dagster projects from scratch using the `create-dagster` CLI tool. There is already a backend API endpoint (`POST /projects/import`) to support importing existing Dagster projects, but it lacks full frontend integration and needs validation testing.

---

## 1. CURRENT PROJECT MANAGEMENT WORKFLOW

### 1.1 Project Creation Flow (Current Implementation)

**Frontend (ProjectManager.tsx)**
- User clicks "New Project" → Opens dialog
- Inputs: Project name, optional Git repository URL, Git branch
- `handleCreateProject()` calls `createProject()` from Zustand store

**Backend API Endpoint: `POST /projects`**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/api/projects.py:35-54
@router.post("", response_model=Project, status_code=201)
async def create_project(project_create: ProjectCreate):
    """Create a new pipeline project."""
    project = project_service.create_project(project_create)
```

**Backend Service: ProjectService.create_project()**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/services/project_service.py:37-97
```

**Creation Steps:**
1. Generate UUID for project ID
2. Create Project model instance
3. If git_repo provided: Add DbtProjectComponent automatically
4. Call `_scaffold_project_with_create_dagster()` → Uses `uvx create-dagster project`
5. Install project dependencies using `uv sync --all-groups`
6. If dbt component: Run `dg scaffold defs dagster_dbt.DbtProjectComponent`
7. Auto-discover assets using `dg list defs`
8. Save project metadata to JSON file

**Key File Locations:**
- Project metadata: `{projects_dir}/{project_id}.json`
- Project directory: `./projects/project_{id_prefix}_{name}/`
- Virtual environment: `./projects/project_{id_prefix}_{name}/.venv/`

### 1.2 Project Structure Schema

**Project Model (Pydantic):**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/models/project.py

class Project(BaseModel):
    id: str                           # UUID
    name: str                         # User-defined name
    description: str | None           # Optional description
    directory_name: str | None        # Sanitized directory name (project_{id}_{name})
    graph: PipelineGraph              # Assets and lineage
    components: list[ComponentInstance] # Dagster components
    custom_lineage: list[CustomLineageEdge]  # User-drawn dependencies
    created_at: datetime
    updated_at: datetime
    git_repo: str | None              # Git repository URL
    git_branch: str                   # Git branch (default: main)
```

### 1.3 Project CRUD Operations

**Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/projects` | Create new project |
| GET | `/projects` | List all projects |
| GET | `/projects/{id}` | Get single project |
| PUT | `/projects/{id}` | Update project |
| DELETE | `/projects/{id}` | Delete project |
| POST | `/projects/{id}/regenerate-assets` | Regenerate asset lineage |
| POST | `/projects/{id}/validate` | Validate project (runs `dg list defs`) |
| POST | `/projects/{id}/materialize` | Run assets (executes `dg launch`) |
| POST | `/projects/{id}/custom-lineage` | Add custom lineage edge |
| DELETE | `/projects/{id}/custom-lineage` | Remove custom lineage edge |

**Frontend API Service:**
```typescript
// File: /Users/ericthomas/dagster_designer/frontend/src/services/api.ts:46-118

export const projectsApi = {
  list: async () => { /* GET /projects */ },
  get: async (id: string) => { /* GET /projects/{id} */ },
  create: async (data: ProjectCreate) => { /* POST /projects */ },
  update: async (id: string, data: Partial<Project>) => { /* PUT /projects/{id} */ },
  delete: async (id: string) => { /* DELETE /projects/{id} */ },
  regenerateAssets: async (projectId: string) => { /* POST /projects/{id}/regenerate-assets */ },
  validate: async (projectId: string) => { /* POST /projects/{id}/validate */ },
  materialize: async (projectId: string, assetKeys?: string[]) => { /* POST /projects/{id}/materialize */ },
  addCustomLineage: async (projectId: string, source: string, target: string) => { /* ... */ },
  removeCustomLineage: async (projectId: string, source: string, target: string) => { /* ... */ },
};
```

---

## 2. EXISTING IMPORT FUNCTIONALITY

### 2.1 Backend Import Endpoint (Already Exists!)

**Endpoint: `POST /projects/import`**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/api/projects.py:57-87

class ProjectImportRequest(BaseModel):
    path: str = Field(..., description="Absolute path to existing Dagster project directory")

@router.post("/import", response_model=Project, status_code=201)
async def import_project(request: ProjectImportRequest):
    """Import an existing Dagster project from disk.
    
    This will:
    1. Validate the path is a valid Dagster project
    2. Copy the project to the projects directory
    3. Create a project record in the backend
    4. Run asset introspection to discover assets
    """
    try:
        project = project_service.import_project(request.path)
        # Auto-regenerate assets to discover existing assets
        nodes, edges = asset_introspection_service.get_assets_for_project(project)
        project.graph.nodes = nodes
        project.graph.edges = edges
        project_service._save_project(project)
        return project
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import project: {str(e)}")
```

### 2.2 Backend Import Service

**Service Method: project_service.import_project()**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/services/project_service.py
# (Method exists but needs to be found/verified)
```

**Workflow:**
1. Validate path is a valid Dagster project directory
2. Detect project structure and existing components
3. Copy project files to `./projects/` directory
4. Generate project metadata JSON
5. Run asset introspection (`dg list defs`) to discover existing assets
6. Create PipelineGraph with discovered assets
7. Return Project model

### 2.3 Asset Introspection Service

**Service: AssetIntrospectionService**
```python
# File: /Users/ericthomas/dagster_designer/backend/app/services/asset_introspection_service.py

def get_assets_for_project(self, project: Project) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Get assets and dependencies for a project by running dg list defs."""
    project_dir = self._get_project_dir(project)
    assets_data = self._run_dg_list_defs(project, project_dir)
    nodes, edges = self._parse_assets_data(assets_data, project, existing_positions)
    return nodes, edges
```

**How It Works:**
1. Executes `dg list defs` in the project's virtual environment
2. Parses JSON output to extract assets and dependencies
3. Creates GraphNode objects for each asset
4. Creates GraphEdge objects for dependencies
5. Preserves existing node positions if available

---

## 3. PROJECT CREATION VS IMPORT WORKFLOW COMPARISON

### Flow Comparison

**CREATE (New Project)**
```
User Input (name, optional git_repo)
  ↓
POST /projects (ProjectCreate)
  ↓
Generate UUID + directory
  ↓
Run: uvx create-dagster project {dir}
  ↓
Run: uv sync --all-groups (install dependencies)
  ↓
If dbt component: dg scaffold defs dagster_dbt.DbtProjectComponent
  ↓
Auto-discover assets: dg list defs
  ↓
Save project metadata JSON
  ↓
Return Project to frontend
```

**IMPORT (Existing Project)**
```
User Input (absolute path to existing project)
  ↓
POST /projects/import (ProjectImportRequest)
  ↓
Validate project structure
  ↓
Copy to projects directory
  ↓
Create project metadata (generate UUID)
  ↓
Run asset introspection: dg list defs
  ↓
Save project metadata JSON
  ↓
Return Project to frontend
```

---

## 4. DATABASE/STORAGE MODEL

### Project Persistence

**Storage Location:**
```
/Users/ericthomas/dagster_designer/
├── projects/                              # Root projects directory (settings.projects_dir)
│   ├── project_12ab34cd_my_project/      # Project directory (directory_name from Project.directory_name)
│   │   ├── .venv/                        # Virtual environment
│   │   │   ├── bin/
│   │   │   │   ├── python
│   │   │   │   ├── dg                    # Dagster dg CLI
│   │   │   │   └── pip
│   │   │   └── lib/
│   │   ├── src/
│   │   │   └── project_12ab34cd_my_project/
│   │   │       ├── __init__.py
│   │   │       ├── definitions.py        # Generated with asset customizations
│   │   │       ├── asset_customizations.json
│   │   │       ├── defs/                 # Component definitions
│   │   │       │   ├── custom_lineage.json
│   │   │       │   └── {component_id}/
│   │   │       │       └── defs.yaml     # Component YAML
│   │   │       └── dagster_designer_components/  # Copied from source
│   │   ├── pyproject.toml                # Project dependencies
│   │   ├── uv.lock                       # Dependency lock file
│   │   ├── dbt-project/                  # Cloned dbt repo (if imported)
│   │   └── profiles.yml                  # DBT profiles (if dbt project)
│   │
│   └── {project_id_1}.json               # Project metadata for project_12ab34cd_my_project
```

**Project Metadata File Format:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "My Dagster Project",
  "description": "Optional description",
  "directory_name": "project_550e8400_my_dagster_project",
  "graph": {
    "nodes": [
      {
        "id": "asset_1",
        "label": "My Asset",
        "node_kind": "asset",
        "position": { "x": 100, "y": 200 },
        "data": {
          "asset_key": ["my_asset"],
          "deps": []
        }
      }
    ],
    "edges": [
      {
        "id": "edge_1",
        "source": "asset_1",
        "target": "asset_2",
        "is_custom": false
      }
    ]
  },
  "components": [
    {
      "id": "dbt-component-123",
      "component_type": "dagster_dbt.DbtProjectComponent",
      "label": "dbt Component",
      "attributes": { "project_path": "dbt-project" },
      "is_asset_factory": true
    }
  ],
  "custom_lineage": [
    {
      "source": "asset_1",
      "target": "asset_2"
    }
  ],
  "created_at": "2025-11-07T12:00:00",
  "updated_at": "2025-11-07T12:00:00",
  "git_repo": "https://github.com/user/repo.git",
  "git_branch": "main"
}
```

---

## 5. FRONTEND COMPONENTS FOR PROJECT MANAGEMENT

### ProjectManager Component
```typescript
// File: /Users/ericthomas/dagster_designer/frontend/src/components/ProjectManager.tsx

Key Features:
- Project menu (New, Open, Save)
- Actions menu (Materialize, Regenerate Lineage, Validate, Preview, Export)
- New Project dialog with:
  - Project name input
  - Optional Git repository URL
  - Optional Git branch
  - Quick start templates (Jaffle Shop, Snowflake Quickstart)
- Open Project dialog listing all available projects
- Code preview modal
- Validation results modal
```

**UI Elements:**
1. **Project Menu Button** - Dropdown with New Project, Open Project, Save
2. **Actions Menu Button** - Dropdown with asset materialization and project operations
3. **New Project Dialog** - Modal for creating projects
4. **Open Projects Dialog** - Modal listing all projects with delete capability
5. **Code Preview Dialog** - Shows generated code files
6. **Validation Results Dialog** - Shows validation output or errors

### Frontend State Management

**Zustand Store (useProject.ts)**
```typescript
// File: /Users/ericthomas/dagster_designer/frontend/src/hooks/useProject.ts

interface ProjectStore {
  currentProject: Project | null;
  projects: Project[];
  isLoading: boolean;
  error: string | null;

  loadProject: (id: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  createProject: (name: string, description?: string, gitRepo?: string, gitBranch?: string) => Promise<Project>;
  updateGraph: (nodes: GraphNode[], edges: GraphEdge[]) => Promise<void>;
  updateComponents: (components: ComponentInstance[]) => Promise<void>;
  saveProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}
```

---

## 6. KEY FILES AND THEIR FUNCTIONS

### Backend Files

| File | Purpose |
|------|---------|
| `/backend/app/models/project.py` | Project data models (Pydantic) |
| `/backend/app/api/projects.py` | REST API endpoints for projects |
| `/backend/app/services/project_service.py` | Project CRUD and lifecycle logic |
| `/backend/app/services/asset_introspection_service.py` | Asset discovery via `dg list defs` |
| `/backend/app/core/config.py` | Configuration (projects directory path) |
| `/backend/app/main.py` | FastAPI app setup and routing |

### Frontend Files

| File | Purpose |
|------|---------|
| `/frontend/src/components/ProjectManager.tsx` | UI for project creation/management |
| `/frontend/src/components/ProjectComponentsList.tsx` | Component list display |
| `/frontend/src/hooks/useProject.ts` | Zustand project state management |
| `/frontend/src/services/api.ts` | API client (axios) |
| `/frontend/src/types/index.ts` | TypeScript types |

---

## 7. WHAT NEEDS TO BE MODIFIED FOR FULL IMPORT SUPPORT

### 7.1 Backend Changes Required

**1. Verify/Complete ProjectService.import_project() method**
- Need to verify it exists and is complete
- Should validate project structure (check for pyproject.toml, src/, etc.)
- Should handle copying project files to projects directory
- Should handle virtual environment detection/creation

**2. Add validation for imported projects**
- Verify pyproject.toml exists
- Verify project structure is valid Dagster project
- Run `dg list defs` to verify it's a valid Dagster project

**3. Handle dependency installation**
- Create/activate virtual environment for imported project
- Install dependencies from pyproject.toml
- Handle dbt adapter detection if dbt project

**4. Extract existing components**
- Parse existing component definitions
- Create ComponentInstance objects
- Build components list in Project model

### 7.2 Frontend Changes Required

**1. Add import UI to ProjectManager**
- Add "Import Project" button to Project menu
- Create "Import Project" dialog with:
  - File/directory picker OR path input field
  - Validation feedback
  - Import button
  - Progress/loading state

**2. Update API service**
- Add `import: async (path: string)` method to projectsApi
- Handle ProjectImportRequest serialization

**3. Update project store**
- Add `importProject` action to useProjectStore
- Handle import errors and loading states

**4. Update UI workflows**
- Load imported project after successful import
- Display project in Open Projects list
- Show validation status after import

### 7.3 Testing Requirements

**1. Backend tests**
- Test with various Dagster project structures
- Test with dbt projects
- Test with missing/invalid projects
- Test error handling

**2. Frontend tests**
- Test import dialog interaction
- Test loading states
- Test error display
- Test imported project display

**3. Integration tests**
- End-to-end import workflow
- Asset discovery after import
- Component detection after import
- Project materialization of imported projects

---

## 8. CURRENT PROJECT LOCATIONS

**Backend:**
- Main project creation: `/Users/ericthomas/dagster_designer/backend/app/services/project_service.py`
- Project API: `/Users/ericthomas/dagster_designer/backend/app/api/projects.py`
- Models: `/Users/ericthomas/dagster_designer/backend/app/models/project.py`
- Asset introspection: `/Users/ericthomas/dagster_designer/backend/app/services/asset_introspection_service.py`

**Frontend:**
- ProjectManager component: `/Users/ericthomas/dagster_designer/frontend/src/components/ProjectManager.tsx`
- Project store: `/Users/ericthomas/dagster_designer/frontend/src/hooks/useProject.ts`
- API service: `/Users/ericthomas/dagster_designer/frontend/src/services/api.ts`

**Configuration:**
- Projects directory: Configured in `/Users/ericthomas/dagster_designer/backend/app/core/config.py`
- Default: `./projects/`

---

## 9. IMPLEMENTATION ROADMAP FOR IMPORT SUPPORT

### Phase 1: Backend Import Implementation
1. Locate and review `ProjectService.import_project()` method
2. Implement project path validation
3. Implement project copying logic
4. Implement dependency installation for imported projects
5. Extract existing components from imported projects
6. Test with sample projects

### Phase 2: Frontend Import UI
1. Add import dialog component
2. Integrate with API service
3. Add import action to project store
4. Add error handling and validation feedback
5. Update project list to show imported projects

### Phase 3: Testing & Polish
1. Test with various project structures
2. Test error scenarios
3. Improve error messages
4. Performance testing
5. Documentation

---

## 10. RELATED FEATURES ALREADY IMPLEMENTED

- **Asset introspection**: Auto-discovers assets from components
- **Custom lineage**: Manual dependency injection
- **Project validation**: Runs `dg list defs` to check project validity
- **Asset materialization**: Executes `dg launch` for asset runs
- **Project export**: Generates zip files of projects
- **Code preview**: Shows generated Dagster code
- **Git integration**: Can clone repositories for dbt projects
- **Component scaffolding**: Automatically scaffolds Dagster components

---

## 11. ARCHITECTURE DECISIONS FOR IMPORT

### Design Considerations

1. **Preserve Original Project Structure** (Recommended)
   - Copy entire project to projects directory
   - Maintain original directory structure
   - Preserve original pyproject.toml
   - Benefits: Minimal changes, easy to manage, preserves original intent

2. **Directory Naming Consistency**
   - Use same naming scheme as created projects: `project_{id_prefix}_{name}`
   - Allows mixed created/imported projects
   - Makes cleanup easier (delete entire directory)

3. **Virtual Environment Strategy**
   - For imported projects: Reuse existing .venv if present and valid
   - Or create new .venv and reinstall dependencies
   - Ensures `dg` CLI is available for asset introspection

4. **Component Detection**
   - For dbt projects: Auto-detect and create DbtProjectComponent
   - For other projects: Parse definitions.py to extract components
   - For custom components: Display as-is without modification

5. **Asset Discovery**
   - Always run `dg list defs` after import
   - Builds graph from actual project definition
   - Ensures graph reflects project reality
   - User can manually modify lineage if needed

---

## Conclusion

The Dagster Designer already has a backend API endpoint for importing projects but lacks:
1. Frontend UI integration
2. Validation of the import_project() implementation
3. Comprehensive error handling
4. Component extraction from existing projects
5. Full end-to-end testing

To add full import support, focus on:
1. **Backend**: Verify/complete `ProjectService.import_project()` method
2. **Frontend**: Add import UI and workflow
3. **Testing**: Validate with real Dagster projects
