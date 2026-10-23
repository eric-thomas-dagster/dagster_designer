"""Try a document extraction on sample files (the Document Extraction workbench's live results)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import extraction_try_service as svc

router = APIRouter(prefix="/projects/{project_id}/extraction", tags=["extraction"])


class TryExtractionRequest(BaseModel):
    files: list[str]
    output_fields: list[str]
    document_type: str = "custom"
    model: str = "gpt-4o"
    api_key_env_var: str | None = "OPENAI_API_KEY"
    # For a local/self-hosted model (e.g. OLLAMA_API_BASE with model "ollama/llava").
    api_base_env_var: str | None = None
    field_regions: dict[str, dict[str, float]] | None = None
    input_type: str = "file"
    max_content_chars: int | None = 20000
    llm_max_retries: int = 2
    # False = always call the model (a "re-run" button); True reuses a result for an identical document + settings.
    use_cache: bool = True


_STATUS = {"not_found": 404, "component_missing": 409, "component_outdated": 409, "no_files": 400, "no_fields": 400, "too_many_files": 400}


@router.post("/try")
async def try_extraction(project_id: str, req: TryExtractionRequest) -> dict[str, Any]:
    """Run the extractor on up to 10 sample documents, without materializing anything.

    One result per file, in order: `{file, ok, fields | error, raw, ms, cached}`. Identical document + settings reuse the
    last result (`cached: true`) so tweaking one field doesn't re-bill every sample.
    """
    spec = req.model_dump()
    use_cache = spec.pop("use_cache")
    try:
        return await svc.try_extraction(project_id, spec, use_cache=use_cache)
    except svc.ExtractionTryError as e:
        raise HTTPException(status_code=_STATUS.get(e.code, 500), detail={"code": e.code, "message": str(e)})
