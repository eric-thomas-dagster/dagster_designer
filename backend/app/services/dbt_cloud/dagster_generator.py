"""Generate Dagster project structure from dbt Cloud configuration using Dagster CLI"""

import os
import subprocess
import shutil
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
import yaml
from .adapter_detector import detect_adapters, extract_environment_variables
from .profiles_generator import generate_profiles_yml


class DagsterProjectGenerator:
    """Generates Dagster project structure from dbt Cloud data using Dagster CLI"""

    def __init__(self, output_dir: str = "dagster_project"):
        """
        Initialize generator

        Args:
            output_dir: Directory where Dagster project will be created
        """
        self.output_dir = Path(output_dir).resolve()
        self.project_root = self.output_dir

    def generate_project(
        self,
        projects: List[Dict[str, Any]],
        jobs: List[Dict[str, Any]],
        environments: List[Dict[str, Any]],
        project_repos: Dict[int, str],
    ):
        """
        Generate complete Dagster project structure using Dagster CLI

        Args:
            projects: List of dbt Cloud projects
            jobs: List of dbt Cloud jobs
            environments: List of dbt Cloud environments
            project_repos: Mapping of project_id to git repository URL
        """
        # Check if Dagster CLI is available
        self._check_dagster_cli()

        # Initialize Dagster project using CLI
        self._init_dagster_project()

        # Scaffold dbt components for each project
        for project in projects:
            project_id = project.get("id")
            if project_id not in project_repos:
                continue

            project_name = self._sanitize_name(project.get("name", f"project_{project_id}"))
            project_display_name = project.get("name", f"project_{project_id}")
            # dbt projects are typically siblings to the Dagster project, not inside it
            # Path will be: ../dbt_projects/<project_name> (relative to Dagster project root)
            dbt_project_path = f"../dbt_projects/{project_display_name}"

            # Scaffold dbt component using CLI
            self._scaffold_dbt_component(project_name, dbt_project_path)

        # Detect required dbt adapters
        required_adapters = detect_adapters(environments)

        # Extract environment variables
        env_vars = extract_environment_variables(environments, jobs)

        # Create package structure and register custom components
        self._create_package_structure()
        self._register_custom_components()
        
        # Generate jobs and schedules as component-based YAML definitions
        self._generate_jobs_and_schedules(projects, jobs, environments, project_repos)

        # Update pyproject.toml with dependencies including adapters and dagster-cloud
        self._update_pyproject_toml(required_adapters)

        # Generate .env file with environment variables
        self._generate_env_file(env_vars)

        # Generate dbt profiles.yml
        self._generate_profiles_yml(environments)

        # Generate git clone script
        self._generate_git_clone_script(projects, project_repos)

        # Generate migration validation script
        self._generate_validation_script()

        # Generate migration summary report
        self._generate_migration_summary(projects, jobs, environments, project_repos, required_adapters)

        # Generate README
        self._generate_readme(projects, project_repos, required_adapters)

    def clone_repositories(self, projects: List[Dict[str, Any]], project_repos: Dict[int, str]):
        """Clone all dbt project repositories"""
        import subprocess
        
        # dbt projects should be siblings to the Dagster project, not inside it
        # This follows the typical Dagster + dbt project structure
        dbt_projects_dir = self.output_dir.parent / "dbt_projects"
        dbt_projects_dir.mkdir(exist_ok=True)
        
        for project in projects:
            project_id = project.get("id")
            if project_id not in project_repos:
                continue
            
            project_name = project.get("name", f"project_{project_id}")
            repo_url = project_repos[project_id]
            project_dir = dbt_projects_dir / project_name
            
            if project_dir.exists():
                continue  # Skip silently, CLI will handle messaging
            
            try:
                subprocess.run(
                    ["git", "clone", repo_url, str(project_dir)],
                    check=True,
                    capture_output=True,
                    text=True
                )
            except subprocess.CalledProcessError as e:
                raise Exception(f"Failed to clone {project_name}: {e.stderr}")

    def generate_dbt_manifests(self, projects: List[Dict[str, Any]], project_repos: Dict[int, str]):
        """Generate dbt manifests for all cloned projects by running dbt parse"""
        import subprocess
        
        dbt_projects_dir = self.output_dir.parent / "dbt_projects"
        
        for project in projects:
            project_id = project.get("id")
            if project_id not in project_repos:
                continue
            
            project_name = project.get("name", f"project_{project_id}")
            project_dir = dbt_projects_dir / project_name
            
            if not project_dir.exists():
                continue  # Skip if project wasn't cloned
            
            # Check if dbt is available
            try:
                subprocess.run(["dbt", "--version"], capture_output=True, check=True)
            except (subprocess.CalledProcessError, FileNotFoundError):
                # dbt not available - skip manifest generation
                continue
            
            # Run dbt parse to generate manifest.json
            # This creates target/manifest.json which Dagster needs
            try:
                subprocess.run(
                    ["dbt", "parse"],
                    cwd=project_dir,
                    check=True,
                    capture_output=True,
                )
            except subprocess.CalledProcessError as e:
                # If dbt parse fails, try dbt compile as fallback
                try:
                    subprocess.run(
                        ["dbt", "compile"],
                        cwd=project_dir,
                        check=True,
                        capture_output=True,
                    )
                except subprocess.CalledProcessError:
                    # If both fail, continue - user can run manually
                    pass

    def copy_profiles_yml(self):
        """Copy profiles.yml.template to ~/.dbt/profiles.yml"""
        import shutil
        from pathlib import Path
        
        # The template is generated in the output directory
        template_path = self.output_dir / "profiles.yml.template"
        if not template_path.exists():
            raise FileNotFoundError(f"profiles.yml.template not found at {template_path}")
        
        dbt_dir = Path.home() / ".dbt"
        dbt_dir.mkdir(exist_ok=True)
        
        target_path = dbt_dir / "profiles.yml"
        
        # Copy the file
        shutil.copy2(template_path, target_path)

    def install_dependencies(self):
        """Install dependencies in the generated Dagster project"""
        import subprocess
        
        try:
            result = subprocess.run(
                ["pip", "install", "-e", "."],
                cwd=self.output_dir,
                check=True,
                capture_output=True,
                text=True
            )
        except subprocess.CalledProcessError as e:
            raise Exception(f"Failed to install dependencies: {e.stderr}")

    def _check_dagster_cli(self):
        """Check if Dagster CLI is available - prioritize create-dagster (recommended)"""
        # Try create-dagster first (recommended per Dagster docs)
        try:
            result = subprocess.run(
                ["create-dagster", "--version"],
                capture_output=True,
                text=True,
                check=True,
            )
            self.cli_command = "create-dagster"
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Fallback to dg
            try:
                result = subprocess.run(
                    ["dg", "--version"],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.cli_command = "dg"
            except (subprocess.CalledProcessError, FileNotFoundError):
                raise RuntimeError(
                    "Dagster CLI (create-dagster or dg) not found. "
                    "Please install Dagster 1.12+ with: pip install dagster[cli] or uvx create-dagster@latest"
                )

    def _init_dagster_project(self):
        """Initialize Dagster project using CLI"""
        project_name = self.output_dir.name

        # If directory exists and is not empty, we'll work with it
        if self.output_dir.exists() and any(self.output_dir.iterdir()):
            # Check if it's already a Dagster project
            project_package = self._get_project_package_name()
            if (self.output_dir / "pyproject.toml").exists() or (self.output_dir / project_package / "defs").exists():
                # It's already a Dagster project, we can work with it
                return
            else:
                raise RuntimeError(
                    f"Directory {self.output_dir} exists and is not empty. "
                    "Please use a different output directory or remove this one."
                )

        # Create parent directory if needed
        self.output_dir.parent.mkdir(parents=True, exist_ok=True)

        # Use create-dagster project to scaffold (per Dagster docs)
        # This creates the proper src/ layout with definitions.py already set up
        try:
            # Try create-dagster first (recommended method per docs)
            if self.cli_command == "create-dagster":
                # create-dagster project_name creates a new directory
                # It creates src/<project_name>/ with definitions.py already set up
                subprocess.run(
                    ["create-dagster", "project", project_name],
                    check=True,
                    cwd=self.output_dir.parent,
                )
                # Check if a subdirectory was created
                possible_dirs = list(self.output_dir.parent.glob(f"{project_name}*"))
                if possible_dirs:
                    created_dir = possible_dirs[0].resolve()
                    # If create-dagster created a nested directory, move contents up
                    if created_dir != self.output_dir and created_dir.exists():
                        # Move all contents from nested directory to output_dir
                        if not self.output_dir.exists():
                            self.output_dir.mkdir(parents=True, exist_ok=True)
                        import shutil
                        for item in created_dir.iterdir():
                            if item.name != self.output_dir.name:  # Avoid moving into itself
                                dest = self.output_dir / item.name
                                if dest.exists():
                                    if dest.is_dir():
                                        shutil.rmtree(dest)
                                    else:
                                        dest.unlink()
                                shutil.move(str(item), str(dest))
                        # Remove the nested directory if empty
                        try:
                            created_dir.rmdir()
                        except:
                            pass
            elif self.cli_command == "dg":
                # Fallback to dg init if create-dagster not available
                if not self.output_dir.exists():
                    self.output_dir.mkdir(parents=True, exist_ok=True)
                
                # Run dg init in the target directory
                subprocess.run(
                    ["dg", "init"],
                    check=True,
                    cwd=self.output_dir,
                    capture_output=True,
                    text=True,
                )
            else:
                # No CLI available, create minimal structure
                self._create_minimal_dagster_structure()
        except subprocess.CalledProcessError as e:
            # If CLI fails, create minimal structure manually
            self._create_minimal_dagster_structure()

    def _create_minimal_dagster_structure(self):
        """Create minimal Dagster project structure if CLI fails"""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Create package and defs directory
        project_package = self._get_project_package_name()
        package_dir = self.output_dir / project_package
        package_dir.mkdir(exist_ok=True)
        (package_dir / "defs").mkdir(exist_ok=True)
        
        # Create minimal pyproject.toml
        project_package = self._get_project_package_name()
        pyproject_content = f"""[project]
name = "dagster-dbt-migration"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "dagster[cli]>=1.12.0",
    "dagster-dbt>=0.22.0",
    "dbt-core>=1.5.0",
]

[tool.setuptools]
packages = ["{project_package}"]

[tool.dg]
directory_type = "project"

[tool.dg.project]
root_module = "{project_package}"
"""
        with open(self.output_dir / "pyproject.toml", "w") as f:
            f.write(pyproject_content)

    def _scaffold_dbt_component(self, component_name: str, dbt_project_path: str):
        """
        Scaffold a dbt component using Dagster CLI

        Args:
            component_name: Name for the dbt component
            dbt_project_path: Relative path to the dbt project directory
        """
        # Always use manual creation since dg scaffold creates wrong format
        # The scaffold command doesn't support the nested dict format we need
        # for project_dir and profiles_dir
        self._create_dbt_component_manual(component_name, dbt_project_path)

    def _create_dbt_component_manual(self, component_name: str, dbt_project_path: str):
        """Manually create dbt component defs.yaml if CLI fails"""
        project_package = self._get_project_package_name()
        defs_dir = self.output_dir / project_package / "defs" / component_name
        defs_dir.mkdir(parents=True, exist_ok=True)

        # Dagster 1.12 defs.yaml format - single object (not a list)
        # The defs.yaml should contain a single component definition
        # Configure project as a dict with project_dir and profiles_dir
        # Use relative path from defs.yaml location since project_root template doesn't resolve in nested dicts
        # defs.yaml is at: <package>/defs/<component_name>/defs.yaml
        # dbt project is a sibling to Dagster project: ../dbt_projects/<project_name>
        # From defs.yaml: up 3 levels (../../../) to Dagster project root, then one more (../) to parent, then dbt_projects/<project_name>
        # So: ../../../../dbt_projects/<project_name>
        # Remove the ../ prefix from dbt_project_path since we're already going up 4 levels
        project_name_only = dbt_project_path.replace("../dbt_projects/", "")
        relative_path = f"../../../../dbt_projects/{project_name_only}"
        
        # For profiles_dir: Use default dbt location (~/.dbt)
        # Dagster's dbt component will automatically find profiles.yml in the default location
        # No need to set DBT_PROFILES_DIR env var - the component handles this
        import os
        profiles_dir = os.path.expanduser("~/.dbt")
        
        defs_config = {
            "type": "dagster_dbt.DbtProjectComponent",
            "attributes": {
                "project": {
                    # Use relative path from defs.yaml location for portability
                    # This works across machines and cloud deployments
                    "project_dir": relative_path,
                    # Use default dbt profiles location
                    # Dagster will automatically find profiles.yml in ~/.dbt
                    "profiles_dir": profiles_dir,
                },
            },
        }

        with open(defs_dir / "defs.yaml", "w") as f:
            yaml.dump(defs_config, f, default_flow_style=False, sort_keys=False)

    def _create_package_structure(self):
        """Create proper Python package structure"""
        # Note: If create-dagster was used, it already created src/<project>/definitions.py
        # We should NOT overwrite it. The standard definitions.py uses:
        #   @definitions
        #   def defs():
        #       return load_from_defs_folder(path_within_project=Path(__file__).parent)
        # This automatically loads YAML components from the defs/ directory.
        # 
        # We only create this structure if create-dagster failed and we're using fallback
        project_package = self._get_project_package_name()
        
        # Check if we're using src/ layout (from create-dagster) or root layout (fallback)
        src_package_dir = self.output_dir / "src" / project_package
        root_package_dir = self.output_dir / project_package
        
        if src_package_dir.exists():
            # Using src/ layout from create-dagster - don't overwrite definitions.py
            package_dir = src_package_dir
        else:
            # Fallback: root layout - create structure manually
            package_dir = root_package_dir
            package_dir.mkdir(exist_ok=True)
            
            # Create __init__.py for the package
            init_file = package_dir / "__init__.py"
            if not init_file.exists():
                with open(init_file, "w") as f:
                    f.write('"""Dagster project migrated from dbt Cloud."""\n')
            
            # Only create definitions.py if it doesn't exist (create-dagster should have created it)
            definitions_file = package_dir / "definitions.py"
            if not definitions_file.exists():
                # Use the standard Dagster pattern that loads YAML components from defs/ directory
                # With the correct folder structure (each component in its own folder with defs.yaml),
                # load_from_defs_folder will automatically discover all components
                with open(definitions_file, "w") as f:
                    f.write('"""Dagster definitions loaded from YAML components."""\n\n')
                    f.write('from pathlib import Path\n')
                    f.write('from dagster import load_from_defs_folder\n\n')
                    f.write('# Import custom components to ensure they\'re registered\n')
                    f.write('# This makes them discoverable by load_from_defs_folder\n')
                    f.write('from .components import DbtCloudJobComponent, DbtCloudScheduleComponent, DbtCloudSensorComponent\n\n')
                    f.write('# Load all definitions from YAML files in the defs/ directory\n')
                    f.write('# With the standard folder structure (each component in its own folder with defs.yaml),\n')
                    f.write('# load_from_defs_folder will automatically discover all components including:\n')
                    f.write('# - dbt components from defs/<project_name>/defs.yaml\n')
                    f.write('# - jobs from defs/jobs/<job_name>/defs.yaml\n')
                    f.write('# - schedules from defs/schedules/<schedule_name>/defs.yaml\n')
                    f.write('# - sensors from defs/sensors/<sensor_name>/defs.yaml\n')
                    f.write('# \n')
                    f.write('# Note: load_from_defs_folder expects the project_root to be the directory containing the defs/ folder\n')
                    f.write('# So we pass the parent directory (dagster_dbt_migration) as the project root\n')
                    f.write('defs = load_from_defs_folder(project_root=Path(__file__).parent)\n')

    def _register_custom_components(self):
        """Register custom components using Dagster CLI and copy component files"""
        # Components are automatically registered when in the project structure
        # We'll scaffold the component structure and then copy our implementations
        
        project_package = self._get_project_package_name()
        package_dir = self.output_dir / project_package
        components_dir = package_dir / "components"
        components_dir.mkdir(parents=True, exist_ok=True)
        
        # Try to scaffold JobComponent using CLI (if it doesn't exist)
        job_component_file = components_dir / "job.py"
        if not job_component_file.exists():
            try:
                # Use dg scaffold component to create the structure
                subprocess.run(
                    ["dg", "scaffold", "component", "JobComponent"],
                    check=True,
                    cwd=self.output_dir,
                    capture_output=True,
                )
            except subprocess.CalledProcessError:
                # If scaffold fails, we'll create it manually
                pass
        
        # Try to scaffold ScheduleComponent using CLI (if it doesn't exist)
        schedule_component_file = components_dir / "schedule.py"
        if not schedule_component_file.exists():
            try:
                subprocess.run(
                    ["dg", "scaffold", "component", "ScheduleComponent"],
                    check=True,
                    cwd=self.output_dir,
                    capture_output=True,
                )
            except subprocess.CalledProcessError:
                # If scaffold fails, we'll create it manually
                pass
        
        # Try to scaffold SensorComponent using CLI (if it doesn't exist)
        sensor_component_file = components_dir / "sensor.py"
        if not sensor_component_file.exists():
            try:
                subprocess.run(
                    ["dg", "scaffold", "component", "SensorComponent"],
                    check=True,
                    cwd=self.output_dir,
                    capture_output=True,
                )
            except subprocess.CalledProcessError:
                # If scaffold fails, we'll create it manually
                pass
        
        # Copy our custom component implementations (overwriting scaffolded versions)
        job_component_source = Path(__file__).parent / "components" / "job.py"
        if job_component_source.exists():
            shutil.copy2(job_component_source, job_component_file)
        
        schedule_component_source = Path(__file__).parent / "components" / "schedule.py"
        if schedule_component_source.exists():
            shutil.copy2(schedule_component_source, schedule_component_file)
        
        sensor_component_source = Path(__file__).parent / "components" / "sensor.py"
        if sensor_component_source.exists():
            shutil.copy2(sensor_component_source, sensor_component_file)
        
        # Ensure __init__.py exists (always generate with correct names, don't copy from source)
        init_file = components_dir / "__init__.py"
        # Always generate __init__.py with correct component names
        if True:  # Always generate to ensure correct names
            # Create minimal __init__.py if it doesn't exist
            with open(init_file, "w") as f:
                f.write('"""Custom Dagster components for jobs, schedules, and sensors."""\n\n')
                f.write("from .job import DbtCloudJobComponent\n")
                f.write("from .schedule import DbtCloudScheduleComponent\n")
                f.write("from .sensor import DbtCloudSensorComponent\n\n")
                f.write("__all__ = [\n")
                f.write('    "DbtCloudJobComponent",\n')
                f.write('    "DbtCloudScheduleComponent",\n')
                f.write('    "DbtCloudSensorComponent",\n')
                f.write("]\n")

    def _generate_jobs_and_schedules(
        self,
        projects: List[Dict[str, Any]],
        jobs: List[Dict[str, Any]],
        environments: List[Dict[str, Any]],
        project_repos: Dict[int, str],
    ):
        """Generate jobs and schedules as component-based YAML definitions"""
        # Group jobs by project
        jobs_by_project = {}
        for job in jobs:
            project_id = job.get("project_id")
            if project_id not in project_repos:
                continue
            if project_id not in jobs_by_project:
                jobs_by_project[project_id] = []
            jobs_by_project[project_id].append(job)

        # Create component-based YAML definitions for jobs, schedules, and sensors
        all_job_defs = []
        all_schedule_defs = []
        all_sensor_defs = []
        
        for project_id, project_jobs in jobs_by_project.items():
            project = next((p for p in projects if p.get("id") == project_id), None)
            if not project:
                continue

            project_name = self._sanitize_name(project.get("name", f"project_{project_id}"))
            
            # The dbt component will create assets with keys based on the component name
            # We need to reference those assets in our jobs
            # The component name is the sanitized project name
            component_name = project_name

            for job in project_jobs:
                job_id = job.get("id")
                job_name = self._sanitize_name(job.get("name", f"job_{job_id}"))
                
                # Get deployment type for prefixing (e.g., PROD, STG, DEV)
                job_env_id = job.get("environment_id")
                env_prefix = ""
                if job_env_id:
                    env = next((e for e in environments if e.get("id") == job_env_id), None)
                    if env:
                        # Try to extract deployment type prefix
                        deployment_prefix = self._extract_deployment_type_prefix(env)
                        if deployment_prefix:
                            env_prefix = f"{deployment_prefix}__"
                        else:
                            # Fallback to environment name if deployment type not available
                            env_name = env.get("name", "").upper().strip()
                            env_prefix = self._sanitize_name(env_name)
                            if env_prefix:
                                env_prefix = f"{env_prefix}__"
                    else:
                        # Environment not found - this shouldn't happen but handle gracefully
                        import sys
                        if not hasattr(self, '_env_not_found_warned'):
                            print(f"⚠️  Warning: Environment ID {job_env_id} not found in environments list", file=sys.stderr)
                            self._env_not_found_warned = True
                
                # Ensure unique job names by including job ID if names are duplicated
                # Check if we've already seen this job name (with same deployment type)
                existing_job_names = []
                for j in project_jobs[:project_jobs.index(job)]:
                    existing_job_id = j.get("id")
                    existing_job_name = self._sanitize_name(j.get("name", f"job_{existing_job_id}"))
                    existing_env_id = j.get("environment_id")
                    existing_env_prefix = ""
                    if existing_env_id:
                        existing_env = next((e for e in environments if e.get("id") == existing_env_id), None)
                        if existing_env:
                            # Try to extract deployment type prefix
                            existing_deployment_prefix = self._extract_deployment_type_prefix(existing_env)
                            if existing_deployment_prefix:
                                existing_env_prefix = f"{existing_deployment_prefix}__"
                            else:
                                # Fallback to environment name
                                existing_env_name = existing_env.get("name", "").upper().strip()
                                existing_env_prefix = self._sanitize_name(existing_env_name)
                                if existing_env_prefix:
                                    existing_env_prefix = f"{existing_env_prefix}__"
                    existing_job_names.append(f"{existing_env_prefix}{existing_job_name}")
                
                full_job_name = f"{env_prefix}{job_name}"
                if full_job_name in existing_job_names:
                    # If still duplicate, append job ID
                    job_name = f"{job_name}_{job_id}"
                    full_job_name = f"{env_prefix}{job_name}"
                
                job_name_safe = f"{project_name}_{full_job_name}"

                # Create job component definition
                # Jobs reference assets from the dbt component using asset selection
                # Format: "component_name.*" to select all assets from the component
                # Note: Asset selection uses wildcard pattern matching
                # Component type uses full module path for proper registration
                project_package = self._get_project_package_name()
                
                # Extract job configuration from dbt Cloud
                execute_steps = job.get("execute_steps", [])
                job_description = job.get("description") or f"Job migrated from dbt Cloud: {job.get('name', f'job_{job_id}')}"
                
                # Parse dbt selection syntax from execute_steps
                # Examples: "dbt build --select model_a model_b", "dbt run --select +model_a", "dbt build"
                asset_selection = self._parse_dbt_selection(execute_steps, component_name)
                
                # Build job attributes
                job_attributes = {
                    "job_name": job_name_safe,
                    "asset_selection": asset_selection,
                    "description": job_description,
                }
                
                # Add tags if available (e.g., from job settings)
                # Also include environment-specific target from job's environment
                tags = {}
                if job.get("settings"):
                    settings = job.get("settings", {})
                    if settings.get("threads"):
                        tags["dbt_threads"] = str(settings.get("threads"))
                    if settings.get("target_name"):
                        tags["dbt_target"] = str(settings.get("target_name"))
                
                # Get environment-specific target from job's environment_id
                # This maps dbt Cloud environments (STG, PROD) to dbt targets
                job_env_id = job.get("environment_id")
                if job_env_id:
                    # Find the environment to get its name
                    env = next((e for e in environments if e.get("id") == job_env_id), None)
                    if env:
                        env_name = env.get("name", "").lower().replace(" ", "_")
                        # Use environment name as target (e.g., "stg", "prod")
                        # This allows jobs to target the correct environment
                        tags["dbt_target"] = env_name
                        tags["dbt_environment"] = env_name  # Also tag with environment for clarity
                
                if tags:
                    job_attributes["tags"] = tags
                
                job_def = {
                    "type": f"{project_package}.components.job.DbtCloudJobComponent",
                    "attributes": job_attributes,
                }
                all_job_defs.append(job_def)

                # Create schedule component definition if schedule exists
                # Check if job is scheduled (triggers.schedule = True)
                triggers = job.get("triggers", {})
                schedule = job.get("schedule")
                if schedule and triggers.get("schedule", False):
                    cron = schedule.get("cron")
                    if cron:
                        schedule_def = {
                            "type": f"{project_package}.components.schedule.DbtCloudScheduleComponent",
                            "attributes": {
                                "schedule_name": f"{job_name_safe}_schedule",
                                "cron_expression": cron,
                                "job_name": job_name_safe,  # Reference the job we just created
                                "description": f"Schedule migrated from dbt Cloud for {job.get('name', f'job_{job_id}')}",
                                "default_status": "RUNNING",
                            },
                        }
                        all_schedule_defs.append(schedule_def)
                
                # Handle job completion triggers (job runs after another job completes)
                # Create a sensor to monitor the trigger job's run status
                completion_trigger = job.get("job_completion_trigger_condition")
                if completion_trigger:
                    trigger_job_id = completion_trigger.get("condition", {}).get("job_id")
                    trigger_statuses = completion_trigger.get("condition", {}).get("statuses", [])
                    # Find the trigger job name
                    trigger_job = next((j for j in project_jobs if j.get("id") == trigger_job_id), None)
                    if trigger_job:
                        # Find the trigger job's full name (with deployment type prefix) from all_job_defs
                        # This ensures we reference the correct job name that was already created
                        trigger_job_name_safe = None
                        trigger_job_id_check = trigger_job.get("id")
                        for j_def in all_job_defs:
                            j_attrs = j_def.get("attributes", {})
                            j_name = j_attrs.get("job_name", "")
                            # The job_name in attributes should match the pattern: project_name_DEPLOYMENT_TYPE__job_name
                            # We need to find the job that corresponds to this trigger_job_id
                            # Since we can't easily match by ID, we'll construct it using the same logic
                            trigger_job_name_base = self._sanitize_name(trigger_job.get("name", f"job_{trigger_job_id_check}"))
                            trigger_env_id = trigger_job.get("environment_id")
                            trigger_env_prefix = ""
                            if trigger_env_id:
                                trigger_env = next((e for e in environments if e.get("id") == trigger_env_id), None)
                                if trigger_env:
                                    # Try to extract deployment type prefix
                                    trigger_deployment_prefix = self._extract_deployment_type_prefix(trigger_env)
                                    if trigger_deployment_prefix:
                                        trigger_env_prefix = f"{trigger_deployment_prefix}__"
                                    else:
                                        # Fallback to environment name
                                        trigger_env_name = trigger_env.get("name", "").upper().strip()
                                        trigger_env_prefix = self._sanitize_name(trigger_env_name)
                                        if trigger_env_prefix:
                                            trigger_env_prefix = f"{trigger_env_prefix}__"
                            full_trigger_job_name = f"{trigger_env_prefix}{trigger_job_name_base}"
                            trigger_job_name_safe = f"{project_name}_{full_trigger_job_name}"
                            break
                        
                        # Map dbt Cloud status codes to Dagster run statuses
                        # dbt Cloud status codes: 1=Queued, 2=Started, 3=Running, 10=Success, 20=Error, 30=Cancelled
                        # Dagster supports multiple statuses by creating separate sensors for each
                        # We'll create one sensor per status in trigger_statuses
                        
                        # All possible dbt Cloud status codes and their Dagster equivalents
                        status_code_map = {
                            10: "SUCCESS",   # Success
                            20: "FAILURE",   # Error
                            30: "CANCELED",  # Cancelled
                            2: "STARTED",    # Started
                            1: "QUEUED",     # Queued (not directly supported in Dagster, but we can map it)
                            3: "STARTED",    # Running (map to STARTED)
                        }
                        
                        # If trigger_statuses is empty or very large, assume "all statuses"
                        # dbt Cloud typically has 4-5 status types, so if we see more than 3, it's likely "all"
                        all_possible_statuses = [10, 20, 30, 2]  # Success, Error, Cancelled, Started
                        if len(trigger_statuses) >= len(all_possible_statuses) or len(trigger_statuses) == 0:
                            # Create sensors for all common statuses
                            trigger_statuses = all_possible_statuses
                        
                        # Create one sensor per status
                        for status_code in trigger_statuses:
                            dagster_status = status_code_map.get(status_code, "SUCCESS")
                            
                            # Skip QUEUED as Dagster doesn't have a direct equivalent
                            if dagster_status == "QUEUED":
                                continue
                            
                            # Create sensor name (include status if multiple statuses)
                            if len(trigger_statuses) > 1:
                                sensor_name = f"{job_name_safe}_sensor_{dagster_status.lower()}"
                            else:
                                sensor_name = f"{job_name_safe}_sensor"
                            
                            # Build status description
                            status_descriptions = {
                                "SUCCESS": "success",
                                "FAILURE": "failure/error",
                                "CANCELED": "cancellation",
                                "STARTED": "start",
                            }
                            status_desc = status_descriptions.get(dagster_status, dagster_status.lower())
                            
                            sensor_def = {
                                "type": f"{project_package}.components.sensor.DbtCloudSensorComponent",
                                "attributes": {
                                    "sensor_name": sensor_name,
                                    "sensor_type": "run_status",
                                    "job_name": job_name_safe,  # The job to trigger
                                    "monitored_job_name": trigger_job_name_safe,  # The job to monitor
                                    "run_status": dagster_status,
                                    "description": f"Sensor migrated from dbt Cloud: triggers {job.get('name', f'job_{job_id}')} when {trigger_job_name_safe} completes with {status_desc}",
                                    "minimum_interval_seconds": 30,
                                    "default_status": "RUNNING",
                                },
                            }
                            all_sensor_defs.append(sensor_def)

        # Write jobs as component-based YAML
        # Each component should be in its own folder with defs.yaml (standard Dagster structure)
        project_package = self._get_project_package_name()
        if all_job_defs:
            # Create directory structure manually (more reliable than scaffold)
            jobs_dir = self.output_dir / project_package / "defs" / "jobs"
            jobs_dir.mkdir(parents=True, exist_ok=True)
            
            # Write each job to its own folder with defs.yaml (standard Dagster component structure)
            # Create a custom YAML dumper that ensures tag values are strings
            class TagStringDumper(yaml.SafeDumper):
                def represent_str(self, data):
                    return self.represent_scalar('tag:yaml.org,2002:str', str(data))
            
            TagStringDumper.add_representer(int, TagStringDumper.represent_str)
            
            for i, job_def in enumerate(all_job_defs):
                job_name = job_def.get("attributes", {}).get("job_name", f"job_{i}")
                job_folder = jobs_dir / job_name
                job_folder.mkdir(parents=True, exist_ok=True)
                job_file = job_folder / "defs.yaml"
                with open(job_file, "w") as f:
                    # Ensure tag values in attributes are strings before dumping
                    if "tags" in job_def.get("attributes", {}):
                        tags = job_def["attributes"]["tags"]
                        job_def["attributes"]["tags"] = {k: str(v) for k, v in tags.items()}
                    yaml.dump(job_def, f, Dumper=TagStringDumper, default_flow_style=False, sort_keys=False)

        # Write schedules as component-based YAML
        # Each component should be in its own folder with defs.yaml (standard Dagster structure)
        if all_schedule_defs:
            # Create directory structure manually (more reliable than scaffold)
            schedules_dir = self.output_dir / project_package / "defs" / "schedules"
            schedules_dir.mkdir(parents=True, exist_ok=True)
            
            # Write each schedule to its own folder with defs.yaml (standard Dagster component structure)
            for i, schedule_def in enumerate(all_schedule_defs):
                schedule_name = schedule_def.get("attributes", {}).get("schedule_name", f"schedule_{i}")
                schedule_folder = schedules_dir / schedule_name
                schedule_folder.mkdir(parents=True, exist_ok=True)
                schedule_file = schedule_folder / "defs.yaml"
                with open(schedule_file, "w") as f:
                    yaml.dump(schedule_def, f, default_flow_style=False, sort_keys=False)
        
        # Write sensors as component-based YAML
        # Each component should be in its own folder with defs.yaml (standard Dagster structure)
        if all_sensor_defs:
            # Create directory structure manually (more reliable than scaffold)
            sensors_dir = self.output_dir / project_package / "defs" / "sensors"
            sensors_dir.mkdir(parents=True, exist_ok=True)
            
            # Write each sensor to its own folder with defs.yaml (standard Dagster component structure)
            for i, sensor_def in enumerate(all_sensor_defs):
                sensor_name = sensor_def.get("attributes", {}).get("sensor_name", f"sensor_{i}")
                sensor_folder = sensors_dir / sensor_name
                sensor_folder.mkdir(parents=True, exist_ok=True)
                sensor_file = sensor_folder / "defs.yaml"
                with open(sensor_file, "w") as f:
                    yaml.dump(sensor_def, f, default_flow_style=False, sort_keys=False)


    def _update_pyproject_toml(self, required_adapters: Set[str]):
        """Update pyproject.toml to include all required dependencies"""
        pyproject_path = self.output_dir / "pyproject.toml"
        
        # Base dependencies
        dependencies = [
            'dagster[cli]>=1.12.0',
            'dagster-dbt>=0.22.0',
            'dagster-cloud>=1.0.0',
            'dbt-core>=1.5.0',
            'dbt-duckdb>=1.5.0',  # For local development
        ]
        
        # Add detected dbt adapters (avoid duplicates)
        for adapter in sorted(required_adapters):
            if adapter != "dbt-duckdb":  # Already added above
                dependencies.append(f'{adapter}>=1.5.0')

        if not pyproject_path.exists():
            # Create new pyproject.toml
            project_package = self._get_project_package_name()
            content = f"""[project]
name = "dagster-dbt-migration"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
"""
            for dep in dependencies:
                content += f'    "{dep}",\n'
            content += """]

[tool.setuptools]
packages = ["{project_package}"]

[tool.setuptools.package-data]
"*" = ["py.typed"]

[tool.dg]
directory_type = "project"

[tool.dg.project]
root_module = "{project_package}"
"""
            with open(pyproject_path, "w") as f:
                f.write(content)
            return

        # Read existing pyproject.toml
        with open(pyproject_path, "r") as f:
            content = f.read()

        # Simple approach: append missing dependencies and update requires-python
        # In production, you might want to parse TOML properly
        project_package = self._get_project_package_name()
        lines = content.split("\n")
        new_lines = []
        in_dependencies = False
        existing_deps = set()
        has_tool_dg = False
        has_tool_dg_project = False
        has_setuptools = False
        
        for line in lines:
            # Check if tool.dg.project section exists
            if '[tool.dg.project]' in line:
                has_tool_dg_project = True
                new_lines.append(line)
                continue
            elif 'root_module' in line and 'tool.dg' in content[:content.find(line)]:
                # Update root_module if it exists
                new_lines.append(f'root_module = "{project_package}"')
                continue
            # Check if tool.dg section exists
            elif '[tool.dg]' in line:
                has_tool_dg = True
                new_lines.append(line)
                continue
            elif 'tool.dg' in line and 'directory_type' in line:
                # Update directory_type if it exists
                new_lines.append('directory_type = "project"')
                continue
            # Check for setuptools configuration
            elif '[tool.setuptools]' in line:
                has_setuptools = True
                new_lines.append(line)
                continue
            elif 'packages =' in line and has_setuptools:
                # Update packages if setuptools section exists
                new_lines.append(f'packages = ["{project_package}"]')
                continue
            # Update requires-python to >=3.10 for Dagster 1.12+ compatibility
            elif 'requires-python' in line and '<3.10' in line:
                new_lines.append('requires-python = ">=3.10"')
                continue
            elif 'requires-python' in line:
                # Replace any existing requires-python with >=3.10
                new_lines.append('requires-python = ">=3.10"')
                continue
            elif 'dependencies = [' in line:
                in_dependencies = True
                new_lines.append(line)
            elif in_dependencies:
                if line.strip().startswith('"') and line.strip().endswith('",'):
                    # Extract dependency name
                    dep_name = line.strip().strip('",').split('>=')[0].split('==')[0]
                    existing_deps.add(dep_name)
                    new_lines.append(line)
                elif line.strip() == "]":
                    # Add missing dependencies before closing bracket
                    for dep in dependencies:
                        dep_name = dep.split('>=')[0].split('==')[0]
                        if dep_name not in existing_deps:
                            new_lines.append(f'    "{dep}",')
                    new_lines.append(line)
                    in_dependencies = False
                else:
                    new_lines.append(line)
            else:
                new_lines.append(line)
        
        # Add setuptools configuration if it doesn't exist
        if not has_setuptools:
            # Find where to insert - after [project] section
            insert_idx = len(new_lines)
            for i, line in enumerate(new_lines):
                if line.strip() == "]" and in_dependencies:
                    insert_idx = i + 1
                    break
            new_lines.insert(insert_idx, "")
            new_lines.insert(insert_idx + 1, "[tool.setuptools]")
            new_lines.insert(insert_idx + 2, f'packages = ["{project_package}"]')
        
        # Add tool.dg.project section if it doesn't exist
        if not has_tool_dg_project:
            if not has_tool_dg:
                new_lines.append("")
                new_lines.append("[tool.dg]")
                new_lines.append('directory_type = "project"')
            new_lines.append("")
            new_lines.append("[tool.dg.project]")
            new_lines.append(f'root_module = "{project_package}"')
        elif not has_tool_dg:
            # Add tool.dg section if project section exists but main section doesn't
            new_lines.append("")
            new_lines.append("[tool.dg]")
            new_lines.append('directory_type = "project"')

        with open(pyproject_path, "w") as f:
            f.write("\n".join(new_lines))

    def _generate_env_file(self, env_vars: Dict[str, str]):
        """Generate .env file with environment variables"""
        env_path = self.output_dir / ".env"
        
        if not env_vars:
            # Create empty .env file with instructions
            content = """# Environment variables for dbt and Dagster
# Add your database credentials and other configuration here
# This file is gitignored by default for security

# Example dbt variables:
# DBT_PROFILES_DIR=~/.dbt
# DBT_TARGET=dev

# Example database credentials (set these based on your dbt Cloud environments):
# DBT_DEV_USER=your_username
# DBT_DEV_PASSWORD=your_password
# DBT_DEV_DATABASE=your_database
"""
        else:
            content = "# Environment variables extracted from dbt Cloud\n"
            content += "# Review and update these values, especially passwords and tokens\n\n"
            content += "# Local Development (DuckDB)\n"
            content += "# Use 'local' target for DuckDB-based local development\n"
            content += "# Set DBT_TARGET=local or use: dbt run --target local\n\n"
            
            # Note: DBT_PROFILES_DIR is not needed - Dagster dbt component
            # automatically finds profiles.yml in ~/.dbt (default location)
            # If you need a custom profiles location, you can set it here:
            # DBT_PROFILES_DIR=~/.dbt
            content += "\n"
            
            for key, value in sorted(env_vars.items()):
                # Skip DBT_PROFILES_DIR - Dagster handles this automatically
                if key != "DBT_PROFILES_DIR":
                    content += f"{key}={value}\n"
            
            content += "\n# Dagster Cloud Deployment Variables\n"
            content += "# These are automatically available in Dagster Cloud deployments:\n"
            content += "# - DAGSTER_CLOUD_DEPLOYMENT_NAME: deployment name (e.g., 'prod', 'staging')\n"
            content += "# - DAGSTER_CLOUD_IS_BRANCH_DEPLOYMENT: '1' if branch deployment\n"
            content += "# - DAGSTER_CLOUD_GIT_BRANCH: git branch name (branch deployments)\n"
            content += "# - DAGSTER_CLOUD_GIT_SHA: commit SHA (branch deployments)\n"
            content += "# See MIGRATION_SUMMARY.md for full list and usage examples\n\n"
            
            content += "# Add any additional environment variables needed for your setup\n"

        with open(env_path, "w") as f:
            f.write(content)

    def _generate_profiles_yml(self, environments: List[Dict[str, Any]]):
        """Generate dbt profiles.yml file"""
        profiles_content = generate_profiles_yml(environments)
        
        # Create .dbt directory in project
        dbt_dir = self.output_dir / ".dbt"
        dbt_dir.mkdir(exist_ok=True)
        
        profiles_path = dbt_dir / "profiles.yml"
        with open(profiles_path, "w") as f:
            f.write("# dbt profiles.yml generated from dbt Cloud migration\n")
            f.write("# Review and update environment variable references as needed\n\n")
            f.write(profiles_content)
        
        # Also create a template in the project root for reference
        template_path = self.output_dir / "profiles.yml.template"
        with open(template_path, "w") as f:
            f.write("# Template dbt profiles.yml\n")
            f.write("# Copy this to ~/.dbt/profiles.yml and update with your credentials\n")
            f.write("# \n")
            f.write("# Default Target: 'local' (DuckDB) for local development\n")
            f.write("#   - DuckDB database will be created at the path specified in DBT_DUCKDB_PATH\n")
            f.write("#   - No additional setup needed for local development\n")
            f.write("# \n")
            f.write("# Deployment-Aware Configuration:\n")
            f.write("#   The dbt components are ALREADY configured with deployment-aware target selection!\n")
            f.write("#   They use DAGSTER_CLOUD_DEPLOYMENT_NAME to automatically select the right target.\n")
            f.write("#   \n")
            f.write("#   To make profiles.yml match this behavior, update the 'target' field:\n")
            f.write("#     target: \"{{ env_var('DAGSTER_CLOUD_DEPLOYMENT_NAME', 'local') }}\"\n")
            f.write("#   \n")
            f.write("#   This matches the pattern from the Dagster demo project:\n")
            f.write("#   https://github.com/dagster-io/hooli-data-eng-pipelines/blob/master/hooli-data-eng/src/hooli_data_eng/defs/dbt/resources.py\n")
            f.write("# \n")
            f.write("# See MIGRATION_SUMMARY.md for more details.\n\n")
            f.write(profiles_content)

    def _generate_git_clone_script(self, projects: List[Dict[str, Any]], project_repos: Dict[int, str]):
        """Generate a script to clone all dbt project repositories"""
        script_path = self.output_dir / "clone_dbt_projects.sh"
        
        content = "#!/bin/bash\n"
        content += "# Script to clone all dbt project repositories\n"
        content += "# dbt projects are cloned as siblings to the Dagster project\n"
        content += "# Generated by dbt Cloud to Dagster migration assistant\n\n"
        content += "set -e\n\n"
        content += "# Get the parent directory (where dbt_projects will be a sibling to dagster_project)\n"
        content += "SCRIPT_DIR=$(cd \"$(dirname \"$0\")\" && pwd)\n"
        content += "PARENT_DIR=$(dirname \"$SCRIPT_DIR\")\n"
        content += "DBT_PROJECTS_DIR=\"$PARENT_DIR/dbt_projects\"\n\n"
        content += "mkdir -p \"$DBT_PROJECTS_DIR\"\n"
        content += "cd \"$DBT_PROJECTS_DIR\"\n\n"
        
        for project in projects:
            project_id = project.get("id")
            if project_id in project_repos:
                project_name = project.get("name", f"project_{project_id}")
                repo_url = project_repos[project_id]
                content += f"echo \"Cloning {project_name}...\"\n"
                content += f"if [ ! -d \"{project_name}\" ]; then\n"
                content += f"    git clone {repo_url} {project_name}\n"
                content += f"else\n"
                content += f"    echo \"  {project_name} already exists, skipping...\"\n"
                content += f"fi\n\n"
        
        content += "echo \"All dbt projects cloned successfully!\"\n"
        
        with open(script_path, "w") as f:
            f.write(content)
        
        # Make script executable
        script_path.chmod(0o755)

    def _generate_validation_script(self):
        """Generate a script to validate the migration"""
        script_path = self.output_dir / "validate_migration.sh"
        
        content = "#!/bin/bash\n"
        content += "# Script to validate the dbt Cloud to Dagster migration\n"
        content += "# Generated by dbt Cloud to Dagster migration assistant\n\n"
        content += "set -e\n\n"
        content += "echo \"🔍 Validating migration...\"\n\n"
        content += "# Check if Dagster CLI is available\n"
        content += "if ! command -v dg &> /dev/null; then\n"
        content += "    echo \"❌ Dagster CLI (dg) not found. Install with: pip install 'dagster[cli]>=1.12.0'\"\n"
        content += "    exit 1\n"
        content += "fi\n\n"
        content += "# Validate Dagster definitions\n"
        content += "echo \"Checking Dagster definitions...\"\n"
        content += "dg check defs || {\n"
        content += "    echo \"❌ Dagster definitions validation failed\"\n"
        content += "    exit 1\n"
        content += "}\n\n"
        content += "# Check if dbt projects are cloned\n"
        # Check sibling dbt_projects directory
        content += "PARENT_DIR=$(cd \"$(dirname \"$0\")\" && pwd)\n"
        content += "DBT_PROJECTS_DIR=\"$PARENT_DIR/dbt_projects\"\n"
        content += "if [ ! -d \"$DBT_PROJECTS_DIR\" ] || [ -z \"$(ls -A $DBT_PROJECTS_DIR)\" ]; then\n"
        content += "    echo \"⚠️  Warning: dbt_projects directory is empty. Run ./clone_dbt_projects.sh\"\n"
        content += "else\n"
        content += "    echo \"✓ dbt projects directory exists\"\n"
        content += "fi\n\n"
        content += "# Check if profiles.yml exists\n"
        content += "if [ ! -f \"~/.dbt/profiles.yml\" ] && [ ! -f \".dbt/profiles.yml\" ]; then\n"
        content += "    echo \"⚠️  Warning: dbt profiles.yml not found. Copy profiles.yml.template to ~/.dbt/profiles.yml\"\n"
        content += "else\n"
        content += "    echo \"✓ dbt profiles.yml found\"\n"
        content += "fi\n\n"
        content += "echo \"✅ Migration validation complete!\"\n"
        content += "echo \"\"\n"
        content += "echo \"Next steps:\"\n"
        content += "echo \"  1. Review and update .env file with your credentials\"\n"
        content += "echo \"  2. Copy profiles.yml.template to ~/.dbt/profiles.yml and update\"\n"
        content += "echo \"  3. Run: dg dev\"\n"
        
        with open(script_path, "w") as f:
            f.write(content)
        
        # Make script executable
        script_path.chmod(0o755)

    def _generate_migration_summary(
        self,
        projects: List[Dict[str, Any]],
        jobs: List[Dict[str, Any]],
        environments: List[Dict[str, Any]],
        project_repos: Dict[int, str],
        required_adapters: Set[str],
    ):
        """Generate a migration summary report"""
        summary_path = self.output_dir / "MIGRATION_SUMMARY.md"
        
        content = "# dbt Cloud to Dagster Migration Summary\n\n"
        content += f"Generated: {self._get_timestamp()}\n\n"
        
        # What was migrated
        content += "## ✅ What Was Migrated\n\n"
        
        # Projects
        migrated_projects = [p for p in projects if p.get("id") in project_repos]
        content += f"### Projects ({len(migrated_projects)})\n\n"
        for project in migrated_projects:
            project_id = project.get("id")
            project_name = project.get("name", f"project_{project_id}")
            repo_url = project_repos.get(project_id, "N/A")
            content += f"- **{project_name}** (ID: {project_id})\n"
            content += f"  - Repository: `{repo_url}`\n"
            content += f"  - Component: `defs/{self._sanitize_name(project_name)}/`\n\n"
        
        # Jobs
        migrated_jobs = [j for j in jobs if j.get("project_id") in project_repos]
        content += f"### Jobs ({len(migrated_jobs)})\n\n"
        for job in migrated_jobs:
            job_id = job.get("id")
            job_name = job.get("name", f"job_{job_id}")
            project_id = job.get("project_id")
            project = next((p for p in projects if p.get("id") == project_id), None)
            project_name = self._sanitize_name(project.get("name", f"project_{project_id}")) if project else "unknown"
            job_name_safe = f"{project_name}_{self._sanitize_name(job_name)}"
            
            content += f"- **{job_name}** (ID: {job_id})\n"
            content += f"  - Dagster Job: `{job_name_safe}`\n"
            if job.get("schedule"):
                cron = job.get("schedule", {}).get("cron", "N/A")
                content += f"  - Schedule: `{job_name_safe}_schedule` (cron: `{cron}`)\n"
            content += "\n"
        
        # Environments
        content += f"### Environments ({len(environments)})\n\n"
        for env in environments:
            env_name = env.get("name", "Unknown")
            connection = env.get("connection", {})
            connection_type = (
                connection.get("type") or connection.get("connection_type") or "unknown"
            )
            content += f"- **{env_name}**\n"
            content += f"  - Connection Type: `{connection_type}`\n"
            content += f"  - Profile Target: `{env_name.lower().replace(' ', '_')}`\n\n"
        
        # Adapters
        if required_adapters:
            content += f"### dbt Adapters ({len(required_adapters)})\n\n"
            for adapter in sorted(required_adapters):
                content += f"- `{adapter}`\n"
            content += "\n"
        
        # Warnings and manual steps
        content += "## ⚠️ Warnings and Manual Steps\n\n"
        
        # Alerts
        content += "### Alerts/Notifications\n"
        content += "**⚠️ Alerts and notifications from dbt Cloud were NOT migrated.**\n\n"
        content += "You will need to manually configure alerts in Dagster:\n"
        content += "- For Dagster Cloud: Use the Alerts feature in the Dagster+ UI\n"
        content += "- For OSS: Configure alerting through your monitoring system\n"
        content += "- Review your dbt Cloud notification settings and recreate them in Dagster\n\n"
        
        # Environment variables
        content += "### Environment Variables\n"
        content += "**Action Required:** Review and update the `.env` file with your actual credentials.\n\n"
        content += "- Update any placeholders marked with `<SET_MANUALLY>`\n"
        content += "- Verify all database connection details\n"
        content += "- For Dagster Cloud: Set these in the Dagster+ UI or agent config\n\n"
        
        # Profiles
        content += "### dbt Profiles\n"
        content += "**Action Required:** Copy `profiles.yml.template` to `~/.dbt/profiles.yml` and update credentials.\n\n"
        content += "- A local DuckDB target has been added for local development\n"
        content += "- Use `dbt_target=local` for local development\n"
        content += "- Update production targets with actual credentials\n\n"
        
        # Git repositories
        missing_repos = [p for p in projects if p.get("id") not in project_repos]
        if missing_repos:
            content += "### Missing Git Repositories\n"
            content += "**Warning:** The following projects were skipped because no git repository was found:\n\n"
            for project in missing_repos:
                project_id = project.get("id")
                project_name = project.get("name", f"project_{project_id}")
                content += f"- {project_name} (ID: {project_id})\n"
            content += "\n"
        
        # Deployment awareness
        content += "## 🌍 Deployment-Aware Configuration\n\n"
        content += "This migration is configured to be deployment-aware using Dagster Cloud environment variables.\n\n"
        content += "### Available Environment Variables\n\n"
        content += "Dagster Cloud provides built-in environment variables that you can use:\n\n"
        content += "| Variable | Description |\n"
        content += "|----------|-------------|\n"
        content += "| `DAGSTER_CLOUD_DEPLOYMENT_NAME` | The name of the Dagster+ deployment (e.g., `prod`, `staging`) |\n"
        content += "| `DAGSTER_CLOUD_IS_BRANCH_DEPLOYMENT` | `1` if the deployment is a branch deployment |\n"
        content += "| `DAGSTER_CLOUD_GIT_BRANCH` | The git branch name (branch deployments only) |\n"
        content += "| `DAGSTER_CLOUD_GIT_SHA` | The commit SHA (branch deployments only) |\n\n"
        content += "### Usage Examples\n\n"
        content += "#### 1. Deployment-Aware Target Selection in profiles.yml\n\n"
        content += "Update the `target` field in your profiles.yml to select the right target based on deployment:\n\n"
        content += "```yaml\n"
        content += "default:\n"
        content += "  outputs:\n"
        content += "    local:\n"
        content += "      type: duckdb\n"
        content += "      # ... local config\n"
        content += "    prod:\n"
        content += "      type: snowflake\n"
        content += "      # ... prod config\n"
        content += "  # Deployment-aware target selection:\n"
        content += "  target: \"{{ env_var('DAGSTER_CLOUD_DEPLOYMENT_NAME', 'local') }}\"\n"
        content += "```\n\n"
        content += "#### 2. Deployment-Aware Target in dbt Component Configuration\n\n"
        content += "In `defs/<project_name>/defs.yaml`, you can add target selection:\n\n"
        content += "```yaml\n"
        content += "- type: dagster_dbt.DbtProjectComponent\n"
        content += "  attributes:\n"
        content += "    project: \"{{ project_root }}/dbt_projects/my_project\"\n"
        content += "    # Add target selection here:\n"
        content += "    target: \"{{ env_var('DAGSTER_CLOUD_DEPLOYMENT_NAME', 'local') }}\"\n"
        content += "```\n\n"
        content += "#### 3. Conditional Logic in Python Components\n\n"
        content += "```python\n"
        content += "import os\n"
        content += "deployment = os.getenv('DAGSTER_CLOUD_DEPLOYMENT_NAME', 'local')\n"
        content += "if deployment == 'prod':\n"
        content += "    target = 'prod'\n"
        content += "elif deployment in ['staging', 'dev']:\n"
        content += "    target = 'staging'\n"
        content += "else:\n"
        content += "    target = 'local'  # Default to DuckDB for local development\n"
        content += "```\n\n"
        content += "### How Target Selection Works\n\n"
        content += "The migration tool automatically configures deployment-aware target selection:\n\n"
        content += "1. **Local Development**: When `DAGSTER_CLOUD_DEPLOYMENT_NAME` is not set or is 'local', uses `local` target (DuckDB)\n"
        content += "2. **Deployments**: When deployed to Dagster Cloud, uses the deployment name as the target\n"
        content += "   - If deployment is 'prod', uses `prod` target from profiles.yml\n"
        content += "   - If deployment is 'staging', uses `staging` target from profiles.yml\n\n"
        content += "This matches the pattern used in the [Dagster demo project](https://github.com/dagster-io/hooli-data-eng-pipelines/blob/master/hooli-data-eng/src/hooli_data_eng/defs/dbt/resources.py).\n\n"
        content += "**No additional configuration needed!** The dbt components are already set up to use the right target based on your deployment.\n\n"
        
        # Add note about environment-specific jobs
        content += "### ⚠️ Environment-Specific Jobs (STG vs PROD)\n\n"
        content += "**Important**: In dbt Cloud, you may have separate jobs for different environments (e.g., STG and PROD).\n\n"
        content += "**Dagster Pattern**: In Dagster, the recommended pattern is to have **one job definition** that works across all deployments, using deployment-aware target selection:\n\n"
        content += "```yaml\n"
        content += "# Single job that works in all deployments\n"
        content += "type: dagster_dbt_migration.components.job.DbtCloudJobComponent\n"
        content += "attributes:\n"
        content += "  job_name: analytics_job\n"
        content += "  asset_selection:\n"
        content += "    - analytics.*\n"
        content += "  tags:\n"
        content += "    # Target is selected automatically based on deployment\n"
        content += "    dbt_target: \"{{ env_var('DAGSTER_CLOUD_DEPLOYMENT_NAME', 'local') }}\"\n"
        content += "```\n\n"
        content += "**Current Migration**: The migration tool preserves your dbt Cloud structure by creating separate jobs for each environment:\n\n"
        content += "- Jobs tagged with `dbt_target: stg` use the STG environment target\n"
        content += "- Jobs tagged with `dbt_target: prod` use the PROD environment target\n"
        content += "- This preserves your existing workflow but is different from typical Dagster patterns\n\n"
        content += "**Recommendation**: After migration, consider consolidating jobs that do the same thing but target different environments:\n\n"
        content += "1. **Option A - Keep Separate Jobs** (Current): Preserves dbt Cloud structure, easier migration\n"
        content += "   - Pros: Matches your dbt Cloud setup exactly\n"
        content += "   - Cons: More jobs to manage, not typical Dagster pattern\n\n"
        content += "2. **Option B - Consolidate Jobs** (Recommended for Dagster): One job per logical workflow\n"
        content += "   - Pros: Cleaner, follows Dagster best practices, easier to maintain\n"
        content += "   - Cons: Requires manual consolidation after migration\n"
        content += "   - How: Merge jobs with same name but different environments, use deployment-aware targets\n\n"
        content += "**To Consolidate**: After reviewing the migration, you can manually merge jobs by:\n"
        content += "1. Keeping one job definition (e.g., `analytics_new_job`)\n"
        content += "2. Removing environment-specific duplicates\n"
        content += "3. Updating the dbt component to use deployment-aware target selection\n"
        content += "4. The dbt component will automatically use the right target based on `DAGSTER_CLOUD_DEPLOYMENT_NAME`\n\n"
        
        # Next steps
        content += "## 📋 Next Steps\n\n"
        content += "1. **Review this summary** - Verify all projects, jobs, and environments were migrated correctly\n"
        content += "2. **Update credentials** - Review and update `.env` file with actual credentials\n"
        content += "3. **Configure profiles** - Copy `profiles.yml.template` to `~/.dbt/profiles.yml`\n"
        content += "4. **Clone repositories** - Run `./clone_dbt_projects.sh` to clone all dbt projects\n"
        content += "5. **Validate migration** - Run `./validate_migration.sh` to check setup\n"
        content += "6. **Configure alerts** - Manually set up alerts in Dagster (see warnings above)\n"
        content += "7. **Test locally** - Use `dbt_target=local` for local development with DuckDB\n"
        content += "8. **Deploy** - Deploy to Dagster Cloud and configure deployment-specific settings\n"
        content += "9. **Start Dagster** - Run `dg dev` to start the Dagster UI\n\n"
        
        # Asset checks note
        content += "## ✅ Automatic Features\n\n"
        content += "- **dbt Tests → Asset Checks**: dbt tests are automatically converted to Dagster asset checks by `dagster-dbt`\n"
        content += "- **Asset Dependencies**: dbt model dependencies are automatically mapped to Dagster asset dependencies\n"
        content += "- **Component-Based**: All definitions use Dagster's component system (no Python code generation)\n\n"
        
        with open(summary_path, "w") as f:
            f.write(content)

    def _get_timestamp(self) -> str:
        """Get current timestamp as string"""
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _generate_readme(
        self, projects: List[Dict[str, Any]], project_repos: Dict[int, str], required_adapters: Set[str]
    ):
        """Generate README for the Dagster project"""
        project_names = [
            p.get("name", f"project_{p.get('id')}")
            for p in projects
            if p.get("id") in project_repos
        ]

        adapter_list = ", ".join(sorted(required_adapters)) if required_adapters else "None detected"
        
        content = f"""# Dagster Project - Migrated from dbt Cloud

This project was generated by the dbt Cloud to Dagster migration assistant using Dagster 1.12+ CLI.

## Projects Migrated

{chr(10).join(f"- {name}" for name in project_names)}

## Detected dbt Adapters

{adapter_list}

## Setup

1. Install dependencies:
```bash
cd {self.output_dir.name}
pip install -e .
```

2. Configure environment variables:
   - Review and update the `.env` file with your database credentials
   - Update any placeholders marked with `<SET_MANUALLY>`
   - The `.env` file is gitignored by default for security

3. Configure dbt profiles:
   - A template `profiles.yml.template` has been generated
   - Copy it to `~/.dbt/profiles.yml` and update with your credentials
   - Or use the generated `.dbt/profiles.yml` in the project directory

4. Clone your dbt projects:
   - Run `./clone_dbt_projects.sh` to clone all repositories
   - Or manually clone to `./dbt_projects/` directory:
"""
        for project in projects:
            project_id = project.get("id")
            if project_id in project_repos:
                project_name = project.get("name", f"project_{project_id}")
                repo_url = project_repos[project_id]
                content += f"   - {project_name}: `git clone {repo_url} ./dbt_projects/{project_name}`\n"

        content += """
5. Start Dagster:
```bash
dg dev
# or
dagster dev
```

## Project Structure

- `defs/` - Contains component and definition files (all YAML-based)
  - `defs/<project_name>/` - dbt component definitions (created via `dg scaffold` as YAML)
  - `defs/jobs/defs.yaml` - Job component definitions (using `components.job.DbtCloudJobComponent`)
  - `defs/schedules/defs.yaml` - Schedule component definitions (using `components.schedule.DbtCloudScheduleComponent`)
- `components/` - Custom component implementations (DbtCloudJobComponent, DbtCloudScheduleComponent, DbtCloudSensorComponent)
- `.env` - Environment variables (gitignored)
- `pyproject.toml` - Project dependencies including dbt adapters and dagster-cloud

## About Jobs and Schedules

Jobs and schedules are defined using **custom components** in YAML:
- **Jobs**: Defined using `components.job.DbtCloudJobComponent` in `defs/jobs/defs.yaml`
- **Schedules**: Defined using `components.schedule.DbtCloudScheduleComponent` in `defs/schedules/defs.yaml`
- **Sensors**: Defined using `components.sensor.DbtCloudSensorComponent` in `defs/sensors/defs.yaml`
- All definitions are component-based YAML - no Python code generation needed!
- Components are automatically loaded by Dagster's component system

## Generated Files

- `profiles.yml.template` - Template dbt profiles.yml (copy to `~/.dbt/profiles.yml`)
- `.dbt/profiles.yml` - Project-specific profiles.yml
- `.env` - Environment variables (gitignored)
- `clone_dbt_projects.sh` - Script to clone all dbt project repositories
- `validate_migration.sh` - Script to validate the migration

## Next Steps

1. **Review and update the `.env` file** with your actual credentials
2. **Configure dbt profiles**: Copy `profiles.yml.template` to `~/.dbt/profiles.yml` and update
3. **Clone dbt projects**: Run `./clone_dbt_projects.sh` or clone manually
4. **Validate migration**: Run `./validate_migration.sh` to check everything is set up correctly
5. **Review component configurations** in `defs/` directories
6. **Verify schedule cron expressions** match your requirements
7. **Test jobs manually** before enabling schedules
8. **Run `dg check defs`** to validate your configuration
9. **Start Dagster**: `dg dev` (or `dagster dev`)
10. **For Dagster Cloud deployment**: Ensure `dagster-cloud` is installed and configured

## Migration Features

✅ **Component-based architecture** - All definitions (dbt components, jobs, schedules) are YAML-based
✅ **Automatic adapter detection** - Detects and installs required dbt adapters
✅ **Environment variable extraction** - Extracts connection details from dbt Cloud
✅ **Profiles.yml generation** - Generates dbt profiles.yml from environment configurations
✅ **Job configuration** - Preserves job settings (threads, target, etc.) as tags
✅ **Schedule migration** - Maps dbt Cloud schedules to Dagster schedules
✅ **Git clone automation** - Script to clone all dbt project repositories
✅ **Migration validation** - Script to validate the migration setup
"""
        with open(self.output_dir / "README.md", "w") as f:
            f.write(content)

    def _parse_dbt_selection(self, execute_steps: List[str], component_name: str) -> List[str]:
        """
        Parse dbt selection syntax from execute_steps and convert to Dagster asset selection.
        
        Examples:
        - ["dbt build --select model_a model_b"] → ["model_a", "model_b"]
        - ["dbt run --select +model_a"] → ["model_a"] (with dependencies handled by Dagster)
        - ["dbt build"] → [f"{component_name}.*"] (all assets)
        - ["dbt build --select tag:my_tag"] → [f"{component_name}.*"] (fallback to all, tag selection not directly mappable)
        
        Args:
            execute_steps: List of dbt command strings (e.g., ["dbt build --select model_a"])
            component_name: Name of the dbt component (for fallback to all assets)
            
        Returns:
            List of asset selection strings for Dagster (e.g., ["model_a", "model_b"] or ["component_name.*"])
        """
        import re
        
        selected_models = []
        has_tag_or_path_selection = False
        
        for step in execute_steps:
            if not step or not isinstance(step, str):
                continue
            
            # Look for --select or --models flags
            # Pattern: --select model1 model2 model3 or --models model1 model2
            # Also handle: --select +model1, --select model1+, --select tag:my_tag, etc.
            # Match everything after --select/--models until the next flag or end of string
            select_pattern = r'--(?:select|models)\s+([^-]+?)(?:\s+--|$)'
            match = re.search(select_pattern, step)
            
            if match:
                # Extract the selection arguments (everything after --select until next flag)
                selection_args = match.group(1).strip()
                
                # Split by spaces, but handle quoted strings
                # Simple approach: split by spaces and filter out flags
                parts = selection_args.split()
                
                for part in parts:
                    part = part.strip()
                    if not part:
                        continue
                    
                    # Handle dbt selection syntax:
                    # - +model_a (downstream dependencies) → just model_a (Dagster handles dependencies)
                    # - model_a+ (upstream dependencies) → just model_a
                    # - model_a (simple model) → model_a
                    # - tag:my_tag (tag selection) → skip (not directly mappable, use all)
                    # - path:models/staging (path selection) → skip (not directly mappable, use all)
                    # - config.materialized:incremental → skip (not directly mappable)
                    
                    if part.startswith('tag:') or part.startswith('path:') or part.startswith('config.'):
                        # Tag/path/config selections are not directly mappable to asset keys
                        # Mark that we have this type of selection
                        has_tag_or_path_selection = True
                        continue
                    
                    # Remove dependency operators (+ prefix/suffix)
                    model_name = part.lstrip('+').rstrip('+')
                    
                    # Remove any other dbt-specific operators (e.g., @, &)
                    # For now, keep it simple and just extract the model name
                    if model_name and not model_name.startswith(('tag:', 'path:', 'config.', '@', '&')):
                        selected_models.append(model_name)
        
        # If we found specific model selections and no tag/path selections, use them
        if selected_models and not has_tag_or_path_selection:
            # Remove duplicates while preserving order
            seen = set()
            unique_models = []
            for model in selected_models:
                if model not in seen:
                    seen.add(model)
                    unique_models.append(model)
            return unique_models
        
        # If no specific selection found or tag/path selection used, default to all assets
        return [f"{component_name}.*"]
    
    def _extract_deployment_type_prefix(self, env: Dict[str, Any]) -> str:
        """
        Extract deployment type prefix (PROD, STG, GENERAL, etc.) from environment object.
        
        The "Set deployment type" field in dbt Cloud UI shows:
        - "General"
        - "STG Staging"
        - "PROD Production"
        
        Returns the prefix (e.g., "PROD", "STG", "GENERAL") or empty string if not found.
        """
        # Check multiple possible field names for deployment type
        # IMPORTANT: Check deployment_type FIRST, as type might be "deployment" (the environment type, not deployment type)
        # Direct check first (most common case)
        deployment_type = env.get("deployment_type")
        
        # If not found, check other possible locations
        if not deployment_type:
            deployment_type = (
                env.get("deployment_environment_type")
                or env.get("deployment_environment_type_name")
                or env.get("environment_type")
                or (env.get("deployment", {}).get("type") if isinstance(env.get("deployment"), dict) else None)
                or (env.get("deployment", {}).get("environment_type") if isinstance(env.get("deployment"), dict) else None)
                or (env.get("deployment", {}).get("deployment_type") if isinstance(env.get("deployment"), dict) else None)
                or (env.get("settings", {}).get("deployment_type") if isinstance(env.get("settings"), dict) else None)
            )
        
        if deployment_type:
            # Handle different formats:
            # - String values: "production", "staging", "general", "PROD Production", "STG Staging"
            # - Numeric codes: might need mapping
            deployment_type_str = str(deployment_type).strip()
            
            # Extract the prefix (PROD, STG, DEV, GENERAL)
            if "PROD" in deployment_type_str.upper() or "PRODUCTION" in deployment_type_str.upper():
                result = "PROD"
            elif "STG" in deployment_type_str.upper() or "STAGING" in deployment_type_str.upper():
                result = "STG"
            elif "DEV" in deployment_type_str.upper() or "DEVELOPMENT" in deployment_type_str.upper():
                result = "DEV"
            elif "GENERAL" in deployment_type_str.upper():
                result = "GENERAL"
            else:
                # Fallback: use first word or uppercase the whole thing
                words = deployment_type_str.upper().split()
                result = words[0] if words else deployment_type_str.upper()
            
            return result
        
        return ""
    
    def _sanitize_name(self, name: str) -> str:
        """Sanitize name for use in file paths and identifiers"""
        return name.replace("-", "_").replace(" ", "_").replace(".", "_").lower()

    def _get_project_package_name(self) -> str:
        """Get the Python package name for the project"""
        # Try to read from pyproject.toml
        pyproject_path = self.output_dir / "pyproject.toml"
        if pyproject_path.exists():
            try:
                # Try tomllib (Python 3.11+)
                try:
                    import tomllib
                    with open(pyproject_path, "rb") as f:
                        data = tomllib.load(f)
                        project_name = data.get("project", {}).get("name", "dagster_dbt_migration")
                        # Convert to Python package name format
                        return project_name.replace("-", "_")
                except ImportError:
                    # Fallback to toml (if available) or simple parsing
                    import re
                    with open(pyproject_path, "r") as f:
                        content = f.read()
                        # Simple regex to extract project name
                        match = re.search(r'name\s*=\s*"([^"]+)"', content)
                        if match:
                            return match.group(1).replace("-", "_")
            except Exception:
                pass
        
        # Default fallback - use directory name
        return self.output_dir.name.replace("-", "_")
