import asyncio
from types import SimpleNamespace

from app.api import templates_registry as T


def test_installs_for_one_project_never_overlap_but_other_projects_are_independent(monkeypatch):
    active = {"p1": 0, "p2": 0}
    peak = {"p1": 0, "p2": 0}

    async def fake_impl(component_id, request):
        pid = request.project_id
        # the real implementation takes the CLI lock (`_install_lock_for`) while holding the endpoint lock -- exercise that
        # nesting, which is exactly what once deadlocked every install
        async with T._install_lock_for(pid):
            await asyncio.sleep(0)
        active[pid] += 1
        peak[pid] = max(peak[pid], active[pid])
        await asyncio.sleep(0.02)
        active[pid] -= 1
        return {"ok": component_id}

    monkeypatch.setattr(T, "_install_component_via_cli_locked", fake_impl)
    T._install_locks.clear()
    T._install_endpoint_locks.clear()

    async def go():
        reqs = [SimpleNamespace(project_id="p1") for _ in range(5)] + [SimpleNamespace(project_id="p2") for _ in range(3)]
        return await asyncio.gather(*(T.install_component_via_cli("openai_agent", r) for r in reqs))

    out = asyncio.run(asyncio.wait_for(go(), timeout=10))   # a deadlock fails here instead of hanging the suite
    assert len(out) == 8 and peak == {"p1": 1, "p2": 1}
