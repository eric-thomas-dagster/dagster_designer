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
import subprocess
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.project_service import project_service


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


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{project_id}/alerts", response_model=AlertsFile)
async def list_alerts(project_id: str):
    """Return all alert policies for the project. Reads whatever YAML
    file exists (or reports the default path if none exists yet)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        # For cloud projects we don't have a local dir; return empty
        # + a pointer that the sync-from-cloud button should be used.
        return AlertsFile(path="(pull from Dagster+ via Sync)", policies=[])
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
    venv_dg = project_dir / ".venv" / "bin" / "dg"
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
    venv_dg = project_dir / ".venv" / "bin" / "dg"
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
