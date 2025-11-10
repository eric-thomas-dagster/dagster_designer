# UI Guide: Understanding Asset Factories

This guide shows how the Dagster Designer UI helps you understand component → asset relationships.

## Visual Indicators

### 1. Component Palette

```
┌──────────────────────────────────┐
│  Components              [Search]│
│                                  │
│  [All] [dbt] [fivetran] [sling] │
│                                  │
│  ┌────────────────────────────┐ │
│  │ 🗄️  DbtProjectComponent   │ │
│  │ Transform data with dbt    │ │
│  │ Category: dbt              │ │
│  └────────────────────────────┘ │
│                                  │
│  ┌────────────────────────────┐ │
│  │ 🔄  FivetranAccount...     │ │
│  │ Sync from 150+ sources     │ │
│  │ Category: fivetran         │ │
│  └────────────────────────────┘ │
│                                  │
│  Drag components onto canvas    │
└──────────────────────────────────┘
```

### 2. Graph Canvas - Component Node

**Asset Factory Component (with badge):**
```
┌───────────────────────────┐
│  🗄️  Salesforce Ingestion │
│     dbt  [🏭]              │  ← Factory badge
└───────────────────────────┘
        ↓
  Hover tooltip:
  "Asset Factory: Generates multiple assets"
```

**Direct Asset Component (no badge):**
```
┌───────────────────────────┐
│  ❄️   Customer Summary    │
│     snowflake              │  ← No badge
└───────────────────────────┘
```

### 3. Property Panel - Asset Factory Component

When you click a component with the 🏭 badge:

```
┌────────────────────────────────────┐
│  Properties              [Save]    │
├────────────────────────────────────┤
│                                    │
│  Label                             │
│  [Marketing Analytics        ]    │
│                                    │
│  Component Type                    │
│  DbtProjectComponent               │
│                                    │
│  ┌──────────────────────────────┐ │
│  │ 🏭 Asset Factory Component   │ │
│  │                              │ │
│  │ This component will generate │ │
│  │ multiple Dagster assets at   │ │
│  │ runtime based on your        │ │
│  │ configuration. The actual    │ │
│  │ asset count and dependencies │ │
│  │ are determined when Dagster  │ │
│  │ loads the definitions.       │ │
│  └──────────────────────────────┘ │
│                                    │
│  ℹ️ Component Description          │
│  Transform your data using dbt...  │
│                                    │
│  Configuration                     │
│  ─────────────                     │
│                                    │
│  project *                         │
│  Path to dbt project               │
│  [/path/to/dbt/project       ]    │
│                                    │
│  profiles_dir                      │
│  Path to profiles directory        │
│  [{{ env.DBT_PROFILES_DIR }} ]    │
│                                    │
│  💡 Tip: Use template variables    │
│  like {{ env.VAR_NAME }}           │
│                                    │
│  ┌──────────────────────────────┐ │
│  │ Asset Generation Examples:   │ │
│  │                              │ │
│  │ • One asset per dbt model    │ │
│  │   in your project            │ │
│  │                              │ │
│  │ • Dependencies based on      │ │
│  │   ref() relationships        │ │
│  │                              │ │
│  │ • Asset keys like:           │ │
│  │   dbt_customers,             │ │
│  │   dbt_orders                 │ │
│  └──────────────────────────────┘ │
└────────────────────────────────────┘
```

### 4. Property Panel - Direct Asset Component

When you click a component without the 🏭 badge:

```
┌────────────────────────────────────┐
│  Properties              [Save]    │
├────────────────────────────────────┤
│                                    │
│  Label                             │
│  [Customer Summary           ]    │
│                                    │
│  Component Type                    │
│  SnowflakeSQLComponent             │
│                                    │
│  ℹ️ Component Description          │
│  Execute SQL to create a table...  │
│                                    │
│  Configuration                     │
│  ─────────────                     │
│                                    │
│  database *                        │
│  [analytics                  ]    │
│                                    │
│  schema *                          │
│  [marts                      ]    │
│                                    │
│  table *                           │
│  [customer_summary           ]    │
│                                    │
│  sql *                             │
│  [SELECT * FROM...           ]    │
│  [                            ]    │
│                                    │
│  💡 Tip: Use template variables    │
│  like {{ env.VAR_NAME }}           │
└────────────────────────────────────┘
```

## Complete Example: Building a Pipeline

### Step 1: Add Fivetran Component

**On Canvas:**
```
┌──────────────────────────┐
│  🔄  Salesforce Data     │
│     fivetran  [🏭]        │
└──────────────────────────┘
```

**In Property Panel:**
```
🏭 Asset Factory Component
This component will generate multiple assets...

Asset Generation Examples:
• One asset per table in each connector
• Asset keys like: fivetran/salesforce/accounts
• Updates reflect Fivetran sync status
```

### Step 2: Add dbt Component

**On Canvas:**
```
┌──────────────────────────┐      ┌──────────────────────────┐
│  🔄  Salesforce Data     │─────▶│  🗄️  Transform           │
│     fivetran  [🏭]        │      │     dbt  [🏭]             │
└──────────────────────────┘      └──────────────────────────┘
```

**In Property Panel:**
```
🏭 Asset Factory Component
This component will generate multiple assets...

Asset Generation Examples:
• One asset per dbt model in your project
• Dependencies based on ref() relationships
• Asset keys like: dbt_customers, dbt_orders
```

### Step 3: Add Snowflake SQL Component

**On Canvas:**
```
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Salesforce  │───▶│  Transform   │───▶│  Final Summary   │
│  fivetran 🏭 │    │  dbt 🏭      │    │  snowflake       │
└──────────────┘    └──────────────┘    └──────────────────┘
  (100 assets)        (50 assets)          (1 asset)
```

**Final Property Panel (Snowflake):**
```
Component Type: SnowflakeSQLComponent
(No factory badge - creates single asset)

Configuration:
- database: analytics
- schema: marts
- table: customer_360
- sql: SELECT ... FROM dbt_customers ...
```

## What Dagster Sees

When you export and Dagster loads your project:

### Component Graph (What You Designed)
```
Fivetran ──▶ dbt ──▶ Snowflake SQL
```

### Asset Lineage (What Dagster Executes)
```
fivetran/salesforce/accounts ────┐
fivetran/salesforce/contacts ────┤
fivetran/salesforce/opportunities─┤
                                  ├──▶ dbt_staging_accounts ──┐
                                  │    dbt_staging_contacts ──┤
                                  │    dbt_staging_opps ──────┤
                                                               ├──▶ dbt_customers ──┐
                                                               │    dbt_orders ─────┤
                                                                                     ├──▶ customer_360
                                                                                     │
```

**Key Insight:** Your 3 component nodes became 100+ actual assets!

## Color Coding Reference

### Property Panel Boxes

| Color | Meaning |
|-------|---------|
| 🟣 Purple | Asset factory notice - this component generates multiple assets |
| 🔵 Blue | Component description from docstring |
| 🟡 Yellow | Asset generation examples - learn how assets are created |
| ⚪ Gray | Tips and hints (template variables, etc.) |

### Component Types

| Badge | Type | Example |
|-------|------|---------|
| 🏭 | Asset Factory | dbt, Fivetran, Sling, dlt - generates many assets |
| (none) | Direct Asset | Snowflake SQL, custom components - usually 1 asset |

## Usage Tips

### 1. Look for the Badge
- 🏭 badge = Component will generate multiple assets
- No badge = Component typically creates single asset

### 2. Read the Purple Box
When configuring an asset factory, the purple box explains that asset count is determined at runtime.

### 3. Check the Examples
The yellow box shows category-specific examples of what assets will be generated.

### 4. Design High-Level Flow
Focus on **data flow** between components, not individual asset dependencies.

### 5. Let Dagster Handle Details
- dbt handles `ref()` relationships
- Fivetran determines table structure
- Dagster computes the full asset DAG

## Common Patterns

### Pattern 1: Ingest → Transform → Output
```
[Fivetran 🏭] ──▶ [dbt 🏭] ──▶ [Snowflake SQL]
  Source data      Transform     Final table
  (many assets)    (many assets) (1 asset)
```

### Pattern 2: Multiple Sources → Single Transform
```
[Fivetran A 🏭] ──┐
                   ├──▶ [dbt 🏭] ──▶ [Output]
[Fivetran B 🏭] ──┘
```

### Pattern 3: Fan-out Processing
```
                   ┌──▶ [dbt Marketing 🏭]
[Sling Ingest 🏭]──┼──▶ [dbt Sales 🏭]
                   └──▶ [dbt Finance 🏭]
```

## Exporting Your Pipeline

When you click "Export", the generated code reflects your component configuration:

### For Asset Factory Components
```yaml
# fivetran_salesforce.yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
  connector_selector:
    by_name:
      - salesforce_connector
```
→ Dagster generates assets at runtime based on Fivetran API

### For Direct Components
```yaml
# customer_summary.yaml
type: dagster_snowflake.SnowflakeSQLComponent
attributes:
  database: analytics
  schema: marts
  table: customer_360
  sql: SELECT ... FROM ...
```
→ Dagster creates the specified asset

## Summary

The Dagster Designer helps you:

✅ **See at a glance** which components are asset factories (🏭)
✅ **Understand what assets** will be generated (examples in property panel)
✅ **Design high-level flow** without manual asset management
✅ **Trust Dagster** to handle the complex asset dependency graph

**Remember:** You design the **architecture** (components), Dagster executes the **details** (assets).
