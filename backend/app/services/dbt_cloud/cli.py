"""CLI interface for dbt Cloud migration assistant"""

import click
from typing import Dict, Optional
from .dbt_cloud_client import DbtCloudClient
from .git_discovery import discover_git_repo, prompt_for_git_repo, validate_git_url
from .dagster_generator import DagsterProjectGenerator
from .adapter_detector import detect_adapters, extract_environment_variables


@click.command()
@click.option(
    "--api-key",
    default=None,
    help="dbt Cloud API key (will prompt if not provided)",
    envvar="DBT_CLOUD_API_KEY",
)
@click.option(
    "--account-id",
    default=None,
    type=int,
    help="dbt Cloud account ID (will prompt if not provided)",
    envvar="DBT_CLOUD_ACCOUNT_ID",
)
@click.option(
    "--output-dir",
    default=None,
    help="Output directory for generated Dagster project (default: dagster_project)",
)
@click.option(
    "--api-base-url",
    default=None,
    help="Custom API base URL for multi-tenant accounts (e.g., https://lm759.us1.dbt.com/api/v2)",
)
@click.option(
    "--skip-confirm",
    is_flag=True,
    help="Skip confirmation prompts",
)
@click.option(
    "--auto-setup",
    is_flag=True,
    default=True,
    help="Automatically clone repositories, copy profiles.yml, and install dependencies (default: enabled)",
)
@click.option(
    "--no-auto-setup",
    is_flag=True,
    help="Skip automatic setup (don't clone repos, copy profiles, or install deps)",
)
def main(api_key: Optional[str], account_id: Optional[int], output_dir: Optional[str], api_base_url: Optional[str], skip_confirm: bool, auto_setup: bool, no_auto_setup: bool):
    """
    Migrate dbt Cloud projects, jobs, and schedules to Dagster.

    This tool fetches your dbt Cloud configuration and generates a Dagster
    project with equivalent jobs and schedules.
    """
    click.echo("🚀 Starting dbt Cloud to Dagster migration...")
    click.echo("")

    # Prompt for required values if not provided
    if not api_key:
        api_key = click.prompt(
            "Enter your dbt Cloud API key",
            hide_input=True,
            type=str,
        )
    
    if account_id is None:
        account_id = click.prompt(
            "Enter your dbt Cloud account ID",
            type=int,
        )
    
    if not output_dir:
        output_dir = click.prompt(
            "Enter output directory for Dagster project",
            default="dagster_project",
            type=str,
        )
    
    # Optional: prompt for API base URL if user might have multi-tenant account
    if not api_base_url:
        use_custom_url = click.confirm(
            "Do you have a multi-tenant account with a custom API URL?",
            default=False,
        )
        if use_custom_url:
            api_base_url = click.prompt(
                "Enter your API base URL (e.g., https://lm759.us1.dbt.com/api/v2)",
                type=str,
            )

    # Initialize client
    try:
        if api_base_url:
            click.echo(f"Using custom API base URL: {api_base_url}")
        client = DbtCloudClient(api_key, account_id, base_url=api_base_url)
        click.echo("✓ Initialized dbt Cloud API client")
        
        # Test connection
        click.echo("🔐 Testing authentication...")
        if not client.test_connection():
            click.echo("✗ Authentication failed. Please check:", err=True)
            click.echo("  - API token is correct and active", err=True)
            click.echo("  - Account ID is correct (check URL: cloud.getdbt.com/settings/accounts/{ID}/)", err=True)
            click.echo("  - Service token has proper permissions", err=True)
            raise click.Abort()
        click.echo("✓ Authentication successful")
    except Exception as e:
        click.echo(f"✗ Failed to connect to dbt Cloud: {e}", err=True)
        raise click.Abort()

    # Fetch data from dbt Cloud
    click.echo("📥 Fetching projects, jobs, and environments...")
    try:
        projects = client.get_projects()
        click.echo(f"  Found {len(projects)} project(s)")

        jobs = client.get_jobs()
        click.echo(f"  Found {len(jobs)} job(s)")

        environments = client.get_environments()
        click.echo(f"  Found {len(environments)} environment(s)")
    except Exception as e:
        click.echo(f"✗ Failed to fetch data: {e}", err=True)
        raise click.Abort()

    if not projects:
        click.echo("⚠ No projects found in dbt Cloud", err=True)
        raise click.Abort()

    # Discover or prompt for git repositories
    click.echo("")
    click.echo("🔍 Discovering git repositories...")
    project_repos: Dict[int, str] = {}

    for project in projects:
        project_id = project.get("id")
        project_name = project.get("name", f"project_{project_id}")
        
        # Try to get detailed project info and repository connection
        repo_url = None
        try:
            repo_connection = client.get_repository_connection(project_id)
            repo_url = discover_git_repo(project, repo_connection)
        except Exception:
            # If detailed fetch fails, try with just project data
            repo_url = discover_git_repo(project)
        
        if repo_url:
            project_repos[project_id] = repo_url
            click.echo(f"  ✓ Found repository for {project_name}: {repo_url}")
        else:
            # Prompt user if not found
            if not skip_confirm:
                repo_url = prompt_for_git_repo(project_name, project_id)
                project_repos[project_id] = repo_url
            else:
                click.echo(
                    f"  ⚠ No repository found for {project_name}, skipping...", err=True
                )

    if not project_repos:
        click.echo("✗ No git repositories configured", err=True)
        raise click.Abort()

    # Detect adapters and environment variables
    click.echo("")
    click.echo("🔍 Analyzing environments for dbt adapters and configuration...")
    required_adapters = detect_adapters(environments)
    if required_adapters:
        click.echo(f"  Detected dbt adapters: {', '.join(sorted(required_adapters))}")
    else:
        click.echo("  ⚠ No dbt adapters detected (will use dbt-core only)")
    
    env_vars = extract_environment_variables(environments, jobs)
    if env_vars:
        click.echo(f"  Found {len(env_vars)} environment variable(s) to configure")

    # Generate Dagster project
    click.echo("")
    click.echo(f"📦 Generating Dagster project in '{output_dir}'...")
    click.echo("  Using Dagster 1.12+ CLI (dg) for project scaffolding...")
    click.echo("  - Scaffolding dbt components with 'dg scaffold defs'")
    click.echo("  - Registering custom job/schedule components with 'dg scaffold component'")
    try:
        generator = DagsterProjectGenerator(output_dir)
        generator.generate_project(projects, jobs, environments, project_repos)
        click.echo("✓ Dagster project generated successfully using Dagster CLI")
    except Exception as e:
        click.echo(f"✗ Failed to generate project: {e}", err=True)
        click.echo("  Make sure Dagster 1.12+ is installed: pip install 'dagster[cli]>=1.12.0'", err=True)
        raise click.Abort()

    # Apply auto-setup (default behavior, unless --no-auto-setup is used)
    if auto_setup and not no_auto_setup:
        click.echo("")
        click.echo("📥 Cloning dbt project repositories...")
        try:
            for project in projects:
                project_id = project.get("id")
                if project_id not in project_repos:
                    continue
                project_name = project.get("name", f"project_{project_id}")
                click.echo(f"  Cloning {project_name}...")
            generator.clone_repositories(projects, project_repos)
            click.echo("✓ All repositories cloned successfully")
        except Exception as e:
            click.echo(f"⚠ Failed to clone repositories: {e}", err=True)
            click.echo("  You can run './clone_dbt_projects.sh' manually later", err=True)
        
        click.echo("")
        click.echo("📦 Generating dbt manifests...")
        try:
            for project in projects:
                project_id = project.get("id")
                if project_id not in project_repos:
                    continue
                project_name = project.get("name", f"project_{project_id}")
                click.echo(f"  Generating manifest for {project_name}...")
            generator.generate_dbt_manifests(projects, project_repos)
            click.echo("✓ All dbt manifests generated successfully")
        except Exception as e:
            click.echo(f"⚠ Failed to generate dbt manifests: {e}", err=True)
            click.echo("  You can run 'dbt parse' in each dbt project directory manually", err=True)
        
        click.echo("")
        click.echo("📋 Copying profiles.yml...")
        try:
            generator.copy_profiles_yml()
            click.echo("✓ profiles.yml copied to ~/.dbt/profiles.yml")
            click.echo("  ⚠ Remember to update credentials in ~/.dbt/profiles.yml", err=True)
        except Exception as e:
            click.echo(f"⚠ Failed to copy profiles.yml: {e}", err=True)
            click.echo("  You can copy 'profiles.yml.template' to '~/.dbt/profiles.yml' manually", err=True)
        
        click.echo("")
        click.echo("📦 Installing dependencies...")
        try:
            generator.install_dependencies()
            click.echo("✓ Dependencies installed successfully")
        except Exception as e:
            click.echo(f"⚠ Failed to install dependencies: {e}", err=True)
            click.echo(f"  You can run 'cd {output_dir} && pip install -e .' manually", err=True)

    # Summary
    click.echo("")
    click.echo("✅ Migration complete!")
    click.echo("")
    click.echo("📄 Migration Summary: See MIGRATION_SUMMARY.md for details")
    click.echo("")
    
    # Show next steps
    if no_auto_setup:
        click.echo("Next steps:")
        click.echo(f"  1. Run './clone_dbt_projects.sh' to clone all dbt project repositories")
        click.echo("  2. Copy 'profiles.yml.template' to '~/.dbt/profiles.yml' and update credentials")
        if required_adapters:
            click.echo(f"  3. Install dependencies (includes adapters: {', '.join(sorted(required_adapters))}):")
        else:
            click.echo("  3. Install dependencies:")
        click.echo(f"     cd {output_dir} && pip install -e .")
        click.echo(f"  4. Start Dagster: cd {output_dir} && dg dev")
    else:
        click.echo("Next steps:")
        click.echo(f"  1. Review the generated project in '{output_dir}/'")
        click.echo("  2. Update the .env file with your database credentials (if needed)")
        click.echo("  3. Update credentials in ~/.dbt/profiles.yml")
        click.echo(f"  4. Run './validate_migration.sh' to validate the migration")
        click.echo(f"  5. Start Dagster: cd {output_dir} && dg dev")
    
    click.echo("")
    click.echo("Note: All definitions are component-based YAML (no Python code generation!)")
    click.echo("      Jobs and schedules use custom components in defs/jobs/ and defs/schedules/")


if __name__ == "__main__":
    main()

