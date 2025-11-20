"""Git repository discovery and validation"""

import re
from typing import Optional, Dict, Any
import click


def validate_git_url(url: str) -> bool:
    """Validate if a string looks like a valid git URL"""
    patterns = [
        r"^https://.*\.git$",
        r"^git@.*:.*\.git$",
        r"^https://.*$",  # Allow URLs without .git suffix
        r"^git@.*:.*$",  # Allow SSH URLs without .git suffix
    ]
    return any(re.match(pattern, url) for pattern in patterns)


def normalize_git_url(url: str) -> str:
    """
    Normalize git URL to https format
    
    Args:
        url: Git URL in various formats
        
    Returns:
        Normalized https URL
    """
    if not url:
        return url
    
    # Convert git:// to https://
    if url.startswith("git://"):
        url = url.replace("git://", "https://", 1)
    
    # Convert git@ to https://
    if url.startswith("git@"):
        # git@github.com:user/repo.git -> https://github.com/user/repo.git
        url = url.replace("git@", "https://", 1).replace(":", "/", 1)
    
    # Ensure it ends with .git for consistency
    if not url.endswith(".git") and not url.endswith("/"):
        url = url + ".git"
    
    return url


def discover_git_repo(project: dict, repository_connection: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """
    Attempt to discover git repository from project metadata and repository connection

    Args:
        project: dbt Cloud project dictionary
        repository_connection: Optional repository connection dictionary from API

    Returns:
        Git repository URL if found, None otherwise
    """
    # First, check the repository field in project (this is the most reliable)
    repo = project.get("repository")
    if repo and isinstance(repo, dict):
        # Check web_url first (most user-friendly)
        web_url = repo.get("web_url")
        if web_url:
            normalized = normalize_git_url(str(web_url))
            if validate_git_url(normalized):
                return normalized
        
        # Check remote_url (may need normalization)
        remote_url = repo.get("remote_url")
        if remote_url:
            normalized = normalize_git_url(str(remote_url))
            if validate_git_url(normalized):
                return normalized
        
        # Check other common fields
        for field in ["url", "clone_url", "html_url", "git_url", "repository_url"]:
            url = repo.get(field)
            if url:
                normalized = normalize_git_url(str(url))
                if validate_git_url(normalized):
                    return normalized
    
    # Check repository_connection if provided
    if repository_connection:
        # Check common fields in repository connection
        for field in ["repository_url", "url", "remote_url", "clone_url", "html_url", "web_url"]:
            url = repository_connection.get(field)
            if url:
                normalized = normalize_git_url(str(url))
                if validate_git_url(normalized):
                    return normalized
        
        # Check nested structures
        if "repository" in repository_connection:
            repo = repository_connection["repository"]
            if isinstance(repo, dict):
                for field in ["url", "clone_url", "html_url", "git_url", "web_url", "remote_url"]:
                    url = repo.get(field)
                    if url:
                        normalized = normalize_git_url(str(url))
                        if validate_git_url(normalized):
                            return normalized
            elif isinstance(repo, str):
                normalized = normalize_git_url(repo)
                if validate_git_url(normalized):
                    return normalized
    
    # Check project fields directly
    # Check repository_url field
    repo_url = project.get("repository_url")
    if repo_url:
        normalized = normalize_git_url(str(repo_url))
        if validate_git_url(normalized):
            return normalized

    # Check other potential fields in project
    for field in ["git_url", "repo_url", "remote_url"]:
        if field in project:
            value = project.get(field)
            if value:
                # Handle dict values
                if isinstance(value, dict):
                    for sub_field in ["url", "clone_url", "html_url", "git_url", "web_url", "remote_url"]:
                        sub_value = value.get(sub_field)
                        if sub_value:
                            normalized = normalize_git_url(str(sub_value))
                            if validate_git_url(normalized):
                                return normalized
                else:
                    normalized = normalize_git_url(str(value))
                    if validate_git_url(normalized):
                        return normalized

    return None


def prompt_for_git_repo(project_name: str, project_id: int) -> str:
    """
    Prompt user for git repository URL

    Args:
        project_name: Name of the dbt project
        project_id: ID of the dbt project

    Returns:
        Git repository URL
    """
    click.echo(f"\nProject: {project_name} (ID: {project_id})")
    while True:
        repo_url = click.prompt(
            "Enter the git repository URL for this project",
            type=str,
        )
        if validate_git_url(repo_url):
            return repo_url
        else:
            click.echo("Invalid git URL format. Please try again.")
            click.echo("Examples:")
            click.echo("  - https://github.com/user/repo.git")
            click.echo("  - git@github.com:user/repo.git")

