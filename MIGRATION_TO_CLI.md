# Migration to Dagster CLI Integration

## What Changed

We've completely redesigned the architecture to use **Dagster's official CLI tools** instead of custom code generation.

### Key Changes

1. **Project Creation:** Now uses `uvx create-dagster@latest project`
2. **Component Scaffolding:** Now uses `dg scaffold defs`
3. **Asset Preview:** Now loads actual Dagster definitions
4. **Validation:** Real-time errors from Dagster itself

---

## Why This Change?

### Problems with Old Approach

❌ **Custom code generation** - We had to reimplement Dagster's YAML format
❌ **No validation** - Errors only discovered at deployment
❌ **No asset preview** - Couldn't see what assets would be generated
❌ **Maintenance burden** - Had to keep up with Dagster changes
❌ **Not using best practices** - Didn't follow Dagster's recommended workflow

### Benefits of New Approach

✅ **Official Dagster tools** - Uses same commands as documentation
✅ **Real-time validation** - Dagster validates configurations immediately
✅ **Actual asset preview** - See exact assets that will be generated
✅ **Better errors** - Get Dagster's own error messages
✅ **Less code** - Remove custom codegen logic
✅ **Future-proof** - Automatically works with new Dagster features
✅ **Best practices** - Follows Dagster's recommended workflow

---

## New User Flow

### Before (Old Approach)

```
1. User creates project in UI
   → JSON metadata stored

2. User adds component via drag-and-drop
   → Node added to graph

3. User configures component
   → Attributes saved in JSON

4. User clicks "Export"
   → Backend generates YAML (custom logic)
   → Download ZIP

5. User extracts and runs
   → May fail with errors (no preview)
```

### After (New Approach)

```
1. User creates project in UI
   → Backend runs: uvx create-dagster@latest project <name>
   → Real Dagster project created

2. User adds component via drag-and-drop
   → Node added to graph

3. User configures component
   → Backend runs: dg scaffold defs <component> <name> --options
   → Proper YAML created by Dagster

4. User sees asset preview automatically
   → Backend loads definitions
   → UI shows actual assets (with refresh button)

5. User clicks "Export"
   → ZIP the Dagster project (already valid!)
   → Or push to Git directly

6. User deploys
   → Works immediately (already validated)
```

---

## Technical Changes

### Backend

#### New Service: `DagsterCLIService`

```python
# backend/app/services/dagster_cli_service.py

class DagsterCLIService:
    """Service for running Dagster CLI commands."""

    def create_dagster_project(project_name: str) -> Path:
        """Run: uvx create-dagster@latest project <name>"""

    def scaffold_component(
        project_path: Path,
        component_type: str,
        component_name: str,
        options: dict
    ) -> Path:
        """Run: dg scaffold defs <type> <name> --options"""

    def load_definitions(project_path: Path) -> dict:
        """Load and extract assets from definitions.py"""

    def validate_project(project_path: Path) -> tuple[bool, str]:
        """Check if project is valid"""
```

#### New API Router: `dagster.py`

```python
# backend/app/api/dagster.py

POST   /api/v1/dagster/create-project      # Create Dagster project
POST   /api/v1/dagster/scaffold-component  # Scaffold component
GET    /api/v1/dagster/preview-assets/{id} # Preview generated assets
GET    /api/v1/dagster/validate-project/{id}  # Validate project
GET    /api/v1/dagster/list-components     # List available components
GET    /api/v1/dagster/component-options/{type}  # Get component options
```

#### Removed: Custom Code Generation

```python
# ❌ REMOVED: backend/app/services/codegen_service.py
# No longer needed - using Dagster's own tools
```

### Frontend

#### New Component: `AssetPreview`

```tsx
// frontend/src/components/AssetPreview.tsx

<AssetPreview projectId={currentProject.id} />
```

**Features:**
- Shows generated assets
- Refresh button
- Error display
- Loading states
- Asset details (deps, metadata, groups)

#### Updated: `PropertyPanel`

Now includes `<AssetPreview />` for asset factory components:

```tsx
{isAssetFactory && currentProject && (
  <div className="mt-4">
    <AssetPreview projectId={currentProject.id} />
  </div>
)}
```

#### New API Methods

```typescript
// frontend/src/services/api.ts

export const dagsterApi = {
  createProject(projectId, projectName),
  scaffoldComponent(projectId, componentType, name, options),
  previewAssets(projectId),
  validateProject(projectId),
  listComponents(),
  getComponentOptions(componentType),
};
```

---

## For Developers

### Setup Requirements

**New dependencies:**

```bash
# Install uv (for uvx command)
pip install uv

# Dagster CLI is included in dagster package
# No additional install needed
```

**Updated `requirements.txt`:**

```txt
uv==0.5.0  # NEW: For uvx commands
```

### Running the New System

```bash
# Backend (unchanged command, new behavior)
cd backend
python -m uvicorn app.main:app --reload

# Frontend (unchanged)
cd frontend
npm run dev
```

### Testing the New Flow

```bash
# 1. Create a project through the API
curl -X POST http://localhost:8000/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "test_pipeline"}'

# Response: {"id": "proj-123", ...}

# 2. Initialize Dagster project
curl -X POST http://localhost:8000/api/v1/dagster/create-project \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj-123", "project_name": "test_pipeline"}'

# 3. Scaffold a component
curl -X POST http://localhost:8000/api/v1/dagster/scaffold-component \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj-123",
    "component_type": "dagster_dbt.DbtProjectComponent",
    "component_name": "transform",
    "options": {"project": "/path/to/dbt"}
  }'

# 4. Preview assets
curl http://localhost:8000/api/v1/dagster/preview-assets/proj-123
```

---

## For Users

### What You'll Notice

#### 1. Real Asset Counts

**Before:** "This will generate multiple assets..."

**After:** "Generated Assets (127 assets)" with full list

#### 2. Immediate Error Feedback

**Before:** Errors only when deploying

**After:** Errors shown immediately in property panel:

```
❌ Error Loading Assets

ValidationError: field 'api_key' is required

Fix: Add your Fivetran API key to the configuration
```

#### 3. Asset Details

**Before:** No visibility into generated assets

**After:** Full asset information:

```
┌───────────────────────────────────────┐
│ fivetran/salesforce/accounts          │
│ Group: salesforce                     │
│ Depends on: []                        │
│ Metadata: {"source": "fivetran"}      │
└───────────────────────────────────────┘
```

#### 4. Refresh Button

**Before:** No way to see updated assets

**After:** Click refresh to reload after configuration changes

---

## Migration Checklist

### For Development

- [x] Install `uv`: `pip install uv`
- [x] Update `requirements.txt`
- [x] Add `DagsterCLIService`
- [x] Add `dagster` API router
- [x] Create `AssetPreview` component
- [x] Update `PropertyPanel` to show asset preview
- [x] Add `dagsterApi` methods to frontend

### For Deployment

- [ ] Ensure `uv` is installed in production environment
- [ ] Ensure `dg` command is available
- [ ] Update deployment scripts to include `uv`
- [ ] Test project creation in production environment
- [ ] Test component scaffolding in production

### For Documentation

- [x] Create `DAGSTER_CLI_INTEGRATION.md`
- [x] Create `MIGRATION_TO_CLI.md`
- [ ] Update main `README.md`
- [ ] Update `QUICKSTART.md`
- [ ] Update architecture diagrams

---

## Breaking Changes

### API Changes

**New endpoints:**
- `POST /api/v1/dagster/create-project`
- `POST /api/v1/dagster/scaffold-component`
- `GET /api/v1/dagster/preview-assets/{id}`

**Deprecated endpoints:**
- `POST /api/v1/codegen/generate` (still works but not recommended)
- `GET /api/v1/codegen/preview/{id}` (replaced by asset preview)

### Workflow Changes

**Before:**
1. Design graph
2. Export ZIP
3. Deploy and hope it works

**After:**
1. Design graph (each node creates real Dagster files)
2. See assets immediately
3. Export ZIP (already validated)
4. Deploy with confidence

---

## Rollback Plan

If needed, the old code generation service is still present:

```python
# backend/app/services/codegen_service.py
# backend/app/api/codegen.py
```

To revert:
1. Remove `dagster` router from `main.py`
2. Use old codegen endpoints
3. Hide `AssetPreview` component

---

## Future Enhancements

Now that we use official Dagster tooling, we can easily add:

- **Live asset validation** - Check asset keys before deployment
- **Dependency visualization** - Show asset lineage graph
- **Test scaffolding** - Use `dg` to generate tests
- **Deployment commands** - Use Dagster Cloud CLI
- **Schema validation** - Use Dagster's own validators

---

## Questions & Answers

### Q: Why not just use the old approach?
**A:** Custom code generation is error-prone, hard to maintain, and doesn't give users real-time feedback. Using official tools is always better.

### Q: Does this require Dagster to be installed?
**A:** Yes, but it was already required. We just use it more directly now.

### Q: Will old projects still work?
**A:** Yes. The old codegen endpoints still exist. New projects use the new approach.

### Q: What if `uvx` or `dg` commands fail?
**A:** The backend returns clear error messages that show in the UI. Users can fix configuration issues immediately.

### Q: Does this work with custom components?
**A:** Yes! As long as they follow Dagster's component protocol, they'll work automatically.

---

## Success Metrics

### Before Migration
- ❌ No validation until deployment
- ❌ No asset preview
- ❌ Custom code to maintain
- ❌ Errors discovered late

### After Migration
- ✅ Immediate validation
- ✅ Real asset preview
- ✅ Less code to maintain
- ✅ Errors caught early
- ✅ Uses official Dagster tools
- ✅ Better user experience

---

## Timeline

**Phase 1: Core Integration** (Complete)
- [x] `DagsterCLIService` implementation
- [x] API endpoints
- [x] Asset preview component
- [x] Frontend integration

**Phase 2: Polish** (In Progress)
- [ ] Error message improvements
- [ ] Loading state refinements
- [ ] Documentation updates

**Phase 3: Advanced Features** (Future)
- [ ] Asset lineage visualization
- [ ] Dependency validation
- [ ] Real-time asset key preview
- [ ] Test generation

---

## Conclusion

**This is a major architectural improvement.** By using Dagster's official CLI tools instead of custom code generation, we get:

1. **Validation** - Immediate feedback on configuration
2. **Preview** - See actual generated assets
3. **Errors** - Real Dagster error messages
4. **Maintenance** - Less custom code
5. **Future-proof** - Automatic support for new features

**The designer now works *with* Dagster, not *around* it.** 🎉
