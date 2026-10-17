"""UI smoke test: boot the real backend + frontend, import a tiny project, drive the main screens in a real browser.

It exists to catch the class of bug that unit tests can't: a page that crashes on open, an endpoint that 500s on a
real project, a tab that throws. It checks, in order:

  1. the API: import the fixture project, discover its assets, the fast project load, live status, partitions;
  2. the UI: open the project, graph renders, Catalog lists the assets, selecting one opens its panel,
     and every main tab opens without a page error;
  3. across all of it: no uncaught page errors, no HTTP 5xx, and none of the requests that are known to be
     wasteful for a local project (e.g. Dagster+ preview polling).

Run:   python e2e/smoke.py            (needs: uv, node + frontend deps, the backend's deps, `pip install playwright`)
Env:   SMOKE_BROWSER_CHANNEL=chrome   use the system Chrome instead of Playwright's bundled Chromium
       SMOKE_KEEP=1                   leave the temp data dir and logs in place
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
FIXTURE = ROOT / "e2e" / "fixture_project"
# The interpreter the backend runs under: its own venv when present (local dev), else whatever runs this script (CI).
_venv_py = BACKEND / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
BACKEND_PYTHON = os.environ.get("SMOKE_BACKEND_PYTHON") or (str(_venv_py) if _venv_py.exists() else sys.executable)

TABS = ["Monitors", "Runs", "Automation", "Code", "Resources", "Pipelines", "Alerts", "dbt", "Assets"]
ASSETS = ["raw_orders", "clean_orders", "order_totals", "lonely_asset"]
# Requests that must never be made for a local project (they 400 and just add noise / load).
FORBIDDEN_REQUESTS = ("/preview/status",)

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("  PASS  " if ok else "  FAIL  ") + what, flush=True)
    if not ok:
        failures.append(what)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 90) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=3)
            return True
        except urllib.error.HTTPError:
            return True  # it answered
        except Exception:
            time.sleep(0.5)
    return False


def api(base: str, method: str, path: str, body: dict | None = None, timeout: float = 600):
    req = urllib.request.Request(
        base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null"), time.time() - t
    except urllib.error.HTTPError as e:
        return e.code, None, time.time() - t


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="designer-smoke-"))
    (work / "data").mkdir()
    (work / "projects").mkdir()
    api_port, ui_port = free_port(), free_port()
    base = f"http://127.0.0.1:{api_port}/api/v1"
    env = {**os.environ, "DATA_DIR": str(work / "data"), "PROJECTS_DIR": str(work / "projects")}
    procs: list[subprocess.Popen] = []
    try:
        print(f"work dir {work}; api :{api_port}, ui :{ui_port}")
        backend_log = open(work / "backend.log", "w")
        procs.append(subprocess.Popen(
            [BACKEND_PYTHON, "-m", "uvicorn", "app.main:app", "--port", str(api_port)],
            cwd=BACKEND, env=env, stdout=backend_log, stderr=subprocess.STDOUT))
        frontend_log = open(work / "frontend.log", "w")
        npx = "npx.cmd" if os.name == "nt" else "npx"
        procs.append(subprocess.Popen(
            [npx, "vite", "--host", "127.0.0.1", "--port", str(ui_port), "--strictPort"], cwd=FRONTEND,
            env={**env, "DESIGNER_DEV_PORT": str(ui_port), "DESIGNER_API_TARGET": f"http://127.0.0.1:{api_port}"},
            stdout=frontend_log, stderr=subprocess.STDOUT))
        check(wait_http(f"{base}/projects/summary", 60), "backend starts")
        check(wait_http(f"http://127.0.0.1:{ui_port}/", 90), "frontend starts")
        if failures:
            return 1

        # ---- 1. API ----------------------------------------------------------------------------------------
        print("API")
        code, project, dt = api(base, "POST", "/projects/import", {"path": str(FIXTURE)})
        check(code == 201 and project, f"import the fixture project ({dt:.0f}s)")
        if not project:
            return 1
        pid = project["id"]
        code, regenerated, dt = api(base, "POST", f"/projects/{pid}/regenerate-assets")
        keys = sorted(n["data"].get("asset_key") for n in (regenerated or {}).get("graph", {}).get("nodes", []) if n.get("node_kind") == "asset")
        check(code == 200 and keys == sorted(ASSETS), f"discovers exactly the fixture's assets ({keys}) in {dt:.0f}s")
        code, _, dt = api(base, "GET", f"/projects/{pid}?live=false")
        check(code == 200 and dt < 2.0, f"project loads fast without live status ({dt*1000:.0f}ms)")
        code, live, _ = api(base, "GET", f"/projects/{pid}/asset-live-status")
        check(code == 200 and isinstance(live, dict) and "statuses" in live, "live status endpoint answers")
        code, _, _ = api(base, "GET", f"/projects/{pid}/partitions-summary")
        check(code == 200, "partitions summary answers")
        code, monitors, _ = api(base, "GET", f"/projects/{pid}/monitors")
        check(code == 200 and monitors is not None, "monitors answer")

        # ---- 2. UI ------------------------------------------------------------------------------------------
        print("UI")
        from playwright.sync_api import sync_playwright

        page_errors: list[str] = []
        bad_responses: list[str] = []
        forbidden_hits: list[str] = []
        with sync_playwright() as p:
            channel = os.environ.get("SMOKE_BROWSER_CHANNEL")
            browser = p.chromium.launch(headless=True, **({"channel": channel} if channel else {}))
            pg = browser.new_page(viewport={"width": 1600, "height": 1000})
            pg.set_default_timeout(30000)
            pg.on("pageerror", lambda e: page_errors.append(str(e)[:300]))

            def on_response(r):
                if "/api/v1/" not in r.url:
                    return
                path = r.url.split("/api/v1")[-1]
                if r.status >= 500:
                    bad_responses.append(f"{r.status} {path[:120]}")
                if any(f in path for f in FORBIDDEN_REQUESTS):
                    forbidden_hits.append(path[:120])
            pg.on("response", on_response)

            pg.goto(f"http://127.0.0.1:{ui_port}/")
            pg.wait_for_timeout(2500)
            pg.get_by_role("button", name="Project").click()
            pg.get_by_text("Open Project", exact=True).click()
            pg.wait_for_timeout(800)
            pg.get_by_text("smoke-fixture", exact=False).first.click()
            try:
                pg.wait_for_selector(".react-flow__node", timeout=30000)
                check(True, "graph renders nodes after opening the project")
            except Exception:
                check(False, "graph renders nodes after opening the project")

            pg.get_by_role("button", name="Catalog").click()
            pg.wait_for_timeout(1500)
            check(all(pg.get_by_text(a, exact=True).count() > 0 for a in ASSETS), "Catalog lists every asset")

            pg.get_by_text("raw_orders", exact=True).first.click()
            pg.wait_for_timeout(1500)
            check(pg.get_by_text("raw_orders").count() > 1, "selecting an asset opens its panel")

            for tab in TABS:
                loc = pg.get_by_text(tab, exact=True)
                if loc.count() == 0:
                    check(False, f"tab {tab} is present")
                    continue
                before = len(page_errors)
                loc.first.click()
                pg.wait_for_timeout(1500)
                check(len(page_errors) == before, f"tab {tab} opens without a page error")
            browser.close()

        check(not page_errors, f"no uncaught page errors {page_errors[:3] or ''}")
        check(not bad_responses, f"no HTTP 5xx responses {bad_responses[:5] or ''}")
        check(not forbidden_hits, f"no wasteful requests for a local project {forbidden_hits[:3] or ''}")
    finally:
        for pr in procs:
            try:
                import psutil
                kids = psutil.Process(pr.pid).children(recursive=True)
            except Exception:
                kids = []
            pr.terminate()
            for k in kids:
                try:
                    k.terminate()
                except Exception:
                    pass
        time.sleep(1)
        if failures and (work / "backend.log").exists():
            print("--- backend log (tail) ---")
            print("\n".join((work / "backend.log").read_text(errors="replace").splitlines()[-40:]))
        if not os.environ.get("SMOKE_KEEP"):
            shutil.rmtree(work, ignore_errors=True)

    print(f"\n{'FAILED' if failures else 'OK'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
