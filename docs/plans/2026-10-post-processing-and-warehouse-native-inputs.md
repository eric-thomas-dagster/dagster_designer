# Plan: universal post_processing fields + warehouse-native Activation inputs

Status: Part 1 Phase 1 done. Part 2 pilot done (turned out to be nearly
free -- see below). Part 1 Phase 2 fully done, including the project-wide
selector-rules authoring UI (the power-user "tag every staging model in
one rule" case). The full dbt `translation` migration is now also done
(see Progress log). Still open: Part 2 rollout / Part 1 Phase 3 (neither
started, and Part 2's 42-component validation pass means rollout is
largely closed already).
Written 2026-10-02 after the custom-lineage refactor (see
`_write_post_processing_defs_yaml`, renamed from
`_write_custom_lineage_defs_yaml`, in
`backend/app/services/project_service.py`) surfaced that Dagster's
`post_processing` mechanism is more general than Designer currently uses it
for, and a separate investigation into reverse-ETL ("Activation")
components found they lack a warehouse-native input path analogous to what
Join/Transform already have.

## Progress log

- **Part 1 / Phase 1 (shipped)**: universal "Common fields"
  (group_name/owners/tags) + "Dependencies" in `ComponentConfigModal`,
  gated to single-asset components. Also found and fixed along the way:
  an `is_asset_factory` component (one instance, many assets) was
  incorrectly falling back to `component.id` as if it were a real asset
  key -- confirmed live this would have created a dangling
  post_processing target; a component using `asset_key` (possibly
  multi-part, e.g. `["raw", "player_tracking"]`) instead of `asset_name`
  wasn't recognized at all, now normalized via `toAssetKeyString`.
- **Structural hardening (shipped, applies everywhere)**: every target
  `_write_post_processing_defs_yaml` writes is now `key:<asset>`, not a
  bare string. Confirmed directly: a bare-string target that doesn't
  resolve raises `DagsterInvalidSubsetError` and crashes loading of the
  ENTIRE project; an explicit `key:` prefix degrades gracefully to
  "matches nothing" for the same nonexistent key, with identical
  behavior when the key DOES exist. This was found the hard way -- stale
  `DependencyGraphComponent` lineage data in a real project (asset-key
  naming mismatch between what the data assumed and what the real
  ingestion components produce) crashed the entire project load the
  moment post_processing went from a no-op to functional. The
  known-asset-key validation added earlier is now belt-and-suspenders,
  not the only thing standing between stale data and a crash.
- **Part 2 pilot (effectively done, turned out already-free)**: checked
  all 33 reverse-ETL community components, not just Google Sheets --
  every one already has `resource`/`sqlalchemy` input support
  (`.get_connection()` with `.get_engine()` fallback) from someone else's
  commits to that repo. The only missing piece was Designer's own
  frontend: the `source` field fell through to a raw JSON textarea. Built
  a real editor (kind selector, resource picker, SQL/CSV/inline modes) in
  `ComponentConfigModal`, schema-driven by field name so it covers all 33
  components at once -- no pilot-then-rollout needed. Caught two real
  bugs in the first pass (a radio toggle using a truthiness check instead
  of a presence check, a kind-switcher that merged instead of replaced)
  before shipping.
- **Part 1 / Phase 2, per-asset case (shipped)**: `PropertyPanel`'s
  asset-metadata editor. Found its non-dbt save path was **entirely
  cosmetic** -- it only mutated the in-memory graph node, never
  persisting anything that affected the real Dagster asset, and got
  silently overwritten on the next introspection regenerate. Migrated it
  to `asset_field_overrides` (description added to that model for this
  case specifically -- safe here since, unlike `ComponentConfigModal`,
  there's no competing description field at the asset level to duplicate
  with), added a Tags field (didn't exist before), and added Dependencies
  (the only place a multi-asset component's individual assets -- dbt,
  fivetran, etc. -- can get this at all, since `ComponentConfigModal`
  operates per component instance, not per asset).
  - Known gap, not fixed: if a dbt asset's description/group_name/owners
    AND tags are changed in the same save, the tags change is silently
    dropped (the dbt branch and the new override branch are
    mutually-exclusive based on a `hasCustomizations` check that doesn't
    look at tags). Low-frequency edge case; flagging rather than fixing
    now given how much this session has already touched.
- **Project-wide selector-rules UI (shipped)**: new `AssetPostProcessingRule`
  model (`target` is a real Dagster selection expression, not a single
  literal key) + `PUT /projects/{id}/post-processing-rules` (replaces the
  whole rule list in one call) + `PostProcessingRulesDialog.tsx`, wired
  into `DbtPanel`'s main toolbar (project-wide, not dbt-specific, but
  that's where the primary use case -- tagging/owning dbt models by
  prefix or tag -- lives). Verified directly against a real Dagster load:
  one rule with `target: "tag:critical=true"` applied to both matching
  assets and correctly left a third, non-matching asset untouched.
  Safety: a rule target with no selector syntax (no `:`, not `*`) gets
  the same `key:` crash-prevention prefix as `AssetFieldOverrides`; real
  selector syntax is used verbatim, since the user is responsible for it
  being correct the same way they'd be hand-writing it in defs.yaml.
  13 new backend tests, all passing.
- **Still not started**: migrating dbt's existing
  `translation.group_name`/`description` mechanism fully onto
  post_processing (the per-asset fix above gives dbt assets a NEW,
  working path for tags specifically, but doesn't replace the old
  mechanism for description/group_name/owners).
- Part 2 rollout to the remaining 27 components and Part 1 Phase 3 are
  unaffected by the above and remain not started.

---

## Part 1: Universal "Common Fields" via post_processing

### Problem

`group_name` / `description` / `owners` / `tags` are currently set in up to
three disconnected places depending on component type:

1. The component's own schema fields (most first-party and community
   components declare these themselves).
2. `TranslationEditor`'s `translation:` block
   (`frontend/src/components/TranslationEditor.tsx`) — rendered
   unconditionally for *every* component type in `ComponentConfigModal`,
   but only ever persisted to disk for dbt component types
   (`_generate_component_yaml_files` in `project_service.py`, gated behind
   `is_dbt_component`). For every non-dbt component, filling in these
   fields silently does nothing — a real, pre-existing bug, not just
   duplication.
3. `post_processing.assets[].attributes` — confirmed (by direct testing
   against a real `dg.load_from_defs_folder` project) to support the full
   `AssetSpec` attribute surface (`group_name`, `description`, `owners`,
   `tags`, `kinds`, `automation_condition`, `partitions_def`,
   `freshness_policy`, `deps`, ...) and the full asset-selection syntax for
   `target:` (`"*"`, `tag:critical=true`, `key:core/stg_*`, boolean `or`),
   independent of which component produced the asset.

Also confirmed directly: even for dbt, only `group_name`/`description`
actually survive today (`_generate_definitions_with_asset_customizations`
only extracts those two fields from `component.translation` into
`asset_customizations.json`) — `owners`/`tags` entered via
`TranslationEditor` for a dbt model are silently dropped too.

### Key technical findings (verified this session, not assumed)

- `post_processing.assets[].target` resolves by **asset key/selector**, not
  by component identity. Verified with a real `@multi_asset` producing two
  outputs: targeting one by key only affected that one, its sibling was
  untouched.
- A dangling `target` (an asset key that doesn't resolve to anything)
  raises `DagsterInvalidSubsetError` and **crashes loading of the entire
  project** — not just that one post_processing entry. A dangling `source`
  in `deps` does not crash, but silently creates a phantom placeholder
  asset spec with no materialization function. Both confirmed by direct
  testing. This is why the Dependencies field shipped in Part 0 below is
  gated so tightly.
- Designer already distinguishes single-asset vs. multi-asset components:
  `ComponentInstance.is_asset_factory` (true for dbt/fivetran/sling/dlt/
  airbyte-style instances — one component instance, many assets).
  `DbtProjectComponent` is in fact *never* edited through
  `ComponentConfigModal` today; dbt customization already goes through
  `PropertyPanel` (the per-asset-node view), confirming the "one editor
  doesn't fit both cases" split already exists in practice.

### Part 0 (shipped, 2026-10-02)

`ComponentConfigModal`'s "Dependencies" field, backed by the custom-lineage
`post_processing` mechanism from Part 1 of the lineage refactor. Gated to
`!isNew && !component.is_asset_factory && attributes.asset_name` present —
no fallback to `component.id`, since that's an instance id, not
necessarily a real asset key, and using it as one for a multi-asset
component would create exactly the dangling-target crash described above.
(This gate was itself added as a fix after the user asked "the
post_processing today is at the component level, not asset level — if it's
a multi-asset component?", which caught a real bug in the first version of
this field: it originally fell back to `component.id`.)

### Phase 1 — `ComponentConfigModal`, single-asset components only

- Scope: components where `!is_asset_factory && attributes.asset_name` is
  present — the majority of first-party + community components
  (SqlTransformerComponent, SqlJoinComponent, dataframe_join, most
  reverse-ETL sinks, etc.).
- Add a universal "Common fields" section (group_name, description,
  owners, tags to start) backed by `post_processing.assets[{target:
  asset_name}]`, same pattern/plumbing as the Dependencies field.
- Suppress rendering of a component-schema-declared field if its name
  matches one the universal section now owns — **pure frontend filtering,
  zero changes to any component's Python/schema**. This is the design
  decision that keeps this from requiring "massive changes across most
  components" (the user's own concern, and a valid one): we don't touch
  component internals, we just stop rendering a second input for the same
  concept.
- Leave `TranslationEditor` in place for `key:` (asset-key-pattern
  rewriting) — `post_processing` has no equivalent for literally
  rewriting an asset's key, only its other attributes.

### Phase 2 — `PropertyPanel`, asset-node level

- Covers what Phase 1 structurally can't: individual assets from
  multi-asset/asset-factory components.
- Same universal fields, but `target:` needs a free-text input accepting
  real Dagster selection syntax, not just a single asset-key dropdown —
  this is where the power use case lives (e.g. partitioning/tagging every
  dbt model matching a prefix or tag in one rule, per the real working
  example from Dagster's own Slack: `target: "key:marts/fct_fuel_margin_daily
  or key:marts/fct_store_pnl_daily"`, `tag:critical=true`, `key:core/stg_*`).
- Migrate dbt's existing per-model `translation.group_name`/`description`
  mechanism onto this same post_processing path, fixing the
  owners/tags-silently-dropped bug as a side effect.

### Phase 3 — optional, deferred

- Audit + strip redundant native `group_name`/`owners`/`tags` fields from
  individual components' own schemas, now that Phase 1's suppression makes
  keeping them purely cosmetic rather than necessary. Lower priority —
  only worth it if the dual-field confusion keeps coming up in practice.

**Out of scope for all phases:** `translation.key` stays dbt-specific.

---

## Part 2: Warehouse-native input for reverse-ETL ("Activation") components

### Current state (confirmed via direct source inspection, not assumed)

28 of 29 reverse-ETL community components (Google Sheets, HubSpot, Braze,
Salesforce, Stripe, Zendesk, Jira, GitHub, Notion, PagerDuty, Pipedrive,
Shopify, ServiceNow, Mailchimp, Intercom, Greenhouse, Asana, Freshdesk,
LaunchDarkly, Heap, and the `dataframe_to_*` family) share one input shape:

```python
upstream_asset_key: Optional[str]      # DataFrame from an existing Dagster asset
source: Optional[Dict[str, Any]]       # mutually exclusive inline escape hatch:
                                        #   {kind: sql, resource_key|database_url_env_var, query}
                                        #   {kind: csv, path}
                                        #   {kind: inline, rows}
```

The `sql` kind is **not actually warehouse-native** today — it still runs
`pd.read_sql(query, engine_or_conn)` into an in-process pandas DataFrame
(`_resolve_source_df`) before the sink writes it out. It's "skip needing a
prior Dagster asset," not "skip the DataFrame." The schema's own
`x-dagster-io.inputs.type` is hardcoded to `"dataframe"`, so the frontend
doesn't even know this escape hatch exists as a distinct mode — it falls
through to a raw `JSON.stringify` textarea in `ComponentConfigModal`
(no resource picker, no SQL editor, no detection of an already
warehouse-native upstream).

### Target design

Per the user's direction, three input modes — the same three-tier
connection resolution already built and tested twice this session
(`SqlJoinComponent._open_sql_session`, the community `warehouse_join`
fix, `SqlTransformerComponent._resolve_engine`):

1. **dataframe** — today's `upstream_asset_key` path. Unchanged.
2. **resource** — `resource_key: str` (+ `table` or `query`). Resolves via
   `.get_connection()` first (the common real case — e.g.
   `dagster_duckdb.DuckDBResource`, which has no `.get_engine()` at all,
   confirmed by direct introspection), falling back to `.get_engine()`/
   `.get_sqlalchemy_engine()` for resources that expose one.
3. **sqlalchemy** — `connection_url` / `connection_url_env_var`, for when
   there's no registered Dagster resource.

**Scope boundary — read this before implementing:** unlike Join/Transform,
"warehouse-native" for a *sink* cannot mean "stays in the warehouse, zero
data movement" — the entire point of a reverse-ETL sink is to push rows to
an external, non-warehouse system (Google Sheets, HubSpot, ...). So modes
2 and 3 above still end up materializing rows in-process (most likely
still via `pd.read_sql` or equivalent) before handing them to the sink's
own write API. What they add is: no DataFrame-producing Dagster asset
has to exist upstream, and the connection is resolved through the same
resource/URL conventions as everywhere else, rather than requiring the
user to hand-configure a `source: {kind: sql, ...}` JSON blob. Don't let
later work drift into promising true zero-data-movement for sinks — it's
a contradiction in terms here.

### Work breakdown

- **Shared helper, once** (community-templates repo): extract the
  dataframe/resource/sqlalchemy resolution into one reusable function
  (mirroring `_open_sql_session`/`_SqlSession` from `sql_join.py`), used by
  all 28 components instead of copy-pasted per-component logic.
- **Schema fixes**: `x-dagster-io.inputs.type` needs to advertise the real
  shape (dataframe OR resource-backed), not a hardcoded `"dataframe"`.
- **Frontend**: a real config step for the `source` field — resource
  picker (reuse `availableResourceKeys`, already computed in
  `ComponentConfigModal.tsx`), connection_url/env-var inputs, a SQL query
  editor — replacing the current raw-JSON-textarea fallback. Mirrors the
  config UX already built for Join/Transform's resource-native paths.
- **Pilot before rollout**: do Google Sheets first (end-to-end, including
  the frontend config step), verify with a real resource-backed write
  (not mocked), then roll the same pattern out across the other 27 — don't
  touch all 28 component.py files before the pattern is proven once.

---

## Suggested execution order

1. Part 1 / Phase 1 (lowest risk, no component Python changes, directly
   extends what's already shipped today).
2. Part 2 pilot (Google Sheets only) — proves the resource/sqlalchemy
   resolution pattern for a sink, which is a different shape (write, not
   read) than anything built so far this session.
3. Part 1 / Phase 2 (PropertyPanel, asset-selector input, dbt migration).
4. Part 2 rollout to the remaining 27 reverse-ETL components, using
   whatever the pilot validated.
5. Part 1 / Phase 3 (optional cleanup) — revisit only if still a pain
   point by then.

## Cross-cutting: pre-flight `dg` validation + rollback (shipped 2026-10-02)

Separate from the plan above, but born from the same work: the user raised
a direct concern -- Dagster's definitions loading is all-or-nothing, so
even one small mistake (anywhere in a project) breaks loading of
*everything*, not just the thing being edited. Confirmed repeatedly this
session (the Bulls project crash from stale lineage data being the
starkest example). Built a general-purpose fix rather than one-off patches:

- `AssetIntrospectionService.validate_project_defs_async(project)` --
  reuses the EXISTING `dg list defs` runner (same one normal asset
  introspection already calls), clearing the cache first so it can't
  return a stale pre-change result. Returns `(True, None)` on success,
  `(False, error_tail)` on failure. Skips validation (returns `True`) if
  the project has no `.venv` yet rather than blocking on unrelated state.
- Wired into the three riskiest write paths with real rollback (not just
  detection) on failure:
  1. `set_post_processing_rules` -- the new rules feature, free-text
     selector with zero syntax validation otherwise.
  2. `update_component_instance_attributes` -- used by Dagster AI
     ("Genie")'s automated edit flow.
  3. `configure_component` (`/templates/configure/{id}`) -- the PRIMARY
     save path for every community component instance, used by
     `ComponentConfigModal` directly and by all ~18 AI/ML config-step
     wizards built earlier this session. This one previously detected
     breakage (`assets_regenerated`/`regenerate_error`) but left the
     broken `defs.yaml` on disk regardless -- "saved, but Dagster
     couldn't load it... fix and re-save" left the WHOLE PROJECT
     unloadable in the meantime. Now reverts the file (deletes it if it
     was a brand-new instance) and skips the `project.components` update
     too, so a rejected save leaves no trace instead of a half-applied one.

Verified directly, twice, against the real Bulls project (not a synthetic
one): a bad connection-adjacent field type on a real `FileListerComponent`
instance was correctly rejected and the file restored byte-for-byte; a
malformed `tag:` selector was NOT caught (Dagster's selector parser
degrades gracefully for unparseable strings rather than erroring -- fine,
no crash either way), while a typo'd attribute field name WAS caught
(Pydantic validation error, clean revert). Also separately verified, per
the user's direct question: a bad *connection URL* (wrong host/credentials)
is a fundamentally different, already-safe failure class -- confirmed
`dg list defs` never attempts a real connection at load time at all; a bad
URL only fails at materialize time, as a normal single-asset run failure,
not a whole-project crash. No pre-flight check needed or possible for that
class.

Not yet covered by this pattern: `add_custom_lineage` /
`set_asset_field_overrides` (lower risk -- both already validate literal
asset keys against the real graph before writing, and have no free-text
field the way rules/component-attributes do) and the ~17 other AI/ML
wizard call sites' frontend messaging (they'll all correctly show a
generic "not regenerated" error via the same `assets_regenerated` check
`configure_component` already returns, just not the more specific "reverted
automatically" wording `ComponentConfigModal.tsx` now has).

## Part 2 validation pass (2026-10-02) -- closes Part 2 fully

Audited all 42 reverse_etl community components (the catalog has grown
from 33 since the original pilot -- other contributors actively adding
more) against the frontend `source` field editor built earlier: does each
one's `schema.json` actually expose the `source` field the way its real
`component.py` implements it?

Found 3 real gaps: `hubspot_object_upsert`, `salesforce_record_upsert`,
`shopify_product_upsert` had the FULL resource/sqlalchemy `source` input
mode already implemented in Python (field, `_resolve_source_df` helper,
mutual-exclusivity check) -- but `schema.json` was never updated to
expose it. Since Designer's config UI reads `schema.json`, not
`component.py`, directly, these 3 components' `source` field was
literally invisible in the UI despite being fully functional underneath.
Also found `upstream_asset_key` was still marked `required: true` in
these 3, stale from before `source` existed as an alternative.

7 more had the field correctly typed but undocumented (no description).
Fixed those too while in there.

Verified via the repo's own `make validate-manifest` (imports every
component + calls `build_defs`, 1218 components repo-wide): exit 0,
confirming the schema.json-only edits didn't affect anything runtime
(expected -- schema.json is a Designer/manifest artifact, never imported
by the component's own Python).

Committed and pushed (`f658a29d`). Combined with the schema-driven
frontend editor (not per-component, so it needed no changes), **all 42
reverse_etl components now correctly expose dataframe/resource/sqlalchemy
input in Designer's UI**. Part 2 is fully closed, not just "effectively
free" as the pilot entry above characterized it.

- **Full dbt `translation` migration (shipped)**: backend got a `kinds`
  field added to `AssetFieldOverrides` (`backend/app/models/project.py`),
  `_write_post_processing_defs_yaml`, `AssetFieldOverridesRequest`, and
  the `set_asset_field_overrides` endpoint -- confirmed directly via a
  real `uv run` Dagster load that `kinds` via post_processing REPLACES
  (not merges) existing kind tags, so any caller must seed from the
  asset's current kinds, not start blank. Frontend `api.ts` and
  `types/index.ts` updated to match. 110 backend tests passing
  (added `test_field_overrides_include_kinds`).

  With that in place, rewrote both of the independently-duplicated
  per-asset dbt customization flows to use the same unified
  `asset_field_overrides` mechanism non-dbt assets already used:

  - `AssetDetailPage.tsx`'s `DefinitionSection`: replaced the
    find-or-create-a-`DbtProjectComponent`-with-`select:<model>` dbt
    branch AND the confirmed-100%-dead `translation.by_key[assetKey]`
    non-dbt branch with one `projectsApi.setAssetFieldOverrides(...)`
    call. `editable` no longer requires a resolvable `sourceComponent`
    (the new mechanism only needs a real asset key). Seeding now prefers
    `project.asset_field_overrides[assetKey]` over stale `node.data`.
  - `PropertyPanel.tsx`'s `handleSaveMetadata`: deleted the entire
    `isDbtAsset && hasCustomizations` branch (the same split-component
    dance, independently reimplemented here); both dbt and non-dbt assets
    now converge on the single `setAssetFieldOverrides` call the
    non-dbt branch already used correctly.

  Net effect: no more N+1 component sprawl for N customized dbt models,
  no more dead writes, and dbt/non-dbt assets are edited identically
  everywhere in the app. Typecheck clean, 106 frontend + 110 backend
  tests passing.

- **Unrelated but adjacent bug found and fixed: `dg` silently drops field
  descriptions in the config modal.** A user configuring
  ChargebeeIngestionComponent saw hints on the first few fields
  (asset_name/site/api_key) and nothing on the rest (resources/
  destination/...). Root-caused via a REAL `dg utils inspect-component`
  call against the user's own real Bulls project (not a guess): `dg`
  drops `description` for EVERY field that has a `default` value --
  confirmed this is NOT specific to the `--defs-yaml-json-schema` flag
  Designer uses; `--defs-yaml-schema` (the "LLM-optimized" format) has
  the exact same gap, and `--scaffold-params-schema`/
  `--defs-yaml-example-values` carry no descriptions at all regardless of
  required/optional. This is a genuine upstream `dg`/Dagster bug (worth
  filing against dagster-io/dagster), not missing component metadata --
  both the real Python source and the community catalog's schema.json
  have full descriptions for every field, confirmed directly.
  Fixed in `backend/app/api/components.py`: `_get_component_schema_via_dg`
  now backfills any field `dg` left without a description from the
  component's own installed `schema.json` (unaffected by the bug, since
  it's read straight off disk, never through `dg`'s schema
  introspection). Along the way, fixed a second, real latent bug this
  surfaced in the backfill's own directory resolution: an imported
  project's actual importable module name (pyproject.toml's
  `root_module`) can differ entirely from Designer's own `directory_name`
  slug (confirmed live: `chicago_bulls_analytics` vs. directory_name
  `project_91204b8f_bulls` for the Bulls project) -- now resolved via the
  existing `get_project_root_module` helper instead of assuming
  `src/<directory_name>/`. 5 new tests
  (`test_component_schema_description_backfill.py`), 115 backend tests
  passing total.

  Confirmed the underlying `dg` bug is NOT fixed upstream as of the
  latest release: re-ran the exact repro against a from-scratch venv with
  `dagster==1.13.24`/`dagster-dg-cli==1.13.24` (current latest) and a
  brand-new, dependency-free 3-field component -- still reproduces
  identically. Also precisely isolated the trigger: it's the presence of
  `default=` on the field, NOT `Optional` typing -- confirmed with a
  plain (non-Optional) `str` field that has a literal default and still
  loses its description, both in the minimal repro and in chargebee's
  real `retry_policy_backoff` field. Filing upstream against
  dagster-io/dagster; Designer's own backfill fix stands regardless of
  when/whether that lands.

- **Reverse-ETL config-modal UX pass (shipped)**: user feedback
  (BrazeSinkComponent) that `source`/`upstream_asset_key`/`resource_key`/
  `api_key_env_var`/`rest_endpoint` all rendered as unrelated plain
  fields with only prose descriptions to explain the mutual-exclusivity
  between them -- "not sure we are building the modals for these to be
  usable by real humans." Scoped to: unify the universal input-source
  toggle, AND upgrade `resource_key` to a real picker with inline
  creation (the fuller of two options offered, not just the toggle-only
  minimal version).
  - `ComponentConfigModal.tsx`'s `source` special-case renderer (kind:
    sql/csv/inline dropdown, built earlier this project) now has a 4th
    option, `upstream_asset`, unifying it with the sibling
    `upstream_asset_key` field -- confirmed via a repo-wide sweep that
    ~60/60 reverse_etl catalog components share this exact pair, so this
    is safe to key purely off field names, no per-component config
    needed. `upstream_asset_key` is claimed out of the generic field loop
    (same mechanism already used for `x-dagster-destination-fields`'
    related_env_var_field) so it only ever renders inside the unified
    picker. Picking any mode clears the other field entirely (component
    `build_defs` raises if both or neither are set) -- confirmed this
    full-replace-not-merge behavior already existed for sql/csv/inline
    switching, extended it to the new 4th option.
  - A NEW top-level-`resource_key` special case (distinct from the
    `source.resource_key` sub-field inside the SQL mode, which already
    had a datalist): a real `<select>` of every resource_key already
    registered by a resource-category component instance in the project
    (`availableResourceKeys`, which already existed and generalizes
    correctly -- no changes needed there), plus a "+ Create new resource"
    button.
  - "Create new resource" opens a two-step flow: pick a resource type
    from the community catalog's `category: 'resource'` templates (NOT
    Designer's built-in component registry, which has no idea community
    resources like BrazeResourceComponent exist -- confirmed via
    `communityTemplatesApi.manifest()`, the same manifest the Library/
    catalog browsing already fetches), then a RECURSIVELY NESTED
    `ComponentConfigModal` pointed at that type. Confirmed via a
    dedicated research pass that `ComponentConfigModal` is a plain fixed
    div, not a Radix Dialog, so nesting has no portal/focus-trap
    conflict -- just needs a higher z-index.
  - New `onInstanceCreated` prop on `ComponentConfigModal`, fired right
    after a successful community-component save (configure POST +
    regenerate both succeeded), before `onClose()` -- the one piece of
    plumbing that genuinely didn't exist: community-component saves never
    call the existing `onSave` (that's the built-in-component branch
    only), so there was no way for a caller to learn what was just
    created. The outer modal's callback reads the new instance's
    `resource_key` attribute back out and writes it into the field that
    triggered creation via the existing `handleFieldChange`.
  - Fixed a real, separate latent gap this surfaced: a brand-new
    component instance's `formData` starts at `{}` (or `initialAttributes`),
    never seeded from the schema's own declared defaults -- invisible for
    most fields (the component's Python-side default just applies at
    runtime), but breaks a caller that needs to read a just-saved
    attribute back immediately, like this one reading back the new
    resource's `resource_key`. Added a narrow, additive effect that seeds
    documented schema defaults into formData once the schema loads for a
    new instance, without clobbering anything the user already typed --
    doesn't touch the existing (and much larger) effect that seeds
    formData for an EXISTING component being edited.
  - Typecheck clean, 106 frontend + 115 backend tests passing (no backend
    changes this pass, confirmed no regressions).

- **Found and fixed a real logic bug in the `source`/`resource_key`
  pickers just shipped above**: both ended up nested INSIDE the
  pre-existing `if (fieldType === 'array') { ... }` block (the 'sinks'
  array-of-objects special case sits there) instead of as siblings of
  it -- since `source` is `'object'`-typed and `resource_key` is
  `'string'`-typed, that outer condition is always false for them, so
  both were 100% dead code, silently falling through to the old plain
  textarea/text-input rendering. Took a long live debugging session
  (ruled out Tauri/Cargo build caching, WebKit's per-app on-disk cache,
  Launch Services resolving `open -a` to the wrong of 26+ stray mounted
  DMG copies, and a stale backend process a `pkill` pattern never
  matched) before browser console logging pinpointed the real cause.
  Moved both to top-level `if` statements (verified via `tsc`/vitest).
  Also found and fixed two follow-on UX issues surfaced once the picker
  actually rendered: (1) resource_key's own component (e.g.
  BrazeResourceComponent) was ALSO getting the "pick/create a resource"
  treatment for its *own* resource_key field, which is a self-registration
  key, not a reference -- gated the picker on `!isResourceComponentType`
  (class name containing "resource"); (2) the SQL-mode `source.resource_key`
  and the top-level destination `resource_key` both rendered as bare
  "resource_key", confusing when both show at once -- relabeled to
  "Warehouse resource" / "Destination resource", and upgraded the
  warehouse one to the same real picker + "Create new resource" flow
  (required generalizing `creatingResourceForField: string | null` to
  `creatingResourceCallback: ((key: string) => void) | null` so either
  call site can wire the result back into wherever its value actually
  lives -- handleFieldChange for the top-level field, updateSource for
  the nested one).

- **Ingestion `destination` field: picker + structured credentials,
  rolled out catalog-wide (shipped)**: user noticed chargebee_ingestion's
  `destination` field was a plain text box despite the description
  listing valid dlt destination identifiers in prose, and separately
  remembered seeing a "pick a destination, see its real fields" UI
  somewhere. Root cause for both, confirmed by surveying all 128
  ingestion components' schema.json: the `enum` annotation on
  `destination` (renders it as `<select>` via the ALREADY-existing
  generic enum-dropdown renderer, no frontend changes needed) and the
  `x-dagster-destination-fields` structured-credentials annotation on
  `destination_credentials_url` (renders per-destination-type fields +
  assembles a connection string, built earlier this project) were BOTH
  present on only 26 of 128 components, all byte-identical content --
  an unfinished catalog-wide rollout, not a bug. Patched all 128 (26
  original + 102 gaining it for the first time) with the same canonical
  `enum`/`ui:widget: select` and verified-against-dlthub-docs structured
  fields for snowflake/postgres (already proven) plus redshift/
  clickhouse/mssql/motherduck (newly verified -- all genuinely fit the
  existing "fields + URI template" mechanism) and bigquery (verified
  dlt's `GcpServiceAccountCredentials` accepts a raw service-account JSON
  string as its native value, so the EXISTING `credentials=<string>`
  component code already supports it -- needed a NEW frontend render
  mode, `credential_format: json_blob`, a single textarea bound straight
  to the target field with no string-template assembly, since the
  existing field-by-field + `encodeURIComponent` assembly would corrupt
  a private key's real embedded newlines/quotes).

  Explicitly NOT attempted: databricks, athena, filesystem (S3/GCS/
  Azure). Verified each needs a bucket_url/staging destination as a
  SEPARATE argument to `dlt.pipeline(...)` -- a real gap in all 128
  components' own Python (`_resolve_destination` only ever passes one
  `credentials=` string to one destination factory, no staging/bucket_url
  field exists anywhere in any of them), not a schema.json gap a frontend
  fix can paper over. User explicitly chose (via AskUserQuestion) to ship
  BigQuery now and scope this separately rather than rush component.py
  changes across the whole catalog. **Next step, not started**: design +
  implement a `destination_bucket_url` (or similarly named) field on the
  ingestion component base pattern, wire it into each component's
  `dlt.pipeline(..., staging=dlt.destinations.filesystem(bucket_url=...,
  credentials=...))` call for databricks/athena, and a bucket_url+creds
  pair for filesystem itself as a destination in its own right. Real
  Python changes across ~128 files -- scope carefully, verify dlt's
  staging semantics per-provider (S3 vs GCS vs Azure have different
  credential shapes) before touching any component.py.

  All three commits pushed to the community-templates repo (`b49d467`,
  `b2f54a9`, `5f47c29`, `27e3883`). Real installed copies in the user's
  own Bulls project (chargebee_ingestion, braze_ingestion) patched to
  match and verified live via direct API calls against the running dev
  backend, same reasoning as every other "installed copy is a stale
  snapshot" fix this session.

- **"Next step, not started" above: now done, both sides (2026-10-11)**.
  The Python half (bucket_url/staging wiring for databricks/athena/
  filesystem) turned out to have already shipped since this doc was
  written -- confirmed directly against the community-templates repo:
  149 ingestion components now have a real `bucket_url` field
  (`component.py`'s `_resolve_destination_with_bucket`/`_resolve_staging`),
  verified via a real dlt run writing to local filesystem. Designer's own
  frontend gap was real and still open, though: `bucket_url`/
  `athena_query_result_bucket` had no annotation telling the modal they're
  conditional on `destination`, so they rendered as generic always-visible
  text boxes.
  - Added two new, generic schema.json annotations (community-templates
    commit `328afe2b`, all 149 components): `x-dagster-visible-when`
    (`{field, values}` -- only render while the named field matches) and
    `x-dagster-label-by` (`{field, labels}` -- swap the displayed label per
    value; bucket_url means something genuinely different per destination,
    final write target vs. staging area).
  - Wired into `ComponentConfigModal.tsx` (this repo, commit `f16d2e4`):
    extracted as pure, unit-tested helpers in new `src/lib/fieldVisibility.ts`
    (9 tests) rather than inline in the modal, matching this codebase's own
    convention. Confirmed `bucket_url`/`athena_query_result_bucket` land in
    `mainEntries`, not a collapsible `GENERIC_FIELD_GROUPS` group, so an
    invisible field just renders `null` -- no empty-accordion edge case to
    handle. tsc clean, 115 frontend tests passing (106 existing + 9 new).
  - Also found and fixed, while verifying the Python side: a stray local
    `.venv` in the community-templates repo root was being walked by both
    `tools/check_component_registry.py` and `generate_manifest.py`
    (neither excluded common venv dir names), producing mass false-positive
    "missing" reports from installed package copies under site-packages.
    Hardened both tools' `EXCLUDE_TOP` against this recurring.
