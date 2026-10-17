import asyncio
import time
from types import SimpleNamespace

from app.api import projects as P
from app.services import component_dependencies as cd


def test_post_returns_at_once_while_the_install_runs_in_the_background(monkeypatch, tmp_path):
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(cd, "used_component_ids", lambda d: {"agentic_pipeline"})
    started = {}

    def slow_ensure(d, ids):
        time.sleep(0.3)
        started["ids"] = ids
        return {"checked": sorted(ids), "installed": ["mcp>=1.0.0"], "failed": None}
    monkeypatch.setattr(cd, "ensure_dependencies", slow_ensure)
    P._dep_jobs.clear()

    async def go():
        t = time.time()
        first = await P.ensure_project_dependencies("p")
        quick = time.time() - t
        again = await P.ensure_project_dependencies("p")       # a second POST while running doesn't start another job
        assert (await P.ensure_project_dependencies_status("p"))["state"] == "running"
        await asyncio.sleep(0.6)
        return first, quick, again, await P.ensure_project_dependencies_status("p")

    first, quick, again, final = asyncio.run(go())
    assert first["state"] == "running" and quick < 0.1 and again["state"] == "running"
    assert final == {"state": "done", "result": {"checked": ["agentic_pipeline"], "installed": ["mcp>=1.0.0"], "failed": None}}


def test_a_crash_in_the_job_is_reported_not_left_running(monkeypatch, tmp_path):
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(cd, "used_component_ids", lambda d: (_ for _ in ()).throw(RuntimeError("boom")))
    P._dep_jobs.clear()

    async def go():
        await P.ensure_project_dependencies("p")
        await asyncio.sleep(0.2)
        return await P.ensure_project_dependencies_status("p")
    out = asyncio.run(go())
    assert out["state"] == "done" and "boom" in out["result"]["failed"]
