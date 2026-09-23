"""Service for Git operations."""

import shutil
import re
from pathlib import Path
from git import Repo, GitCommandError, InvalidGitRepositoryError

from ..core.config import settings


class GitService:
    """Service for Git repository operations."""

    def __init__(self):
        self.repos_dir = settings.data_dir / "repos"
        self.repos_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def parse_github_url(url: str) -> dict:
        """Parse a GitHub URL and extract repository info.

        Supports formats:
        - https://github.com/user/repo.git
        - https://github.com/user/repo
        - https://github.com/user/repo/tree/branch/path/to/dir
        - https://github.com/user/repo/tree/branch

        Returns:
            dict with keys: repo_url, branch, subdir
        """
        # Pattern for GitHub URLs with optional tree/branch/path
        pattern = r'https://github\.com/([^/]+)/([^/]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.+))?)?/?$'
        match = re.match(pattern, url)

        if not match:
            # Not a GitHub web URL, return as-is (might be a .git URL)
            return {
                'repo_url': url,
                'branch': 'main',
                'subdir': None
            }

        user, repo, branch, subdir = match.groups()

        # Construct the .git clone URL
        repo_url = f"https://github.com/{user}/{repo}.git"

        return {
            'repo_url': repo_url,
            'branch': branch or 'main',
            'subdir': subdir
        }

    def clone_repo(self, repo_url: str, token: str | None = None, branch: str = "main") -> Path:
        """Clone a Git repository.

        Args:
            repo_url: Repository URL (https://github.com/user/repo.git)
            token: GitHub personal access token
            branch: Branch to clone

        Returns:
            Path to cloned repository
        """
        # Parse repo name from URL
        repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
        repo_path = self.repos_dir / repo_name

        # Remove existing repo if present
        if repo_path.exists():
            shutil.rmtree(repo_path)

        # Build URL with token if provided
        if token and "github.com" in repo_url:
            # Convert https://github.com/user/repo.git to https://token@github.com/user/repo.git
            clone_url = repo_url.replace("https://", f"https://{token}@")
        else:
            clone_url = repo_url

        try:
            Repo.clone_from(clone_url, repo_path, branch=branch)
            return repo_path
        except GitCommandError as e:
            raise ValueError(f"Failed to clone repository: {e}")

    def commit_and_push(
        self,
        repo_path: Path,
        files: list[str],
        message: str,
        token: str | None = None,
    ) -> None:
        """Commit and push changes to a repository.

        Args:
            repo_path: Path to repository
            files: List of file paths to commit (relative to repo root)
            message: Commit message
            token: GitHub personal access token
        """
        try:
            repo = Repo(repo_path)

            # Stage files
            for file_path in files:
                repo.index.add([file_path])

            # Commit
            repo.index.commit(message)

            # Push
            if token:
                # Update remote URL with token
                origin = repo.remote(name="origin")
                url = origin.url
                if "github.com" in url and not f"{token}@" in url:
                    url = url.replace("https://", f"https://{token}@")
                    origin.set_url(url)

            repo.remote(name="origin").push()

        except GitCommandError as e:
            raise ValueError(f"Failed to commit/push: {e}")

    def pull_latest(self, repo_path: Path, token: str | None = None) -> None:
        """Pull latest changes from remote.

        Args:
            repo_path: Path to repository
            token: GitHub personal access token
        """
        try:
            repo = Repo(repo_path)

            if token:
                # Update remote URL with token
                origin = repo.remote(name="origin")
                url = origin.url
                if "github.com" in url and not f"{token}@" in url:
                    url = url.replace("https://", f"https://{token}@")
                    origin.set_url(url)

            repo.remote(name="origin").pull()

        except GitCommandError as e:
            raise ValueError(f"Failed to pull: {e}")

    def init_repo(self, repo_path: Path, message: str = "Initial commit") -> None:
        """Initialize a fresh git repo at `repo_path` with a first commit
        of whatever's already there. No-op if `repo_path` already has a
        `.git`. No `origin` is set up here -- that happens later via
        `set_remote`, once the caller has somewhere to push to.
        """
        try:
            Repo(repo_path)
            return
        except InvalidGitRepositoryError:
            pass

        repo = Repo.init(repo_path)

        # A from-scratch project may run on a machine with no global git
        # identity configured yet; fall back to a local one so the
        # initial commit doesn't fail with "please tell me who you are".
        try:
            repo.config_reader().get_value("user", "email")
        except Exception:
            with repo.config_writer() as cw:
                cw.set_value("user", "name", "Dagster Designer")
                cw.set_value("user", "email", "designer@dagsterlabs.com")

        repo.git.add(A=True)
        if repo.index.entries:
            repo.index.commit(message)

    def set_remote(self, repo_path: Path, remote_url: str, name: str = "origin") -> None:
        """Point a remote at `remote_url`, creating it if it doesn't
        already exist on this repo."""
        try:
            repo = Repo(repo_path)
            existing = {r.name for r in repo.remotes}
            if name in existing:
                repo.remote(name=name).set_url(remote_url)
            else:
                repo.create_remote(name, remote_url)
        except (GitCommandError, InvalidGitRepositoryError) as e:
            raise ValueError(f"Failed to set remote: {e}")

    def get_repo_status(self, repo_path: Path) -> dict:
        """Get repository status.

        Returns:
            Dictionary with status information
        """
        try:
            repo = Repo(repo_path)

            return {
                "branch": repo.active_branch.name,
                "is_dirty": repo.is_dirty(),
                "untracked_files": repo.untracked_files,
                "modified_files": [item.a_path for item in repo.index.diff(None)],
                "staged_files": [item.a_path for item in repo.index.diff("HEAD")],
            }
        except Exception as e:
            raise ValueError(f"Failed to get status: {e}")


# Global service instance
git_service = GitService()
