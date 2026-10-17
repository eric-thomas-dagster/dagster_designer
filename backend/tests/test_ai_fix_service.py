"""Safety-critical pieces of the AI fix feature: the CLI permission arguments,
and the snapshot -> diff -> undo cycle that makes an agent's edits reversible."""
import pytest

from app.services import ai_fix_service as svc


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.settings, "data_dir", tmp_path / "data")
    d = tmp_path / "proj"
    (d / "src/mod/defs/a").mkdir(parents=True)
    (d / "src/mod/defs/a/defs.yaml").write_text("type: x\nattributes:\n  n: 1\n")
    (d / "src/mod/defs/b.yaml").write_text("keep: me\n")
    (d / "pyproject.toml").write_text("[project]\nname='p'\n")
    (d / ".env").write_text("SECRET=1\n")  # never tracked
    (d / "data").mkdir()
    (d / "data/big.duckdb").write_bytes(b"\0" * 10)  # never tracked
    (d / "src/mod/__pycache__").mkdir()
    (d / "src/mod/__pycache__/x.pyc").write_bytes(b"\0")  # skipped
    return d


# ---- permissions -----------------------------------------------------------

def _args(mode):
    return svc.build_cli_args(mode, "PROMPT")


def _after(args, flag):
    i = args.index(flag) + 1
    out = []
    while i < len(args) and not args[i].startswith("--"):
        out.append(args[i]); i += 1
    return out


def test_fix_mode_never_allow_lists_edit_or_write():
    # Allow-listing Edit/Write let the agent write OUTSIDE the project folder
    # (verified against the real CLI); acceptEdits alone keeps it inside.
    a = _args("fix")
    assert _after(a, "--permission-mode") == ["acceptEdits"]
    allowed = _after(a, "--allowedTools")
    assert not {"Edit", "Write", "NotebookEdit"} & set(allowed)
    assert all(t.startswith(("Read", "Glob", "Grep", "Bash(dg ")) for t in allowed)


def test_explain_mode_is_read_only():
    a = _args("explain")
    assert _after(a, "--permission-mode") == ["dontAsk"]
    assert {"Edit", "Write", "NotebookEdit"} <= set(_after(a, "--disallowedTools"))


@pytest.mark.parametrize("mode", ["explain", "fix"])
def test_env_files_and_shell_are_locked_down(mode):
    a = _args(mode)
    denied = set(_after(a, "--disallowedTools"))
    assert {"Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)"} <= denied
    assert not [t for t in _after(a, "--allowedTools") if t.startswith("Bash") and not t.startswith("Bash(dg ")]
    assert "--no-session-persistence" in a and "--max-budget-usd" in a
    assert _after(a, "--setting-sources") == ["user"]


def test_prompt_includes_error_and_truncates_huge_output():
    p = svc.build_prompt("fix", "BOOM " * 10_000, "My Proj", "my_mod", "as_package")
    assert p.startswith("/dagster-expert") and "my_mod" in p and "...[truncated]..." in p
    assert len(p) < 14_000
    assert "Do NOT modify" in svc.build_prompt("explain", "e", "p", "m", "as_package")


def test_prompt_tells_the_agent_the_only_shell_commands_it_may_use():
    # The agent once tried `uv run dg check defs`, got denied, and ended by asking
    # a (nonexistent) human for approval. The prompt must name the allowed form.
    for mode in ("explain", "fix"):
        p = svc.build_prompt(mode, "e", "p", "m", "as_package")
        assert "`dg check defs`" in p and "no `uv run`" in p and "Never ask for approval" in p


# ---- snapshot / diff / undo ------------------------------------------------

def test_snapshot_only_tracks_source_not_secrets_or_data(project):
    sid = svc.create_snapshot("p1", project)
    files = set(svc._snapshot_files(svc._snapshot_dir("p1", sid)))
    assert files == {"src/mod/defs/a/defs.yaml", "src/mod/defs/b.yaml", "pyproject.toml"}


def test_diff_reports_modified_added_deleted(project):
    sid = svc.create_snapshot("p1", project)
    (project / "src/mod/defs/a/defs.yaml").write_text("type: x\nattributes:\n  n: 2\n")
    (project / "src/mod/defs/b.yaml").unlink()
    (project / "src/mod/defs/new").mkdir()
    (project / "src/mod/defs/new/defs.yaml").write_text("z: 1\n")
    by_path = {c["path"]: c for c in svc.diff_snapshot("p1", project, sid)}
    assert by_path["src/mod/defs/a/defs.yaml"]["status"] == "modified"
    assert "-  n: 1" in by_path["src/mod/defs/a/defs.yaml"]["diff"] and "+  n: 2" in by_path["src/mod/defs/a/defs.yaml"]["diff"]
    assert by_path["src/mod/defs/b.yaml"]["status"] == "deleted"
    assert by_path["src/mod/defs/new/defs.yaml"]["status"] == "added"
    assert len(by_path) == 3


def test_no_changes_means_empty_diff(project):
    sid = svc.create_snapshot("p1", project)
    assert svc.diff_snapshot("p1", project, sid) == []


def test_undo_restores_everything_and_leaves_untracked_files_alone(project):
    sid = svc.create_snapshot("p1", project)
    (project / "src/mod/defs/a/defs.yaml").write_text("CHANGED\n")
    (project / "src/mod/defs/b.yaml").unlink()
    (project / "src/mod/defs/new").mkdir()
    (project / "src/mod/defs/new/defs.yaml").write_text("z: 1\n")
    (project / ".env").write_text("SECRET=2\n")  # outside snapshot scope: untouched by undo
    svc.restore_snapshot("p1", project, sid)
    assert (project / "src/mod/defs/a/defs.yaml").read_text() == "type: x\nattributes:\n  n: 1\n"
    assert (project / "src/mod/defs/b.yaml").read_text() == "keep: me\n"
    assert not (project / "src/mod/defs/new").exists()  # created dir pruned
    assert (project / ".env").read_text() == "SECRET=2\n"
    with pytest.raises(FileNotFoundError):  # snapshot is consumed
        svc._snapshot_dir("p1", sid)


def test_snapshot_id_is_validated_against_path_traversal(project):
    for bad in ["../x", "..", "a/b", "", "20260101T000000000000Z-zzzzzz"]:
        with pytest.raises(ValueError):
            svc._snapshot_dir("p1", bad)


def test_old_snapshots_are_pruned(project):
    ids = [svc.create_snapshot("p1", project) for _ in range(svc._KEEP_SNAPSHOTS + 3)]
    remaining = {p.name for p in svc._snapshot_root("p1").iterdir()}
    assert len(remaining) == svc._KEEP_SNAPSHOTS and ids[-1] in remaining


def test_build_mode_has_exactly_fix_permissions():
    # "build" implements a request the catalog planner couldn't; it must be no more powerful than "fix".
    assert _after(_args("build"), "--permission-mode") == ["acceptEdits"]
    assert _after(_args("build"), "--allowedTools") == _after(_args("fix"), "--allowedTools")
    assert _after(_args("build"), "--disallowedTools") == _after(_args("fix"), "--disallowedTools")
    assert svc.MAX_BUDGET_USD["build"] == svc.MAX_BUDGET_USD["fix"]


def test_build_prompt_carries_the_task_and_the_planner_failure_and_the_safety_rules():
    p = svc.build_prompt("build", "attributes.source -- Input should be a valid dictionary", "Shop", "shop_mod", "as_package",
                         task="pull the domain out of the email field")
    assert p.startswith("/dagster-expert ")
    assert "pull the domain out of the email field" in p and "valid dictionary" in p and "`shop_mod`" in p
    assert "never touch .env" in p and "dg check defs" in p
    # with no failure context it still makes sense
    assert "could not complete this request." in svc.build_prompt("build", "", "Shop", "m", "as_package", task="t")
