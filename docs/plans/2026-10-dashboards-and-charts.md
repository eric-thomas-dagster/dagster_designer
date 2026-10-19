# Plan: Dashboards / Charts integration

Status: researched 2026-10-02, not yet scoped into an implementation plan.

## The ask

A "Dashboards" or "Charts" nav item / capability in Designer. Explicitly
**not** a substitute for the existing "Insights" tab — Insights (Dagster+
only) covers operational metrics about the *pipelines themselves* (usage,
cost, reliability). This is about visualizing the *data the pipelines
produce* — business-facing charts/dashboards over warehouse tables, not
pipeline health.

## Research findings (real research, not assumption)

### dbt Charts
- Dagster-Labs-unaffiliated "dashboards-as-code" product, Public Beta
  (dbt Summit 2026). Dashboards defined as plain YAML, markets itself as
  "BI unbundled."
- **No embed SDK/iframe** — hosted app (dbtcharts.com) + shareable links
  only; a destination today, not embeddable in Designer.
- **No public API** for programmatic chart CRUD yet. YAML files + an
  open-source CLI are the programmatic surface.
- **VCS artifact**: yes, by design — dashboards are YAML meant to live in
  the git repo, diffable in PRs.
- **Dagster integration**: none found.
- Confirmed the original guess: does **not** require dbt itself or a dbt
  Cloud subscription — docs explicitly allow raw SQL against the
  warehouse directly. Free tier exists (3 collaborators, unlimited
  queries); paid tier still being priced.
- **Read today as**: watch, not build on — no embed surface or API yet.

### Apache Superset
- Mature Apache open-source BI tool (also sold hosted as "Preset").
- **Embeddable**: yes, strongest of the four — official
  `@superset-ui/embedded-sdk`, iframe + guest-token auth, documented
  (SIP-75), production-proven elsewhere.
- **API**: yes, full REST API (`/api/v1/...`) for charts/dashboards/datasets.
- **VCS artifact**: yes — `/api/v1/dashboard/export` and
  `/api/v1/assets/export` produce importable YAML bundles ("assets as
  code" is an established Superset workflow).
- **Dagster integration**: none official — would be a custom build.
- **Pricing**: fully open source/self-hosted, zero gate on embed or API —
  only cost is hosting/ops.

### Omni
- Modern BI (fast ad-hoc exploration + governed semantic model). Named
  Dagster Labs **partner**.
- **Embeddable**: yes — official `@omni-co/embed` SDK, signed-URL iframe
  embedding of dashboards/workbooks/AI chat.
- **API**: yes — REST API covering documents/dashboards, semantic models,
  connections, users; a "Documents v2" API to create/import dashboards.
- **VCS artifact**: partial — the semantic *model* layer (topics/views) is
  plain YAML with native git integration (branch mode, PRs, API). Individual
  dashboard documents can be exported/imported via API, but git-native
  versioning is centered on the model layer, not confirmed complete for
  every dashboard visual/layout element.
- **Dagster integration**: **official and active** — `dagster-omni`
  PyPI package / `OmniComponent` represents Omni documents as Dagster
  assets with lineage to upstream data (releases through Aug 2026).
- **Pricing**: fully sales-gated/enterprise, no public self-serve tier to
  test embed/API against. The existing official component is a real head
  start vs. the others.

### Sigma
- Cloud-native, spreadsheet-style BI querying the warehouse directly.
  Named Dagster Labs **partner and customer**.
- **Embeddable**: yes — native Embed API (`POST /v2/workbooks/{id}/embeds`),
  JWT-based, embeds full workbook/page/single element; mature, purpose-built.
- **API**: yes — REST API v2 (connections, workbooks, teams), plus a
  newer "Workbooks-as-Code" API (**private beta**) returning a full
  workbook definition as YAML.
- **VCS artifact**: emerging, not finished — Workbooks-as-Code can export
  to YAML for git diff/review, but write-back today only works for the
  simplest workbooks (single table, no joins); essentially one-way/partial,
  still private beta.
- **Dagster integration**: **official and GA** — `dagster-sigma` package
  represents Sigma workbooks/datasets as Dagster assets with lineage;
  Dagster has published a blog post on this partnership.
- **Pricing gate**: Sigma explicitly calls secure embedding "a premium
  feature requiring sales engagement," and external embed users are
  billed on a **separate price book** from internal seats — API is public,
  real embed access is commercially gated.

## Bottom line for prioritization

- **Superset**: only one with zero pricing gate and a fully mature
  embed+API+YAML story; no existing Dagster work to build on.
- **Omni & Sigma**: both already have official, GA-ish `dagster-*`
  components (real head start on the Dagster-asset-lineage side), both
  have strong embed SDKs/APIs, but both are enterprise-priced/sales-gated
  for embedding specifically, and neither has a fully mature git-native
  dashboard-*definition* story (Omni: model-layer only; Sigma: private
  beta, partial write-back).
- **dbt Charts**: best git/YAML story by design, but no embed surface or
  public API yet (beta-stage product) — watch, not build on, today.

## Open questions for the real scoping pass

- Given Omni/Sigma already have official `dagster-omni`/`dagster-sigma`
  components (asset representation + lineage), does "integrate dashboards
  into Designer" mean (a) surface those EXISTING components' assets
  properly in the graph (lower lift, re-uses official work), (b) actually
  EMBED the dashboard UI inside Designer via their embed SDKs (bigger
  lift, hits the commercial embed-access gate), or (c) both?
  "Insights isn't sufficient" might already be partially answered by (a)
  alone, worth checking before assuming (b) is required.
- If embedding is the goal, the Omni/Sigma commercial embed gate means
  this can't be a feature available to every Designer user out of the box
  — likely needs its own "bring your own Omni/Sigma account + embed
  entitlement" story, not a bundled capability.
- Superset is the only path with no commercial gate at all — worth asking
  whether a from-scratch (no official Dagster tie-in yet) Superset
  integration is preferred over a partner-aligned but commercially-gated
  Omni/Sigma one, given the partner/customer relationships are a real
  signal but embedding specifically is gated regardless of the
  relationship.

## Decision (2026-10-02): not pursuing

Closed, won't build. dbt Charts is confirmed unusable today (no embed
SDK, no public API, beta-stage hosted app only). A native in-Designer
charting feature was considered as the fallback (query + chart picker,
no third-party BI dependency) but rejected: it would have zero to do
with Dagster itself and use no Dagster code or concepts -- a
general-purpose BI feature bolted onto a Dagster-specific tool, not a
Dagster integration. Embedding Superset/Omni/Sigma remains the only
path that stays Dagster-relevant (via lineage/asset representation,
`dagster-omni`/`dagster-sigma`), but nobody has asked for that
specifically -- this whole thread is shelved, not just deprioritized.
