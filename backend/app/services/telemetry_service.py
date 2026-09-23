"""Designer's own usage telemetry -- piggybacked entirely on Dagster OSS's
existing, already-shipped telemetry pipeline (dagster_shared.telemetry),
not a new vendor or a new collection endpoint.

Why reuse instead of building our own:
  * Same anonymized per-machine instance_id Dagster itself already
    generates at ~/.dagster/.telemetry/id.yaml (or $DAGSTER_HOME) --
    Designer never overrides DAGSTER_HOME for the `dg dev` subprocesses
    it manages, so this id is already stable across every project on a
    given machine.
  * Same local batching/upload machinery (dagster._core.telemetry_upload)
    -- events queue at ~/.dagster/logs/ and ship hourly (or at 10MB) to
    telemetry.dagster.io, which is Dagster Labs' own endpoint.
  * Same opt-out surface users may already know about: a `dagster.yaml`
    with `telemetry: {enabled: false}`, or DAGSTER_DISABLE_TELEMETRY.
    Anyone who's opted OSS Dagster out of telemetry is automatically
    opted out of Designer's own events too, with zero extra code here.

Backwards compatibility: this module only ever ADDS new `action` names
(all prefixed `designer_`) and new metadata keys. It never touches
TelemetryEntry's schema, never reuses/collides with any of Dagster's own
action names (start_dagit_webserver, scheduled_run_created, ...), and
never modifies dagster/dagster_shared source -- purely additive calls
against their existing public functions.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def log_designer_action(action: str, metadata: Optional[dict[str, Any]] = None) -> None:
    """Fire a Designer-specific telemetry event through Dagster's own
    telemetry pipeline. Best-effort and silent on failure -- telemetry
    must never be able to break or slow down the app. `action` should be
    prefixed `designer_` to stay clearly namespaced apart from Dagster's
    own action names. `metadata` values are coerced to strings to match
    TelemetryEntry's schema; keep them to booleans/counts/enums, never
    anything identifying (names, paths, URLs, tokens)."""
    try:
        from dagster_shared.telemetry import (
            TelemetrySettings,
            get_or_set_instance_id,
            get_telemetry_enabled_from_dagster_yaml,
            log_telemetry_action,
        )
    except ImportError:
        logger.debug("dagster_shared.telemetry not installed -- skipping designer telemetry")
        return

    def _settings() -> "TelemetrySettings":
        enabled = get_telemetry_enabled_from_dagster_yaml()
        instance_id = get_or_set_instance_id() if enabled else None
        return TelemetrySettings(
            dagster_telemetry_enabled=enabled,
            instance_id=instance_id,
            run_storage_id=None,
        )

    try:
        log_telemetry_action(
            _settings,
            action,
            metadata={k: str(v) for k, v in (metadata or {}).items()},
        )
    except Exception as e:
        logger.debug(f"designer telemetry action {action!r} failed (non-fatal): {e}")


class _TelemetryUploader:
    """Thin wrapper around dagster._core.telemetry_upload's own
    uploading_logging_thread context manager (the same one dagster-daemon
    uses), held open for the life of the backend process so queued
    events -- ours and any dg dev subprocess's, since they share the
    same ~/.dagster/logs/ -- actually get shipped instead of just
    accumulating on disk. Started/stopped explicitly (not via `with`)
    since it needs to span FastAPI's startup/shutdown hooks rather than
    a single block."""

    def __init__(self) -> None:
        self._ctx = None

    def start(self) -> None:
        try:
            from dagster._core.telemetry_upload import uploading_logging_thread
        except ImportError:
            logger.debug("dagster telemetry_upload not installed -- not starting uploader")
            return
        try:
            self._ctx = uploading_logging_thread()
            self._ctx.__enter__()
        except Exception as e:
            logger.debug(f"failed to start designer telemetry uploader (non-fatal): {e}")
            self._ctx = None

    def stop(self) -> None:
        if self._ctx is None:
            return
        try:
            self._ctx.__exit__(None, None, None)
        except Exception:
            pass
        self._ctx = None


telemetry_uploader = _TelemetryUploader()
