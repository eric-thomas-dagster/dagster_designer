"""API endpoints for Git operations."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.git_service import git_service

router = APIRouter(prefix="/git", tags=["git"])


class CloneRequest(BaseModel):
    """Request to clone a repository."""

    repo_url: str
    token: str | None = None
    branch: str = "main"


class CommitPushRequest(BaseModel):
    """Request to commit and push changes."""

    repo_name: str
    files: list[str]
    message: str
    token: str | None = None


class PullRequest(BaseModel):
    """Request to pull latest changes."""

    repo_name: str
    token: str | None = None


@router.post("/clone")
async def clone_repository(request: CloneRequest):
    """Clone a Git repository.

    Args:
        request: Clone request with repo URL, token, and branch
    """
    try:
        repo_path = git_service.clone_repo(
            request.repo_url,
            request.token,
            request.branch,
        )
        return {
            "repo_path": str(repo_path),
            "repo_name": repo_path.name,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/commit-push")
async def commit_and_push(request: CommitPushRequest):
    """Commit and push changes to a repository.

    Args:
        request: Commit/push request with repo name, files, message, and token
    """
    repo_path = git_service.repos_dir / request.repo_name

    if not repo_path.exists():
        raise HTTPException(status_code=404, detail="Repository not found")

    try:
        git_service.commit_and_push(
            repo_path,
            request.files,
            request.message,
            request.token,
        )
        return {"status": "success", "message": "Changes committed and pushed"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/pull")
async def pull_latest(request: PullRequest):
    """Pull latest changes from remote.

    Args:
        request: Pull request with repo name and token
    """
    repo_path = git_service.repos_dir / request.repo_name

    if not repo_path.exists():
        raise HTTPException(status_code=404, detail="Repository not found")

    try:
        git_service.pull_latest(repo_path, request.token)
        return {"status": "success", "message": "Pulled latest changes"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/status/{repo_name}")
async def get_status(repo_name: str):
    """Get repository status.

    Args:
        repo_name: Repository name
    """
    repo_path = git_service.repos_dir / repo_name

    if not repo_path.exists():
        raise HTTPException(status_code=404, detail="Repository not found")

    try:
        status = git_service.get_repo_status(repo_path)
        return status
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
