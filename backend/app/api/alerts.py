"""Alert policies API.

Alerts in Dagster are authored as YAML and consumed by Dagster+ via
`dg api alert-policy sync <path>`. Only Dagster+ deployments actually
fire the alerts -- OSS Dagster ignores them -- but we let anyone
author the YAML locally so it's committed and version-controlled
alongside the rest of the pipeline.

Design decisions:
  * ONE canonical file per project. Default path is `alert_policies.yaml`
    at the project root, override-able via `project.alerts_relative_path`.
    Users can also point at an existing file elsewhere in the tree.
  * We read + write the whole file (list of policies) rather than
    per-policy YAMLs so `dg api alert-policy sync` gets exactly what
    we're showing in the UI. No drift between local + cloud.
  * Sync is destructive on the cloud side -- `dg api alert-policy sync`
    replaces the ENTIRE policy set on the Dagster+ deployment. Pull is
    a straight read of what Dagster+ has right now.

Ref: https://docs.dagster.io/guides/observe/alerts/yaml-reference
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core.uv_binary import venv_bin_path
from ..services.project_service import project_service
from ..services.dagster_plus_client import (
    query as dagster_plus_query,
    query as dp_query,
    ALERT_POLICIES_QUERY,
    ALERT_POLICIES_DOCUMENT_QUERY,
    CUSTOM_METRICS_LIST_QUERY,
    CREATE_CUSTOM_METRIC_MUTATION,
    CREATE_OR_UPDATE_ALERT_POLICY_MUTATION,
    DELETE_ALERT_POLICY_MUTATION,
    SET_ALERT_POLICY_MUTE_MUTATION,
    DagsterPlusError,
)


router = APIRouter(prefix="/projects", tags=["alerts"])


# ---------------------------------------------------------------------------
# Model -- one Pydantic class per policy type, plus a common wrapper.
# Kept intentionally permissive: the Dagster schema allows fields we may
# not know about yet (esp. under `notification_service`), so extra keys
# on any type pass through via `extra_config`.
# ---------------------------------------------------------------------------


PolicyType = Literal[
    "asset",
    "run",
    "code_location",
    "automation",
    "agent_downtime",
    "insight_metric",
]


class NotificationEmail(BaseModel):
    email_addresses: list[str]


class NotificationSlack(BaseModel):
    slack_workspace_name: str | None = None
    slack_channel_name: str


class NotificationMSTeams(BaseModel):
    ms_teams_webhook_url: str


class NotificationPagerDuty(BaseModel):
    integration_key: str


class NotificationWebhook(BaseModel):
    url: str
    headers: dict[str, str] | None = None


class NotificationService(BaseModel):
    """Wrapper -- exactly one of these fields is populated per policy.
    Matches Dagster's YAML shape: `notification_service.email` etc."""
    email: NotificationEmail | None = None
    slack: NotificationSlack | None = None
    ms_teams: NotificationMSTeams | None = None
    pagerduty: NotificationPagerDuty | None = None
    webhook: NotificationWebhook | None = None


class AssetPolicyConfig(BaseModel):
    """Asset-scoped alerts. Targets can be `all`, asset keys, or asset
    groups; events specify which conditions fire the alert."""
    asset_selection: str | list[str] | None = None   # e.g. "*", "group:analytics/*", ["orders_augmented"]
    asset_group: str | None = None                    # legacy alias for a single group
    events: list[str] = Field(default_factory=list)   # materialization_success | materialization_failure | asset_check_failed | asset_check_severity | freshness_slo_violation
    tags: dict[str, str] | None = None


class RunPolicyConfig(BaseModel):
    """Run-scoped alerts. Fires on job run terminal states + optional
    time-limit-exceeded event."""
    events: list[str] = Field(default_factory=list)   # run_success | run_failure | run_time_limit_exceeded
    tags: dict[str, str] | None = None                # match runs carrying these tags
    time_limit_seconds: int | None = None             # for run_time_limit_exceeded


class CodeLocationPolicyConfig(BaseModel):
    """Fires when a code location fails to load. No config besides an
    empty stub -- Dagster picks up load failures automatically."""
    pass


class AutomationPolicyConfig(BaseModel):
    """Fires on schedule / sensor tick failure."""
    events: list[str] = Field(default_factory=list)   # tick_failure | tick_success (rare)
    include_schedules: bool = True
    include_sensors: bool = True


class AgentDowntimePolicyConfig(BaseModel):
    """Hybrid-only. Fires when an agent hasn't heartbeated within the
    configured window (default 5 minutes on Dagster+ side)."""
    pass


class InsightMetricPolicyConfig(BaseModel):
    """Fires when a metric limit is exceeded across the org."""
    metric: str                                        # e.g. "dagster_credits", "compute_duration_ms"
    threshold: float | None = None
    comparison: str | None = None                      # gt | gte | lt | lte


class AlertPolicy(BaseModel):
    name: str                                          # snake_case identifier
    description: str | None = None
    enabled: bool = True
    type: PolicyType
    # Only ONE of the below is populated per instance -- the wizard
    # picks based on `type`. Others stay None.
    asset: AssetPolicyConfig | None = None
    run: RunPolicyConfig | None = None
    code_location: CodeLocationPolicyConfig | None = None
    automation: AutomationPolicyConfig | None = None
    agent_downtime: AgentDowntimePolicyConfig | None = None
    insight_metric: InsightMetricPolicyConfig | None = None
    notification_service: NotificationService = Field(default_factory=NotificationService)
    # Fallback for fields the wizard doesn't know about yet -- lets
    # advanced users hand-edit the YAML without us stomping their config.
    extra_config: dict[str, Any] | None = None


class AlertsFile(BaseModel):
    path: str                     # relative path to the YAML file
    policies: list[AlertPolicy] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Cloud (Dagster+) alert policies -- fetched live via GraphQL, editable
# through Dagster+'s own document-based mutation rather than round-tripped
# through the local AlertPolicy model above.
#
# Deliberately a SEPARATE, simpler shape from AlertPolicy: Dagster+'s
# alertPolicies query returns `eventTypes` (a list, e.g.
# ["ASSET_HEALTH_WARNING", "ASSET_HEALTH_DEGRADED"]) and `alertTargets` (a
# list of typed targets), neither of which maps cleanly onto the local YAML
# schema's single `type` enum + one populated type-specific sub-object.
# `document` carries the policy's full config in the exact shape
# createOrUpdateAlertPolicyFromDocument expects back -- editing means
# handing that same dict back, tweaked, rather than reconstructing it field
# by field into a different model.
# ---------------------------------------------------------------------------


class CloudAlertPolicy(BaseModel):
    id: str
    name: str
    description: str = ""
    enabled: bool = True
    event_types: list[str] = Field(default_factory=list)
    notification_type: str | None = None   # humanized, e.g. "Slack: #hooli-alerts"
    target_types: list[str] = Field(default_factory=list)
    source: str | None = None
    # Policies defined in the user's Python code (source="CODE") can't be
    # edited or deleted here -- Dagster+ itself rejects that with
    # CodeBackedAlertPolicyError. Surfaced so the UI can disable those
    # actions instead of letting the user hit a confusing API error.
    is_code_backed: bool = False
    muted_until: float | None = None   # unix timestamp; None means not muted
    document: dict[str, Any] | None = None


class CloudAlertsFile(BaseModel):
    path: str = "Dagster+"
    policies: list[CloudAlertPolicy] = Field(default_factory=list)
    is_cloud: bool = True


class SaveCloudAlertRequest(BaseModel):
    # The full per-policy document (see CloudAlertPolicy.document) -- for a
    # new policy, the caller builds this from scratch; for an edit, it's
    # the existing document with fields changed.
    document: dict[str, Any]


class MuteCloudAlertRequest(BaseModel):
    # None/omitted un-mutes (Dagster+ semantics: muteForSeconds omitted or
    # null clears any existing mute).
    mute_for_seconds: int | None = None


DEFAULT_ALERTS_FILENAME = "alert_policies.yaml"


def _find_alerts_path(project_dir: Path) -> Path:
    """Locate the project's alerts YAML file. Convention is
    `alert_policies.yaml` at the project root -- we check a few common
    spots (root, `alerts/`, `defs/alerts/`) and return the first hit,
    falling back to the default root path when nothing exists yet."""
    candidates = [
        project_dir / DEFAULT_ALERTS_FILENAME,
        project_dir / "alerts.yaml",
        project_dir / "alerts" / "alert_policies.yaml",
        project_dir / "defs" / "alerts" / "alert_policies.yaml",
    ]
    for c in candidates:
        if c.exists():
            return c
    return project_dir / DEFAULT_ALERTS_FILENAME


def _read_alerts_file(path: Path) -> list[dict]:
    """Return the raw policies list from a YAML file. The Dagster
    convention supports both `alert_policies:` at the top level and a
    bare list; accept either."""
    if not path.exists():
        return []
    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse {path}: {e}")
    if isinstance(raw, list):
        return raw
    return (raw.get("alert_policies") or [])


def _write_alerts_file(path: Path, policies: list[AlertPolicy]) -> None:
    """Persist policies to the YAML file. Wraps them under
    `alert_policies:` so the file is directly consumable by
    `dg api alert-policy sync`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"alert_policies": [_policy_to_yaml_dict(p) for p in policies]}
    with open(path, "w") as f:
        yaml.safe_dump(payload, f, sort_keys=False, default_flow_style=False)


def _policy_to_yaml_dict(p: AlertPolicy) -> dict:
    """Serialize a policy back to the YAML shape Dagster expects.
    Drops unset config sub-objects; merges extra_config at the top level."""
    out: dict[str, Any] = {
        "name": p.name,
        "type": p.type,
    }
    if p.description:
        out["description"] = p.description
    if not p.enabled:
        out["enabled"] = False
    # Type-specific config -- unwrap so YAML doesn't nest under `asset:`.
    cfg_field_map: dict[str, Any] = {
        "asset": p.asset,
        "run": p.run,
        "code_location": p.code_location,
        "automation": p.automation,
        "agent_downtime": p.agent_downtime,
        "insight_metric": p.insight_metric,
    }
    cfg = cfg_field_map.get(p.type)
    if cfg is not None:
        cfg_dict = cfg.model_dump(exclude_none=True)
        if cfg_dict:
            out[p.type] = cfg_dict
    # Notifications -- only include the populated sub-service.
    notif = p.notification_service.model_dump(exclude_none=True)
    if notif:
        out["notification_service"] = notif
    if p.extra_config:
        out.update(p.extra_config)
    return out


def _policy_from_yaml_dict(d: dict) -> AlertPolicy:
    """Parse a policy from YAML. Absorbs unknown fields into
    extra_config so hand-edited YAML isn't dropped on round-trip."""
    known = {"name", "description", "enabled", "type",
             "asset", "run", "code_location", "automation",
             "agent_downtime", "insight_metric", "notification_service"}
    extra = {k: v for k, v in d.items() if k not in known}
    p_type = d.get("type") or "asset"
    kwargs: dict[str, Any] = {
        "name": d.get("name") or "unnamed_policy",
        "description": d.get("description"),
        "enabled": d.get("enabled", True),
        "type": p_type,
        "extra_config": extra or None,
    }
    if "notification_service" in d:
        kwargs["notification_service"] = NotificationService(**(d["notification_service"] or {}))
    if p_type == "asset":
        kwargs["asset"] = AssetPolicyConfig(**(d.get("asset") or {}))
    elif p_type == "run":
        kwargs["run"] = RunPolicyConfig(**(d.get("run") or {}))
    elif p_type == "code_location":
        kwargs["code_location"] = CodeLocationPolicyConfig(**(d.get("code_location") or {}))
    elif p_type == "automation":
        kwargs["automation"] = AutomationPolicyConfig(**(d.get("automation") or {}))
    elif p_type == "agent_downtime":
        kwargs["agent_downtime"] = AgentDowntimePolicyConfig(**(d.get("agent_downtime") or {}))
    elif p_type == "insight_metric":
        kwargs["insight_metric"] = InsightMetricPolicyConfig(**(d.get("insight_metric") or {}))
    return AlertPolicy(**kwargs)


def _humanize_typename(typename: str | None, suffix: str) -> str | None:
    """"SlackAlertPolicyNotification" -> "Slack", "AssetSelectionViewTarget"
    -> "Asset Selection View" -- strips the GraphQL type's boilerplate
    suffix and CamelCase-splits whatever's left."""
    if not typename:
        return None
    name = typename[: -len(suffix)] if typename.endswith(suffix) else typename
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name) or typename


def _notification_summary(doc_policy: dict) -> str | None:
    """Richer than the __typename-only humanizer above -- e.g. "Slack:
    #hooli-alerts" instead of just "Slack", pulled from the document's own
    nested notification_service (whichever single channel key is set)."""
    svc = (doc_policy.get("notification_service") or {})
    if "slack" in svc:
        ch = (svc["slack"] or {}).get("slack_channel_name")
        return f"Slack: #{ch}" if ch else "Slack"
    if "email" in svc:
        addrs = (svc["email"] or {}).get("email_addresses") or []
        return f"Email: {', '.join(addrs)}" if addrs else "Email"
    if "ms_teams" in svc or "microsoft_teams" in svc:
        return "Microsoft Teams"
    if "pagerduty" in svc:
        return "PagerDuty"
    if "webhook" in svc:
        return "Webhook"
    return None


def _dagster_plus_creds(project) -> tuple[str, str, str, str]:
    return (
        project.dagster_plus_org or "",
        project.dagster_plus_deployment or "",
        project.dagster_plus_token or "",
        project.dagster_plus_region,
    )


async def _list_cloud_alerts(project) -> CloudAlertsFile:
    """Live Dagster+ alert policies for a connected cloud project. Fetches
    both the structured list (has `id`, needed for mute/delete, and
    `source`, needed to know which policies are code-backed and therefore
    not editable here) and the per-policy document form (richer display
    data, and the exact shape editing hands back)."""
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        structured = await dagster_plus_query(org, deployment, token, ALERT_POLICIES_QUERY, region=region)
        doc_result = await dagster_plus_query(org, deployment, token, ALERT_POLICIES_DOCUMENT_QUERY, region=region)
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch alert policies from Dagster+: {e}")
    doc_wrapper = doc_result.get("alertPoliciesAsDocumentOrError") or {}
    if doc_wrapper.get("__typename") != "AlertPoliciesAsDocument":
        raise HTTPException(status_code=502, detail=doc_wrapper.get("message") or "Dagster+ returned an unexpected response for alert policies.")
    docs_by_name = {d.get("name"): d for d in (doc_wrapper.get("document") or {}).get("alert_policies", [])}

    policies = []
    for p in (structured.get("alertPolicies") or []):
        name = p.get("name", "")
        doc = docs_by_name.get(name)
        policies.append(CloudAlertPolicy(
            id=p.get("id", ""),
            name=name,
            description=p.get("description") or "",
            enabled=bool(p.get("enabled", True)),
            event_types=list(p.get("eventTypes") or []),
            notification_type=(_notification_summary(doc) if doc else None) or _humanize_typename(
                (p.get("notificationService") or {}).get("__typename"), "AlertPolicyNotification"
            ),
            target_types=[
                _humanize_typename(t.get("__typename"), "Target") or "Unknown"
                for t in (p.get("alertTargets") or [])
            ],
            source=p.get("source"),
            is_code_backed=p.get("source") == "CODE",
            muted_until=p.get("mutedUntil"),
            document=doc,
        ))
    return CloudAlertsFile(policies=policies)


async def _save_cloud_alert(project, document: dict) -> CloudAlertPolicy:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, CREATE_OR_UPDATE_ALERT_POLICY_MUTATION, variables={"document": document},
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to save alert policy: {e}")
    result = data.get("createOrUpdateAlertPolicyFromDocument") or {}
    typename = result.get("__typename")
    if typename == "AlertPolicy":
        return CloudAlertPolicy(id=result.get("id", ""), name=result.get("name", ""), document=document)
    if typename == "CodeBackedAlertPolicyError":
        raise HTTPException(status_code=400, detail=f"\"{result.get('alertPolicyName')}\" is defined in code and can't be edited here.")
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to save alert policy.")


async def _delete_cloud_alert(project, name: str) -> None:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, DELETE_ALERT_POLICY_MUTATION, variables={"name": name},
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to delete alert policy: {e}")
    result = data.get("deleteAlertPolicy") or {}
    typename = result.get("__typename")
    if typename == "DeleteAlertPolicySuccess":
        return
    if typename == "CodeBackedAlertPolicyError":
        raise HTTPException(status_code=400, detail=f"\"{result.get('alertPolicyName')}\" is defined in code and can't be deleted here.")
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to delete alert policy.")


async def _mute_cloud_alert(project, alert_id: str, mute_for_seconds: int | None) -> CloudAlertPolicy:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, SET_ALERT_POLICY_MUTE_MUTATION,
            variables={"id": alert_id, "seconds": mute_for_seconds},
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to update mute state: {e}")
    result = data.get("setAlertPolicyMuteUntil") or {}
    if result.get("__typename") == "AlertPolicy":
        return CloudAlertPolicy(id=result.get("id", ""), name="")
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to update mute state.")


# ---------------------------------------------------------------------------
# Dagster+ GraphQL -> AlertPolicy translation
# ---------------------------------------------------------------------------


def _policies_from_graphql(data: dict[str, Any]) -> list[AlertPolicy]:
    """Parse Dagster+'s `alertPolicies` list into our AlertPolicy shape.
    Dagster+ discriminates policy type via the `alertTargets` union
    (there's no explicit `type` field) -- e.g. an AssetKeyTarget means
    an asset alert, RunResultTarget means run, and so on. Anything
    unrecognized is preserved raw in `extra_config` so a re-save round
    trips it."""
    results = data.get("alertPolicies") or []
    out: list[AlertPolicy] = []
    # Which alert-target types map to which of our PolicyType buckets.
    # Insight / metric-monitor / credit-limit targets all roll up to
    # `insight_metric`; scheduler-related targets to `automation`; etc.
    target_type_bucket: dict[str, PolicyType] = {
        "AssetGroupTarget": "asset",
        "AssetKeyTarget": "asset",
        "AssetSelectionTarget": "asset",
        "AssetSelectionViewTarget": "asset",
        "FavoritesSelectionViewTarget": "asset",
        "RunResultTarget": "run",
        "LongRunningJobThresholdTarget": "run",
        "CodeLocationTarget": "code_location",
        "ScheduleSensorTarget": "automation",
        "InsightsDeploymentThresholdTarget": "insight_metric",
        "InsightsAssetGroupThresholdTarget": "insight_metric",
        "InsightsAssetThresholdTarget": "insight_metric",
        "InsightsJobThresholdTarget": "insight_metric",
        "MetricMonitorAssetSelectionThresholdTarget": "insight_metric",
        "MetricMonitorFavoritesThresholdTarget": "insight_metric",
        "MetricMonitorAssetSelectionViewThresholdTarget": "insight_metric",
        "CreditLimitTarget": "insight_metric",
    }

    for r in results:
        targets = r.get("alertTargets") or []
        target_typenames = [(t or {}).get("__typename") for t in targets if t]
        events = [str(e) for e in (r.get("eventTypes") or []) if e]

        # Infer bucket from the first recognized target, then override
        # with AGENT_UNAVAILABLE if the event set says so (agent alerts
        # ship without a target).
        policy_type: PolicyType = "run"
        for tn in target_typenames:
            if tn in target_type_bucket:
                policy_type = target_type_bucket[tn]
                break
        if "AGENT_UNAVAILABLE" in events:
            policy_type = "agent_downtime"

        # ---- Notification service ---------------------------------
        ns_raw = r.get("notificationService") or {}
        ns = NotificationService()
        ns_tn = ns_raw.get("__typename")
        if ns_tn == "EmailAlertPolicyNotification":
            ns.email = NotificationEmail(email_addresses=ns_raw.get("emailAddresses") or [])
        elif ns_tn == "EmailOwnersAlertPolicyNotification":
            ns.email = NotificationEmail(email_addresses=ns_raw.get("defaultEmailAddresses") or [])
        elif ns_tn == "SlackAlertPolicyNotification":
            ns.slack = NotificationSlack(
                slack_channel_name=ns_raw.get("slackChannelName") or "",
                slack_workspace_name=ns_raw.get("slackWorkspaceName"),
            )
        elif ns_tn == "MicrosoftTeamsAlertPolicyNotification":
            ns.ms_teams = NotificationMSTeams(ms_teams_webhook_url=ns_raw.get("webhookUrl") or "")
        elif ns_tn == "PagerdutyAlertPolicyNotification":
            ns.pagerduty = NotificationPagerDuty(integration_key=ns_raw.get("integrationKey") or "")
        elif ns_tn == "WebhookAlertPolicyNotification":
            ns.webhook = NotificationWebhook(url=ns_raw.get("webhookUrl") or "")

        # ---- Per-type config --------------------------------------
        tags_list = r.get("tags") or []
        tags_dict: dict[str, str] = {t.get("key"): t.get("value") for t in tags_list if t.get("key")}

        asset_cfg = None
        run_cfg = None
        code_loc_cfg = None
        auto_cfg = None
        agent_cfg = None
        insight_cfg = None

        if policy_type == "asset":
            asset_keys: list[str] = []
            asset_groups: list[str] = []
            selection_str: str | None = None
            for t in targets:
                tn = (t or {}).get("__typename")
                if tn == "AssetKeyTarget":
                    p = ((t.get("assetKey") or {}).get("path")) or []
                    if p:
                        asset_keys.append("/".join(p))
                elif tn == "AssetGroupTarget":
                    g = t.get("assetGroup")
                    if g:
                        asset_groups.append(g)
                elif tn == "AssetSelectionTarget":
                    selection_str = t.get("assetSelectionString") or selection_str
            if selection_str:
                selection: str | list[str] | None = selection_str
            elif asset_groups and not asset_keys:
                selection = [f"group:{g}" for g in asset_groups]
            elif asset_keys:
                selection = asset_keys
            else:
                selection = "*"
            asset_cfg = AssetPolicyConfig(
                asset_selection=selection,
                events=events,
                tags=tags_dict or None,
            )
        elif policy_type == "run":
            # RunResultTarget / LongRunningJobThresholdTarget carry the
            # scoping info (tags, code locations, jobs). Collapse into
            # our RunPolicyConfig -- we keep tags dict + surface a time
            # limit when it's a long-running-job policy.
            time_limit = None
            for t in targets:
                if (t or {}).get("__typename") == "LongRunningJobThresholdTarget":
                    time_limit = t.get("thresholdSeconds")
                if isinstance(t.get("tags"), list):
                    for tt in t["tags"]:
                        if tt and tt.get("key"):
                            tags_dict.setdefault(tt["key"], tt.get("value") or "")
            run_cfg = RunPolicyConfig(
                events=events,
                tags=tags_dict or None,
                time_limit_seconds=time_limit,
            )
        elif policy_type == "code_location":
            code_loc_cfg = CodeLocationPolicyConfig()
        elif policy_type == "automation":
            # types: list of "SCHEDULE" / "SENSOR" (or both)
            included = set()
            for t in targets:
                if (t or {}).get("__typename") == "ScheduleSensorTarget":
                    for x in (t.get("types") or []):
                        included.add((x or "").upper())
            auto_cfg = AutomationPolicyConfig(
                events=events,
                include_schedules="SCHEDULE" in included or not included,
                include_sensors="SENSOR" in included or not included,
            )
        elif policy_type == "agent_downtime":
            agent_cfg = AgentDowntimePolicyConfig()
        elif policy_type == "insight_metric":
            metric = ""
            threshold = None
            comparison = None
            for t in targets:
                if (t or {}).get("metricName"):
                    metric = t.get("metricName") or ""
                    threshold = t.get("threshold")
                    comparison = t.get("operator")
                    break
            insight_cfg = InsightMetricPolicyConfig(
                metric=metric,
                threshold=threshold,
                comparison=(comparison or "").lower() or None,
            )

        # Preserve the raw target list + policyOptions in extra_config
        # so a future re-save doesn't quietly drop scoping info we don't
        # yet model in the wizard (long-running-job specifics, insight
        # metrics detail, favorites-view metric monitors, etc.).
        extra: dict[str, Any] = {}
        if targets:
            extra["raw_alert_targets"] = targets
        if r.get("policyOptions"):
            extra["policy_options"] = r["policyOptions"]

        out.append(AlertPolicy(
            name=r.get("name") or "",
            description=r.get("description") or None,
            enabled=bool(r.get("enabled", True)),
            type=policy_type,
            asset=asset_cfg,
            run=run_cfg,
            code_location=code_loc_cfg,
            automation=auto_cfg,
            agent_downtime=agent_cfg,
            insight_metric=insight_cfg,
            notification_service=ns,
            extra_config=extra or None,
        ))
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{project_id}/alerts", response_model=AlertsFile | CloudAlertsFile)
async def list_alerts(project_id: str):
    """Return all alert policies for the project. Local projects read
    whatever YAML file exists (or reports the default path if none exists
    yet); Dagster+ (cloud) projects fetch the live policy list via
    GraphQL -- editable via the /alerts/cloud/* endpoints below rather than
    this same PUT/DELETE pair, since Dagster+'s edit surface takes a
    differently-shaped document than the local YAML model."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        return await _list_cloud_alerts(project)
    project_dir = project_service._get_project_dir(project)
    path = _find_alerts_path(project_dir)
    try:
        raw = _read_alerts_file(path)
        policies = [_policy_from_yaml_dict(d) for d in raw]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load alerts: {e}")
    try:
        rel = path.relative_to(project_dir).as_posix()
    except ValueError:
        rel = str(path)
    return AlertsFile(path=rel, policies=policies)


def _require_cloud_project(project_id: str):
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="This project isn't a Dagster+ connection.")
    return project


@router.post("/{project_id}/alerts/cloud", response_model=CloudAlertsFile)
async def save_cloud_alert(project_id: str, request: SaveCloudAlertRequest):
    """Create or update a Dagster+ alert policy from its document form
    (see CloudAlertPolicy.document) -- Dagster+ itself decides create vs.
    update from whether `name` in the document matches an existing policy.
    Returns the full refreshed list so the UI stays in sync with whatever
    Dagster+ actually stored (which may differ slightly from what was
    sent, e.g. normalized fields)."""
    project = _require_cloud_project(project_id)
    await _save_cloud_alert(project, request.document)
    return await _list_cloud_alerts(project)


@router.delete("/{project_id}/alerts/cloud/{name}", response_model=CloudAlertsFile)
async def delete_cloud_alert(project_id: str, name: str):
    project = _require_cloud_project(project_id)
    await _delete_cloud_alert(project, name)
    return await _list_cloud_alerts(project)


@router.post("/{project_id}/alerts/cloud/{alert_id}/mute", response_model=CloudAlertsFile)
async def mute_cloud_alert(project_id: str, alert_id: str, request: MuteCloudAlertRequest):
    """mute_for_seconds omitted/null un-mutes (Dagster+'s own semantics)."""
    project = _require_cloud_project(project_id)
    await _mute_cloud_alert(project, alert_id, request.mute_for_seconds)
    return await _list_cloud_alerts(project)


class SaveAlertsRequest(BaseModel):
    policies: list[AlertPolicy]


@router.put("/{project_id}/alerts", response_model=AlertsFile)
async def save_alerts(project_id: str, request: SaveAlertsRequest):
    """Overwrite the alerts YAML file with the given policy list.
    Idempotent -- the endpoint always writes the full set, so the wizard
    can just POST the current state after any edit / add / delete."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="Cloud projects have no local YAML file to write. Use sync-to-cloud instead.")
    # Guard against duplicate names -- dg would reject this on sync.
    names = [p.name for p in request.policies]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise HTTPException(status_code=400, detail=f"Duplicate policy names: {', '.join(sorted(dupes))}")
    project_dir = project_service._get_project_dir(project)
    path = _find_alerts_path(project_dir)
    try:
        _write_alerts_file(path, request.policies)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write alerts: {e}")
    try:
        rel = path.relative_to(project_dir).as_posix()
    except ValueError:
        rel = str(path)
    return AlertsFile(path=rel, policies=request.policies)


@router.delete("/{project_id}/alerts/{name}", response_model=AlertsFile)
async def delete_alert(project_id: str, name: str):
    """Remove one alert policy by name. Rewrites the YAML in place."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="Cloud projects have no local alerts file.")
    project_dir = project_service._get_project_dir(project)
    path = _find_alerts_path(project_dir)
    raw = _read_alerts_file(path)
    policies = [_policy_from_yaml_dict(d) for d in raw]
    policies = [p for p in policies if p.name != name]
    _write_alerts_file(path, policies)
    try:
        rel = path.relative_to(project_dir).as_posix()
    except ValueError:
        rel = str(path)
    return AlertsFile(path=rel, policies=policies)


# ---- YAML preview (client wants to see what will be written) ----------


class YamlPreviewResponse(BaseModel):
    yaml: str


@router.post("/{project_id}/alerts/preview", response_model=YamlPreviewResponse)
async def preview_alerts_yaml(project_id: str, request: SaveAlertsRequest):
    """Return the YAML string that would be written for the given
    policy list. Doesn't touch disk; drives the review-step of the
    wizard."""
    payload = {"alert_policies": [_policy_to_yaml_dict(p) for p in request.policies]}
    return YamlPreviewResponse(yaml=yaml.safe_dump(payload, sort_keys=False, default_flow_style=False))


# ---- Cloud sync -- push (destructive) + pull -------------------------


class SyncPushRequest(BaseModel):
    """Optional overrides. Default: sync whatever's in the current
    alerts file. Can also pass explicit policies for a dry-run flow."""
    confirmed: bool = False   # required "yes I understand it overwrites Dagster+ alerts" gate


class SyncResponse(BaseModel):
    success: bool
    detail: str
    policies_pushed: int = 0
    stdout: str | None = None
    stderr: str | None = None


@router.post("/{project_id}/alerts/sync-to-cloud", response_model=SyncResponse)
async def sync_alerts_to_cloud(project_id: str, request: SyncPushRequest):
    """Push the local alerts YAML to Dagster+ via
    `dg api alert-policy sync`.
    THIS IS DESTRUCTIVE. Dagster+ replaces the org's entire alert set
    with what's in the file. There's only one canonical policy set per
    deployment; the sync has no merge / diff semantics.
    Requires `confirmed=true` to actually run."""
    if not request.confirmed:
        raise HTTPException(status_code=400, detail="Sync overwrites all Dagster+ alerts. Set confirmed=true to proceed.")
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="Sync operates on local projects that push to a Dagster+ deployment; open the local project (not the cloud connection) to sync.")
    project_dir = project_service._get_project_dir(project)
    path = _find_alerts_path(project_dir)
    if not path.exists():
        raise HTTPException(status_code=400, detail=f"No alerts file at {path}. Create at least one policy first.")

    # Shell out to `dg api alert-policy sync <path>`. Uses the project's
    # venv so dg picks up its `dagster-cloud` config (org, deployment,
    # token) from the workspace. Errors bubble up in stderr.
    venv_dg = venv_bin_path(project_dir / ".venv", "dg")
    cmd_bin = str(venv_dg) if venv_dg.exists() else "dg"
    try:
        proc = subprocess.run(
            [cmd_bin, "api", "alert-policy", "sync", str(path)],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return SyncResponse(success=False, detail="Sync timed out after 120s.")
    except FileNotFoundError:
        return SyncResponse(success=False, detail=f"`dg` CLI not found. Install it or ensure {venv_dg} exists.")
    if proc.returncode != 0:
        return SyncResponse(
            success=False,
            detail=f"`dg api alert-policy sync` exited {proc.returncode}",
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    raw = _read_alerts_file(path)
    return SyncResponse(
        success=True,
        detail=f"Synced {len(raw)} policy(ies) from {path.name} to Dagster+.",
        policies_pushed=len(raw),
        stdout=proc.stdout,
        stderr=proc.stderr,
    )


@router.post("/{project_id}/alerts/sync-from-cloud", response_model=AlertsFile)
async def sync_alerts_from_cloud(project_id: str):
    """Pull the current Dagster+ alert set into the local YAML.
    Overwrites the local file. Uses `dg api alert-policy list` and
    writes the result to the canonical alerts path.

    Note: as of Dagster 1.x, `dg api alert-policy list` returns JSON.
    If your dg build doesn't ship the `list` subcommand, this returns
    a helpful error rather than silently doing nothing."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="Open the local project (not the cloud connection) to pull alerts into the repo.")
    project_dir = project_service._get_project_dir(project)
    venv_dg = venv_bin_path(project_dir / ".venv", "dg")
    cmd_bin = str(venv_dg) if venv_dg.exists() else "dg"
    try:
        proc = subprocess.run(
            [cmd_bin, "api", "alert-policy", "list", "--output=json"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="`dg api alert-policy list` timed out.")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"`dg` CLI not found at {venv_dg} or on PATH.")
    if proc.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=(
                f"`dg api alert-policy list` failed: {proc.stderr.strip() or proc.stdout.strip() or 'no output'}. "
                "If your dg build doesn't support `list`, use the Dagster+ UI to export and paste into the YAML manually."
            ),
        )
    try:
        parsed = json.loads(proc.stdout or "[]")
    except Exception:
        raise HTTPException(status_code=502, detail=f"Couldn't parse dg output as JSON: {proc.stdout[:400]}")
    # Accept either a bare list or a wrapper dict.
    if isinstance(parsed, dict):
        raw = parsed.get("alert_policies") or parsed.get("policies") or []
    else:
        raw = parsed
    policies = [_policy_from_yaml_dict(d) for d in raw]
    path = _find_alerts_path(project_dir)
    _write_alerts_file(path, policies)
    try:
        rel = path.relative_to(project_dir).as_posix()
    except ValueError:
        rel = str(path)
    return AlertsFile(path=rel, policies=policies)


# ---------------------------------------------------------------------------
# Custom metrics (Dagster+ only)
# ---------------------------------------------------------------------------


class CustomMetric(BaseModel):
    """One custom-metric definition on a Dagster+ deployment. Metrics
    are the bridge between numeric metadata emitted on asset checks /
    materializations and threshold-based alerts -- the alert policy
    references the metric by id."""
    id: str
    metadata_key: str
    display_name: str | None = None
    description: str | None = None
    unit_type: str | None = None                    # ReportingUnitType enum name


class CustomMetricsListResponse(BaseModel):
    metrics: list[CustomMetric]


class EnsureMetricRequest(BaseModel):
    """Reuse-if-exists / create-if-missing for a custom metric keyed by
    `metadata_key`. Keeping the key as the natural identifier lets any
    asset emitting the same metadata label reuse the metric -- so users
    who care about `failed_row_count` see one row on Dagster+'s Insights,
    not one per asset."""
    metadata_key: str
    unit_type: str = "FLOAT"                        # BYTES | FLOAT | INTEGER | MILLISECONDS | SECONDS
    display_name: str | None = None
    description: str | None = None


def _custom_metric_from_gql(row: dict) -> CustomMetric:
    return CustomMetric(
        id=row.get("id") or "",
        metadata_key=row.get("metadataKey") or "",
        display_name=row.get("displayName"),
        description=row.get("description"),
        unit_type=row.get("unitType"),
    )


@router.get("/{project_id}/custom-metrics", response_model=CustomMetricsListResponse)
async def list_custom_metrics(project_id: str):
    """List all custom metrics defined on the Dagster+ deployment."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        # OSS Dagster doesn't have the custom-metrics concept.
        return CustomMetricsListResponse(metrics=[])
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            CUSTOM_METRICS_LIST_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))
    rows = data.get("customMetrics") or []
    return CustomMetricsListResponse(metrics=[_custom_metric_from_gql(r) for r in rows])


@router.post("/{project_id}/custom-metrics/ensure", response_model=CustomMetric)
async def ensure_custom_metric(project_id: str, request: EnsureMetricRequest):
    """Reuse-or-create by metadata_key. Metrics are keyed by their
    metadata label -- any asset check emitting that same metadata
    entry contributes to the metric, so we never want duplicates."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(
            status_code=400,
            detail="Custom metrics only exist on Dagster+ deployments.",
        )
    if not request.metadata_key.strip():
        raise HTTPException(status_code=400, detail="metadata_key is required.")

    # ---- Reuse first -----------------------------------------------
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            CUSTOM_METRICS_LIST_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))
    for row in (data.get("customMetrics") or []):
        if (row.get("metadataKey") or "").strip() == request.metadata_key.strip():
            return _custom_metric_from_gql(row)

    # ---- Create if missing ------------------------------------------
    valid_units = {"BYTES", "FLOAT", "INTEGER", "MILLISECONDS", "SECONDS"}
    unit = (request.unit_type or "FLOAT").upper()
    if unit not in valid_units:
        raise HTTPException(status_code=400, detail=f"unit_type must be one of {sorted(valid_units)}")
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            CREATE_CUSTOM_METRIC_MUTATION,
            variables={
                "customMetricInput": {
                    "metadataKey": request.metadata_key.strip(),
                    "displayName": request.display_name or request.metadata_key.strip(),
                    "description": request.description,
                    "unitType": unit,
                },
            },
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))
    node = data.get("createCustomMetric") or {}
    if node.get("__typename") != "CreateCustomMetricSuccess":
        raise HTTPException(status_code=502, detail=f"createCustomMetric returned {node.get('__typename')}: {node}")
    cm = node.get("customMetric") or {}
    return _custom_metric_from_gql(cm)


# ---------------------------------------------------------------------------
# Metric-threshold alert creation (Dagster+ only)
# ---------------------------------------------------------------------------


class MetricThresholdAlertRequest(BaseModel):
    """Create an alert that fires when a custom metric crosses a
    threshold on a specific asset. Mirrors what Dagster+'s "Threshold
    Alert" wizard produces server-side, but keyed off the metric's
    metadata_key (which we ensure via /custom-metrics/ensure)."""
    name: str                                          # policy name -- shown in Dagster+ list
    description: str | None = None
    metadata_key: str                                  # ties to a CustomMetric
    asset_key: str                                     # `foo/bar/baz` -- our slash-joined form
    threshold: float
    operator: str = "GREATER_THAN"                     # GREATER_THAN | LESS_THAN | GREATER_THAN_OR_EQUAL | LESS_THAN_OR_EQUAL
    lookback_window_hours: int = 24                    # window over which the aggregation runs
    aggregation: str = "MAX"                           # MAX | MIN | AVG | LATEST | SUM
    notify_emails: list[str] = Field(default_factory=list)
    notify_slack_channel: str | None = None
    notify_slack_workspace: str | None = None
    enabled: bool = True


class MetricThresholdAlertResponse(BaseModel):
    id: str
    name: str
    enabled: bool
    event_types: list[str] = Field(default_factory=list)


@router.post("/{project_id}/alerts/metric-threshold", response_model=MetricThresholdAlertResponse)
async def create_metric_threshold_alert(project_id: str, request: MetricThresholdAlertRequest):
    """Create (or update by name) a metric-threshold alert on a
    Dagster+ deployment. We serialize the policy as a YAML document
    and push it through `createOrUpdateAlertPolicyFromDocument` -- the
    same mutation Dagster+'s UI uses when saving an alert."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(
            status_code=400,
            detail=(
                "Metric-threshold alerts require Dagster+ (they compose Custom Metrics + "
                "the Insights alerting layer, neither of which exists in OSS Dagster)."
            ),
        )
    if not request.notify_emails and not request.notify_slack_channel:
        raise HTTPException(status_code=400, detail="Provide at least one notification target (email or slack).")

    # Build the notification block -- matches alert_policies.yaml.
    notification: dict = {}
    if request.notify_emails:
        notification["email"] = {"email_addresses": request.notify_emails}
    elif request.notify_slack_channel:
        notification["slack"] = {"slack_channel_name": request.notify_slack_channel}
        if request.notify_slack_workspace:
            notification["slack"]["slack_workspace_name"] = request.notify_slack_workspace

    # Assemble the alert policy document. Root-level fields (not
    # wrapped in `alert_policy`). Target is `insights_asset_threshold_target`
    # which scopes the alert to a specific (asset, metric) pair --
    # exactly the granularity we want ("alert me only when THIS check's
    # failed_row_count on THIS asset crosses X").
    document = {
        "name": request.name,
        "description": request.description or "",
        "enabled": request.enabled,
        "event_types": ["INSIGHTS_CONSUMPTION_EXCEEDED"],
        "notification_service": notification,
        "alert_targets": [
            {
                "insights_asset_threshold_target": {
                    "asset_key": request.asset_key.split("/"),
                    "metric_name": request.metadata_key,
                    "operator": request.operator,
                    "selection_period_days": max(1, request.lookback_window_hours // 24),
                    "threshold": request.threshold,
                },
            },
        ],
    }

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            CREATE_OR_UPDATE_ALERT_POLICY_MUTATION,
            # `document` is a GenericScalar (JSON object), not a
            # serialized string -- pass the dict straight through.
            variables={"document": document},
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))

    node = data.get("createOrUpdateAlertPolicyFromDocument") or {}
    tn = node.get("__typename")
    if tn in ("InvalidAlertPolicyError", "PythonError", "UnauthorizedError"):
        raise HTTPException(status_code=502, detail=node.get("message") or f"{tn} from Dagster+")
    if not node.get("id"):
        raise HTTPException(status_code=502, detail=f"Unexpected response: {node}")
    return MetricThresholdAlertResponse(
        id=node.get("id") or "",
        name=node.get("name") or request.name,
        enabled=bool(node.get("enabled", True)),
        event_types=list(node.get("eventTypes") or []),
    )
