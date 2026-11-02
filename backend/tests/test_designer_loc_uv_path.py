"""The sandbox's `dagster-component add` shells out to a bare `uv`; a
GUI-launched app has no uv on PATH, so the bundled one must be added."""
from pathlib import Path
from unittest import mock

from app.services import designer_loc_service as svc


def test_component_add_gets_bundled_uv_on_path(tmp_path):
    state = mock.Mock()
    state.dir.return_value = tmp_path
    state.log = []
    fake_bin = tmp_path / "bundle-bin"
    fake_bin.mkdir()
    captured = {}

    def fake_run(cmd, **kw):
        captured["env"] = kw["env"]
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch("app.core.uv_binary._bundled_uv_dir", return_value=fake_bin), \
         mock.patch.object(svc.subprocess, "run", side_effect=fake_run):
        svc._run_dagster_component_add(state, "shopify_ingestion")

    assert captured["env"]["PATH"].split(":")[0] == str(fake_bin)
