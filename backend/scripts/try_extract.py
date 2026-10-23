"""Run a document extractor on a few sample files and print the results as JSON (last stdout line).

Runs in the PROJECT's Python environment (like preview_asset.py): the extractor is a project-installed component, so its
imports (dagster, litellm, ...) only exist there. It calls the component's own `extract_one`, so a sample's result is what
the real asset would produce -- same prompt, same parsing, same model call.

Request (JSON on stdin):
  {"component_path": str, "files": [str], "output_fields": [str], "document_type": str, "model": str,
   "api_key_env_var": str|null, "api_base_env_var": str|null, "field_regions": {..}|null,
   "input_type": "file"|"text", "max_content_chars": int|null, "llm_max_retries": int, "project_dir": str|null}
"""
import importlib.util
import json
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

warnings.filterwarnings("ignore")

MAX_WORKERS = 4


def _load_project_dotenv(project_dir: str | None) -> None:
    """Fill (never override) env vars from the project's .env -- `dg dev` reads it, so a key the user put there should work here too."""
    if not project_dir:
        return
    env_file = Path(project_dir) / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def _load_component(path: str):
    spec = importlib.util.spec_from_file_location("try_extract_component", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    req = json.loads(sys.stdin.read())
    try:
        _load_project_dotenv(req.get("project_dir"))
        mod = _load_component(req["component_path"])
        if not hasattr(mod, "extract_one"):
            print(json.dumps({"success": False, "code": "component_outdated",
                              "error": "The installed structured_document_extractor predates the sample runner. Reinstall/update it to use Try it."}))
            return 0
        key_var, base_var = req.get("api_key_env_var"), req.get("api_base_env_var")
        api_key = os.environ.get(key_var) if key_var else None
        api_base = os.environ.get(base_var) if base_var else None
        doc_type = req.get("document_type") or "custom"
        label = doc_type.replace("_", " ") if doc_type != "custom" else "document"

        def run(file_ref: str) -> dict:
            started = time.time()
            warnings_out: list[str] = []
            try:
                fields, raw = mod.extract_one(
                    file_ref,
                    input_type=req.get("input_type", "file"),
                    output_fields=req["output_fields"],
                    doc_label=label,
                    model=req["model"],
                    api_key=api_key,
                    api_base=api_base,
                    llm_max_retries=req.get("llm_max_retries", 2),
                    max_content_chars=req.get("max_content_chars"),
                    field_regions=req.get("field_regions"),
                    warn=warnings_out.append,
                )
                return {"file": file_ref, "ok": True, "fields": fields, "raw": raw, "warnings": warnings_out,
                        "ms": int((time.time() - started) * 1000)}
            except Exception as e:  # one bad document must not sink the batch
                return {"file": file_ref, "ok": False, "error": f"{type(e).__name__}: {e}"[:600], "warnings": warnings_out,
                        "ms": int((time.time() - started) * 1000)}

        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, max(1, len(req["files"])))) as pool:
            results = list(pool.map(run, req["files"]))
        print(json.dumps({"success": True, "results": results}))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": f"{type(e).__name__}: {e}"}))
        return 0


if __name__ == "__main__":
    sys.exit(main())
