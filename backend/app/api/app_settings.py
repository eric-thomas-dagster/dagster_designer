"""App-level settings (see core/app_settings.py)."""
from fastapi import APIRouter
from pydantic import BaseModel

from ..core import app_settings

router = APIRouter(prefix="/app-settings", tags=["app-settings"])


class AppSettings(BaseModel):
    fast_local_loading: bool = True


class AppSettingsUpdate(BaseModel):
    fast_local_loading: bool | None = None


@router.get("", response_model=AppSettings)
async def get_app_settings():
    return AppSettings(**app_settings.load())


@router.put("", response_model=AppSettings)
async def update_app_settings(update: AppSettingsUpdate):
    return AppSettings(**app_settings.update(update.model_dump(exclude_none=True)))
