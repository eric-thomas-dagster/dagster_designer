# Manifest fields Genie reads

Genie (the Agent Builder and the AI bar) decides which components it can plan with, and which deterministic checks apply to a
plan, from the component manifest. Every field below is **optional**: when a component doesn't declare it, the built-in
defaults in `backend/app/services/genie_catalog.py` apply, so existing manifests keep working.

| field | type | effect |
|---|---|---|
| `builders` | `string[]` | Adds the component to each named scoped builder's pool: `agents_pipelines` (Agent Builder), `rag` (RAG & Vector Search). A new component appears in the builder with no designer release. |
| `genie_checks` | `string[]` | Which deterministic checks run on picks of this component: `model_provider` (every step naming a model needs `model` + `api_key_env_var`), `per_row_misuse` (reject a linear chain of per-row ops forced into a whole-pipeline component), `context_pipeline` (op order, `execution_mode: sql` limits, model/key requirements for knowledge-base builds). `[]` turns the defaults off. |
| `requires_resources` | `{component_id, config_path, reason}[]` | When the pick's config has a string at `config_path` (dotted, e.g. `receipts.resource_key`), the plan lists that resource as needed. The UI offers to install it; resources are never planned as picks. |

Example:

```json
{
  "id": "context_engineering_pipeline",
  "category": "ai",
  "builders": ["rag", "agents_pipelines"],
  "genie_checks": ["context_pipeline"],
  "requires_resources": [
    {"component_id": "context_receipt_store", "config_path": "receipts.resource_key", "reason": "reads retrieval receipts back into every rebuild"}
  ]
}
```

Related endpoints: `GET /api/ai/builders` (live component count per scoped builder), `POST /api/ai/plan` (`requires_resources` in
the response, with `installed` filled when `project_id` is sent), `GET /api/projects/{id}/knowledge-base/health`
(usage and quality read from a SQLite context receipt store).
