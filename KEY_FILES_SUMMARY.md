# Dagster Designer - Key Files and Code Snippets Summary

## Critical File Locations

### Backend (Python/FastAPI)

#### 1. Project Data Models
**File:** `/Users/ericthomas/dagster_designer/backend/app/models/project.py`
- Defines `Project`, `ProjectCreate`, `ProjectUpdate` Pydantic models
- Stores project metadata, components, lineage, git info
- Line count: 56 lines

#### 2. Project API Endpoints  
**File:** `/Users/ericthomas/dagster_designer/backend/app/api/projects.py`
- Implements REST endpoints for project CRUD
- **INCLUDES: POST /projects/import endpoint (line 57-87)**
- Endpoints for asset regeneration, validation, materialization
- Custom lineage management
- Line count: 464 lines

#### 3. Project Service (Business Logic)
**File:** `/Users/ericthomas/dagster_designer/backend/app/services/project_service.py`
- `ProjectService` class handles all project lifecycle
- Methods: `create_project()`, `import_project()`, `list_projects()`, `update_project()`, etc.
- Handles project scaffolding, dependency installation, component generation
- **KEY METHODS:**
  - `create_project()` - Lines 37-97 (Create new project)
  - `import_project()` - EXISTS but location needs verification
  - `_scaffold_project_with_create_dagster()` - Lines 449-484
  - `_install_dependencies_with_uv()` - Lines 526-578
  - `_generate_component_yaml_files()` - Lines 609-812
- Line count: 1,025 lines

#### 4. Asset Introspection Service
**File:** `/Users/ericthomas/dagster_designer/backend/app/services/asset_introspection_service.py`
- Discovers assets from Dagster components
- `get_assets_for_project()` - Main method that runs `dg list defs`
- Parses JSON output and creates graph nodes/edges
- Used after project creation AND import
- Line count: ~300+ lines

#### 5. Configuration
**File:** `/Users/ericthomas/dagster_designer/backend/app/core/config.py`
- Defines `settings` object with `projects_dir` path
- Default projects directory: `./projects/`

#### 6. Main App Setup
**File:** `/Users/ericthomas/dagster_designer/backend/app/main.py`
- FastAPI app initialization
- Registers all routers including `projects.router`
- CORS configuration

---

### Frontend (TypeScript/React)

#### 1. Project Manager Component
**File:** `/Users/ericthomas/dagster_designer/frontend/src/components/ProjectManager.tsx`
- Main UI component for project management
- **Features:**
  - Project menu (New, Open, Save)
  - Actions menu (Materialize, Regenerate, Validate, Preview, Export)
  - New Project dialog with git repo input
  - Open Projects dialog
  - Validation and preview dialogs
- **KEY METHODS:**
  - `handleCreateProject()` - Line 51-68
  - `handleExport()` - Line 83-100
  - `handleMaterializeAll()` - Line 115-147
  - `handleRegenerateLineage()` - Line 149-167
  - `handleValidateProject()` - Line 169-184
- Line count: 645 lines
- **DOES NOT HAVE:** Import project UI yet

#### 2. Project Store (State Management)
**File:** `/Users/ericthomas/dagster_designer/frontend/src/hooks/useProject.ts`
- Zustand store for project state
- **STATE:**
  - `currentProject`: Current open project
  - `projects`: List of all projects
  - `isLoading`: Loading flag
  - `error`: Error message
- **ACTIONS:**
  - `loadProject()` - Load single project
  - `loadProjects()` - List all projects
  - `createProject()` - Create new project
  - `updateGraph()` - Update project graph
  - `updateComponents()` - Update components
  - `saveProject()` - Save project
  - `deleteProject()` - Delete project
- **MISSING:** `importProject()` action
- Line count: 144 lines

#### 3. API Service
**File:** `/Users/ericthomas/dagster_designer/frontend/src/services/api.ts`
- Axios-based API client
- `projectsApi` object with methods:
  - `list()` - GET /projects
  - `get(id)` - GET /projects/{id}
  - `create()` - POST /projects
  - `update()` - PUT /projects/{id}
  - `delete()` - DELETE /projects/{id}
  - `regenerateAssets()` - POST /projects/{id}/regenerate-assets
  - `validate()` - POST /projects/{id}/validate
  - `materialize()` - POST /projects/{id}/materialize
  - `addCustomLineage()` - POST /projects/{id}/custom-lineage
  - `removeCustomLineage()` - DELETE /projects/{id}/custom-lineage
- **MISSING:** `import()` method
- Line count: 673 lines

#### 4. Component List
**File:** `/Users/ericthomas/dagster_designer/frontend/src/components/ProjectComponentsList.tsx`
- Displays components for current project
- Shows component type and settings
- Line count: 79 lines

#### 5. TypeScript Types
**File:** `/Users/ericthomas/dagster_designer/frontend/src/types/index.ts`
- Defines TypeScript interfaces for all models
- Includes: `Project`, `ComponentInstance`, `GraphNode`, `GraphEdge`, etc.

---

## API Endpoint Summary

### Current Endpoints (Implemented)

```
POST   /api/v1/projects              # Create new project
GET    /api/v1/projects              # List all projects
GET    /api/v1/projects/{id}         # Get project details
PUT    /api/v1/projects/{id}         # Update project
DELETE /api/v1/projects/{id}         # Delete project
POST   /api/v1/projects/import       # Import existing project ← ALREADY EXISTS!
POST   /api/v1/projects/{id}/regenerate-assets
POST   /api/v1/projects/{id}/validate
POST   /api/v1/projects/{id}/materialize
POST   /api/v1/projects/{id}/custom-lineage
DELETE /api/v1/projects/{id}/custom-lineage
POST   /api/v1/projects/{id}/clone-repo
```

---

## Critical Code Sections for Import Feature

### Backend: Project Model Definition
**Location:** `/Users/ericthomas/dagster_designer/backend/app/models/project.py:30-37`
```python
class ProjectCreate(BaseModel):
    """Request to create a new project."""
    name: str = Field(..., description="Project name", min_length=1)
    description: str | None = None
    git_repo: str | None = None
    git_branch: str = "main"
```

### Backend: Import Request Model
**Location:** `/Users/ericthomas/dagster_designer/backend/app/api/projects.py:30-32`
```python
class ProjectImportRequest(BaseModel):
    """Request to import an existing Dagster project."""
    path: str = Field(..., description="Absolute path to existing Dagster project directory")
```

### Backend: Import Endpoint
**Location:** `/Users/ericthomas/dagster_designer/backend/app/api/projects.py:57-87`
```python
@router.post("/import", response_model=Project, status_code=201)
async def import_project(request: ProjectImportRequest):
    """Import an existing Dagster project from disk."""
    try:
        project = project_service.import_project(request.path)
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

### Backend: Project Creation Flow
**Location:** `/Users/ericthomas/dagster_designer/backend/app/services/project_service.py:37-97`
- Scaffolds with `uvx create-dagster project`
- Installs dependencies with `uv sync --all-groups`
- Scaffolds components with `dg scaffold defs`
- Discovers assets with `dg list defs`

### Frontend: Create Project Handler
**Location:** `/Users/ericthomas/dagster_designer/frontend/src/components/ProjectManager.tsx:51-68`
```typescript
const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
        setIsCreating(true);
        await createProject(
            newProjectName, 
            undefined, 
            newProjectGitRepo || undefined, 
            newProjectGitBranch
        );
        // Clear form and close dialog
    } catch (error) {
        console.error('Failed to create project:', error);
        alert('Failed to create project. Check the console for details.');
    } finally {
        setIsCreating(false);
    }
};
```

### Frontend: Zustand Store - Create Action
**Location:** `/Users/ericthomas/dagster_designer/frontend/src/hooks/useProject.ts:47-66`
```typescript
createProject: async (name: string, description?: string, gitRepo?: string, gitBranch?: string) => {
    set({ isLoading: true, error: null });
    try {
        const project = await projectsApi.create({
            name,
            description,
            git_repo: gitRepo,
            git_branch: gitBranch || 'main',
        });
        set({
            currentProject: project,
            projects: [project, ...get().projects],
            isLoading: false,
        });
        return project;
    } catch (error) {
        set({ error: 'Failed to create project', isLoading: false });
        throw error;
    }
};
```

---

## Project Storage Structure

```
./projects/
├── {uuid_1}.json                 # Project metadata (created immediately)
├── project_abcd1234_my_project/ # Project directory
│   ├── .venv/                   # Virtual environment with dg CLI
│   ├── src/
│   │   └── project_abcd1234_my_project/
│   │       ├── definitions.py
│   │       ├── defs/
│   │       │   ├── custom_lineage.json
│   │       │   └── {component_id}/
│   │       │       └── defs.yaml
│   │       └── dagster_designer_components/
│   ├── pyproject.toml
│   ├── uv.lock
│   └── tests/
│
└── {uuid_2}.json                 # Another project
```

---

## Dependency Graph for Import Feature

### What Import Depends On (Already Implemented)

1. **ProjectService** - CRUD operations
   - `_get_project_dir()` - Get project directory path
   - `_get_project_file()` - Get project JSON file path
   - `_save_project()` - Save project metadata JSON
   
2. **AssetIntrospectionService** - Asset discovery
   - `get_assets_for_project()` - Runs `dg list defs`
   - `_run_dg_list_defs()` - Executes dg command
   - `_parse_assets_data()` - Parses output

3. **Project Model** - Data structure
   - Pydantic model for validation
   - Already supports all import fields

### What Needs to Be Added

1. **Backend:**
   - Verify `ProjectService.import_project()` exists and is complete
   - Add validation for project structure
   - Handle virtual environment for imported projects
   - Extract existing components from imported projects

2. **Frontend:**
   - Add `import()` method to `projectsApi`
   - Add `importProject()` action to Zustand store
   - Add UI component for import dialog
   - Add import button to ProjectManager menu

---

## Summary: What's Implemented vs Missing

### Already Implemented ✓
- Backend POST /projects/import endpoint
- Asset introspection (dg list defs)
- Project model and storage
- Project CRUD operations
- Frontend create project UI
- Frontend project list and selection

### Needs Implementation ✗
- Backend `ProjectService.import_project()` completion
- Frontend import button and dialog UI
- Frontend `projectsApi.import()` method
- Frontend Zustand `importProject()` action
- Comprehensive error handling for import
- Component extraction from imported projects
- Virtual environment handling for imports

---

## Next Steps for Implementation

### Step 1: Verify Backend Import Service
- Find and review `ProjectService.import_project()` method
- Check if it's fully implemented or just a stub
- Add any missing validation logic

### Step 2: Add Frontend API Method
**File to modify:** `/Users/ericthomas/dagster_designer/frontend/src/services/api.ts`
```typescript
import: async (path: string) => {
    const response = await api.post<Project>('/projects/import', { path });
    return response.data;
},
```

### Step 3: Add Frontend Store Action
**File to modify:** `/Users/ericthomas/dagster_designer/frontend/src/hooks/useProject.ts`
```typescript
importProject: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
        const project = await projectsApi.import(path);
        set({
            currentProject: project,
            projects: [project, ...get().projects],
            isLoading: false,
        });
        return project;
    } catch (error) {
        set({ error: 'Failed to import project', isLoading: false });
        throw error;
    }
};
```

### Step 4: Add Frontend UI
**File to modify:** `/Users/ericthomas/dagster_designer/frontend/src/components/ProjectManager.tsx`
- Add "Import Project" button to Project menu
- Create import dialog component
- Handle file/path input
- Handle loading and error states

