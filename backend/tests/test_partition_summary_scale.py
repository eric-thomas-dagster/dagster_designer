import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

from app.api import projects as P


def test_asset_absent_from_fresh_summary_is_unpartitioned_without_loading(monkeypatch, tmp_path):
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: SimpleNamespace(id=pid))
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    P._partition_info_cache.clear()
    P._partition_summary_cache["p"] = (time.time(), {"daily": SimpleNamespace()})
    # would spawn a whole-project load if it got past the summary shortcut
    monkeypatch.setattr(P.project_service, "get_project_root_module", lambda p: (_ for _ in ()).throw(AssertionError("loaded project")))
    r = asyncio.run(P.get_asset_partitions("p", "plain_asset"))
    assert r.is_partitioned is False and r.partitions_def is None and r.asset_key == "plain_asset"
