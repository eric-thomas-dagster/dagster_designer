from types import SimpleNamespace
from unittest.mock import patch

from app.services import project_service as ps


def test_install_without_preexisting_status_entry_does_not_keyerror(tmp_path):
    svc = ps.ProjectService.__new__(ps.ProjectService)
    project = SimpleNamespace(id="pid-xyz", directory_name="d", is_imported=True)
    ps._dependency_status.pop("pid-xyz", None)
    with patch.object(ps.ProjectService, "_get_project_dir", lambda self, p: tmp_path):
        try:
            svc._install_dependencies_with_uv(project)
        except KeyError as e:
            raise AssertionError(f"KeyError {e}")
        except Exception:
            pass  # anything else (no pyproject, no uv...) is irrelevant to this regression
    assert "pid-xyz" in ps._dependency_status
