# Template System for Dagster Primitives

## Overview

We've implemented a **visual template builder** that allows users to create Dagster primitives (Python assets, SQL assets, schedules, jobs, sensors, and asset checks) through an intuitive form-based interface instead of writing code manually.

---

## 🎯 Features

### 1. Six Primitive Types ✅

**Python Assets** - @asset decorator
- Custom Python code
- Dependencies on other assets
- Group names, descriptions, owners
- Compute kind badges
- Tags and metadata

**SQL Assets** - SQL-based assets
- SQL query editor
- IO manager configuration
- Database-backed assets
- Dependencies on upstream assets

**Schedules** - Time-based triggers
- Cron expression builder
- Timezone support
- Job association
- Human-readable descriptions

**Jobs** - Asset collections
- Asset selection
- Tags and metadata
- Batch materializations

**Sensors** - Event-based triggers
- File sensors (watch for files)
- Run status sensors (monitor runs)
- Custom sensors (any logic)
- Configurable intervals

**Asset Checks** - Data quality validation
- Row count checks
- Freshness checks (data age)
- Schema validation
- Custom checks

### 2. Visual Form Builder ✅

**Tab-based interface** with:
- One tab per primitive type
- Clear field labels
- Inline help text
- Required field indicators (`*`)
- Type-specific options (conditional fields)

### 3. Live Code Preview ✅

**Monaco editor** showing:
- Generated Python code
- Real-time syntax highlighting
- Editable before saving
- Copy-paste ready

### 4. Save to Project ✅

**Automatic file organization**:
- Python/SQL assets → `{project}_defs/assets/`
- Schedules → `{project}_defs/schedules/`
- Jobs → `{project}_defs/jobs/`
- Sensors → `{project}_defs/sensors/`
- Asset checks → `{project}_defs/checks/`

---

## 🏗️ Architecture

### Backend Services

#### **TemplateService** (`backend/app/services/template_service.py`)

Core service for generating Python code templates.

**Key Methods:**

```python
class TemplateService:
    def generate_python_asset(
        asset_name: str,
        group_name: str = "",
        description: str = "",
        compute_kind: str = "python",
        code: str = "",
        deps: list[str] | None = None,
        owners: list[str] | None = None,
        tags: dict[str, str] | None = None,
    ) -> str

    def generate_sql_asset(
        asset_name: str,
        query: str,
        group_name: str = "",
        description: str = "",
        io_manager_key: str = "db_io_manager",
        deps: list[str] | None = None,
    ) -> str

    def generate_schedule(
        schedule_name: str,
        cron_expression: str,
        job_name: str,
        description: str = "",
        timezone: str = "UTC",
    ) -> str

    def generate_job(
        job_name: str,
        asset_selection: list[str],
        description: str = "",
        tags: dict[str, str] | None = None,
    ) -> str

    def generate_sensor(
        sensor_name: str,
        sensor_type: Literal["file", "run_status", "custom"],
        job_name: str,
        description: str = "",
        file_path: str = "",
        minimum_interval_seconds: int = 30,
    ) -> str

    def generate_asset_check(
        check_name: str,
        asset_name: str,
        check_type: Literal["row_count", "freshness", "schema", "custom"],
        description: str = "",
        threshold: int | None = None,
        max_age_hours: int | None = None,
    ) -> str

    def save_template_to_project(
        project_id: str,
        primitive_type: PrimitiveType,
        name: str,
        code: str,
    ) -> Path

    def get_template_preview(
        primitive_type: PrimitiveType,
        params: dict[str, Any],
    ) -> str
```

**Template Examples:**

**Python Asset:**
```python
"""Generated Python asset."""

from dagster import asset, AssetExecutionContext
from typing import Any


@asset(group_name="analytics", description="Customer data", compute_kind="python")
def customers():
    """Compute the customers asset."""
    # TODO: Add your asset computation logic here
    return {}
```

**SQL Asset:**
```python
"""Generated SQL asset."""

from dagster import asset, AssetExecutionContext
from typing import Any


@asset(io_manager_key="db_io_manager", group_name="analytics", compute_kind="sql")
def customers_summary(context: AssetExecutionContext):
    """Execute SQL query for customers_summary."""
    query = """
SELECT customer_id, COUNT(*) as order_count
FROM orders
GROUP BY customer_id
    """

    return query
```

**Schedule:**
```python
"""Generated schedule."""

from dagster import schedule, ScheduleEvaluationContext


@schedule(
    cron_schedule="0 0 * * *",
    job_name="daily_refresh",
    timezone="UTC",
)
def daily_schedule(context: ScheduleEvaluationContext):
    """Run daily at midnight"""
    return {}
```

**Job:**
```python
"""Generated job."""

from dagster import define_asset_job


analytics_job = define_asset_job(
    name="analytics_job",
    selection=["raw_data", "transformed_data", "final_report"],
    description="Complete analytics pipeline"
)
```

**Sensor:**
```python
"""Generated sensor."""

from dagster import sensor, SensorEvaluationContext, RunRequest, SkipReason
from datetime import datetime


@sensor(
    job_name="process_file",
    minimum_interval_seconds=30,
)
def file_sensor(context: SensorEvaluationContext):
    """Watch for file: /data/new_data.csv"""
    from pathlib import Path

    if Path("/data/new_data.csv").exists():
        context.log.info(f"File found: /data/new_data.csv")
        return RunRequest(run_key=f"file_{datetime.now().isoformat()}")

    return SkipReason("File not found")
```

**Asset Check:**
```python
"""Generated asset check."""

from dagster import asset_check, AssetCheckResult, AssetCheckExecutionContext


@asset_check(asset="customers")
def check_row_count(context: AssetCheckExecutionContext, asset_value):
    """Check that customers has at least 100 rows."""
    # TODO: Replace with actual row count logic
    row_count = len(asset_value) if isinstance(asset_value, (list, tuple)) else 0

    passed = row_count >= 100

    return AssetCheckResult(
        passed=passed,
        metadata={
            "row_count": row_count,
            "threshold": 100,
        },
        description=f"Found {row_count} rows (threshold: 100)"
    )
```

#### **Templates API** (`backend/app/api/templates.py`)

REST endpoints for template operations.

**Endpoints:**

```
POST /api/v1/templates/preview
POST /api/v1/templates/python-asset
POST /api/v1/templates/sql-asset
POST /api/v1/templates/schedule
POST /api/v1/templates/job
POST /api/v1/templates/sensor
POST /api/v1/templates/asset-check
POST /api/v1/templates/save
GET  /api/v1/templates/examples/{primitive_type}
```

**Request/Response Examples:**

```typescript
// Generate Python Asset
POST /api/v1/templates/python-asset
{
  "asset_name": "customers",
  "group_name": "analytics",
  "description": "Customer data",
  "compute_kind": "python",
  "deps": ["raw_customers"],
  "owners": ["data-team@company.com"]
}
→ Response: { "code": "...", "asset_name": "customers" }

// Save Template
POST /api/v1/templates/save
{
  "project_id": "proj-123",
  "primitive_type": "python_asset",
  "name": "customers",
  "code": "..."
}
→ Response: {
  "message": "Template saved successfully",
  "file_path": "proj-123/proj-123_defs/assets/customers.py"
}
```

### Frontend Components

#### **TemplateBuilder** (`frontend/src/components/TemplateBuilder.tsx`)

Main template builder component with split-panel layout.

**Layout:**
- **Left Panel** (50%) - Form builder with tabs
- **Right Panel** (50%) - Code preview with Monaco editor

**Features:**
- Tab-based navigation (6 tabs)
- Form validation (required fields)
- Conditional fields (based on type)
- Generate button (per tab)
- Save to project button
- Live code editing
- Syntax highlighting

**State Management:**

```typescript
// Separate state for each primitive type
const [pythonAsset, setPythonAsset] = useState<PythonAssetParams>({...});
const [sqlAsset, setSqlAsset] = useState<SQLAssetParams>({...});
const [schedule, setSchedule] = useState<ScheduleParams>({...});
const [job, setJob] = useState<JobParams>({...});
const [sensor, setSensor] = useState<SensorParams>({...});
const [assetCheck, setAssetCheck] = useState<AssetCheckParams>({...});

// Generated code
const [generatedCode, setGeneratedCode] = useState('');
```

**Mutations:**

```typescript
const generatePythonAssetMutation = useMutation({
  mutationFn: () => templatesApi.generatePythonAsset(pythonAsset),
  onSuccess: (data) => setGeneratedCode(data.code),
});

const saveMutation = useMutation({
  mutationFn: () => templatesApi.save({
    project_id: currentProject.id,
    primitive_type: activeTab,
    name: pythonAsset.asset_name,
    code: generatedCode,
  }),
  onSuccess: (data) => alert(`Saved to ${data.file_path}`),
});
```

#### **API Client** (`frontend/src/services/api.ts`)

TypeScript interfaces and API client for templates.

```typescript
export type PrimitiveType = 'python_asset' | 'sql_asset' | 'schedule' | 'job' | 'sensor' | 'asset_check';

export const templatesApi = {
  preview: async (primitiveType: PrimitiveType, params: any) => TemplateResponse
  generatePythonAsset: async (params: PythonAssetParams) => TemplateResponse
  generateSQLAsset: async (params: SQLAssetParams) => TemplateResponse
  generateSchedule: async (params: ScheduleParams) => TemplateResponse
  generateJob: async (params: JobParams) => TemplateResponse
  generateSensor: async (params: SensorParams) => TemplateResponse
  generateAssetCheck: async (params: AssetCheckParams) => TemplateResponse
  save: async (request: SaveTemplateRequest) => { message: string; file_path: string }
  getExamples: async (primitiveType: PrimitiveType) => { examples: any[] }
}
```

#### **App Integration** (`frontend/src/App.tsx`)

Added "Templates" tab to main navigation:

```tsx
<Tabs.Root defaultValue="assets">
  <Tabs.List>
    <Tabs.Trigger value="assets">Assets</Tabs.Trigger>
    <Tabs.Trigger value="code">Code</Tabs.Trigger>
    <Tabs.Trigger value="templates">Templates</Tabs.Trigger> {/* NEW */}
  </Tabs.List>

  <Tabs.Content value="assets">{/* Graph editor */}</Tabs.Content>
  <Tabs.Content value="code">{/* Code editor */}</Tabs.Content>
  <Tabs.Content value="templates">
    <TemplateBuilder />
  </Tabs.Content>
</Tabs.Root>
```

---

## 🚀 Usage

### Creating a Python Asset

1. Click the **"Templates"** tab
2. Select **"Python Asset"** tab (default)
3. Fill in the form:
   - Asset Name: `customers`
   - Group Name: `analytics`
   - Description: `Customer data from database`
   - Dependencies: `raw_customers`
   - Owners: `data-team@company.com`
   - Code: `return pd.read_sql("SELECT * FROM customers", conn)`
4. Click **"Generate Code"**
5. Review the generated Python code in the right panel
6. Click **"Save to Project"**
7. File saved to: `my_project/my_project_defs/assets/customers.py`

### Creating a SQL Asset

1. Click **"SQL Asset"** tab
2. Fill in the form:
   - Asset Name: `customer_summary`
   - SQL Query:
     ```sql
     SELECT
       customer_id,
       COUNT(*) as order_count,
       SUM(total) as total_revenue
     FROM orders
     GROUP BY customer_id
     ```
   - Group Name: `analytics`
   - IO Manager Key: `snowflake_io_manager`
3. Click **"Generate Code"**
4. Click **"Save to Project"**

### Creating a Schedule

1. Click **"Schedule"** tab
2. Fill in the form:
   - Schedule Name: `daily_refresh`
   - Cron Expression: `0 0 * * *` (daily at midnight)
   - Job Name: `analytics_job`
   - Description: `Refresh analytics tables daily`
   - Timezone: `America/New_York`
3. Click **"Generate Code"**
4. Click **"Save to Project"**

### Creating a Job

1. Click **"Job"** tab
2. Fill in the form:
   - Job Name: `analytics_pipeline`
   - Asset Selection: `raw_data, clean_data, analytics_table`
   - Description: `Complete analytics pipeline`
3. Click **"Generate Code"**
4. Click **"Save to Project"**

### Creating a Sensor

1. Click **"Sensor"** tab
2. Fill in the form:
   - Sensor Name: `file_watcher`
   - Sensor Type: `File Sensor`
   - Job Name: `process_file_job`
   - File Path: `/data/incoming/new_data.csv`
   - Description: `Watch for new data files`
   - Minimum Interval: `30` seconds
3. Click **"Generate Code"**
4. Click **"Save to Project"**

### Creating an Asset Check

1. Click **"Asset Check"** tab
2. Fill in the form:
   - Check Name: `check_customers_count`
   - Asset Name: `customers`
   - Check Type: `Row Count`
   - Minimum Row Count: `1000`
   - Description: `Ensure customers table has data`
3. Click **"Generate Code"**
4. Click **"Save to Project"**

---

## 📊 File Organization

Generated files are automatically organized:

```
my_project/
├── my_project_defs/
│   ├── assets/
│   │   ├── __init__.py
│   │   ├── customers.py           # Python assets
│   │   └── customer_summary.py    # SQL assets
│   ├── schedules/
│   │   ├── __init__.py
│   │   └── daily_refresh.py       # Schedules
│   ├── jobs/
│   │   ├── __init__.py
│   │   └── analytics_pipeline.py  # Jobs
│   ├── sensors/
│   │   ├── __init__.py
│   │   └── file_watcher.py        # Sensors
│   └── checks/
│       ├── __init__.py
│       └── check_customers_count.py # Asset checks
└── definitions.py
```

---

## 🎨 UI/UX Details

### Form Features

**Required Fields:**
- Marked with red asterisk (`*`)
- Validated before generation
- Clear error messages

**Optional Fields:**
- Provide sensible defaults
- Help text explaining purpose
- Examples in placeholders

**Conditional Fields:**
- Show/hide based on selections
- Example: File path only for file sensors
- Example: Threshold only for row count checks

**Array Inputs:**
- Comma-separated values
- Automatically split and trimmed
- Empty values filtered out

### Code Preview

**Features:**
- Full Monaco editor
- Python syntax highlighting
- Editable before saving
- Line numbers
- Scroll for long code

**Buttons:**
- **Generate Code** - Primary action per tab
- **Save to Project** - Only enabled when code exists
- Loading states during API calls
- Success/error feedback

---

## 🔧 Customization

### Adding Custom Fields

To add a new field to the Python Asset form:

1. **Update State:**
```typescript
const [pythonAsset, setPythonAsset] = useState<PythonAssetParams>({
  // ... existing fields
  my_new_field: '',
});
```

2. **Update Backend:**
```python
def generate_python_asset(
    # ... existing params
    my_new_field: str = "",
):
    # Use my_new_field in template generation
```

3. **Add Form Input:**
```tsx
<div>
  <label>My New Field</label>
  <input
    value={pythonAsset.my_new_field}
    onChange={(e) => setPythonAsset({ ...pythonAsset, my_new_field: e.target.value })}
  />
</div>
```

### Adding a New Primitive Type

To add a new primitive type (e.g., "Resource"):

1. **Backend Template:**
```python
def generate_resource(
    resource_name: str,
    resource_type: str,
    config: dict,
) -> str:
    template = f'''"""Generated resource."""
from dagster import ConfigurableResource

class {resource_name}(ConfigurableResource):
    # ...
'''
    return template
```

2. **Backend API:**
```python
@router.post("/resource")
async def generate_resource(request: ResourceRequest):
    code = template_service.generate_resource(...)
    return {"code": code}
```

3. **Frontend Tab:**
```tsx
<Tabs.Trigger value="resource">Resource</Tabs.Trigger>
<Tabs.Content value="resource">
  {/* Resource form */}
</Tabs.Content>
```

---

## 🧪 Testing

### Manual Testing

**Python Asset:**
```bash
curl -X POST http://localhost:8000/api/v1/templates/python-asset \
  -H "Content-Type: application/json" \
  -d '{
    "asset_name": "test_asset",
    "group_name": "test",
    "description": "Test asset"
  }'
```

**SQL Asset:**
```bash
curl -X POST http://localhost:8000/api/v1/templates/sql-asset \
  -H "Content-Type: application/json" \
  -d '{
    "asset_name": "test_sql",
    "query": "SELECT 1"
  }'
```

**Save Template:**
```bash
curl -X POST http://localhost:8000/api/v1/templates/save \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "my_project",
    "primitive_type": "python_asset",
    "name": "test_asset",
    "code": "..."
  }'
```

### Python Testing

```python
from app.services.template_service import TemplateService

# Test Python asset generation
ts = TemplateService()
code = ts.generate_python_asset(
    asset_name="customers",
    group_name="analytics",
    description="Customer data",
)
print(code)

# Test SQL asset generation
code = ts.generate_sql_asset(
    asset_name="summary",
    query="SELECT * FROM table",
)
print(code)

# Test schedule generation
code = ts.generate_schedule(
    schedule_name="daily",
    cron_expression="0 0 * * *",
    job_name="my_job",
)
print(code)
```

---

## 🎓 Best Practices

### Naming Conventions

**Assets:**
- Use lowercase with underscores: `customer_orders`
- Avoid special characters
- Be descriptive: `daily_sales_summary` not `summary`

**Jobs:**
- Use verbs: `refresh_analytics`, `sync_data`
- Indicate scope: `full_pipeline`, `incremental_update`

**Schedules:**
- Include frequency: `hourly_sync`, `daily_refresh`
- Match timezone: `daily_refresh_utc`, `nightly_backup_et`

**Sensors:**
- Describe trigger: `file_watcher`, `run_status_monitor`
- Include target: `watch_incoming_data`, `monitor_upstream_jobs`

**Asset Checks:**
- Start with `check_`: `check_row_count`, `check_freshness`
- Include asset name: `check_customers_schema`

### Code Organization

**Group Related Assets:**
```python
# All raw data assets
group_name="raw_data"

# All transformed assets
group_name="analytics"

# All ML models
group_name="ml_models"
```

**Use Descriptive Descriptions:**
```python
description="Customer orders from Salesforce, synced hourly via Fivetran"
# Better than:
description="Orders data"
```

**Tag Appropriately:**
```python
tags={"owner": "data-team", "pii": "true", "env": "prod"}
```

---

## 📚 Related Documentation

- [CODE_EDITOR_IMPLEMENTATION.md](CODE_EDITOR_IMPLEMENTATION.md) - Code editor with file operations
- [DAGSTER_1.12_FEATURES.md](DAGSTER_1.12_FEATURES.md) - State-backed components, translation
- [COMPONENT_ASSET_MODEL.md](COMPONENT_ASSET_MODEL.md) - Components vs assets explained

---

## 🚧 Future Enhancements

### Phase 2 Features

1. **Template Presets**
   - Save custom templates
   - Share templates across projects
   - Import/export templates

2. **Enhanced Validation**
   - Cron expression validator
   - Asset name conflict detection
   - Dependency graph validation

3. **Advanced Editors**
   - Visual cron builder (dropdown menus)
   - Asset dependency picker (multiselect)
   - SQL query autocomplete

4. **Examples Gallery**
   - Pre-built examples per type
   - Load example into form
   - Quick start templates

5. **Code Diff**
   - Show changes when editing
   - Undo/redo functionality
   - Version history

6. **Batch Operations**
   - Generate multiple assets at once
   - Bulk import from CSV
   - Template from existing code

---

## 🎉 Summary

**We've successfully implemented:**

✅ **Backend Template Service** - Generates Python code for 6 primitive types
✅ **REST API** - 8 endpoints for template operations
✅ **Visual Form Builder** - Tab-based UI with validation
✅ **Live Code Preview** - Monaco editor with syntax highlighting
✅ **Save to Project** - Auto-organized file structure
✅ **Type Safety** - TypeScript interfaces throughout

**Total Implementation:**
- **2 new backend files**: TemplateService, Templates API
- **1 new frontend file**: TemplateBuilder component
- **2 modified files**: main.py, api.ts, App.tsx
- **~1,400 lines of code**

**This provides a complete visual builder for all Dagster primitives!** 🚀
