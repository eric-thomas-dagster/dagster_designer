# Dagster 1.12+ Features Integration

## Overview

We've integrated the latest Dagster features from version 1.12+, including:

1. **State-Backed Components** - Incremental loading with persistent state
2. **Translation Capabilities** - Customize asset generation (descriptions, groups, etc.)
3. **Dynamic Component Installation** - Install packages on-demand with `uv add`

---

## 1. State-Backed Components

### What They Are

State-backed components maintain state across materializations, enabling:
- **Incremental data loading** (only new/changed data)
- **CDC (Change Data Capture)** tracking
- **API pagination** with cursor persistence
- **Efficient syncs** without full reloads

### Examples

**Fivetran (State-Backed):**
```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
# Automatically tracks sync state per table
# Only syncs changed data since last run
```

**dlt (State-Backed):**
```yaml
type: dagster_dlt.DltLoadCollectionComponent
attributes:
  loads:
    - source: .loads.github_source
# Maintains cursor state automatically
# Incremental loading based on saved position
```

### UI Indicators

When you configure a state-backed component:

```
┌────────────────────────────────────────┐
│ 🏭 Asset Factory Component             │
│ 📊 State-Backed (Incremental Loading)  │ ← New
│                                        │
│ This component maintains state for     │
│ incremental data loading.              │
└────────────────────────────────────────┘

Asset Preview:
┌────────────────────────────────────────┐
│ fivetran/salesforce/accounts           │
│ 📊 Incremental (state-backed)          │ ← Indicator
│ Last sync: 2024-01-15 10:00:00        │
└────────────────────────────────────────┘
```

### See Also

Full details in [STATE_BACKED_COMPONENTS.md](STATE_BACKED_COMPONENTS.md)

---

## 2. Translation Capabilities

### What Translation Does

Translation lets you customize how assets are generated from components:

**Common Use Cases:**
- Custom asset descriptions
- Asset group names
- Custom asset key patterns
- Owner assignments
- Tags and metadata

### Translation Editor

When configuring any component, you now see a **Translation** section:

```
┌────────────────────────────────────────┐
│ Translation (Asset Customization)      │
├────────────────────────────────────────┤
│ Description                            │
│ [Table {{ props.table }} ]            │
│                                        │
│ Group Name                             │
│ [analytics                     ]      │
│                                        │
│ Asset Key Pattern                      │
│ [prod_{{ node.name }}          ]      │
│                                        │
│ Owners                                 │
│ [analytics-team@company.com    ]      │
│                                        │
│ Tags                                   │
│ [prod,critical                 ]      │
└────────────────────────────────────────┘
```

### Examples

#### Basic: Group All Assets

```yaml
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt
translation:
  group_name: analytics
```

**Result:** All dbt assets grouped under "analytics"

#### Advanced: Custom Descriptions

```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
translation:
  description: "Synced from Fivetran: {{ props.table }}"
  group_name: "source_data"
  tags: ["fivetran", "raw"]
```

**Result:**
```
Assets:
- fivetran/salesforce/accounts
  Description: "Synced from Fivetran: accounts"
  Group: source_data
  Tags: [fivetran, raw]
```

#### Pattern: Custom Asset Keys

```yaml
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt
translation:
  key: "prod_{{ node.name }}"
```

**Result:**
```
Assets:
- prod_customers (instead of dbt_customers)
- prod_orders (instead of dbt_orders)
```

### Template Variables

Use Jinja2 templates in translation:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{ node.name }}` | Node/model name | `customers` |
| `{{ props.table }}` | Table name (Fivetran) | `accounts` |
| `{{ props.connector }}` | Connector name | `salesforce` |
| `{{ env.VAR }}` | Environment variable | `PROD` |

### UI Features

- **Pre-filled common fields** (description, group_name, key, owners, tags)
- **Template variable hints**
- **Examples dropdown**
- **Advanced JSON editor** for full control
- **Real-time preview** in asset list

---

## 3. Dynamic Component Installation

### The Problem

Previously, you could only use components that were already installed in the backend environment.

### The Solution

**Dynamic installation with `uv add`:**

When you try to use a component that isn't installed, the system:
1. Detects the missing package
2. Offers to install it
3. Runs `uv add dagster-<package>`
4. Component becomes available immediately

### UI Flow

```
1. User drags "dlt" component to canvas

2. System checks: Is dagster-dlt installed?
   → No

3. Dialog appears:
   ┌────────────────────────────────────────┐
   │ Component Package Not Installed        │
   ├────────────────────────────────────────┤
   │ The dlt component requires:            │
   │                                        │
   │   dagster-dlt                          │
   │                                        │
   │ Would you like to install it now?     │
   │                                        │
   │ This will run:                         │
   │   uv add dagster-dlt                   │
   │                                        │
   │ [Cancel]              [Install]        │
   └────────────────────────────────────────┘

4. User clicks "Install"
   → Backend runs: uv add dagster-dlt
   → Installation completes

5. Component is now available
   → User can configure and use it
```

### API Endpoints

**Install Component:**
```
POST /api/v1/dagster/install-component
{
  "project_id": "proj-123",
  "component_type": "dagster_dlt.DltLoadCollectionComponent"
}

Response:
{
  "success": true,
  "message": "Successfully installed dagster-dlt"
}
```

**Check if Installed:**
```
GET /api/v1/dagster/check-component-installed/proj-123/dagster_dlt.DltLoadCollectionComponent

Response:
{
  "installed": true
}
```

**List Available Packages:**
```
GET /api/v1/dagster/available-components

Response:
{
  "components": [
    {
      "module": "dagster_dbt",
      "package": "dagster-dbt",
      "description": "Transform data with dbt"
    },
    {
      "module": "dagster_fivetran",
      "package": "dagster-fivetran",
      "description": "Sync data from 150+ sources"
    },
    ...
  ]
}
```

**List Installed Packages:**
```
GET /api/v1/dagster/installed-components/proj-123

Response:
{
  "installed": ["dagster-dbt", "dagster-fivetran"],
  "total": 2
}
```

### Supported Packages

The system knows about all major Dagster packages:

- `dagster-dbt` - dbt transformations
- `dagster-fivetran` - Fivetran integration
- `dagster-sling` - Database replication
- `dagster-dlt` - Modern data loading
- `dagster-airbyte` - Airbyte integration
- `dagster-snowflake` - Snowflake warehouse
- `dagster-bigquery` - BigQuery integration
- `dagster-databricks` - Databricks platform
- `dagster-aws` - AWS services
- `dagster-gcp` - Google Cloud Platform
- `dagster-azure` - Microsoft Azure
- `dagster-k8s` - Kubernetes
- `dagster-docker` - Docker containers
- `dagster-slack` - Slack notifications
- `dagster-pagerduty` - PagerDuty alerting
- `dagster-datadog` - Datadog monitoring

### Backend Service

**New: `ComponentInstaller`**

```python
# backend/app/services/component_installer.py

class ComponentInstaller:
    def install_component_package(
        project_path: Path,
        component_type: str
    ) -> tuple[bool, str]:
        """Install package using uv add."""

    def is_component_installed(
        project_path: Path,
        component_type: str
    ) -> bool:
        """Check if package is installed."""

    def list_available_components() -> list[dict]:
        """List all available packages."""
```

---

## Complete Example: Using All Features

### Scenario

Building a sales analytics pipeline with:
- Fivetran for data ingestion (state-backed)
- dbt for transformations
- Custom asset naming (translation)
- Install dlt on-demand (dynamic installation)

### Step 1: Create Project

```
User: "Create sales_analytics"
Backend: uvx create-dagster@latest project sales_analytics
```

### Step 2: Add Fivetran (State-Backed + Translation)

```
User drags Fivetran component

Configuration:
  account_id: my_account
  api_key: {{ env.FIVETRAN_API_KEY }}

Translation:
  description: "Raw data from {{ props.connector }}"
  group_name: "source_data"
  tags: ["fivetran", "raw", "salesforce"]

Result (scaffolded YAML):
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
    api_key: "{{ env.FIVETRAN_API_KEY }}"
translation:
  description: "Raw data from {{ props.connector }}"
  group_name: "source_data"
  tags: ["fivetran", "raw", "salesforce"]

Assets Generated (127 total):
📊 fivetran/salesforce/accounts
   Description: "Raw data from salesforce"
   Group: source_data
   Tags: [fivetran, raw, salesforce]
   State-backed: Incremental sync

📊 fivetran/salesforce/contacts
   ...
```

### Step 3: Add dbt (Translation)

```
User drags dbt component

Configuration:
  project: /path/to/dbt

Translation:
  description: "Transformed: {{ node.name }}"
  group_name: "analytics"
  owners: ["analytics-team@company.com"]

Assets Generated (50 total):
- dbt_staging_customers
  Description: "Transformed: staging_customers"
  Group: analytics
  Owners: [analytics-team@company.com]
  Depends on: [fivetran/salesforce/accounts, fivetran/salesforce/contacts]

- dbt_customers
  Description: "Transformed: customers"
  Group: analytics
  ...
```

### Step 4: Try dlt (Dynamic Installation)

```
User drags dlt component

System: dagster-dlt not installed

Dialog: "Install dagster-dlt?"
User: "Yes"

Backend: uv add dagster-dlt
Result: Package installed

User configures dlt component

Assets Generated (20 total):
- dlt_github_issues
- dlt_github_prs
...
```

### Final Result

```
Total Assets: 197

Source Layer (state-backed):
├─ fivetran/salesforce/* (127 assets)
└─ dlt/github/* (20 assets)

Transform Layer:
└─ dbt/* (50 assets)

All with:
✅ Custom descriptions
✅ Organized in groups
✅ Tagged appropriately
✅ Incremental loading (where applicable)
```

---

## Benefits Summary

### State-Backed Components

**Before:**
```
Every run: Full reload
Time: 2 hours
Data: 100 GB
```

**After:**
```
First run: Full reload (2 hours, 100 GB)
Subsequent: Incremental (5 min, 100 MB)
```

**Savings:** 96% faster, 99.9% less data

### Translation

**Before:**
```
Assets:
- dbt_model_1
- dbt_model_2
- fivetran_table_1

(No grouping, generic names)
```

**After:**
```
Assets:
- prod_customers (group: analytics, owner: team@company)
- prod_orders (group: analytics, owner: team@company)
- raw_salesforce_accounts (group: source_data, tags: [raw, fivetran])

(Organized, descriptive, ownership clear)
```

### Dynamic Installation

**Before:**
```
Want to use dlt?
1. SSH into server
2. pip install dagster-dlt
3. Restart backend
4. Now you can use it
```

**After:**
```
Want to use dlt?
1. Drag dlt component
2. Click "Install"
3. Use it immediately
```

---

## Migration Guide

### Updating Existing Projects

#### Add Translation

Edit existing component YAML:

```yaml
# Before
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt

# After
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt
translation:  # ← Add this
  group_name: analytics
  description: "{{ node.name }}"
```

#### Enable State-Backed Behavior

Most components are state-backed by default (Fivetran, dlt, etc.). No changes needed!

To verify:
```
Asset Preview shows: 📊 Incremental (state-backed)
```

### Installing New Components

Just use them! The system will offer to install automatically.

Or manually:
```bash
cd projects/my_pipeline
uv add dagster-dlt
```

---

## Summary

**We now support:**

✅ **State-Backed Components** (Dagster 1.12+)
   - Incremental loading
   - Persistent state
   - Efficient syncs
   - 📊 indicator in UI

✅ **Translation Capabilities**
   - Custom descriptions
   - Asset groups
   - Custom key patterns
   - Owners and tags
   - Template variables
   - Visual editor in UI

✅ **Dynamic Component Installation**
   - Install packages on-demand
   - `uv add` integration
   - No server restart needed
   - Auto-detection of missing packages

**All integrated into the visual designer!** 🎉

---

## Resources

- [Dagster 1.12 Release](https://dagster.io/blog/dagster-1-12-monster-mash)
- [State-Backed Components Guide](https://docs.dagster.io/guides/build/components/state-backed-components)
- [Translation Documentation](https://docs.dagster.io/guides/build/components)
- [STATE_BACKED_COMPONENTS.md](STATE_BACKED_COMPONENTS.md) (detailed guide)
