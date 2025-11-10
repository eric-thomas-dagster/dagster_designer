# Dagster CLI Integration - Architecture

## Overview

**Major Architectural Improvement:** Instead of building custom code generation, we now use **Dagster's official CLI tools** (`dg` commands). This provides:

✅ **Official Dagster tooling** - Uses the same commands as the documentation
✅ **Proper validation** - Dagster validates component configurations
✅ **Real asset preview** - Load actual definitions to see generated assets
✅ **Error messages** - Get Dagster's own error messages for debugging
✅ **Future-proof** - Automatically supports new Dagster features

---

## Architecture Changes

### Old Approach ❌

```
User configures component in UI
  ↓
Our custom code generates YAML
  ↓
Hope it matches Dagster's format
  ↓
User exports ZIP
  ↓
User runs Dagster (may fail with errors)
```

**Problems:**
- We had to reimplement Dagster's YAML generation
- No validation until user runs it
- Can't preview actual assets
- Errors only discovered at deployment time

### New Approach ✅

```
User creates project
  ↓
Backend runs: uvx create-dagster@latest project <name>
  ↓
User adds component via UI
  ↓
Backend runs: dg scaffold defs <component-type> <name> --options
  ↓
Backend runs: Load definitions and extract assets
  ↓
UI shows actual generated assets or errors
  ↓
User sees exactly what Dagster will execute
```

**Benefits:**
- Use official Dagster commands
- Immediate validation
- Real asset preview
- Errors shown in real-time
- Always correct format

---

## Dagster CLI Commands Used

### 1. Project Creation

**Command:**
```bash
uvx create-dagster@latest project <project-name>
```

**What it does:**
- Creates proper Dagster project structure
- Sets up `pyproject.toml` with correct config
- Creates `<project>_defs/` directory
- Generates `definitions.py` boilerplate

**Our Integration:**
```python
# Backend: dagster_cli_service.py
dagster_cli_service.create_dagster_project(project_name)
```

**API Endpoint:**
```
POST /api/v1/dagster/create-project
{
  "project_id": "abc-123",
  "project_name": "my_pipeline"
}
```

### 2. Component Scaffolding

**Command:**
```bash
dg scaffold defs dagster_fivetran.FivetranAccountComponent fivetran_ingest \
  --account-id test_account \
  --api-key "{{ env.FIVETRAN_API_KEY }}" \
  --api-secret "{{ env.FIVETRAN_API_SECRET }}"
```

**What it does:**
- Creates component YAML file
- Validates options against component schema
- Proper naming and structure
- Template variable support built-in

**Our Integration:**
```python
# Backend: dagster_cli_service.py
dagster_cli_service.scaffold_component(
    project_path=Path("/projects/my_pipeline"),
    component_type="dagster_fivetran.FivetranAccountComponent",
    component_name="fivetran_ingest",
    options={
        "account_id": "test_account",
        "api_key": "{{ env.FIVETRAN_API_KEY }}",
        "api_secret": "{{ env.FIVETRAN_API_SECRET }}",
    }
)
```

**API Endpoint:**
```
POST /api/v1/dagster/scaffold-component
{
  "project_id": "abc-123",
  "component_type": "dagster_fivetran.FivetranAccountComponent",
  "component_name": "fivetran_ingest",
  "options": {
    "account_id": "test_account",
    "api_key": "{{ env.FIVETRAN_API_KEY }}",
    "api_secret": "{{ env.FIVETRAN_API_SECRET }}"
  }
}
```

### 3. Asset Preview (Loading Definitions)

**Approach:**
- Dynamically import the project's `definitions.py`
- Extract assets from the `defs` object
- Return asset information as JSON

**Implementation:**
```python
# Backend creates a temporary inspection script:
from my_pipeline_defs.definitions import defs

assets = []
for asset in defs.assets:
    assets.append({
        "key": str(asset.key),
        "group_name": asset.group_name,
        "description": asset.description,
        "deps": [str(dep) for dep in asset.deps],
        "metadata": dict(asset.metadata),
    })

print(json.dumps({"success": True, "assets": assets}))
```

**API Endpoint:**
```
GET /api/v1/dagster/preview-assets/{project_id}

Response:
{
  "success": true,
  "assets": [
    {
      "key": "fivetran/salesforce/accounts",
      "group_name": "salesforce",
      "description": "Accounts table from Salesforce",
      "deps": [],
      "metadata": {"source": "fivetran"}
    },
    ...
  ],
  "asset_count": 127,
  "error": null
}
```

### 4. Component Discovery

**Command:**
```bash
dg list components
```

**What it does:**
- Lists all available component types
- Shows installed component libraries

**Output Example:**
```
dagster_dbt.DbtProjectComponent
dagster_fivetran.FivetranAccountComponent
dagster_sling.SlingReplicationCollectionComponent
dagster_dlt.DltLoadCollectionComponent
```

**Our Integration:**
```python
# Backend: dagster_cli_service.py
dagster_cli_service.list_components_from_dg()
```

---

## New Workflow

### User Experience

#### 1. Create Project

**User Action:** Click "New Project" → Enter "sales_analytics"

**Backend:**
```bash
uvx create-dagster@latest project sales_analytics
```

**Result:**
```
sales_analytics/
├── pyproject.toml
├── sales_analytics_defs/
│   ├── __init__.py
│   └── definitions.py
```

#### 2. Add Fivetran Component

**User Action:**
- Drag Fivetran component to canvas
- Click it to open property panel
- Configure:
  - account_id: "my_account"
  - api_key: "{{ env.FIVETRAN_API_KEY }}"
  - api_secret: "{{ env.FIVETRAN_API_SECRET }}"
- Click "Save"

**Backend:**
```bash
dg scaffold defs dagster_fivetran.FivetranAccountComponent fivetran_sync \
  --account-id my_account \
  --api-key "{{ env.FIVETRAN_API_KEY }}" \
  --api-secret "{{ env.FIVETRAN_API_SECRET }}"
```

**Result:**
```
sales_analytics/
├── sales_analytics_defs/
│   ├── fivetran_sync.yaml  ← Created by dg scaffold
│   └── definitions.py
```

**fivetran_sync.yaml:**
```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
    api_key: "{{ env.FIVETRAN_API_KEY }}"
    api_secret: "{{ env.FIVETRAN_API_SECRET }}"
```

#### 3. Preview Assets

**User Action:** Property panel automatically loads assets

**Backend:**
1. Creates inspection script
2. Runs: `python _inspect_defs.py`
3. Returns asset information

**UI Shows:**
```
Generated Assets (127 assets)

┌──────────────────────────────────────────┐
│ fivetran/salesforce/accounts             │
│ Group: salesforce                        │
│ Accounts table from Salesforce           │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ fivetran/salesforce/contacts             │
│ Group: salesforce                        │
│ Contacts table from Salesforce           │
└──────────────────────────────────────────┘

... 125 more assets
```

#### 4. Handle Errors

**If configuration is invalid:**

**Backend Error:**
```python
{
  "success": false,
  "assets": [],
  "error": "FivetranAccountComponent validation error: account_id is required"
}
```

**UI Shows:**
```
┌────────────────────────────────────────────┐
│ ❌ Error Loading Assets                    │
│                                            │
│ FivetranAccountComponent validation       │
│ error: account_id is required              │
│                                            │
│ Possible causes:                           │
│ • Component configuration is invalid       │
│ • Required dependencies are missing        │
│ • Project hasn't been initialized          │
└────────────────────────────────────────────┘
```

---

## Backend Service: DagsterCLIService

### Key Methods

```python
class DagsterCLIService:
    def create_dagster_project(self, project_name: str) -> tuple[Path, str]:
        """Create project using uvx create-dagster@latest."""

    def scaffold_component(
        self,
        project_path: Path,
        component_type: str,
        component_name: str,
        options: dict[str, Any]
    ) -> tuple[Path, str]:
        """Scaffold component using dg scaffold defs."""

    def load_definitions(self, project_path: Path) -> dict[str, Any]:
        """Load Dagster definitions and extract assets."""

    def list_components_from_dg(self) -> list[dict[str, Any]]:
        """List available components using dg list."""

    def validate_project(self, project_path: Path) -> tuple[bool, str]:
        """Validate project can be loaded."""
```

### Error Handling

All methods return structured errors:

```python
{
    "success": False,
    "error": "Descriptive error message from Dagster",
    "assets": []
}
```

---

## Frontend Integration

### New API Calls

```typescript
// services/api.ts

export const dagsterApi = {
  // Create Dagster project
  createProject: async (projectId: string, projectName: string),

  // Scaffold component
  scaffoldComponent: async (
    projectId: string,
    componentType: string,
    componentName: string,
    options: Record<string, any>
  ),

  // Preview assets
  previewAssets: async (projectId: string): Promise<AssetPreviewResponse>,

  // Validate project
  validateProject: async (projectId: string),

  // List components
  listComponents: async (),

  // Get component options
  getComponentOptions: async (componentType: string),
};
```

### New UI Component: AssetPreview

Shows in property panel for asset factory components:

```tsx
<AssetPreview projectId={currentProject.id} />
```

**Features:**
- Loads assets automatically
- Refresh button to reload
- Shows asset count
- Displays asset details (key, group, deps, metadata)
- Error handling with helpful messages
- Loading state with spinner

---

## Benefits of This Approach

### 1. Official Tooling ✅
- Uses `uvx` and `dg` commands
- Same commands as Dagster documentation
- No custom code generation

### 2. Real-Time Validation ✅
- Errors shown immediately in UI
- Configuration validated by Dagster
- No surprises at deployment time

### 3. Actual Asset Preview ✅
- See exact assets Dagster will create
- Shows asset dependencies
- Displays metadata and groups

### 4. Better UX ✅
- Immediate feedback
- Clear error messages
- Visual asset count
- Dependency visualization

### 5. Maintainability ✅
- Less custom code to maintain
- Automatically supports new Dagster features
- Follows Dagster best practices

---

## Requirements

### Python Environment

```bash
# Install uv (for uvx command)
pip install uv

# Install Dagster CLI
pip install dagster

# Component libraries (as needed)
pip install dagster-dbt dagster-fivetran dagster-sling dagster-dlt
```

### Updated Dependencies

```
# requirements.txt
uv==0.5.0              # For uvx commands
dagster==1.9.0         # For dg commands and definitions loading
```

---

## Example: Complete Workflow

### 1. User Creates Project "analytics"

**API Call:**
```
POST /api/v1/projects
{ "name": "analytics" }
```

**Response:**
```json
{ "id": "proj-123", "name": "analytics" }
```

**Then Immediately:**
```
POST /api/v1/dagster/create-project
{ "project_id": "proj-123", "project_name": "analytics" }
```

**Backend Runs:**
```bash
uvx create-dagster@latest project analytics
```

### 2. User Adds dbt Component

**User configures:**
- Component type: `dagster_dbt.DbtProjectComponent`
- Name: `transform`
- Options: `{ "project": "/path/to/dbt" }`

**API Call:**
```
POST /api/v1/dagster/scaffold-component
{
  "project_id": "proj-123",
  "component_type": "dagster_dbt.DbtProjectComponent",
  "component_name": "transform",
  "options": { "project": "/path/to/dbt" }
}
```

**Backend Runs:**
```bash
cd analytics
dg scaffold defs dagster_dbt.DbtProjectComponent transform \
  --project /path/to/dbt
```

**Creates:**
```yaml
# analytics/analytics_defs/transform.yaml
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt
```

### 3. UI Automatically Previews Assets

**API Call:**
```
GET /api/v1/dagster/preview-assets/proj-123
```

**Backend:**
1. Creates `_inspect_defs.py`
2. Runs: `python _inspect_defs.py`
3. Parses JSON output

**Response:**
```json
{
  "success": true,
  "assets": [
    {
      "key": "dbt_staging_customers",
      "group_name": "staging",
      "description": "Staging model for customers",
      "deps": ["raw_customers"],
      "metadata": {}
    },
    {
      "key": "dbt_customers",
      "group_name": "marts",
      "description": "Final customers model",
      "deps": ["dbt_staging_customers"],
      "metadata": {"owner": "analytics_team"}
    }
  ],
  "asset_count": 2
}
```

**UI Displays:**
```
Generated Assets (2 assets)

[dbt_staging_customers]
Group: staging
Depends on: raw_customers

[dbt_customers]
Group: marts
Depends on: dbt_staging_customers
```

---

## Error Scenarios

### Scenario 1: Invalid Configuration

**User Input:** Forgets required field

**Dagster Error:**
```
ValidationError: field required (type=value_error.missing)
```

**UI Shows:**
```
❌ Error Loading Assets

ValidationError: field required

Possible causes:
• Component configuration is invalid
• Required dependencies are missing
```

### Scenario 2: Missing dbt Project

**User Input:** Points to non-existent dbt project

**Dagster Error:**
```
FileNotFoundError: dbt project not found at /path/to/dbt
```

**UI Shows:**
```
❌ Error Loading Assets

FileNotFoundError: dbt project not found at /path/to/dbt

Fix: Ensure the dbt project path is correct
```

### Scenario 3: Import Error

**User Input:** Component library not installed

**Dagster Error:**
```
ImportError: No module named 'dagster_fivetran'
```

**UI Shows:**
```
❌ Error Loading Assets

ImportError: No module named 'dagster_fivetran'

Fix: Install the component library:
pip install dagster-fivetran
```

---

## Comparison: Old vs New

| Feature | Old Approach | New Approach |
|---------|--------------|--------------|
| Project creation | Custom YAML generation | `uvx create-dagster@latest` |
| Component scaffolding | Manual YAML writing | `dg scaffold defs` |
| Validation | None (until deployment) | Immediate via Dagster |
| Asset preview | Not possible | Real assets from definitions |
| Error messages | Generic | Dagster's own errors |
| Maintenance | High (custom codegen) | Low (use official tools) |
| Future compatibility | Manual updates needed | Automatic |

---

## Summary

**Before:** We tried to replicate Dagster's behavior
**After:** We use Dagster's actual tools

**Result:**
- ✅ Official Dagster workflow
- ✅ Real-time validation
- ✅ Actual asset preview
- ✅ Better error messages
- ✅ Less code to maintain
- ✅ Future-proof architecture

**This is the correct way to build a Dagster visual designer!** 🎉
