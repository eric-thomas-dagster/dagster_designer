import pytest


@pytest.fixture(autouse=True)
def _isolated_definitions_disk_cache(tmp_path, monkeypatch):
    """The saved-definitions cache must never carry a result from one test into another (or into a developer's real data dir)."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
