from typing import Callable

from pydantic import BaseModel

from app.services.component_registry import ComponentRegistry


class WithCallable(BaseModel):
    fn: Callable[[int], int]


class Plain(BaseModel):
    name: str


def _registry():
    return ComponentRegistry.__new__(ComponentRegistry)


def test_a_model_with_a_callable_field_yields_no_schema_instead_of_raising():
    assert _registry()._extract_schema(WithCallable) is None


def test_a_normal_model_still_yields_its_schema():
    assert _registry()._extract_schema(Plain)["properties"]["name"]["type"] == "string"


def test_non_models_yield_none():
    assert _registry()._extract_schema(dict) is None
