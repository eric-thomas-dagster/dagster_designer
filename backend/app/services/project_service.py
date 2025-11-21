"""Service for managing pipeline projects."""

import json
import uuid
import subprocess
import toml
import sys
import venv
import yaml
import asyncio
from pathlib import Path
from datetime import datetime
from typing import Dict, Tuple

from ..core.config import settings
from ..models.project import Project, ProjectCreate, ProjectUpdate
from ..models.partition import PartitionConfig
from .component_registry import component_registry
from .partition_service import partition_service

# Track dependency installation status for each project
# {project_id: {'status': 'installing|success|error', 'error': str|None, 'output': str|None}}
_dependency_status: Dict[str, Dict[str, str]] = {}
_dependency_locks: Dict[str, asyncio.Lock] = {}


class ProjectService:
    """Service for project CRUD operations."""

    def __init__(self):
        self.projects_dir = settings.projects_dir

    def _cleanup_orphaned_projects(self):
        """Clean up orphaned project files from failed creation attempts.

        Handles two types of orphans:
        1. Orphaned directories: Project directories without corresponding JSON metadata
        2. Orphaned JSON: JSON metadata files without corresponding project directories

        This ensures the projects directory stays clean after failed creation attempts.
        """
        import shutil

        # Find all JSON files and their corresponding directories
        json_files = set()
        for json_path in self.projects_dir.glob("*.json"):
            try:
                with open(json_path, 'r') as f:
                    data = json.load(f)
                    project_id = data.get('id')
                    directory_name = data.get('directory_name')

                    if project_id and directory_name:
                        json_files.add((project_id, directory_name, json_path))
            except Exception as e:
                print(f"⚠️  Error reading project JSON {json_path}: {e}")
                continue

        # Find all project directories
        project_dirs = {}
        for item in self.projects_dir.iterdir():
            if item.is_dir() and item.name.startswith('project_'):
                project_dirs[item.name] = item

        # Check for orphaned directories (directory exists but no JSON)
        json_dir_names = {dir_name for _, dir_name, _ in json_files}
        orphaned_dirs = set(project_dirs.keys()) - json_dir_names

        for dir_name in orphaned_dirs:
            dir_path = project_dirs[dir_name]
            print(f"⚠️  Found orphaned directory from failed attempt: {dir_name}")
            print(f"🧹 Cleaning up orphaned directory...")
            shutil.rmtree(dir_path)
            print(f"✅ Removed orphaned directory: {dir_name}")

        # Check for orphaned JSON (JSON exists but no directory)
        for project_id, dir_name, json_path in json_files:
            if dir_name not in project_dirs:
                print(f"⚠️  Found orphaned JSON metadata from failed attempt: {json_path.name}")
                print(f"   Expected directory: {dir_name}")
                print(f"🧹 Cleaning up orphaned JSON...")
                json_path.unlink()
                print(f"✅ Removed orphaned JSON: {json_path.name}")

    def _get_project_file(self, project_id: str) -> Path:
        """Get the file path for a project."""
        return self.projects_dir / f"{project_id}.json"

    def _get_project_dir(self, project: Project) -> Path:
        """Get the directory path for a project.

        Uses the sanitized directory_name if available, otherwise falls back to project.id
        for backwards compatibility with old projects.
        """
        if project.directory_name:
            return self.projects_dir / project.directory_name
        return self.projects_dir / project.id

    def create_project(self, project_create: ProjectCreate) -> Project:
        """Create a new project."""
        print(f"\n{'='*60}")
        print(f"🚀 Creating new project: {project_create.name}")
        print(f"{'='*60}")

        # Clean up any orphaned files from previous failed attempts
        self._cleanup_orphaned_projects()

        project_id = str(uuid.uuid4())
        print(f"📋 Generated project ID: {project_id}")
        if project_create.git_repo:
            print(f"🔗 Git repo URL: {project_create.git_repo}")
            print(f"🌿 Git branch: {project_create.git_branch}")

        project = Project(
            id=project_id,
            name=project_create.name,
            description=project_create.description,
            git_repo=project_create.git_repo,
            git_branch=project_create.git_branch,
            is_imported=bool(project_create.git_repo),  # Mark as imported if created from git repo
        )

        # If git repo specified, clone first to detect project type
        is_existing_dagster_project = False
        if project.git_repo:
            import tempfile
            import shutil
            import subprocess
            from .git_service import GitService

            # Clone to temporary directory first to detect project type
            with tempfile.TemporaryDirectory() as temp_dir:
                print(f"📦 Cloning git repository to temporary location...")

                # Parse the GitHub URL to extract repo, branch, and subdirectory
                print(f"🔗🔗🔗 RAW GIT URL RECEIVED: {project.git_repo}")
                parsed = GitService.parse_github_url(project.git_repo)
                repo_url = parsed['repo_url']
                branch = parsed['branch'] if parsed['branch'] != 'main' else project.git_branch
                subdir = parsed['subdir']

                print(f"   URL: {repo_url}")
                print(f"   Branch: {branch}")
                print(f"🔗🔗🔗 PARSED SUBDIRECTORY: {subdir}")
                if subdir:
                    print(f"   Subdirectory: {subdir}")

                # Extract repo name from URL
                repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
                temp_repo_dir = Path(temp_dir) / repo_name

                try:
                    # Try to clone with the specified branch
                    result = subprocess.run(
                        ["git", "clone", "--depth", "1", "-b", branch, repo_url, str(temp_repo_dir)],
                        capture_output=True,
                        text=True,
                    )

                    # If clone failed because branch not found, try to detect default branch
                    if result.returncode != 0 and "not found in upstream" in result.stderr:
                        print(f"⚠️  Branch '{branch}' not found, detecting default branch...")

                        # Get the default branch using git ls-remote
                        ls_remote_result = subprocess.run(
                            ["git", "ls-remote", "--symref", repo_url, "HEAD"],
                            capture_output=True,
                            text=True,
                            check=True,
                        )

                        # Parse output like: "ref: refs/heads/master	HEAD"
                        default_branch = "main"  # fallback
                        for line in ls_remote_result.stdout.split('\n'):
                            if line.startswith('ref:'):
                                default_branch = line.split('/')[-1].split('\t')[0].strip()
                                break

                        print(f"✅ Detected default branch: {default_branch}")

                        # Try cloning with the detected default branch
                        result = subprocess.run(
                            ["git", "clone", "--depth", "1", "-b", default_branch, repo_url, str(temp_repo_dir)],
                            capture_output=True,
                            text=True,
                            check=True,
                        )
                    elif result.returncode != 0:
                        # Some other git error occurred
                        raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)

                    # Determine which directory to analyze (root or subdirectory)
                    if subdir:
                        analyze_dir = temp_repo_dir / subdir
                        if not analyze_dir.exists():
                            print(f"⚠️  Warning: Subdirectory '{subdir}' not found in repository")
                            print(f"   Using root directory instead")
                            analyze_dir = temp_repo_dir
                        else:
                            print(f"✅ Using subdirectory: {subdir}")
                    else:
                        analyze_dir = temp_repo_dir

                    print(f"Successfully cloned repository to {analyze_dir}")

                    # Auto-detect project type
                    project_type = self._detect_project_type(analyze_dir)
                    print(f"🔍 Detected project type: {project_type}")

                    # Now set the proper directory_name
                    module_name = project.name.lower().replace(" ", "_").replace("-", "_")
                    if module_name and module_name[0].isdigit():
                        module_name = f"project_{module_name}"
                    project.directory_name = f"project_{project.id.split('-')[0]}_{module_name}"

                    if project_type == "dagster":
                        print(f"ℹ️  Detected existing Dagster project - using as-is")
                        is_existing_dagster_project = True

                        # Move the cloned Dagster project to final location
                        project_dir = self._get_project_dir(project)
                        print(f"📁 Moving Dagster project to {project_dir}")
                        shutil.move(str(analyze_dir), str(project_dir))
                        print(f"✅ Dagster project moved to {project_dir}")

                        # Save project metadata
                        self._save_project(project)
                    elif project_type == "dbt":
                        # Scaffold Dagster wrapper project FIRST
                        print(f"🏗️  Scaffolding Dagster wrapper project for dbt...")
                        self._scaffold_project_with_create_dagster(project)
                        self._save_project(project)

                        # Move dbt repo into scaffolded project
                        project_dir = self._get_project_dir(project)
                        # Use subdirectory name or repo name for the target directory
                        target_name = Path(subdir).name if subdir else repo_name
                        dbt_target_dir = project_dir / target_name
                        print(f"📁 Moving dbt project to {dbt_target_dir}")
                        shutil.move(str(analyze_dir), str(dbt_target_dir))

                        # Add dbt component with translator to resolve key conflicts
                        from ..models.component import ComponentInstance
                        # Use directory name as module name (with hyphens replaced by underscores)
                        full_module_name = project.directory_name.replace("-", "_")
                        component_module = f"{full_module_name}.dagster_designer_components.DbtProjectWithTranslatorComponent"
                        dbt_component = ComponentInstance(
                            id=f"dbt-{uuid.uuid4().hex[:8]}",
                            component_type=component_module,
                            label=f"{project.name} dbt",
                            attributes={
                                "project": target_name,
                            },
                            is_asset_factory=True,
                        )
                        project.components.append(dbt_component)
                        # Create/enhance profiles.yml and .env for dbt
                        self._create_dbt_profiles(dbt_target_dir, project_dir)

                        # Generate YAML files for all components
                        print(f"📝 Generating component YAML files...")
                        self._generate_component_yaml_files(project)

                        # Generate definitions.py with asset customizations
                        print(f"📝 Generating definitions.py...")
                        self._generate_definitions_with_asset_customizations(project)

                        self._save_project(project)
                    elif project_type == "multi-dbt":
                        # Multiple dbt projects detected - scaffold Dagster project and create components for each
                        print(f"ℹ️  Multiple dbt projects detected - creating components for each...")
                        dbt_projects = self._find_dbt_projects_recursive(analyze_dir)

                        if dbt_projects:
                            print(f"📦 Found {len(dbt_projects)} dbt projects:")
                            # Store relative paths BEFORE moving the directory
                            dbt_project_relative_paths = []
                            for dbt_proj in dbt_projects:
                                rel_path = dbt_proj.relative_to(analyze_dir)
                                dbt_project_relative_paths.append(rel_path)
                                print(f"   - {rel_path}")

                            # Scaffold Dagster wrapper project
                            self._scaffold_project_with_create_dagster(project)
                            self._save_project(project)

                            # Move the repository to the project directory
                            project_dir = self._get_project_dir(project)
                            target_dir = project_dir / repo_name
                            print(f"📁 Moving repository to {target_dir}")
                            shutil.move(str(analyze_dir), str(target_dir))

                            # Create a component for each dbt project found
                            from ..models.component import ComponentInstance
                            # Use directory name as module name (with hyphens replaced by underscores)
                            full_module_name = project.directory_name.replace("-", "_")
                            component_module = f"{full_module_name}.dagster_designer_components.DbtProjectWithTranslatorComponent"

                            print(f"📦 Creating {len(dbt_project_relative_paths)} dbt components...")
                            for relative_path in dbt_project_relative_paths:
                                component_path = repo_name / relative_path
                                component_name = relative_path.name

                                print(f"📦 Creating dbt component for: {component_path}")

                                dbt_component = ComponentInstance(
                                    id=f"dbt-{uuid.uuid4().hex[:8]}",
                                    component_type=component_module,
                                    label=f"{component_name}",
                                    attributes={
                                        "project": str(component_path),
                                    },
                                    is_asset_factory=True,
                                )
                                project.components.append(dbt_component)

                                # Create/enhance profiles.yml for this dbt project
                                dbt_target_dir = project_dir / component_path
                                self._create_dbt_profiles(dbt_target_dir, project_dir)

                            # Generate YAML files for all components
                            print(f"📝 Generating component YAML files...")
                            self._generate_component_yaml_files(project)

                            # Generate definitions.py with asset customizations
                            print(f"📝 Generating definitions.py...")
                            self._generate_definitions_with_asset_customizations(project)

                            self._save_project(project)
                    else:
                        # Unknown project type - check for multiple dbt projects in subdirectories
                        print(f"ℹ️  Unknown project type - checking for dbt projects in subdirectories...")
                        dbt_projects = self._find_dbt_projects_recursive(analyze_dir)

                        if dbt_projects:
                            # Found dbt projects in subdirectories - treat as multi-dbt-project
                            print(f"📦 Found {len(dbt_projects)} dbt project(s) - creating components for each")

                            # Scaffold Dagster wrapper project FIRST
                            print(f"🏗️  Scaffolding Dagster wrapper project...")
                            self._scaffold_project_with_create_dagster(project)
                            self._save_project(project)

                            # Move cloned repo into scaffolded project
                            project_dir = self._get_project_dir(project)
                            target_dir = project_dir / repo_name
                            print(f"📁 Moving repository to {target_dir}")
                            shutil.move(str(analyze_dir), str(target_dir))

                            # Create a component for each dbt project found
                            from ..models.component import ComponentInstance
                            # Use directory name as module name (with hyphens replaced by underscores)
                            full_module_name = project.directory_name.replace("-", "_")
                            component_module = f"{full_module_name}.dagster_designer_components.DbtProjectWithTranslatorComponent"

                            for dbt_project_path in dbt_projects:
                                # Calculate relative path from the target_dir
                                relative_path = dbt_project_path.relative_to(analyze_dir)
                                component_path = repo_name / relative_path
                                component_name = relative_path.name

                                print(f"📦 Creating dbt component for: {component_path}")

                                dbt_component = ComponentInstance(
                                    id=f"dbt-{uuid.uuid4().hex[:8]}",
                                    component_type=component_module,
                                    label=f"{component_name}",
                                    attributes={
                                        "project": str(component_path),
                                    },
                                    is_asset_factory=True,
                                )
                                project.components.append(dbt_component)

                                # Create/enhance profiles.yml for this dbt project
                                dbt_target_dir = project_dir / component_path
                                self._create_dbt_profiles(dbt_target_dir, project_dir)

                            # Generate YAML files for all components
                            print(f"📝 Generating component YAML files...")
                            self._generate_component_yaml_files(project)

                            # Generate definitions.py with asset customizations
                            print(f"📝 Generating definitions.py...")
                            self._generate_definitions_with_asset_customizations(project)

                            self._save_project(project)

                        else:
                            # No dbt projects found - scaffold as generic wrapper
                            print(f"ℹ️  No dbt projects found - scaffolding generic Dagster wrapper...")
                            self._scaffold_project_with_create_dagster(project)
                            self._save_project(project)

                            # Move cloned files into scaffolded project
                            project_dir = self._get_project_dir(project)
                            target_dir = project_dir / repo_name
                            print(f"📁 Moving repository to {target_dir}")
                            shutil.move(str(analyze_dir), str(target_dir))

                except subprocess.CalledProcessError as e:
                    raise ValueError(f"Failed to clone repository: {e.stderr}")
        else:
            # No git repo - scaffold empty project
            print(f"🏗️  Scaffolding project structure with create-dagster...")
            self._scaffold_project_with_create_dagster(project)
            self._save_project(project)

        # Skip dependency installation during creation - will be done asynchronously
        # This allows the project to be returned to the user immediately (fast!)
        # Dependencies will be installed in the background via install_dependencies_async
        print(f"⏭️  Skipping dependency installation during creation (will install in background)")

        # For existing Dagster projects, skip scaffolding/generation steps
        if not is_existing_dagster_project:
            # Add components using dg scaffold (must come AFTER dependency installation)
            if project.components:
                print(f"📦 Scaffolding {len(project.components)} components...")
                self._scaffold_components(project)

            # Copy designer component classes (needed for custom primitives)
            print(f"📝 Copying designer component classes...")
            self._copy_component_classes_to_project(project)

            # Update pyproject.toml to register designer components (without .lib)
            self._update_pyproject_registry(project)

            # Generate definitions.py with custom lineage support
            print(f"📝 Generating definitions.py...")
            self._generate_definitions_with_asset_customizations(project)
        else:
            print(f"ℹ️  Skipping scaffolding steps - using existing Dagster project as-is")

        print(f"✅ Project {project.name} created successfully!")
        print(f"{'='*60}\n")
        return project

    def import_project(self, project_path: str) -> Project:
        """Import an existing Dagster project from disk.

        Args:
            project_path: Absolute path to the existing Dagster project directory

        Returns:
            Project object for the imported project

        Raises:
            ValueError: If the path is invalid or not a valid Dagster project
        """
        import shutil

        print(f"\n{'='*60}")
        print(f"📦 Importing existing Dagster project from: {project_path}")
        print(f"{'='*60}")

        # Validate path
        source_path = Path(project_path).resolve()
        if not source_path.exists():
            raise ValueError(f"Path does not exist: {project_path}")

        if not source_path.is_dir():
            raise ValueError(f"Path is not a directory: {project_path}")

        # Check if it's a valid Dagster project by looking for pyproject.toml
        pyproject_file = source_path / "pyproject.toml"
        if not pyproject_file.exists():
            raise ValueError(f"Not a valid Dagster project (missing pyproject.toml): {project_path}")

        # Try to read pyproject.toml to extract project name
        try:
            with open(pyproject_file, "r") as f:
                pyproject_data = toml.load(f)
            project_name = pyproject_data.get("project", {}).get("name", source_path.name)
        except Exception as e:
            print(f"⚠️  Warning: Could not read pyproject.toml: {e}")
            project_name = source_path.name

        # Generate new project ID
        project_id = str(uuid.uuid4())
        print(f"📋 Generated project ID: {project_id}")

        # Sanitize project name for directory
        module_name = project_name.lower().replace(" ", "_").replace("-", "_")
        if module_name and module_name[0].isdigit():
            module_name = f"project_{module_name}"

        # Create directory name
        dir_name = f"project_{project_id.split('-')[0]}_{module_name}"

        # Create project object
        project = Project(
            id=project_id,
            name=project_name,
            description=f"Imported from {project_path}",
            directory_name=dir_name,
            is_imported=True,  # Mark as imported
        )

        # Copy project to projects directory
        dest_path = self._get_project_dir(project)
        print(f"📁 Copying project to: {dest_path}")

        try:
            # Copy the entire project directory
            shutil.copytree(source_path, dest_path, symlinks=False, ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc'))
            print(f"✅ Project files copied")
        except Exception as e:
            raise ValueError(f"Failed to copy project: {e}")

        # Check if virtualenv exists in the copied project
        venv_dir = dest_path / ".venv"
        if venv_dir.exists():
            print(f"🔄 Removing existing virtual environment...")
            shutil.rmtree(venv_dir)

        # Install dependencies with uv
        print(f"📥 Installing project dependencies with uv...")
        self._install_dependencies_with_uv(project)

        # Inject custom lineage loading logic into definitions.py
        print(f"🔧 Injecting custom lineage support into definitions.py...")
        self._inject_custom_lineage_logic(project)

        # Discover existing components in the project
        print(f"🔍 Discovering components in imported project...")
        self._discover_components(project)

        # Save project metadata
        print(f"💾 Saving project metadata...")
        self._save_project(project)

        print(f"✅ Project {project.name} imported successfully!")
        print(f"{'='*60}\n")
        return project

    def get_project(self, project_id: str) -> Project | None:
        """Get a project by ID."""
        project_file = self._get_project_file(project_id)

        if not project_file.exists():
            return None

        with open(project_file, "r") as f:
            data = json.load(f)
            return Project(**data)

    def list_projects(self) -> list[Project]:
        """List all projects."""
        projects = []

        for project_file in self.projects_dir.glob("*.json"):
            try:
                with open(project_file, "r") as f:
                    data = json.load(f)
                    projects.append(Project(**data))
            except Exception:
                # Skip invalid project files
                continue

        # Sort by updated_at descending
        projects.sort(key=lambda p: p.updated_at, reverse=True)
        return projects

    def list_projects_summary(self) -> list[dict]:
        """List all projects with minimal metadata (optimized for large lists).

        This method only parses the essential fields from JSON files,
        skipping heavy data like graph nodes/edges and components.
        Much faster than list_projects() for displaying project lists.
        """
        from ..models.project import ProjectSummary

        projects = []

        for project_file in self.projects_dir.glob("*.json"):
            try:
                with open(project_file, "r") as f:
                    data = json.load(f)
                    # Only extract the fields we need for the list view
                    summary = ProjectSummary(
                        id=data.get("id"),
                        name=data.get("name"),
                        description=data.get("description"),
                        created_at=data.get("created_at"),
                        updated_at=data.get("updated_at"),
                        git_repo=data.get("git_repo"),
                        is_imported=data.get("is_imported", False),
                    )
                    projects.append(summary)
            except Exception as e:
                # Skip invalid project files
                print(f"Skipping invalid project file {project_file}: {e}")
                continue

        # Sort by updated_at descending
        projects.sort(key=lambda p: p.updated_at, reverse=True)
        return projects

    def update_project(self, project_id: str, project_update: ProjectUpdate) -> Project | None:
        """Update a project."""
        import sys
        from ..models.component import ComponentInstance
        from ..models.graph import PipelineGraph

        print(f"\n[update_project] ====== START ======", flush=True)
        print(f"[update_project] project_id: {project_id}", flush=True)
        sys.stdout.flush()

        project = self.get_project(project_id)
        if not project:
            print(f"[update_project] Project not found!", flush=True)
            return None

        # Update fields
        update_data = project_update.model_dump(exclude_unset=True)
        print(f"[update_project] update_data keys: {list(update_data.keys())}", flush=True)
        print(f"[update_project] 'components' in update_data: {'components' in update_data}", flush=True)
        print(f"[update_project] 'graph' in update_data: {'graph' in update_data}", flush=True)

        if "components" in update_data:
            print(f"[update_project] Number of components: {len(update_data['components'])}", flush=True)
        if "graph" in update_data:
            print(f"[update_project] Graph has {len(update_data['graph'].get('nodes', []))} nodes", flush=True)
        sys.stdout.flush()

        # Convert dicts to proper Pydantic models before setting
        for field, value in update_data.items():
            if field == "components" and isinstance(value, list):
                # Reconstruct ComponentInstance objects
                reconstructed_components = []
                for comp in value:
                    if isinstance(comp, dict):
                        reconstructed_components.append(ComponentInstance(**comp))
                    else:
                        reconstructed_components.append(comp)
                setattr(project, field, reconstructed_components)
                print(f"[update_project] Reconstructed {len(reconstructed_components)} components", flush=True)
            elif field == "graph" and isinstance(value, dict):
                # Reconstruct PipelineGraph object
                reconstructed_graph = PipelineGraph(**value)
                setattr(project, field, reconstructed_graph)
                print(f"[update_project] Reconstructed graph with {len(reconstructed_graph.nodes)} nodes", flush=True)
            elif field == "custom_lineage" and isinstance(value, list):
                # Reconstruct CustomLineageEdge objects
                from ..models.project import CustomLineageEdge
                reconstructed_lineage = []
                for edge in value:
                    if isinstance(edge, dict):
                        reconstructed_lineage.append(CustomLineageEdge(**edge))
                    else:
                        reconstructed_lineage.append(edge)
                setattr(project, field, reconstructed_lineage)
                print(f"[update_project] Reconstructed {len(reconstructed_lineage)} custom lineage edges", flush=True)
            else:
                setattr(project, field, value)

        # If components were updated, inject dependencies and reinstall
        if "components" in update_data:
            print(f"[update_project] Components updated! Calling YAML generation...", flush=True)
            sys.stdout.flush()
            self._update_project_dependencies(project)
            self._install_project_dependencies(project)
            # Generate YAML files for primitive components (job, schedule, sensor, asset_check)
            self._generate_component_yaml_files(project)
            # Generate definitions.py with asset customizations
            self._generate_definitions_with_asset_customizations(project)
            print(f"[update_project] YAML generation and definitions completed", flush=True)
        elif "graph" in update_data:
            # If graph was updated, check if any nodes have partition_config and apply them
            print(f"[update_project] Graph updated! Checking for partition configs...", flush=True)
            sys.stdout.flush()

            nodes_with_partition_configs = []
            for node in project.graph.nodes:
                if node.data and node.data.get("partition_config"):
                    nodes_with_partition_configs.append(node)
                    print(f"[update_project] Found partition config on node: {node.id}", flush=True)

            if nodes_with_partition_configs:
                print(f"[update_project] Applying partition configs to {len(nodes_with_partition_configs)} component(s)...", flush=True)
                # Find matching components and apply partition configs
                for node in nodes_with_partition_configs:
                    # Find the component instance that matches this node
                    component_found = False
                    for component in project.components:
                        if component.id == node.id:
                            print(f"[update_project] Applying partition config to registered component: {component.id}", flush=True)
                            self._apply_component_partition_config(project, component)
                            component_found = True
                            break

                    # If not found in registered components, it might be a community component
                    # Create a pseudo-component object for the partition service
                    if not component_found:
                        print(f"[update_project] Applying partition config to community component: {node.id}", flush=True)
                        # Create a simple object with just an id attribute
                        class PseudoComponent:
                            def __init__(self, component_id):
                                self.id = component_id

                        pseudo_component = PseudoComponent(node.id)
                        self._apply_component_partition_config(project, pseudo_component)
                print(f"[update_project] Partition config application completed", flush=True)
            else:
                print(f"[update_project] No partition configs found in graph", flush=True)
        else:
            print(f"[update_project] Neither components nor graph in update_data, skipping generation", flush=True)

        project.updated_at = datetime.now()
        self._save_project(project)
        print(f"[update_project] ====== END ======\n", flush=True)
        sys.stdout.flush()
        return project

    def discover_components_for_project(self, project_id: str) -> Project | None:
        """Discover components from YAML files in an existing project.

        This is useful for imported projects or when components are manually added.

        Args:
            project_id: The project ID

        Returns:
            Updated project with discovered components, or None if project not found
        """
        project = self.get_project(project_id)
        if not project:
            return None

        print(f"\n{'='*60}")
        print(f"🔍 Discovering components for project: {project.name}")
        print(f"{'='*60}")

        # Clear existing components before discovery
        original_count = len(project.components)
        project.components = []
        print(f"Cleared {original_count} existing components")

        # Discover components
        self._discover_components(project)

        # Save the updated project
        project.updated_at = datetime.now()
        self._save_project(project)

        print(f"✅ Component discovery complete! Found {len(project.components)} components")
        print(f"{'='*60}\n")

        return project

    def delete_project(self, project_id: str) -> bool:
        """Delete a project and its associated files."""
        import shutil

        project_file = self._get_project_file(project_id)

        if not project_file.exists():
            return False

        # Get project to find its directory
        project = self.get_project(project_id)

        # Delete project directory if it exists
        if project:
            project_dir = self._get_project_dir(project)
            if project_dir.exists():
                print(f"🗑️  Deleting project directory: {project_dir}")
                shutil.rmtree(project_dir)
                print(f"✅ Project directory deleted")

        # Delete project JSON file
        project_file.unlink()
        print(f"✅ Project metadata deleted")

        return True

    def clone_repo_for_project(self, project_id: str, git_repo: str, git_branch: str = "main") -> tuple[Project, str] | None:
        """Clone a git repository for an existing project.

        Returns:
            Tuple of (updated project, repo directory name) or None if project not found.
        """
        project = self.get_project(project_id)
        if not project:
            return None

        # Update project with git info
        project.git_repo = git_repo
        project.git_branch = git_branch
        project.updated_at = datetime.now()

        # Clone the repository
        result = self._clone_git_repo(project)
        repo_name = ""
        if result:
            repo_dir, repo_name = result
            print(f"Successfully cloned repository to {repo_dir}")

        self._save_project(project)
        return project, repo_name

    def _save_project(self, project: Project):
        """Save a project to disk."""
        project_file = self._get_project_file(project.id)

        with open(project_file, "w") as f:
            json.dump(project.model_dump(mode="json"), f, indent=2, default=str)

        # NOTE: We no longer write a root defs.yaml file because we use the modern
        # subdirectory structure where each component has its own defs.yaml in a subdirectory.
        # Writing both causes conflicts with Dagster's load_from_defs_folder.
        # self._write_defs_yaml(project)

        # Write custom lineage to JSON file for Dagster to load
        self._write_custom_lineage_file(project)

    def _write_defs_yaml(self, project: Project):
        """Write all components to a defs.yaml file in the project directory.

        This creates a version-controllable YAML file that can be used as the source of truth.
        The file contains all components in multi-document YAML format (separated by ---).
        """
        import yaml

        project_dir = self._get_project_dir(project)

        # Find the defs directory (handles both src/module/defs and module/defs structures)
        defs_dir = None

        # First, try src/<module>/defs (scaffolded projects)
        if (project_dir / "src").exists():
            module_name = project.directory_name.replace("-", "_")
            candidate = project_dir / "src" / module_name / "defs"
            if candidate.exists():
                defs_dir = candidate

        # Then try <module>/defs at project root (imported projects)
        if not defs_dir:
            for item in project_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project', '.venv', '__pycache__']:
                    candidate = item / "defs"
                    if candidate.exists():
                        defs_dir = candidate
                        break

        if not defs_dir or not defs_dir.exists():
            print(f"[_write_defs_yaml] Could not find defs directory for project {project.name}")
            return

        # Generate YAML documents for each component
        yaml_docs = []

        for component in project.components:
            doc = {
                'type': component.component_type,
                'attributes': component.attributes
            }

            # Add optional fields if present (but not label - it's not valid in Dagster's schema)
            # ComponentInstance doesn't have description attribute
            # if needed in the future, add it to the model
            if component.translation:
                doc['translation'] = component.translation
            if component.post_processing:
                doc['post_processing'] = component.post_processing

            # Convert to YAML string
            yaml_str = yaml.dump(doc, default_flow_style=False, sort_keys=False)
            yaml_docs.append(yaml_str)

        # Combine with --- separators
        yaml_content = "---\n\n".join(yaml_docs)

        # Write to defs.yaml
        defs_yaml_file = defs_dir / "defs.yaml"

        with open(defs_yaml_file, "w") as f:
            f.write(yaml_content)

        print(f"[_write_defs_yaml] Wrote {len(project.components)} components to {defs_yaml_file}")

    def _write_custom_lineage_file(self, project: Project):
        """Write custom lineage to a JSON file in the project directory.

        This file is read by definitions.py to inject custom dependencies.
        Merges edges from both project.custom_lineage and DependencyGraphComponent.
        """
        project_dir = self._get_project_dir(project)

        # Find the defs directory (handles both src/ and imported project structures)
        defs_dir = None

        # First, try <module>/defs at project root (imported projects)
        for item in project_dir.iterdir():
            if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project', '.venv', '__pycache__']:
                potential_defs_dir = item / "defs"
                if potential_defs_dir.exists() and (potential_defs_dir / "__init__.py").exists():
                    defs_dir = potential_defs_dir
                    break

        # If not found, check for standard structure (src/module/defs)
        if not defs_dir:
            src_dir = project_dir / "src"
            if src_dir.exists() and src_dir.is_dir():
                for item in src_dir.iterdir():
                    if item.is_dir() and not item.name.startswith('.'):
                        potential_defs_dir = item / "defs"
                        if potential_defs_dir.exists():
                            defs_dir = potential_defs_dir
                            break

        if not defs_dir:
            print(f"⚠️  Could not find defs directory for custom_lineage.json", flush=True)
            return

        custom_lineage_file = defs_dir / "custom_lineage.json"

        # Create parent directories if they don't exist
        custom_lineage_file.parent.mkdir(parents=True, exist_ok=True)

        # Collect all edges from multiple sources
        all_edges = []

        # 1. Add edges from project.custom_lineage (legacy/UI-drawn edges)
        for edge in project.custom_lineage:
            all_edges.append({"source": edge.source, "target": edge.target})

        # 2. Add edges from DependencyGraphComponent (YAML-based dependencies)
        dep_graph_component = next(
            (comp for comp in project.components
             if comp.component_type == 'dagster_component_templates.DependencyGraphComponent'),
            None
        )

        component_edges = []
        if dep_graph_component:
            component_edges = dep_graph_component.attributes.get('edges', [])
            for edge in component_edges:
                if isinstance(edge, dict) and 'source' in edge and 'target' in edge:
                    all_edges.append({"source": edge['source'], "target": edge['target']})

        # Deduplicate edges and filter out self-loops
        unique_edges = []
        seen = set()
        for edge in all_edges:
            # Skip self-loops (asset depending on itself)
            if edge['source'] == edge['target']:
                print(f"⚠️  Skipping self-loop: {edge['source']} -> {edge['target']}", flush=True)
                continue

            edge_tuple = (edge['source'], edge['target'])
            if edge_tuple not in seen:
                seen.add(edge_tuple)
                unique_edges.append(edge)

        # Write to file
        lineage_data = {"edges": unique_edges}

        with open(custom_lineage_file, "w") as f:
            json.dump(lineage_data, f, indent=2)

        print(f"✅ Written custom_lineage.json with {len(unique_edges)} edges "
              f"({len(project.custom_lineage)} from UI, "
              f"{len(component_edges)} from DependencyGraphComponent)",
              flush=True)

    def _inject_custom_lineage_logic(self, project: Project):
        """Inject custom lineage loading logic into an imported project's definitions.py.

        This ensures that DependencyGraphComponent edges are applied to asset specs
        at runtime via map_asset_specs().
        """
        project_dir = self._get_project_dir(project)

        # Find the definitions.py file (handles both src/ and imported project structures)
        definitions_file = None

        # Try standard structure first (src/module/__init__.py)
        src_dir = project_dir / "src"
        if src_dir.exists():
            for item in src_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.'):
                    candidate = item / "definitions.py"
                    if candidate.exists():
                        definitions_file = candidate
                        break

        # Try imported project structure (module/__init__.py at root)
        if not definitions_file:
            for item in project_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project', '.venv', '__pycache__']:
                    candidate = item / "definitions.py"
                    if candidate.exists():
                        definitions_file = candidate
                        break

        if not definitions_file:
            print(f"⚠️  Could not find definitions.py to inject custom lineage logic", flush=True)
            return

        # Read the existing definitions.py content
        with open(definitions_file, "r") as f:
            content = f.read()

        # Check if custom lineage logic already exists
        if "custom_lineage" in content and "inject_custom_dependencies" in content:
            print(f"✅ Custom lineage logic already exists in definitions.py", flush=True)
            return

        # Prepare the custom lineage code to inject
        custom_lineage_code = '''
# Load custom lineage from JSON file (if it exists)
custom_lineage_file = Path(__file__).parent / "defs" / "custom_lineage.json"
custom_lineage_edges = []
if custom_lineage_file.exists():
    try:
        with open(custom_lineage_file, "r") as f:
            custom_lineage_data = json.load(f)
            custom_lineage_edges = custom_lineage_data.get("edges", [])
            if custom_lineage_edges:
                print(f"✅ Loaded {len(custom_lineage_edges)} custom lineage edge(s)")
    except Exception as e:
        print(f"⚠️  Failed to load custom_lineage.json: {e}")
'''

        inject_code = '''
# Apply custom lineage by injecting dependencies into asset specs
if custom_lineage_edges:
    print(f"⚠️  Custom lineage injection temporarily disabled due to API compatibility issues")
    print(f"    Custom lineage is tracked in the UI but does not affect Dagster runtime dependencies")
    # TODO: Fix custom lineage injection for Dagster 1.11+
    # The challenge is properly merging AssetDep objects with existing deps
'''

        # Check if we need to add imports
        needs_json = "import json" not in content
        needs_pathlib = "from pathlib import Path" not in content and "import pathlib" not in content

        # Build the injection
        lines = content.split('\n')

        # Find where to inject imports (after existing imports)
        import_section_end = 0
        for i, line in enumerate(lines):
            if line.startswith('import ') or line.startswith('from '):
                import_section_end = i + 1

        # Add missing imports
        if needs_json or needs_pathlib:
            new_imports = []
            if needs_json:
                new_imports.append("import json")
            if needs_pathlib:
                new_imports.append("from pathlib import Path")

            # Insert after last import
            for imp in reversed(new_imports):
                lines.insert(import_section_end, imp)
            import_section_end += len(new_imports)

        # Find where to inject custom lineage loading (before defs creation)
        # Look for common patterns like "defs = " or "Definitions("
        defs_line_idx = None
        for i, line in enumerate(lines):
            if 'defs = ' in line and 'Definitions' in line:
                defs_line_idx = i
                break

        if defs_line_idx is None:
            print(f"⚠️  Could not find 'defs = Definitions' pattern in definitions.py", flush=True)
            return

        # Insert custom lineage loading code before defs creation
        custom_lineage_lines = custom_lineage_code.strip().split('\n')
        for j, cl_line in enumerate(custom_lineage_lines):
            lines.insert(defs_line_idx + j, cl_line)

        # Find the end of defs creation (after the defs variable is assigned)
        # We'll insert the injection code after all defs operations
        inject_idx = None
        for i in range(defs_line_idx + len(custom_lineage_lines), len(lines)):
            line = lines[i].strip()
            # Look for the last line that modifies defs
            if line.startswith('defs = ') or (line and not line.startswith('#') and i > defs_line_idx + len(custom_lineage_lines) + 10):
                inject_idx = i + 1

        if inject_idx is None:
            # Default to end of file
            inject_idx = len(lines)

        # Insert injection code
        inject_lines = inject_code.strip().split('\n')
        for j, inj_line in enumerate(inject_lines):
            lines.insert(inject_idx + j, inj_line)

        # Write back
        new_content = '\n'.join(lines)
        with open(definitions_file, "w") as f:
            f.write(new_content)

        print(f"✅ Injected custom lineage logic into {definitions_file.relative_to(project_dir)}", flush=True)

    def _extract_repo_name(self, git_repo: str) -> str:
        """Extract repository name from git URL.

        Examples:
            https://github.com/dbt-labs/jaffle-shop-classic.git -> jaffle-shop-classic
            git@github.com:user/my-repo.git -> my-repo
            https://github.com/user/repo -> repo
        """
        # Remove trailing .git if present
        repo_url = git_repo.rstrip('/')
        if repo_url.endswith('.git'):
            repo_url = repo_url[:-4]

        # Extract the last part of the path
        repo_name = repo_url.split('/')[-1]

        # Remove any query parameters or fragments
        repo_name = repo_name.split('?')[0].split('#')[0]

        return repo_name

    def _clone_git_repo(self, project: Project) -> tuple[Path, str] | None:
        """Clone a git repository for the project.

        Supports GitHub web URLs like:
        - https://github.com/user/repo/tree/branch/path/to/dir

        Returns:
            Tuple of (path to cloned repository or subdirectory, directory name) or None if cloning failed.
        """
        if not project.git_repo:
            return None

        from .git_service import GitService

        # Parse the GitHub URL to extract repo, branch, and subdirectory
        parsed = GitService.parse_github_url(project.git_repo)
        repo_url = parsed['repo_url']
        branch = parsed['branch'] if parsed['branch'] != 'main' else project.git_branch
        subdir = parsed['subdir']

        project_dir = self._get_project_dir(project)
        repo_name = self._extract_repo_name(repo_url)
        repo_dir = project_dir / repo_name

        try:
            print(f"📦 Cloning git repository...")
            print(f"   URL: {repo_url}")
            print(f"   Branch: {branch}")
            if subdir:
                print(f"   Subdirectory: {subdir}")

            # Clone the repository
            subprocess.run(
                ["git", "clone", "--depth", "1", "-b", branch, repo_url, str(repo_dir)],
                check=True,
                capture_output=True,
                text=True,
            )

            # If a subdirectory was specified, return that path instead
            if subdir:
                subdir_path = repo_dir / subdir
                if not subdir_path.exists():
                    print(f"⚠️  Warning: Subdirectory '{subdir}' not found in repository")
                    print(f"   Using root directory instead")
                    return repo_dir, repo_name
                print(f"✅ Using subdirectory: {subdir}")
                return subdir_path, repo_name

            return repo_dir, repo_name
        except subprocess.CalledProcessError as e:
            print(f"Failed to clone repository: {e.stderr}")
            return None

    def _update_project_dependencies(self, project: Project):
        """Update pyproject.toml with dependencies for all project components."""
        project_dir = self._get_project_dir(project)
        pyproject_path = project_dir / "pyproject.toml"

        if not pyproject_path.exists():
            return

        try:
            # Read current pyproject.toml
            with open(pyproject_path, "r") as f:
                pyproject_data = toml.load(f)

            # Get current dependencies
            current_deps = set(pyproject_data.get("project", {}).get("dependencies", []))

            # Collect all required dependencies from components
            for component in project.components:
                component_deps = component_registry.get_dependencies(component.component_type)
                for dep in component_deps:
                    # Extract package name (before >= or ==)
                    pkg_name = dep.split(">=")[0].split("==")[0].strip()

                    # Remove any existing version of this package
                    current_deps = {d for d in current_deps if not d.startswith(pkg_name)}

                    # Add the new version
                    current_deps.add(dep)

            # Update dependencies in pyproject data
            if "project" not in pyproject_data:
                pyproject_data["project"] = {}
            pyproject_data["project"]["dependencies"] = sorted(list(current_deps))

            # Write back to file
            with open(pyproject_path, "w") as f:
                toml.dump(pyproject_data, f)

            print(f"Updated dependencies for project {project.id}: {sorted(current_deps)}")

        except Exception as e:
            print(f"Failed to update dependencies for project {project.id}: {e}")

    def _create_project_virtualenv(self, project: Project):
        """Create a virtualenv for the project."""
        project_dir = self._get_project_dir(project).resolve()
        venv_dir = project_dir / ".venv"

        if venv_dir.exists():
            print(f"Virtualenv already exists for project {project.id}")
            return

        try:
            print(f"Creating virtualenv for project {project.id}...")
            venv.create(str(venv_dir), with_pip=True)
            print(f"Created virtualenv at {venv_dir}")
        except Exception as e:
            print(f"Failed to create virtualenv for project {project.id}: {e}")

    def _install_project_dependencies(self, project: Project):
        """Install dependencies into the project's virtualenv."""
        project_dir = self._get_project_dir(project).resolve()
        venv_dir = project_dir / ".venv"

        # Get the path to pip in the venv
        if sys.platform == "win32":
            pip_path = venv_dir / "Scripts" / "pip.exe"
        else:
            pip_path = venv_dir / "bin" / "pip"

        if not pip_path.exists():
            print(f"Pip not found in virtualenv for project {project.id} at {pip_path}")
            return

        try:
            print(f"Installing dependencies for project {project.id}...")
            # Install the project in editable mode (which installs dependencies from pyproject.toml)
            result = subprocess.run(
                [str(pip_path.resolve()), "install", "-e", ".", "--quiet"],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
            )

            if result.returncode == 0:
                print(f"Successfully installed dependencies for project {project.id}")
            else:
                print(f"Failed to install dependencies for project {project.id}: {result.stderr}")
        except subprocess.TimeoutExpired:
            print(f"Timeout installing dependencies for project {project.id}")
        except Exception as e:
            print(f"Error installing dependencies for project {project.id}: {e}")

    def _get_project_python_path(self, project: Project) -> Path:
        """Get the path to python executable in the project's virtualenv."""
        project_dir = self._get_project_dir(project)
        venv_dir = project_dir / ".venv"

        if sys.platform == "win32":
            return venv_dir / "Scripts" / "python.exe"
        else:
            return venv_dir / "bin" / "python"

    def _get_project_dg_path(self, project: Project) -> Path:
        """Get the path to dg executable in the project's virtualenv."""
        project_dir = self._get_project_dir(project)
        venv_dir = project_dir / ".venv"

        if sys.platform == "win32":
            return venv_dir / "Scripts" / "dg.exe"
        else:
            return venv_dir / "bin" / "dg"

    def _scaffold_project_with_create_dagster(self, project: Project):
        """Scaffold project using create-dagster command."""
        # Sanitize project name for Python module (must start with letter/underscore)
        module_name = project.name.lower().replace(" ", "_").replace("-", "_")
        # Ensure module name starts with a letter or underscore
        if module_name and module_name[0].isdigit():
            module_name = f"project_{module_name}"

        # Use project_<id>_<name> as directory to ensure uniqueness and valid Python identifier
        dir_name = f"project_{project.id.split('-')[0]}_{module_name}"

        # Store the directory name in the project
        project.directory_name = dir_name
        project_dir = self._get_project_dir(project)

        try:
            # Run create-dagster project command
            result = subprocess.run(
                ["/Users/ericthomas/.local/bin/uvx", "create-dagster", "project", str(project_dir), "--no-uv-sync", "--verbose"],
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                print(f"Failed to create project with create-dagster: {result.stderr}")
                raise Exception(f"create-dagster failed: {result.stderr}")

            print(f"Successfully scaffolded project at {project_dir}")

        except subprocess.TimeoutExpired:
            print(f"Timeout running create-dagster")
            raise
        except Exception as e:
            print(f"Error running create-dagster: {e}")
            raise

    def _scaffold_components(self, project: Project):
        """Scaffold components using dg scaffold defs commands."""
        project_dir = self._get_project_dir(project)
        venv_dir = project_dir / ".venv"

        # Get the path to dg in the project's virtualenv
        if sys.platform == "win32":
            dg_path = venv_dir / "Scripts" / "dg.exe"
        else:
            dg_path = venv_dir / "bin" / "dg"

        if not dg_path.exists():
            print(f"dg not found in virtualenv at {dg_path}")
            return

        for component in project.components:
            try:
                # Skip custom components (they use YAML generation instead of dg scaffold)
                if "dagster_designer_components" in component.component_type:
                    print(f"Skipping scaffold for custom component {component.id} - will use YAML generation")
                    continue

                # Build the scaffold command based on component type
                if component.component_type == "dagster_dbt.DbtProjectComponent":
                    # Use 'project' field (the new standard) or fall back to legacy 'project_path'
                    project_path = component.attributes.get("project") or component.attributes.get("project_path", "dbt")
                    folder_name = component.id

                    cmd = f"source {str(venv_dir.resolve())}/bin/activate && {str(dg_path.resolve())} scaffold defs dagster_dbt.DbtProjectComponent {folder_name} --project-path '{project_path}'"

                    result = subprocess.run(
                        ["bash", "-c", cmd],
                        cwd=str(project_dir.resolve()),
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )

                    if result.returncode == 0:
                        print(f"Successfully scaffolded component {component.id}")

                        # Apply partition configuration if present
                        self._apply_component_partition_config(project, component)
                    else:
                        print(f"Failed to scaffold component {component.id}: {result.stderr}")

            except Exception as e:
                print(f"Error scaffolding component {component.id}: {e}")

    def _apply_component_partition_config(self, project: Project, component):
        """
        Apply partition configuration to a component from its node data.

        Args:
            project: The project containing the component
            component: Component instance to apply partitions to
        """
        try:
            # Find the component node in the graph to get partition_config
            if not project.graph or not project.graph.nodes:
                return

            component_node = None
            for node in project.graph.nodes:
                if node.id == component.id:
                    component_node = node
                    break

            if not component_node or not component_node.data:
                return

            # Check if partition_config exists in node data
            partition_config_data = component_node.data.get("partition_config")
            if not partition_config_data:
                return

            # Parse partition config
            partition_config = PartitionConfig(**partition_config_data)

            # Get component directory
            project_dir = self._get_project_dir(project)
            component_dir = project_dir / "src" / project.directory_name / "defs" / component.id

            if not component_dir.exists():
                print(f"[Partition] Component directory not found: {component_dir}")
                return

            # Apply partition configuration
            partition_service.apply_partition_config(component_dir, partition_config)

        except Exception as e:
            print(f"[Partition] Error applying partition config to {component.id}: {e}")

    async def install_dependencies_async(self, project: Project):
        """Install dependencies asynchronously in the background.

        This allows the project to be returned to the user immediately while
        dependencies are installed in the background. Status is tracked in _dependency_status.
        """
        # Get or create lock for this project
        if project.id not in _dependency_locks:
            _dependency_locks[project.id] = asyncio.Lock()

        async with _dependency_locks[project.id]:
            # Set status to installing
            _dependency_status[project.id] = {'status': 'installing', 'error': None, 'output': ''}
            print(f"🔄 [ASYNC] Starting dependency installation for project {project.id}...")

            try:
                # Run the synchronous install in a thread pool to not block
                loop = asyncio.get_event_loop()
                output = await loop.run_in_executor(None, self._install_dependencies_with_uv, project)

                # Success!
                _dependency_status[project.id] = {'status': 'success', 'error': None, 'output': output}
                print(f"✅ [ASYNC] Dependencies installed successfully for project {project.id}")

            except Exception as e:
                error_msg = str(e)
                # Get any output that was captured before the error
                current_output = _dependency_status[project.id].get('output', '')
                _dependency_status[project.id] = {'status': 'error', 'error': error_msg, 'output': current_output}
                print(f"❌ [ASYNC] Failed to install dependencies for project {project.id}: {error_msg}")

    def get_dependency_status(self, project_id: str) -> Dict[str, str]:
        """Get the current dependency installation status for a project."""
        return _dependency_status.get(project_id, {'status': 'idle', 'error': None, 'output': ''})

    def _install_dependencies_with_uv(self, project: Project) -> str:
        """Install dependencies using uv.

        Returns:
            str: Combined stdout and stderr output from all installation commands
        """
        project_dir = self._get_project_dir(project)
        output_lines = []

        def log(msg: str):
            """Log message to both console and output buffer"""
            print(msg)
            output_lines.append(msg)
            # Update status immediately so user sees the message
            _dependency_status[project.id]['output'] = '\n'.join(output_lines)

        log(f"🔍 Starting dependency installation for project {project.id}")
        log(f"📂 Project directory: {project_dir}")
        log(f"⚙️  Using UV directly (not uvx) for faster performance")
        log(f"📦 UV cache: ~/.cache/uv/ (730+ packages cached)")

        try:
            # First install dagster-dbt and the detected dbt adapter if we have dbt components
            # Check for both standard and custom dbt components
            has_dbt = any(
                c.component_type == "dagster_dbt.DbtProjectComponent" or
                "DbtProject" in c.component_type
                for c in project.components
            )

            if has_dbt:
                # Detect the adapter from the cloned repo
                repo_dir = None
                if project.git_repo:
                    # Find the cloned repo directory
                    for item in project_dir.iterdir():
                        if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests']:
                            repo_dir = item
                            break

                # Detect adapter type
                adapter_type = 'duckdb'  # default
                if repo_dir:
                    adapter_type = self._detect_dbt_adapter(repo_dir)

                # Map adapter type to package name
                adapter_package = f"dbt-{adapter_type}"

                # Pin dbt-core to 1.10.13 to avoid uv installation bug in 1.10.14
                # See: https://github.com/dbt-labs/dbt-core/issues/10xxx
                log(f"📦 Step 1/3: Adding dagster-dbt, dbt-core==1.10.13, and {adapter_package}...")
                log(f"⏳ This may take 1-3 minutes depending on network speed and number of dependencies...")

                # Use subprocess.Popen for real-time output streaming
                import time
                import os
                import threading
                start_time = time.time()

                # Add UV_NO_WORKSPACE to prevent scanning sibling projects
                env = os.environ.copy()
                env['UV_NO_WORKSPACE'] = '1'

                # Add verbose flag to get more output from UV
                # Use UV directly (not uvx) for much faster performance
                process = subprocess.Popen(
                    ["/Users/ericthomas/.local/bin/uv", "add", "-v", "dagster-dbt", "dbt-core==1.10.13", adapter_package],
                    cwd=str(project_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,  # Line buffered
                    env=env,
                )

                # Add a progress indicator for when UV is silent
                def progress_indicator():
                    last_update = time.time()
                    while process.poll() is None:
                        time.sleep(10)
                        if time.time() - start_time > 10:
                            elapsed = int(time.time() - start_time)
                            log(f"   ... still working ({elapsed}s elapsed)")

                progress_thread = threading.Thread(target=progress_indicator, daemon=True)
                progress_thread.start()

                # Read output in real-time
                for line in process.stdout:
                    line = line.rstrip()
                    if line:
                        output_lines.append(f"   {line}")
                        _dependency_status[project.id]['output'] = '\n'.join(output_lines)

                process.wait(timeout=300)
                elapsed = time.time() - start_time
                log(f"✅ Package addition completed in {elapsed:.1f}s")

                if process.returncode != 0:
                    raise subprocess.CalledProcessError(process.returncode, process.args)

                _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            # Install all dependencies including dev dependencies
            # We need dagster-dg-cli (dg command) for asset introspection
            log("📥 Step 2/3: Syncing dependencies (installing packages)...")
            log("⏳ This may take 1-3 minutes for large projects...")

            # Use subprocess.Popen for real-time output streaming
            import time
            import os
            import threading
            start_time = time.time()

            # Add UV_NO_WORKSPACE to prevent scanning sibling projects
            env = os.environ.copy()
            env['UV_NO_WORKSPACE'] = '1'

            # Add verbose flag to get more output from UV
            # Use UV directly (not uvx) for much faster performance
            # Install dev dependencies too (includes dagster-dg-cli which we need for `dg list defs`)
            process = subprocess.Popen(
                ["/Users/ericthomas/.local/bin/uv", "sync", "-v"],
                cwd=str(project_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # Line buffered
                env=env,
            )

            # Add a progress indicator for when UV is silent
            def progress_indicator():
                while process.poll() is None:
                    time.sleep(10)
                    if time.time() - start_time > 10:
                        elapsed = int(time.time() - start_time)
                        log(f"   ... still syncing ({elapsed}s elapsed)")

            progress_thread = threading.Thread(target=progress_indicator, daemon=True)
            progress_thread.start()

            # Read output in real-time
            for line in process.stdout:
                line = line.rstrip()
                if line:
                    output_lines.append(f"   {line}")
                    _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            process.wait(timeout=180)
            elapsed = time.time() - start_time
            log(f"✅ Sync completed in {elapsed:.1f}s")

            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)

            _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            log("✅ Dependencies installed successfully")

            # Skip dagster-webserver installation during project creation for faster setup
            # It will be installed on-demand when user opens Dagster UI
            # This saves 30-60 seconds during project creation

            # Install project in editable mode so dg can import it
            # This is required for both scaffolded and imported projects
            log("📦 Step 3/3: Installing project in editable mode...")
            log("⏳ This allows `dg list defs` to import the project module...")
            _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            # Use subprocess.Popen for real-time output streaming
            import time
            start_time = time.time()
            # Use UV directly (not uvx) for much faster performance
            process = subprocess.Popen(
                ["bash", "-c", f"UV_PROJECT_ENVIRONMENT=.venv /Users/ericthomas/.local/bin/uv pip install -e ."],
                cwd=str(project_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # Line buffered
            )

            # Read output in real-time
            for line in process.stdout:
                line = line.rstrip()
                if line:
                    output_lines.append(f"   {line}")
                    _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            process.wait(timeout=60)
            elapsed = time.time() - start_time
            log(f"✅ Editable install completed in {elapsed:.1f}s")

            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)

            _dependency_status[project.id]['output'] = '\n'.join(output_lines)

            log("✅ Project setup complete (dagster-webserver will be installed when needed)")

            return '\n'.join(output_lines)

        except subprocess.TimeoutExpired as e:
            log("❌ Timeout installing dependencies")
            if e.stdout:
                output_lines.append(f"\nStdout before timeout:\n{e.stdout}")
            if e.stderr:
                output_lines.append(f"\nStderr before timeout:\n{e.stderr}")
            raise Exception(f"Timeout installing dependencies: {e}")
        except Exception as e:
            log(f"❌ Error installing dependencies: {e}")
            raise

    def _discover_components(self, project: Project):
        """Discover existing components from defs.yaml files in the project."""
        from ..models.component import ComponentInstance

        project_dir = self._get_project_dir(project)

        # Find the defs directory - could be in multiple locations:
        # 1. Projects created by tool: src/<project_module>/defs
        # 2. Imported projects: <project_module>/defs
        defs_dir = None

        # First try src/<module>/defs (created by this tool)
        src_dir = project_dir / "src"
        if src_dir.exists():
            for item in src_dir.iterdir():
                if item.is_dir():
                    potential_defs_dir = item / "defs"
                    if potential_defs_dir.exists():
                        # Check if this defs dir actually has component YAML files
                        yaml_files = list(potential_defs_dir.glob("*/defs.yaml"))
                        if yaml_files:
                            defs_dir = potential_defs_dir
                            break

        # If not found, try <module>/defs (imported projects)
        if not defs_dir:
            for item in project_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project']:
                    potential_defs_dir = item / "defs"
                    if potential_defs_dir.exists() and potential_defs_dir.is_dir():
                        # Check if this defs dir actually has component YAML files
                        yaml_files = list(potential_defs_dir.glob("*/defs.yaml"))
                        if yaml_files:
                            defs_dir = potential_defs_dir
                            break

        if not defs_dir:
            print(f"No defs directory found in project")
            return

        print(f"Scanning for components in: {defs_dir}")

        # Find all defs.yaml files
        yaml_files = list(defs_dir.glob("*/defs.yaml"))
        print(f"Found {len(yaml_files)} component YAML files")

        for yaml_file in yaml_files:
            try:
                component_id = yaml_file.parent.name
                print(f"  Processing component: {component_id}")

                # Parse the YAML file
                with open(yaml_file, 'r') as f:
                    yaml_content = yaml.safe_load(f)

                if not yaml_content or 'type' not in yaml_content:
                    print(f"  ⚠️  Skipping {component_id}: missing 'type' field")
                    continue

                component_type = yaml_content['type']
                attributes = yaml_content.get('attributes', {}).copy()  # Make a copy to modify

                # Translation can be either at top level or nested under attributes
                translation = yaml_content.get('translation')
                if not translation and 'translation' in attributes:
                    translation = attributes.pop('translation')  # Remove from attributes

                # Store original template values before resolution
                original_attributes = {}

                # Resolve {{ project_root }} template variable to actual path
                for key, value in attributes.items():
                    if isinstance(value, str) and '{{ project_root }}' in value:
                        # Store the original template for display
                        original_attributes[f'{key}_display'] = value
                        # Replace {{ project_root }} with the absolute project directory path
                        resolved_path = value.replace('{{ project_root }}', str(project_dir.resolve()))
                        attributes[key] = resolved_path
                        print(f"    Resolved template: {key} = {resolved_path}")

                # Merge original templates into attributes for display
                attributes.update(original_attributes)

                # Keep dbt component attributes as-is (no conversion needed)
                # DbtProjectComponent now uses 'project' field directly

                # Create a label from the component ID or attributes
                label = component_id.replace('_', ' ').title()

                # Create ComponentInstance
                component = ComponentInstance(
                    id=component_id,
                    component_type=component_type,
                    label=label,
                    attributes=attributes,
                    translation=translation,
                    is_asset_factory=True,
                )

                project.components.append(component)
                print(f"  ✅ Added component: {component_type} ({component_id})")

            except Exception as e:
                print(f"  ⚠️  Failed to parse {yaml_file}: {e}")

        print(f"Discovered {len(project.components)} components")

    def _copy_component_classes_to_project(self, project: Project):
        """Copy dagster_designer_components to the project so they can be imported."""
        import shutil

        project_dir = self._get_project_dir(project)
        module_name = project.directory_name.replace("-", "_")
        project_src_dir = project_dir / "src" / module_name

        if not project_src_dir.exists():
            print(f"Project src directory not found: {project_src_dir}")
            return

        # Source: backend/dagster_designer_components
        components_source = Path(__file__).parent.parent.parent / "dagster_designer_components"

        # Destination: project/src/<module_name>/dagster_designer_components
        components_dest = project_src_dir / "dagster_designer_components"

        try:
            # Remove existing if present
            if components_dest.exists():
                shutil.rmtree(components_dest)

            # Copy the entire directory
            shutil.copytree(components_source, components_dest)
            print(f"Copied component classes to {components_dest}")
        except Exception as e:
            print(f"Error copying component classes: {e}")

    def _update_pyproject_registry(self, project: Project):
        """Update pyproject.toml to register dagster_designer_components without .lib prefix."""
        project_dir = self._get_project_dir(project)
        pyproject_file = project_dir / "pyproject.toml"

        if not pyproject_file.exists():
            print(f"pyproject.toml not found at {pyproject_file}")
            return

        try:
            content = pyproject_file.read_text()
            module_name = project.directory_name.replace("-", "_")

            # Replace any .lib.dagster_designer_components with .dagster_designer_components
            old_pattern = f"{module_name}.lib.dagster_designer_components"
            new_pattern = f"{module_name}.dagster_designer_components"

            if old_pattern in content:
                content = content.replace(old_pattern, new_pattern)
                pyproject_file.write_text(content)
                print(f"✅ Updated pyproject.toml registry_modules: {old_pattern} -> {new_pattern}")
            else:
                print(f"ℹ️  No registry update needed in pyproject.toml")
        except Exception as e:
            print(f"⚠️  Error updating pyproject.toml: {e}")

    def _generate_component_yaml_files(self, project: Project):
        """Generate YAML files for primitive components (job, schedule, sensor, asset_check).

        These components use custom Dagster component classes and are instantiated from YAML.
        """
        import yaml
        import sys
        from ..models.component import ComponentInstance

        print(f"\n[_generate_component_yaml_files] ====== START ======", flush=True)
        sys.stdout.flush()

        # First ensure component classes are available
        self._copy_component_classes_to_project(project)

        project_dir = self._get_project_dir(project)

        # Determine the module name from the directory (keep the full name, just replace dashes)
        module_name = project.directory_name.replace("-", "_")
        defs_dir = project_dir / "src" / module_name / "defs"

        print(f"[YAML Generation] project_dir: {project_dir}", flush=True)
        print(f"[YAML Generation] module_name: {module_name}", flush=True)
        print(f"[YAML Generation] defs_dir: {defs_dir}", flush=True)
        print(f"[YAML Generation] defs_dir.exists(): {defs_dir.exists()}", flush=True)
        sys.stdout.flush()

        if not defs_dir.exists():
            print(f"❌ Defs directory not found: {defs_dir}", flush=True)
            return

        # Map component types to their fully qualified Python class names
        # Use the project-local copy of the components (module_name already includes 'project_' prefix)
        component_type_map = {
            "job": f"{module_name}.dagster_designer_components.JobComponent",
            "schedule": f"{module_name}.dagster_designer_components.ScheduleComponent",
            "sensor": f"{module_name}.dagster_designer_components.SensorComponent",
            "asset_check": f"{module_name}.dagster_designer_components.AssetCheckComponent",
            "python_asset": f"{module_name}.dagster_designer_components.PythonAssetComponent",
            "sql_asset": f"{module_name}.dagster_designer_components.SQLAssetComponent",
            # Built-in Dagster components
            "dagster.PythonScriptComponent": "dagster.PythonScriptComponent",
            "dagster.TemplatedSqlComponent": "dagster.TemplatedSqlComponent",
            # External library components - use their original type (no project prefix needed)
            "dagster_dbt.DbtProjectComponent": "dagster_dbt.DbtProjectComponent",
            "dagster_fivetran.FivetranConnector": "dagster_fivetran.FivetranConnector",
            "dagster_sling.SlingReplication": "dagster_sling.SlingReplication",
            "dagster_dlt.DltPipeline": "dagster_dlt.DltPipeline",
            # Custom dbt component with translator (maps to itself - full path already provided)
            f"{module_name}.dagster_designer_components.DbtProjectWithTranslatorComponent": f"{module_name}.dagster_designer_components.DbtProjectWithTranslatorComponent",
        }

        print(f"[YAML Generation] Processing {len(project.components)} components", flush=True)
        sys.stdout.flush()

        # Convert dicts to ComponentInstance objects if needed
        # This handles the case where components were deserialized as dicts from ProjectUpdate
        components = []
        for comp in project.components:
            if isinstance(comp, dict):
                print(f"[YAML Generation] Converting dict to ComponentInstance: {comp.get('id')}", flush=True)
                components.append(ComponentInstance(**comp))
            else:
                components.append(comp)
        sys.stdout.flush()

        # Group dbt components by project_path to consolidate them
        from collections import defaultdict
        dbt_components_by_project = defaultdict(list)
        non_dbt_components = []

        for component in components:
            # Recognize both standard and custom dbt components
            is_dbt_component = (
                component.component_type.startswith("dagster_dbt") or
                "DbtProject" in component.component_type
            )
            if is_dbt_component:
                # Use 'project' field (the new standard) or fall back to legacy 'project_path'
                project_path = component.attributes.get("project") or component.attributes.get("project_path", "")
                if project_path:
                    dbt_components_by_project[project_path].append(component)
                else:
                    non_dbt_components.append(component)
            else:
                non_dbt_components.append(component)

        # Create base dbt components (one per project_path)
        # Use the existing component IDs if they're reasonable, don't generate from paths
        base_dbt_components = []
        base_dbt_ids = set()
        for project_path, dbt_comps in dbt_components_by_project.items():
            # Use the first component if it has a reasonable ID (not path-based)
            first_comp = dbt_comps[0]
            # Check if the ID looks like it was generated from a path (contains many underscores or dots)
            if '..' in first_comp.id or first_comp.id.count('_') > 10:
                # Bad ID - generate a simple one from the last part of the path
                from pathlib import Path
                project_name = Path(project_path).name
                base_id = f"dbt_{project_name.replace('-', '_')}"
                label = f"DBT {project_name.replace('_', ' ').title()}"
            else:
                # Good ID - use it
                base_id = first_comp.id
                label = first_comp.label

            base_dbt_ids.add(base_id)
            base_comp = ComponentInstance(
                id=base_id,
                component_type=first_comp.component_type,  # Preserve original type (standard or custom)
                label=label,
                attributes=first_comp.attributes,
                translation=first_comp.translation,
                post_processing=first_comp.post_processing,
                is_asset_factory=True
            )
            base_dbt_components.append(base_comp)
            print(f"[YAML Generation] Using dbt component: {base_id} for project_path: {project_path}", flush=True)

        # Clean up old dbt component directories that are no longer needed
        import shutil
        existing_dirs = [d for d in defs_dir.iterdir() if d.is_dir() and not d.name.startswith('.')]
        for existing_dir in existing_dirs:
            # Check if this is a dbt component directory
            defs_yaml = existing_dir / "defs.yaml"
            if defs_yaml.exists():
                try:
                    import yaml
                    with open(defs_yaml) as f:
                        yaml_content = yaml.safe_load(f)
                    # If it's a dbt component and not in our base list, remove it
                    component_type = yaml_content.get("type", "")
                    is_dbt = (
                        component_type == "dagster_dbt.DbtProjectComponent" or
                        "DbtProject" in component_type
                    )
                    if yaml_content and is_dbt:
                        if existing_dir.name not in base_dbt_ids and existing_dir.name not in [c.id for c in non_dbt_components]:
                            print(f"[YAML Generation] Removing obsolete dbt component directory: {existing_dir}", flush=True)
                            shutil.rmtree(existing_dir)
                except Exception as e:
                    print(f"[YAML Generation] Error checking/removing directory {existing_dir}: {e}", flush=True)

        # Process all components (base dbt + non-dbt)
        all_components_to_process = base_dbt_components + non_dbt_components

        for component in all_components_to_process:
            component_type = component.component_type
            print(f"[YAML Generation] Component {component.id}: type={component_type}", flush=True)

            # Skip standard dbt components - they should be managed by dg scaffold only
            # But DO NOT skip custom dbt components - they need YAML generation
            if component_type == "dagster_dbt.DbtProjectComponent":
                print(f"[YAML Generation] Skipping standard dbt component {component.id} - managed by dg scaffold", flush=True)
                continue

            # Only generate YAML for components in the type map
            # Allow custom dbt components even if not explicitly in the map
            is_custom_dbt = "DbtProject" in component_type and "dagster_designer_components" in component_type
            if component_type not in component_type_map and not is_custom_dbt:
                print(f"[YAML Generation] Skipping {component_type} - not in type map", flush=True)
                continue

            # Components are stored in subdirectories with defs.yaml inside
            component_dir = defs_dir / component.id
            yaml_file = component_dir / "defs.yaml"

            print(f"[YAML Generation] Will write to: {yaml_file}", flush=True)

            # Create component directory if it doesn't exist
            if not component_dir.exists():
                component_dir.mkdir(parents=True, exist_ok=True)
                print(f"[YAML Generation] Created directory: {component_dir}", flush=True)

            # Use 'attributes' for dbt components (they use a different format)
            # Use 'params' for other components
            is_dbt_component = (
                component_type.startswith("dagster_dbt") or
                "DbtProject" in component_type
            )
            params_key = "attributes" if is_dbt_component else "params"

            # For dbt components, handle special field mappings and nesting translation
            if is_dbt_component:
                # Create a copy of attributes
                dbt_attributes = dict(component.attributes)

                # Ensure 'project' path is relative (it should already be stored as relative)
                # No conversion needed - DbtProjectComponent now uses 'project' field directly

                # Add translation if present
                if hasattr(component, 'translation') and component.translation:
                    dbt_attributes["translation"] = component.translation
                    print(f"[YAML Generation] Adding translation inside attributes for {component.id}: {component.translation}", flush=True)

                # Use component_type directly for custom dbt components, otherwise lookup in map
                type_value = component_type if is_custom_dbt else component_type_map.get(component_type, component_type)
                yaml_data = {
                    "type": type_value,
                    params_key: dbt_attributes,
                }
            else:
                # For built-in Dagster components (Python, SQL, etc.), filter out UI-only fields
                # that are not valid component parameters
                filtered_attributes = dict(component.attributes)

                # Remove UI/metadata fields that shouldn't be in the YAML
                ui_only_fields = [
                    'deps',  # Dependencies are handled by Dagster, not component params
                    'label',  # UI display name
                    'componentType',  # Duplicate of component_type
                    'component_type',  # Duplicate of component_type
                    'attributes',  # Nested attributes from buggy saves
                    'description',  # This goes in translation, not params
                ]

                for field in ui_only_fields:
                    filtered_attributes.pop(field, None)

                # Note: translation is NOT added for non-dbt components as they don't support it
                # Descriptions for Python/SQL components should be set in code, not component YAML

                yaml_data = {
                    "type": component_type_map[component_type],
                    params_key: filtered_attributes,
                }

            try:
                # Validate configuration before writing
                if component_type not in component_type_map or component_type.startswith("dagster_dbt"):
                    # Skip validation for dbt components and unmapped types
                    with open(yaml_file, 'w') as f:
                        yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False)
                    print(f"✅ Generated YAML for {component_type} component: {yaml_file}", flush=True)
                else:
                    # For community components, check if schema exists and validate
                    from ..api.templates_registry import validate_component_config

                    # Try to find component directory with schema
                    # Look in lib/dagster_designer_components or components subdirectories
                    potential_schema_dirs = [
                        defs_dir.parent / "lib" / "dagster_designer_components" / component.id,
                        defs_dir.parent / "components" / component.id,
                    ]

                    schema_dir = None
                    for potential_dir in potential_schema_dirs:
                        if potential_dir.exists() and (potential_dir / "schema.json").exists():
                            schema_dir = potential_dir
                            break

                    if schema_dir:
                        # Validate against schema
                        validated_attrs, validation_errors = validate_component_config(
                            schema_dir, yaml_data[params_key]
                        )

                        if validation_errors:
                            error_msg = f"Validation failed for {component.id}:\n" + "\n".join(f"  - {err}" for err in validation_errors)
                            print(f"❌ {error_msg}", flush=True)
                            # Don't write invalid YAML - skip this component
                            continue

                        # Use validated attributes
                        yaml_data[params_key] = validated_attrs

                    # Write validated YAML
                    with open(yaml_file, 'w') as f:
                        yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False)
                    print(f"✅ Generated YAML for {component_type} component: {yaml_file}", flush=True)

                    # Apply partition configuration if present
                    self._apply_component_partition_config(project, component)
            except Exception as e:
                print(f"❌ Error generating YAML for component {component.id}: {e}", flush=True)

            sys.stdout.flush()

        print(f"[_generate_component_yaml_files] ====== END ======\n", flush=True)
        sys.stdout.flush()

    def _generate_definitions_with_asset_customizations(self, project: Project):
        """Generate definitions.py with asset customization support for dbt components."""
        import json
        from pathlib import Path
        from collections import defaultdict

        project_dir = self._get_project_dir(project)
        module_name = project.directory_name.replace("-", "_")
        module_dir = project_dir / "src" / module_name
        definitions_file = module_dir / "definitions.py"
        customizations_file = module_dir / "asset_customizations.json"

        # Group dbt components by project path to find customizations
        dbt_components_by_project = defaultdict(list)
        for component in project.components:
            if component.component_type.startswith("dagster_dbt"):
                # Use 'project' field (the new standard) or fall back to legacy 'project_path'
                project_path = component.attributes.get("project") or component.attributes.get("project_path", "")
                if project_path:
                    dbt_components_by_project[project_path].append(component)

        # Collect asset customizations from dbt components
        asset_customizations = {}
        for project_path, components in dbt_components_by_project.items():
            for component in components:
                # If component has select attribute, it's targeting specific assets
                select = component.attributes.get("select")
                if select and component.translation:
                    # The select value is the asset key
                    asset_key = select
                    customizations = {}
                    if component.translation.get("group_name"):
                        customizations["group_name"] = component.translation["group_name"]
                    if component.translation.get("description"):
                        customizations["description"] = component.translation["description"]
                    if customizations:
                        asset_customizations[asset_key] = customizations

        # Write asset_customizations.json
        if asset_customizations:
            with open(customizations_file, 'w') as f:
                json.dump(asset_customizations, f, indent=2)
            print(f"✅ Generated asset_customizations.json with {len(asset_customizations)} customizations")

        # Generate definitions.py
        definitions_content = '''from pathlib import Path
import json
import dagster as dg

# Import custom components to register them with Dagster
# The @component_type decorator registers them when imported
from .dagster_designer_components import (
    JobComponent,
    ScheduleComponent,
    SensorComponent,
    AssetCheckComponent,
)

# Load base definitions from components
defs = dg.load_from_defs_folder(path_within_project=Path(__file__).parent)

# Load custom lineage from JSON file (if it exists)
custom_lineage_file = Path(__file__).parent / "defs" / "custom_lineage.json"
custom_lineage_edges = []
if custom_lineage_file.exists():
    try:
        with open(custom_lineage_file, "r") as f:
            custom_lineage_data = json.load(f)
            custom_lineage_edges = custom_lineage_data.get("edges", [])
            if custom_lineage_edges:
                print(f"✅ Loaded {len(custom_lineage_edges)} custom lineage edge(s)")
    except Exception as e:
        print(f"⚠️  Failed to load custom_lineage.json: {e}")

# Apply custom lineage by injecting dependencies using map_resolved_asset_specs with selection
# This approach works for both Python assets and dbt assets (dbt models are skipped)
if custom_lineage_edges:
    # First, get all asset specs to check which ones are from dbt
    all_specs = list(defs.get_all_asset_specs())
    dbt_asset_keys = set()

    # Identify dbt assets by checking if they have dbt metadata
    for spec in all_specs:
        # dbt assets have metadata with 'dagster-dbt/asset_type' or come from dbt component
        metadata = spec.metadata or {}
        if any('dbt' in str(key).lower() for key in metadata.keys()):
            dbt_asset_keys.add(spec.key.to_user_string())

    # Build a map of which assets need custom deps
    target_to_sources = {}
    dbt_targets = []

    for edge in custom_lineage_edges:
        target = edge.get("target")
        source = edge.get("source")
        if target and source:
            # Check if target is a dbt asset dynamically
            if target in dbt_asset_keys:
                dbt_targets.append(target)
                continue

            if target not in target_to_sources:
                target_to_sources[target] = []
            target_to_sources[target].append(dg.AssetKey([source]))

    # Apply custom deps to each target asset using selection
    for target_asset, source_keys in target_to_sources.items():
        try:
            defs = defs.map_resolved_asset_specs(
                func=lambda spec: spec.merge_attributes(deps=source_keys),
                selection=target_asset  # Only modify this specific asset
            )
            print(f"✅ Applied custom lineage to {target_asset}: depends on {[str(key) for key in source_keys]}")
        except Exception as e:
            print(f"⚠️  Could not inject custom lineage for {target_asset}: {e}")

    if dbt_targets:
        print(f"⚠️  Cannot add dependencies to dbt models (define in dbt schema.yml): {', '.join(set(dbt_targets))}")

# Load asset customizations (for group_name, description overrides)
customizations_path = Path(__file__).parent / "asset_customizations.json"
if customizations_path.exists():
    try:
        with open(customizations_path) as f:
            customizations = json.load(f)

        # Apply customizations using map_asset_specs
        def apply_customizations(spec):
            asset_key_str = spec.key.to_user_string()
            if asset_key_str in customizations:
                custom = customizations[asset_key_str]
                kwargs = {}
                if "group_name" in custom:
                    kwargs["group_name"] = custom["group_name"]
                if "description" in custom:
                    kwargs["description"] = custom["description"]
                if kwargs:
                    return spec.replace_attributes(**kwargs)
            return spec

        defs = defs.map_asset_specs(func=apply_customizations)
        print(f"✅ Applied {len(customizations)} asset customizations")
    except Exception as e:
        print(f"⚠️  Failed to load asset_customizations.json: {e}")
'''

        with open(definitions_file, 'w') as f:
            f.write(definitions_content)
        print(f"✅ Generated definitions.py with asset customization support")

    def _detect_dbt_adapter(self, repo_dir: Path) -> str:
        """Detect the dbt adapter type from the cloned repo.

        Checks in order:
        1. requirements.txt for dbt-* packages
        2. packages.yml for dbt adapter packages
        3. existing profiles.yml
        4. Falls back to duckdb
        """
        # Check requirements.txt
        requirements_file = repo_dir / "requirements.txt"
        if requirements_file.exists():
            try:
                requirements = requirements_file.read_text()
                # Common dbt adapters
                adapters = {
                    'dbt-snowflake': 'snowflake',
                    'dbt-bigquery': 'bigquery',
                    'dbt-redshift': 'redshift',
                    'dbt-postgres': 'postgres',
                    'dbt-duckdb': 'duckdb',
                    'dbt-databricks': 'databricks',
                    'dbt-spark': 'spark',
                }
                for package, adapter in adapters.items():
                    if package in requirements:
                        print(f"Detected dbt adapter '{adapter}' from requirements.txt")
                        return adapter
            except:
                pass

        # Check existing profiles.yml
        profiles_file = repo_dir / "profiles.yml"
        if profiles_file.exists():
            try:
                import yaml
                with open(profiles_file, 'r') as f:
                    profiles = yaml.safe_load(f)
                    # Try to find adapter type in profiles
                    for profile_name, profile_config in profiles.items():
                        if isinstance(profile_config, dict):
                            outputs = profile_config.get('outputs', {})
                            for output_name, output_config in outputs.items():
                                if isinstance(output_config, dict):
                                    adapter_type = output_config.get('type')
                                    if adapter_type:
                                        print(f"Detected dbt adapter '{adapter_type}' from existing profiles.yml")
                                        return adapter_type
            except:
                pass

        # Default to duckdb
        print("No adapter detected, defaulting to duckdb")
        return 'duckdb'

    def _detect_project_type(self, repo_dir: Path) -> str:
        """Detect the type of project in the given directory.

        Args:
            repo_dir: Path to the cloned repository directory

        Returns:
            "multi-dbt" if multiple dbt projects are found in subdirectories
            "dbt" if dbt_project.yml is found
            "dagster" if it's an existing Dagster project (definitions.py or pyproject.toml with dagster)
            "unknown" otherwise
        """
        print(f"🔍 Detecting project type in {repo_dir}...")

        # First check for multiple dbt projects in subdirectories
        dbt_projects = self._find_dbt_projects_recursive(repo_dir)
        if len(dbt_projects) > 1:
            print(f"   Found {len(dbt_projects)} dbt projects in subdirectories - this is a multi-dbt project")
            return "multi-dbt"

        # Check for single dbt project in root
        if (repo_dir / "dbt_project.yml").exists():
            print(f"   Found dbt_project.yml - this is a dbt project")
            return "dbt"

        # Check for Dagster project - look for definitions.py
        if (repo_dir / "definitions.py").exists():
            print(f"   Found definitions.py - this is a Dagster project")
            return "dagster"

        # Check for Dagster project - look in subdirectories for definitions.py
        # (common pattern: repo/project_name/definitions.py)
        for subdir in repo_dir.iterdir():
            if subdir.is_dir() and (subdir / "definitions.py").exists():
                print(f"   Found definitions.py in {subdir.name}/ - this is a Dagster project")
                return "dagster"

        # Check pyproject.toml for dagster dependencies
        pyproject_file = repo_dir / "pyproject.toml"
        if pyproject_file.exists():
            try:
                content = pyproject_file.read_text()
                # Simple check - if "dagster" appears in dependencies
                if "dagster" in content.lower():
                    print(f"   Found 'dagster' in pyproject.toml - this is a Dagster project")
                    return "dagster"
            except Exception as e:
                print(f"   Could not read pyproject.toml: {e}")

        print(f"   No dbt or Dagster project markers found - unknown project type")
        return "unknown"

    def _find_dbt_projects_recursive(self, repo_dir: Path, max_depth: int = 3) -> list[Path]:
        """Recursively search for dbt projects (dbt_project.yml files) in subdirectories.

        Args:
            repo_dir: Path to the root directory to search
            max_depth: Maximum depth to search (default 3)

        Returns:
            List of Path objects pointing to directories containing dbt_project.yml files
        """
        dbt_projects = []

        def search_dir(current_dir: Path, depth: int):
            if depth > max_depth:
                return

            # Don't search hidden directories or common non-project directories
            if current_dir.name.startswith('.') or current_dir.name in {'node_modules', '__pycache__', 'venv', '.venv'}:
                return

            try:
                # Check if current directory has dbt_project.yml
                if (current_dir / "dbt_project.yml").exists():
                    dbt_projects.append(current_dir)
                    print(f"   Found dbt project at: {current_dir.relative_to(repo_dir)}")
                    # Don't search subdirectories of a dbt project
                    return

                # Search subdirectories
                for item in current_dir.iterdir():
                    if item.is_dir():
                        search_dir(item, depth + 1)
            except (PermissionError, OSError) as e:
                # Skip directories we can't access
                pass

        print(f"🔍 Searching for dbt projects in subdirectories...")
        search_dir(repo_dir, 0)

        if dbt_projects:
            print(f"✅ Found {len(dbt_projects)} dbt project(s)")
        else:
            print(f"   No dbt projects found in subdirectories")

        return dbt_projects

    def _create_dbt_profiles(self, dbt_dir: Path, project_root: Path):
        """Create or enhance profiles.yml for dbt introspection.

        Args:
            dbt_dir: Path to the dbt project directory
            project_root: Path to the Dagster project root (where .env file goes)

        Checks for existing profiles in common locations:
        1. profiles.yml in root (standard location)
        2. profile/profiles.yml (some projects use this)
        3. profiles/profiles.yml (alternative naming)

        If found in a subdirectory:
        - Copies it to root
        - Extracts env vars and creates .env file at project root
        - Adds a dev target with DuckDB for local development

        Otherwise, creates a minimal profiles.yml.
        """
        import shutil
        import yaml
        import re

        profiles_file = dbt_dir / "profiles.yml"

        # Check if profiles.yml already exists in root
        if profiles_file.exists():
            print(f"ℹ️  Using existing profiles.yml in root")
            return

        # Check for profiles.yml in common subdirectories
        possible_locations = [
            dbt_dir / "profile" / "profiles.yml",
            dbt_dir / "profiles" / "profiles.yml",
        ]

        existing_profiles_path = None
        for location in possible_locations:
            if location.exists():
                existing_profiles_path = location
                break

        if existing_profiles_path:
            print(f"✅ Found existing profiles.yml at {existing_profiles_path.relative_to(dbt_dir)}")

            # Read the existing profiles
            try:
                with open(existing_profiles_path, 'r') as f:
                    profiles_content = f.read()
                    profiles_data = yaml.safe_load(profiles_content)

                # Extract environment variables from the profiles
                env_vars = re.findall(r"env_var\(['\"]([^'\"]+)['\"]\)", profiles_content)
                if env_vars:
                    # Create .env file at the PROJECT ROOT (where the env var editor expects it)
                    env_file = project_root / ".env"
                    env_lines = ["# Environment variables for dbt project", ""]
                    for var in sorted(set(env_vars)):
                        # Add placeholder with descriptive comment
                        env_lines.append(f"# TODO: Set your {var}")
                        env_lines.append(f"{var}=")
                        env_lines.append("")

                    env_file.write_text("\n".join(env_lines))
                    print(f"📝 Created .env file at project root with {len(set(env_vars))} environment variable placeholders")

                # Find the profile name (first non-config key in the profiles)
                # Skip 'config' key as that's dbt settings, not a profile
                profile_keys = [k for k in profiles_data.keys() if k != 'config']
                profile_name = profile_keys[0] if profile_keys else "default"

                # Add a dev target with DuckDB if it doesn't exist
                if profile_name in profiles_data:
                    profile_config = profiles_data[profile_name]
                    outputs = profile_config.get('outputs', {})

                    # Only add dev target if it doesn't exist
                    if 'dev' not in outputs:
                        # Add dev target with DuckDB
                        outputs['dev'] = {
                            'type': 'duckdb',
                            'path': '../data.duckdb'
                        }

                        # Change default target to dev for local development
                        profile_config['target'] = 'dev'
                        profile_config['outputs'] = outputs

                        # Write the modified profiles back
                        with open(profiles_file, 'w') as f:
                            yaml.dump(profiles_data, f, default_flow_style=False, sort_keys=False)
                        print(f"📋 Enhanced profiles.yml with dev target (DuckDB) for local development")
                    else:
                        # Just copy as-is if dev target exists
                        shutil.copy(existing_profiles_path, profiles_file)
                        print(f"📋 Copied profiles.yml to root")
                else:
                    # Couldn't parse properly, just copy
                    shutil.copy(existing_profiles_path, profiles_file)
                    print(f"📋 Copied profiles.yml to root")

            except Exception as e:
                print(f"⚠️  Error processing profiles.yml: {e}")
                # Fall back to simple copy
                shutil.copy(existing_profiles_path, profiles_file)
                print(f"📋 Copied profiles.yml to root (fallback)")

            return

        # No existing profiles found - create a minimal one
        # Extract profile name from dbt_project.yml if it exists
        # Note: dbt_project.yml has both 'name' (project name) and 'profile' (which profile to use)
        # We need to use the 'profile' field, not 'name'
        dbt_project_file = dbt_dir / "dbt_project.yml"
        profile_name = "default"

        if dbt_project_file.exists():
            try:
                with open(dbt_project_file, 'r') as f:
                    dbt_config = yaml.safe_load(f)
                    # Use the 'profile' field if it exists, otherwise fall back to 'name'
                    profile_name = dbt_config.get('profile', dbt_config.get('name', 'default'))
            except:
                pass

        # Detect the adapter type
        adapter_type = self._detect_dbt_adapter(dbt_dir)

        # Create minimal profiles.yml with detected adapter
        # Note: path is relative to the dbt project directory (dbt_dir)
        # The data.duckdb file is in the parent directory (Dagster project root)
        profiles_content = f"""{profile_name}:
  target: dev
  outputs:
    dev:
      type: {adapter_type}
      path: ../data.duckdb
"""
        profiles_file.write_text(profiles_content)
        print(f"📝 Created profiles.yml for profile '{profile_name}' with adapter: {adapter_type}")


# Global service instance
project_service = ProjectService()
