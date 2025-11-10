# Understanding Components vs Assets in Dagster Designer

## The Core Distinction

### Components (What You Design)
**Components** are factories that generate Dagster definitions. When you drag a component onto the canvas, you're configuring a **definition generator**.

### Assets (What Gets Executed)
**Assets** are the actual data objects that Dagster materializes. They're created dynamically when Dagster loads your component definitions.

## Component Types

### 1. Asset Factory Components (1 → Many)

These components scan external configurations and generate multiple assets:

#### **dbt Component** (`dagster_dbt.DbtProjectComponent`)
```yaml
type: dagster_dbt.DbtProjectComponent
attributes:
  project: /path/to/dbt/project
```

**Generates:**
- One asset per dbt model in `models/`
- Asset keys like: `dbt_customers`, `dbt_orders`, `dbt_monthly_revenue`
- Asset dependencies based on dbt's `ref()` and `source()` relationships

**Asset Count:** Could be 10s to 100s of assets from one component

#### **Fivetran Component** (`dagster_fivetran.FivetranAccountComponent`)
```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
    api_key: "{{ env.FIVETRAN_API_KEY }}"
  connector_selector:
    by_name:
      - salesforce_connector
```

**Generates:**
- One asset per table in each connector
- Asset keys like: `fivetran/salesforce/accounts`, `fivetran/salesforce/opportunities`
- Updates reflect Fivetran sync status

**Asset Count:** Could be dozens of assets per connector

#### **Sling Component** (`dagster_sling.SlingReplicationCollectionComponent`)
```yaml
type: dagster_sling.SlingReplicationCollectionComponent
attributes:
  connections:
    POSTGRES:
      type: postgres
      host: localhost
  replications:
    - path: ./replication.yaml
```

**Generates:**
- Assets based on replication config
- One asset per source → target mapping
- Asset keys reflect database and table names

#### **dlt Component** (`dagster_dlt.DltLoadCollectionComponent`)
```yaml
type: dagster_dlt.DltLoadCollectionComponent
attributes:
  loads:
    - source: .loads.github_source
      pipeline: .loads.github_pipeline
```

**Generates:**
- Assets for each dlt resource
- Asset keys based on resource names
- Dynamic based on source configuration

### 2. Direct Asset Components (1 → 1 or Few)

These components create a specific, known set of assets:

#### **Snowflake SQL Component** (`dagster_snowflake.SnowflakeSQLComponent`)
```yaml
type: dagster_snowflake.SnowflakeSQLComponent
attributes:
  database: analytics
  schema: marts
  table: customer_summary
  sql: SELECT * FROM raw.customers
```

**Generates:**
- One asset: `customer_summary`
- Direct mapping to table

**Asset Count:** Typically 1 asset per component

## Visual Representation Strategy

### Current Implementation: Component View

The graph editor shows **components as nodes**:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Fivetran   │────▶ │     dbt     │────▶ │  Snowflake  │
│  Component  │      │  Component  │      │     SQL     │
└─────────────┘      └─────────────┘      └─────────────┘
     ↓                      ↓                     ↓
 (100 assets)          (50 assets)           (1 asset)
```

**What the edges mean:**
- Data flow direction (upstream → downstream)
- Logical dependencies between data sources
- NOT actual asset dependencies (those are determined by Dagster)

### What Happens at Runtime

When Dagster loads your definitions:

```python
# Your component YAML
dbt_component = DbtProjectComponent(project="/path/to/dbt")

# Dagster calls build_defs()
defs = dbt_component.build_defs(context)

# This creates:
# - Asset: customers (depends on: raw_customers)
# - Asset: orders (depends on: raw_orders, customers)
# - Asset: revenue (depends on: orders, customers)
# ... etc
```

The actual **asset lineage graph** is much more detailed than the component graph.

## Implications for Design

### 1. Component Connections
When you connect two components in the designer:
- You're expressing **data flow** at a high level
- The actual asset dependencies are computed by Dagster
- Dagster uses asset keys and `deps` to build the real DAG

### 2. Asset Keys and Dependencies
Components handle dependencies through:

**Translation rules:**
```yaml
translation:
  group_name: analytics
  description: "Table {{ props.name }}"
  # Asset key patterns
  key: "dbt_{{ node.name }}"
```

**Post-processing:**
```yaml
post_processing:
  assets:
    - target: "*"  # All generated assets
      attributes:
        deps:
          - upstream_asset_key
```

### 3. Asset Discovery
To see what assets a component will generate, you need to:
1. Load the component in Dagster
2. Call `build_defs()`
3. Inspect the resulting `Definitions` object

**This is why asset preview is tricky** - it requires executing component logic.

## Design Patterns

### Pattern 1: Source → Transform → Destination

```
Fivetran Component → dbt Component → Snowflake Table
(ingestion)         (transformation)  (final output)

Runtime:
fivetran/salesforce/accounts ──┐
fivetran/salesforce/contacts ──┤
                               ├─▶ dbt_customer_360 ─▶ marts.customers
fivetran/salesforce/opportunities ─┘
```

### Pattern 2: Multiple Sources → dbt

```
Fivetran (Salesforce) ──┐
                        ├─▶ dbt Component ─▶ Analytics Assets
Fivetran (HubSpot) ─────┘

Runtime:
- dbt can ref() any Fivetran source
- Asset dependencies auto-detected via dbt manifest
```

### Pattern 3: Fan-out Processing

```
Sling (Ingest) ─┬─▶ dbt Component (Marketing)
                │
                ├─▶ dbt Component (Sales)
                │
                └─▶ dbt Component (Finance)

Runtime:
- Each dbt project generates independent assets
- But can share upstream Sling assets
```

## Best Practices

### 1. Component Naming
Name components by their **purpose**, not the assets they generate:
- ❌ "customers_and_orders_and_revenue" (asset names)
- ✅ "salesforce_ingestion" (purpose)
- ✅ "marketing_transforms" (purpose)

### 2. Grouping Assets
Use `translation.group_name` to organize generated assets:
```yaml
translation:
  group_name: salesforce_data  # All Fivetran assets

# or
translation:
  group_name: marketing_analytics  # All dbt models
```

### 3. Asset Key Patterns
Use consistent patterns for discoverability:
```yaml
translation:
  key: "source_{{ connector }}_{{ table }}"  # fivetran
  key: "dbt_{{ node.name }}"                 # dbt
  key: "ml_{{ model_name }}"                 # custom
```

### 4. Dependency Management
Let Dagster handle most dependencies automatically:
- dbt: Uses manifest.json for `ref()` relationships
- Fivetran: No downstream deps by default
- Explicit deps only when needed:
  ```yaml
  post_processing:
    assets:
      - target: "my_asset"
        attributes:
          deps: ["external_asset_key"]
  ```

## Future Enhancements

### Asset Lineage View
Show the actual asset DAG (requires loading definitions):
```
┌──────────────────────────────────────────┐
│ Component View (Design Time)             │
│  Fivetran ──▶ dbt ──▶ Snowflake         │
└──────────────────────────────────────────┘
                   ↓
┌──────────────────────────────────────────┐
│ Asset View (Runtime)                     │
│  sf_accounts ─┬─▶ customers ──▶ summary │
│  sf_contacts ─┘                          │
└──────────────────────────────────────────┘
```

### Asset Count Indicator
Show how many assets a component generates:
```
┌─────────────────┐
│  dbt Component  │
│  📊 47 assets   │
└─────────────────┘
```

### Asset Preview Panel
When clicking a component, show expected assets:
```
dbt Component
└─ Estimated Assets:
   ├─ dbt_customers (depends: raw_customers)
   ├─ dbt_orders (depends: raw_orders, dbt_customers)
   └─ dbt_revenue (depends: dbt_orders)
```

## Summary

| Concept | What It Is | Cardinality |
|---------|-----------|-------------|
| **Component** | Definition factory you configure in designer | 1 node in graph |
| **Assets** | Data objects Dagster materializes | N assets per component |
| **Component Graph** | High-level data flow (design time) | What you see in UI |
| **Asset Lineage** | Actual dependency DAG (runtime) | What Dagster executes |

**Key Insight:** You design at the **component level**, but Dagster executes at the **asset level**.

The designer helps you:
1. Configure component parameters
2. Express high-level data flow
3. Generate proper YAML definitions

Dagster handles:
1. Asset discovery from components
2. Asset dependency resolution
3. Asset materialization and orchestration

This separation allows you to manage complex pipelines visually without manually defining hundreds of individual assets!
