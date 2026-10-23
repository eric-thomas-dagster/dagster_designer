"""Try a document extraction on sample files (the Document Extraction workbench's live results)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import extraction_golden_service as golden
from ..services import extraction_scoring as scoring
from ..services import extraction_try_service as svc

router = APIRouter(prefix="/projects/{project_id}/extraction", tags=["extraction"])


class TryExtractionRequest(BaseModel):
    files: list[str]
    output_fields: list[str]
    # Names the extraction so results are scored against its golden set (values a person confirmed). Optional.
    asset_name: str | None = None
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


class GoldenMark(BaseModel):
    asset_name: str
    digest: str
    path: str = ""
    field: str
    # What the person says is right: `value_text` as they typed it (JSON if it parses, else text, blank = "should be empty"), or an
    # already-typed `value` (the "✓ the model got it right" case sends the model's own value).
    value_text: str | None = None
    value: Any = None
    # The value the model produced for this field, so the response can say whether it now matches.
    extracted: Any = None


@router.get("/golden")
async def get_golden(project_id: str, asset_name: str) -> dict[str, Any]:
    """Everything marked so far for an extraction: {documents: {<content hash>: {path, expected: {field: value}}}}."""
    try:
        return golden.load(svc.project_dir_for(project_id), asset_name)
    except svc.ExtractionTryError as e:
        raise HTTPException(status_code=_STATUS.get(e.code, 500), detail={"code": e.code, "message": str(e)})


@router.put("/golden")
async def mark_field(project_id: str, mark: GoldenMark) -> dict[str, Any]:
    """Record the right value for one field of one sample document. `expected` is the document's full set of marks afterwards; `match`
    says whether the model's value (if sent) agrees with it."""
    value = scoring.parse_typed_value(mark.value_text) if mark.value_text is not None else mark.value
    try:
        data = golden.set_expected(svc.project_dir_for(project_id), mark.asset_name, mark.digest, mark.path, mark.field, value)
    except svc.ExtractionTryError as e:
        raise HTTPException(status_code=_STATUS.get(e.code, 500), detail={"code": e.code, "message": str(e)})
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "golden_full", "message": str(e)})
    return {
        "expected": golden.expected_for(data, mark.digest),
        "match": scoring.values_match(value, mark.extracted),
        "marked_documents": len(data["documents"]),
    }


@router.delete("/golden")
async def unmark_field(project_id: str, asset_name: str, digest: str, field: str) -> dict[str, Any]:
    try:
        data = golden.clear_expected(svc.project_dir_for(project_id), asset_name, digest, field)
    except svc.ExtractionTryError as e:
        raise HTTPException(status_code=_STATUS.get(e.code, 500), detail={"code": e.code, "message": str(e)})
    return {"expected": golden.expected_for(data, digest), "marked_documents": len(data["documents"])}
