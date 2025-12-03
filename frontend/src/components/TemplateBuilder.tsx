import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Code,
  Database,
  Clock,
  Play,
  Radar,
  CheckCircle,
  Save,
  FileCode,
  Plus,
  Users,
  ArrowLeftRight,
  AlertTriangle,
  Timer,
  Workflow,
} from 'lucide-react';
import { primitivesApi } from '@/services/api';
import { CommunityTemplates } from './CommunityTemplates';
import { PipelineTemplates } from './PipelineTemplates';
import { CronBuilder } from './CronBuilder';
import { EnhancedDataQualityChecksBuilder } from './EnhancedDataQualityChecksBuilder';
import {
  templatesApi,
  type PythonAssetParams,
  type SQLAssetParams,
  type ScheduleParams,
  type JobParams,
  type SensorParams,
  type AssetCheckParams,
  type FreshnessPolicyParams,
} from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

export function TemplateBuilder() {
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('python_asset');
  const [generatedCode, setGeneratedCode] = useState('');
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [scheduleType, setScheduleType] = useState<'job' | 'assets'>('job');

  // Fetch available jobs - only when needed (for schedules and sensors)
  const needsPrimitives = activeTab === 'schedule' || activeTab === 'sensor';
  const { data: primitivesData } = useQuery({
    queryKey: ['primitives', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.listAll(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject && needsPrimitives,
  });

  // Fetch all definitions (from dg list defs - includes all jobs, not just template-created)
  const { data: allDefinitions } = useQuery({
    queryKey: ['definitions', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.getAllDefinitions(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject && needsPrimitives,
  });

  // Merge template-created jobs with discovered jobs from definitions
  const getAvailableJobs = () => {
    const templateJobs = primitivesData?.primitives.jobs || [];
    const definitionJobs = allDefinitions?.jobs || [];

    // Mark template jobs
    const jobs = templateJobs.map(j => ({ name: j.name, isManaged: true }));

    // Add discovered jobs that aren't already in template jobs
    const managedNames = new Set(jobs.map(j => j.name));
    const discovered = definitionJobs
      .filter(d => !managedNames.has(d.name))
      .map(d => ({ name: d.name, isManaged: false }));

    return [...jobs, ...discovered];
  };

  // Fetch installed community components - always fetch when project is loaded for instant availability
  const { data: installedComponents } = useQuery({
    queryKey: ['installed-components', currentProject?.id],
    queryFn: () => currentProject ? templatesApi.getInstalled(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Filter for sensor components only
  const communitySensors = installedComponents?.components.filter(
    (component) => component.category === 'sensors'
  ) || [];

  // Filter for asset check components only
  const communityAssetChecks = installedComponents?.components.filter(
    (component) => component.category === 'asset_checks'
  ) || [];

  // Fetch schema for selected community sensor
  const [selectedCommunitySensor, setSelectedCommunitySensor] = useState<string | null>(null);
  const [communitySensorAttributes, setCommunitySensorAttributes] = useState<Record<string, any>>({});

  const { data: communitySensorSchema, isLoading: schemaLoading } = useQuery({
    queryKey: ['component-schema', currentProject?.id, selectedCommunitySensor],
    queryFn: () =>
      currentProject && selectedCommunitySensor
        ? templatesApi.getInstalledComponentSchema(currentProject.id, selectedCommunitySensor)
        : Promise.reject('No component selected'),
    enabled: !!currentProject && !!selectedCommunitySensor,
  });

  // Initialize community sensor attributes with defaults when schema loads
  useEffect(() => {
    if (communitySensorSchema?.attributes) {
      console.log('Community sensor schema loaded:', communitySensorSchema);
      const defaults: Record<string, any> = {};
      Object.entries(communitySensorSchema.attributes).forEach(([key, attr]) => {
        if (attr.default !== undefined) {
          defaults[key] = attr.default;
        }
      });
      setCommunitySensorAttributes(defaults);
    }
  }, [communitySensorSchema]);

  // Debug log
  useEffect(() => {
    console.log('Selected community sensor:', selectedCommunitySensor);
    console.log('Schema loading:', schemaLoading);
    console.log('Schema data:', communitySensorSchema);
  }, [selectedCommunitySensor, schemaLoading, communitySensorSchema]);

  // State management for community asset checks
  const [selectedCommunityAssetCheck, setSelectedCommunityAssetCheck] = useState<string | null>(null);
  const [communityAssetCheckAttributes, setCommunityAssetCheckAttributes] = useState<Record<string, any>>({});
  const [communityAssetCheckInstanceName, setCommunityAssetCheckInstanceName] = useState<string>('');

  const { data: communityAssetCheckSchema, isLoading: assetCheckSchemaLoading } = useQuery({
    queryKey: ['component-schema-asset-check', currentProject?.id, selectedCommunityAssetCheck],
    queryFn: () =>
      currentProject && selectedCommunityAssetCheck
        ? templatesApi.getInstalledComponentSchema(currentProject.id, selectedCommunityAssetCheck)
        : Promise.reject('No component selected'),
    enabled: !!currentProject && !!selectedCommunityAssetCheck,
  });

  // Initialize community asset check attributes with defaults when schema loads
  useEffect(() => {
    if (communityAssetCheckSchema?.attributes) {
      console.log('Community asset check schema loaded:', communityAssetCheckSchema);
      const defaults: Record<string, any> = {};
      Object.entries(communityAssetCheckSchema.attributes).forEach(([key, attr]) => {
        if (attr.default !== undefined) {
          defaults[key] = attr.default;
        }
      });
      setCommunityAssetCheckAttributes(defaults);
    }
  }, [communityAssetCheckSchema]);

  // Auto-generate unique instance name for enhanced_data_quality_checks
  useEffect(() => {
    if (selectedCommunityAssetCheck === 'enhanced_data_quality_checks' && !communityAssetCheckInstanceName) {
      const timestamp = new Date().getTime().toString().slice(-6);
      const suggestedName = `enhanced_data_quality_checks_${timestamp}`;
      console.log('[TemplateBuilder] Auto-generating instance name:', suggestedName);
      setCommunityAssetCheckInstanceName(suggestedName);
    } else if (selectedCommunityAssetCheck !== 'enhanced_data_quality_checks') {
      // Clear instance name when switching away from enhanced_data_quality_checks
      setCommunityAssetCheckInstanceName('');
    }
  }, [selectedCommunityAssetCheck, communityAssetCheckInstanceName]);

  // Python Asset Form State
  const [pythonAsset, setPythonAsset] = useState<PythonAssetParams>({
    asset_name: 'my_asset',
    group_name: '',
    description: '',
    compute_kind: 'python',
    code: '',
    deps: [],
    owners: [],
    tags: {},
  });

  // SQL Asset Form State
  const [sqlAsset, setSqlAsset] = useState<SQLAssetParams>({
    asset_name: 'my_sql_asset',
    query: 'SELECT * FROM table',
    group_name: '',
    description: '',
    io_manager_key: 'db_io_manager',
    deps: [],
  });

  // Schedule Form State
  const [schedule, setSchedule] = useState<ScheduleParams>({
    schedule_name: 'my_schedule',
    cron_expression: '0 0 * * *',
    job_name: 'my_job',
    description: '',
    timezone: 'UTC',
  });

  // Job Form State
  const [job, setJob] = useState<JobParams>({
    job_name: 'my_job',
    asset_selection: [],
    description: '',
    tags: {},
  });

  // Selection mode state
  const [jobSelectionMode, setJobSelectionMode] = useState<'select' | 'filter'>('select');
  const [pythonAssetSelectionMode, setPythonAssetSelectionMode] = useState<'select' | 'filter'>('select');
  const [scheduleSelectionMode, setScheduleSelectionMode] = useState<'select' | 'filter'>('select');
  const [assetSensorMode, setAssetSensorMode] = useState<'select' | 'external'>('select');

  // Sensor Form State
  const [sensor, setSensor] = useState<SensorParams>({
    sensor_name: 'my_sensor',
    sensor_type: 'custom',
    job_name: 'my_job',
    description: '',
    file_path: '',
    monitored_job_name: '',
    run_status: 'SUCCESS',
    minimum_interval_seconds: 30,
  });

  // Asset Check Form State
  const [assetCheck, setAssetCheck] = useState<AssetCheckParams>({
    check_name: 'my_check',
    asset_name: 'my_asset',
    check_type: 'row_count',
    description: '',
    threshold: 0,
    max_age_hours: 24,
  });

  // Freshness Policy Form State
  const [freshnessPolicy, setFreshnessPolicy] = useState<FreshnessPolicyParams>({
    policy_name: 'my_freshness_policy',
    description: '',
    maximum_lag_minutes: 60,
    maximum_lag_env_var: '',
    cron_schedule: '',
    cron_env_var: '',
  });

  // Handle URL parameters for pre-selecting values
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    const type = params.get('type');
    const asset = params.get('asset');

    if (type === 'asset_check' && asset) {
      setActiveTab('asset_check');
      setAssetCheck(prev => ({
        ...prev,
        asset_name: decodeURIComponent(asset),
        check_name: `check_${decodeURIComponent(asset).replace(/\//g, '_')}`,
      }));
    }
  }, []);

  // Generate mutations
  const generatePythonAssetMutation = useMutation({
    mutationFn: () => templatesApi.generatePythonAsset(pythonAsset),
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateSQLAssetMutation = useMutation({
    mutationFn: () => templatesApi.generateSQLAsset(sqlAsset),
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateScheduleMutation = useMutation({
    mutationFn: () => {
      // Prepare schedule params based on scheduleType
      const params: any = {
        schedule_name: schedule.schedule_name,
        cron_expression: schedule.cron_expression,
        description: schedule.description,
        timezone: schedule.timezone,
      };

      if (scheduleType === 'job') {
        params.job_name = schedule.job_name;
      } else {
        // Parse comma-separated asset names
        const assets = schedule.job_name
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        params.asset_selection = assets;
      }

      return templatesApi.generateSchedule(params);
    },
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateJobMutation = useMutation({
    mutationFn: () => templatesApi.generateJob({ ...job, project_id: currentProject?.id }),
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateSensorMutation = useMutation({
    mutationFn: () => {
      // Merge community sensor attributes into sensor params if it's a community sensor
      let sensorParams = sensor;
      if (selectedCommunitySensor && communitySensorSchema) {
        sensorParams = {
          ...sensor,
          ...communitySensorAttributes,
          component_type: communitySensorSchema.type, // Include the actual component type
        };
      }
      return templatesApi.generateSensor(sensorParams);
    },
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateAssetCheckMutation = useMutation({
    mutationFn: () => {
      // For community asset checks, generate component YAML
      if (selectedCommunityAssetCheck) {
        // Generate YAML for the component
        const yaml = `type: ${selectedCommunityAssetCheck === 'enhanced_data_quality_checks'
          ? 'dagster_component_templates.EnhancedDataQualityChecksComponent'
          : communityAssetCheckSchema?.type || selectedCommunityAssetCheck}
attributes:
${generateYamlAttributes(communityAssetCheckAttributes, 1)}`;

        return Promise.resolve({
          code: yaml,
          check_name: selectedCommunityAssetCheck
        });
      }

      // For basic asset checks, use the standard API
      return templatesApi.generateAssetCheck(assetCheck);
    },
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const generateFreshnessPolicyMutation = useMutation({
    mutationFn: () => templatesApi.generateFreshnessPolicy(freshnessPolicy),
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  // Helper function to convert attributes to YAML format
  const generateYamlAttributes = (attrs: Record<string, any>, indentLevel: number): string => {
    const indent = '  '.repeat(indentLevel);
    let yaml = '';

    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${indent}${key}:\n`;
        yaml += generateYamlAttributes(value, indentLevel + 1);
      } else if (Array.isArray(value)) {
        yaml += `${indent}${key}:\n`;
        value.forEach((item) => {
          if (typeof item === 'object') {
            yaml += `${indent}  -\n`;
            yaml += generateYamlAttributes(item, indentLevel + 2);
          } else {
            yaml += `${indent}  - ${JSON.stringify(item)}\n`;
          }
        });
      } else if (typeof value === 'string') {
        yaml += `${indent}${key}: "${value}"\n`;
      } else {
        yaml += `${indent}${key}: ${value}\n`;
      }
    }

    return yaml;
  };

  const handleTabChange = (newTab: string) => {
    if (generatedCode && newTab !== activeTab) {
      if (confirm('You have unsaved generated code. Do you want to discard it and switch tabs?')) {
        setGeneratedCode('');
        setActiveTab(newTab);
      }
    } else {
      setActiveTab(newTab);
    }
  };

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!currentProject) throw new Error('No project selected');

      // For community asset checks, use configure endpoint
      if (selectedCommunityAssetCheck) {
        // For enhanced_data_quality_checks, validate instance name
        if (selectedCommunityAssetCheck === 'enhanced_data_quality_checks') {
          if (!communityAssetCheckInstanceName || communityAssetCheckInstanceName.trim() === '') {
            throw new Error('Instance Name is required for Enhanced Data Quality Checks');
          }
        }

        // For enhanced_data_quality_checks, include the instance name
        const config = selectedCommunityAssetCheck === 'enhanced_data_quality_checks'
          ? { name: communityAssetCheckInstanceName, ...communityAssetCheckAttributes }
          : communityAssetCheckAttributes;

        console.log('[TemplateBuilder] Saving community asset check with config:', config);

        const response = await fetch(`/api/v1/templates/configure/${selectedCommunityAssetCheck}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: currentProject.id,
            config,
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
          throw new Error(error.detail || 'Failed to configure component');
        }

        return response.json();
      }

      // For regular templates, save as code files
      const primitiveTypeMap: Record<string, string> = {
        python_asset: pythonAsset.asset_name,
        sql_asset: sqlAsset.asset_name,
        schedule: schedule.schedule_name,
        job: job.job_name,
        sensor: sensor.sensor_name,
        asset_check: assetCheck.check_name,
        freshness_policy: freshnessPolicy.policy_name,
      };

      return templatesApi.save({
        project_id: currentProject.id,
        primitive_type: activeTab as any,
        name: primitiveTypeMap[activeTab],
        code: generatedCode,
      });
    },
    onSuccess: async (data) => {
      if (selectedCommunityAssetCheck) {
        alert(`Component configured successfully!\n\nYAML file: ${data.yaml_file}`);
        // Invalidate installed components cache and reload project
        if (currentProject) {
          queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
          loadProject(currentProject.id);
        }
      } else {
        alert(`Saved to ${data.file_path}`);

        // Invalidate primitives and definitions cache so jobs/schedules/sensors appear immediately
        if (currentProject) {
          // Clear backend cache to force fresh fetch
          try {
            await fetch(`/api/v1/primitives/definitions/cache/${currentProject.id}`, {
              method: 'DELETE',
            });
          } catch (error) {
            console.warn('Failed to clear backend cache:', error);
          }

          // Invalidate template-created primitives (for schedules/sensors dropdowns)
          queryClient.invalidateQueries({ queryKey: ['primitives', currentProject.id] });
          // Invalidate all definitions (from dg list defs - includes all jobs)
          queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });
        }
      }
    },
  });

  const handleGenerate = () => {
    switch (activeTab) {
      case 'python_asset':
        generatePythonAssetMutation.mutate();
        break;
      case 'sql_asset':
        generateSQLAssetMutation.mutate();
        break;
      case 'schedule':
        generateScheduleMutation.mutate();
        break;
      case 'job':
        generateJobMutation.mutate();
        break;
      case 'sensor':
        generateSensorMutation.mutate();
        break;
      case 'asset_check':
        generateAssetCheckMutation.mutate();
        break;
      case 'freshness_policy':
        generateFreshnessPolicyMutation.mutate();
        break;
    }
  };

  const handleSave = () => {
    if (!generatedCode) {
      alert('Generate code first');
      return;
    }
    saveMutation.mutate();
  };

  return (
    <div className="h-full flex bg-white">
      {/* Left Panel - Form */}
      <div className={`${activeTab === 'community' || activeTab === 'pipelines' ? 'w-full' : 'w-1/2 border-r border-gray-200'} flex flex-col`}>
        <Tabs.Root value={activeTab} onValueChange={handleTabChange} className="flex-1 min-h-0 flex flex-col">
          {/* Tab List */}
          <Tabs.List className="flex flex-shrink-0 border-b border-gray-200 overflow-x-auto">
            <Tabs.Trigger
              value="python_asset"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Code className="w-4 h-4" />
              <span>Python Asset</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="sql_asset"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Database className="w-4 h-4" />
              <span>SQL Asset</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="schedule"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Clock className="w-4 h-4" />
              <span>Schedule</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="job"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Play className="w-4 h-4" />
              <span>Job</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="sensor"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Radar className="w-4 h-4" />
              <span>Sensor</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="asset_check"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <CheckCircle className="w-4 h-4" />
              <span>Asset Check</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="freshness_policy"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Timer className="w-4 h-4" />
              <span>Freshness Policy</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="community"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Users className="w-4 h-4" />
              <span>Community</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="pipelines"
              className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Workflow className="w-4 h-4" />
              <span>Pipeline Templates</span>
            </Tabs.Trigger>
          </Tabs.List>

          {/* Python Asset Tab */}
          <Tabs.Content value="python_asset" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Asset Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={pythonAsset.asset_name}
                onChange={(e) => setPythonAsset({ ...pythonAsset, asset_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_asset"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Group Name</label>
              <input
                type="text"
                value={pythonAsset.group_name}
                onChange={(e) => setPythonAsset({ ...pythonAsset, group_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="analytics"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={pythonAsset.description}
                onChange={(e) => setPythonAsset({ ...pythonAsset, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="A Python asset that..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Compute Kind</label>
              <input
                type="text"
                value={pythonAsset.compute_kind}
                onChange={(e) => setPythonAsset({ ...pythonAsset, compute_kind: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="python"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Dependencies
                </label>
                <div className="flex rounded-md border border-gray-300 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPythonAssetSelectionMode('select')}
                    className={`px-3 py-1 text-xs font-medium ${
                      pythonAssetSelectionMode === 'select'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Select Assets
                  </button>
                  <button
                    type="button"
                    onClick={() => setPythonAssetSelectionMode('filter')}
                    className={`px-3 py-1 text-xs font-medium border-l border-gray-300 ${
                      pythonAssetSelectionMode === 'filter'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Filter Expression
                  </button>
                </div>
              </div>

              {pythonAssetSelectionMode === 'select' ? (
                /* Multi-select dropdown mode */
                (() => {
                  const availableAssets = currentProject?.graph.nodes
                    .filter((node: any) => node.node_kind === 'asset')
                    .map((node: any) => node.data.asset_key || node.id) || [];

                  return availableAssets.length > 0 ? (
                    <div className="space-y-2">
                      <select
                        multiple
                        value={pythonAsset.deps || []}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                          setPythonAsset({ ...pythonAsset, deps: selected });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        size={Math.min(5, Math.max(3, availableAssets.length))}
                      >
                        {availableAssets.map((assetKey: string) => (
                          <option key={assetKey} value={assetKey}>
                            {assetKey}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500">
                        Hold Cmd/Ctrl to select multiple assets
                      </p>
                      {pythonAsset.deps && pythonAsset.deps.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {pythonAsset.deps.map((dep: string) => (
                            <span
                              key={dep}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                            >
                              {dep}
                              <button
                                onClick={() => {
                                  setPythonAsset({
                                    ...pythonAsset,
                                    deps: pythonAsset.deps?.filter((d: string) => d !== dep),
                                  });
                                }}
                                className="hover:text-blue-900"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md p-3">
                      No assets found. Use Filter Expression mode or load assets first.
                    </div>
                  );
                })()
              ) : (
                /* Filter expression mode */
                <div className="space-y-2">
                  <input
                    type="text"
                    value={pythonAsset.deps?.join(', ') || ''}
                    onChange={(e) =>
                      setPythonAsset({
                        ...pythonAsset,
                        deps: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="* or tag:team=marketing or +upstream_asset"
                  />
                  <p className="text-xs text-gray-500">
                    Use Dagster asset selection syntax. Examples: <code className="bg-gray-100 px-1 rounded">*</code>, <code className="bg-gray-100 px-1 rounded">tag:team=data</code>, <code className="bg-gray-100 px-1 rounded">+my_asset</code>
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Owners (comma-separated emails)
              </label>
              <input
                type="text"
                value={pythonAsset.owners?.join(', ')}
                onChange={(e) =>
                  setPythonAsset({
                    ...pythonAsset,
                    owners: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="team@company.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Asset Code (function body)
              </label>
              <textarea
                value={pythonAsset.code}
                onChange={(e) => setPythonAsset({ ...pythonAsset, code: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                rows={6}
                placeholder="# Your asset logic here&#10;return {}"
              />
            </div>

            <button
              onClick={handleGenerate}
              disabled={generatePythonAssetMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* SQL Asset Tab */}
          <Tabs.Content value="sql_asset" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Asset Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={sqlAsset.asset_name}
                onChange={(e) => setSqlAsset({ ...sqlAsset, asset_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_sql_asset"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                SQL Query <span className="text-red-500">*</span>
              </label>
              <textarea
                value={sqlAsset.query}
                onChange={(e) => setSqlAsset({ ...sqlAsset, query: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                rows={8}
                placeholder="SELECT * FROM table"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Group Name</label>
              <input
                type="text"
                value={sqlAsset.group_name}
                onChange={(e) => setSqlAsset({ ...sqlAsset, group_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="analytics"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={sqlAsset.description}
                onChange={(e) => setSqlAsset({ ...sqlAsset, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="A SQL asset that..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">IO Manager Key</label>
              <input
                type="text"
                value={sqlAsset.io_manager_key}
                onChange={(e) => setSqlAsset({ ...sqlAsset, io_manager_key: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="db_io_manager"
              />
            </div>

            <button
              onClick={handleGenerate}
              disabled={generateSQLAssetMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Schedule Tab */}
          <Tabs.Content value="schedule" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Schedule Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={schedule.schedule_name}
                onChange={(e) => setSchedule({ ...schedule, schedule_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_schedule"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Cron Expression <span className="text-red-500">*</span>
              </label>
              <CronBuilder
                value={schedule.cron_expression}
                onChange={(cron) => setSchedule({ ...schedule, cron_expression: cron })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Schedule Type <span className="text-red-500">*</span>
              </label>
              <div className="flex space-x-4 mb-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="job"
                    checked={scheduleType === 'job'}
                    onChange={(e) => setScheduleType(e.target.value as 'job' | 'assets')}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Schedule a Job</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="assets"
                    checked={scheduleType === 'assets'}
                    onChange={(e) => setScheduleType(e.target.value as 'job' | 'assets')}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Schedule Assets</span>
                </label>
              </div>
            </div>

            {scheduleType === 'job' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Job Name <span className="text-red-500">*</span>
                </label>
                {(() => {
                  const availableJobs = getAvailableJobs();
                  return availableJobs.length > 0 ? (
                    <select
                      value={schedule.job_name}
                      onChange={(e) => setSchedule({ ...schedule, job_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    >
                      <option value="">Select a job...</option>
                      {availableJobs.map((job) => (
                        <option key={job.name} value={job.name}>
                          {job.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={schedule.job_name}
                        onChange={(e) => setSchedule({ ...schedule, job_name: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        placeholder="my_job"
                      />
                      <p className="text-xs text-amber-600 mt-1 flex items-center">
                        <Plus className="w-3 h-3 mr-1" />
                        No jobs found. Create a job first or enter a job name manually.
                      </p>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Asset Selection <span className="text-red-500">*</span>
                  </label>
                  <div className="flex rounded-md border border-gray-300 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setScheduleSelectionMode('select')}
                      className={`px-3 py-1 text-xs font-medium ${
                        scheduleSelectionMode === 'select'
                          ? 'bg-blue-600 text-white'
                          : 'bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Select Assets
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleSelectionMode('filter')}
                      className={`px-3 py-1 text-xs font-medium border-l border-gray-300 ${
                        scheduleSelectionMode === 'filter'
                          ? 'bg-blue-600 text-white'
                          : 'bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Filter Expression
                    </button>
                  </div>
                </div>

                {scheduleSelectionMode === 'select' ? (
                  /* Multi-select dropdown mode */
                  (() => {
                    const availableAssets = currentProject?.graph.nodes
                      .filter((node: any) => node.node_kind === 'asset')
                      .map((node: any) => node.data.asset_key || node.id) || [];

                    // Parse current comma-separated value into array
                    const selectedAssets = schedule.job_name
                      .split(',')
                      .map(s => s.trim())
                      .filter(s => s.length > 0);

                    return availableAssets.length > 0 ? (
                      <div className="space-y-2">
                        <select
                          multiple
                          value={selectedAssets}
                          onChange={(e) => {
                            const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                            setSchedule({ ...schedule, job_name: selected.join(', ') });
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          size={Math.min(6, Math.max(3, availableAssets.length))}
                        >
                          {availableAssets.map((assetKey: string) => (
                            <option key={assetKey} value={assetKey}>
                              {assetKey}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-500">
                          Hold Cmd/Ctrl to select multiple assets
                        </p>
                        {selectedAssets.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {selectedAssets.map((asset: string) => (
                              <span
                                key={asset}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                              >
                                {asset}
                                <button
                                  onClick={() => {
                                    const filtered = selectedAssets.filter((a: string) => a !== asset);
                                    setSchedule({ ...schedule, job_name: filtered.join(', ') });
                                  }}
                                  className="hover:text-blue-900"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md p-3">
                        No assets found. Use Filter Expression mode or load assets first.
                      </div>
                    );
                  })()
                ) : (
                  /* Filter expression mode */
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={schedule.job_name}
                      onChange={(e) => setSchedule({ ...schedule, job_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="* or tag:team=marketing or group:analytics"
                    />
                    <p className="text-xs text-gray-500">
                      Use Dagster asset selection syntax. Examples: <code className="bg-gray-100 px-1 rounded">*</code>, <code className="bg-gray-100 px-1 rounded">tag:team=data</code>, <code className="bg-gray-100 px-1 rounded">group:analytics</code>
                    </p>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={schedule.description}
                onChange={(e) => setSchedule({ ...schedule, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="Schedule to run..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
              <input
                type="text"
                value={schedule.timezone}
                onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="UTC"
              />
            </div>

            <button
              onClick={handleGenerate}
              disabled={generateScheduleMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Job Tab */}
          <Tabs.Content value="job" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Job Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={job.job_name}
                onChange={(e) => setJob({ ...job, job_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_job"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Asset Selection <span className="text-red-500">*</span>
                </label>
                <div className="flex rounded-md border border-gray-300 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setJobSelectionMode('select')}
                    className={`px-3 py-1 text-xs font-medium ${
                      jobSelectionMode === 'select'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Select Assets
                  </button>
                  <button
                    type="button"
                    onClick={() => setJobSelectionMode('filter')}
                    className={`px-3 py-1 text-xs font-medium border-l border-gray-300 ${
                      jobSelectionMode === 'filter'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Filter Expression
                  </button>
                </div>
              </div>

              {jobSelectionMode === 'select' ? (
                /* Multi-select dropdown mode */
                (() => {
                  const availableAssets = currentProject?.graph.nodes
                    .filter((node: any) => node.node_kind === 'asset')
                    .map((node: any) => node.data.asset_key || node.id) || [];

                  return availableAssets.length > 0 ? (
                    <div className="space-y-2">
                      <select
                        multiple
                        value={job.asset_selection}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                          setJob({ ...job, asset_selection: selected });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        size={Math.min(6, Math.max(3, availableAssets.length))}
                      >
                        {availableAssets.map((assetKey: string) => (
                          <option key={assetKey} value={assetKey}>
                            {assetKey}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500">
                        Hold Cmd/Ctrl to select multiple assets
                      </p>
                      {job.asset_selection.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {job.asset_selection.map((asset: string) => (
                            <span
                              key={asset}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                            >
                              {asset}
                              <button
                                onClick={() => {
                                  setJob({
                                    ...job,
                                    asset_selection: job.asset_selection.filter((a: string) => a !== asset),
                                  });
                                }}
                                className="hover:text-blue-900"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Partition compatibility validation */}
                      {(() => {
                        if (job.asset_selection.length === 0 || !currentProject?.graph?.nodes) {
                          return null;
                        }

                        // Get partition configs for selected assets
                        const selectedAssetPartitions = job.asset_selection
                          .map((assetKey: string) => {
                            const node = currentProject.graph.nodes.find(
                              (n: any) => (n.data.asset_key || n.id) === assetKey
                            );
                            if (!node?.data?.partition_config?.enabled) {
                              return null;
                            }
                            return {
                              assetKey,
                              partitionType: node.data.partition_config.partition_type,
                              startDate: node.data.partition_config.start_date,
                              timezone: node.data.partition_config.timezone,
                            };
                          })
                          .filter(Boolean);

                        // If no partitioned assets or only one, no incompatibility
                        if (selectedAssetPartitions.length <= 1) {
                          return null;
                        }

                        // Check for incompatibility
                        const firstPartition = selectedAssetPartitions[0];
                        const incompatibleAssets = selectedAssetPartitions.filter((p: any) => {
                          return (
                            p.partitionType !== firstPartition.partitionType ||
                            p.startDate !== firstPartition.startDate ||
                            p.timezone !== firstPartition.timezone
                          );
                        });

                        if (incompatibleAssets.length === 0) {
                          return null;
                        }

                        // Group assets by their partition config
                        const partitionGroups = new Map<string, string[]>();
                        selectedAssetPartitions.forEach((p: any) => {
                          const key = `${p.partitionType}|${p.startDate || 'none'}|${p.timezone || 'UTC'}`;
                          if (!partitionGroups.has(key)) {
                            partitionGroups.set(key, []);
                          }
                          partitionGroups.get(key)!.push(p.assetKey);
                        });

                        return (
                          <div className="mt-3 bg-amber-50 border border-amber-300 rounded-md p-3">
                            <div className="flex gap-2">
                              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-amber-900">
                                  Warning: Selected assets have incompatible partition definitions
                                </p>
                                <p className="text-xs text-amber-800 mt-1">
                                  Dagster requires all partitioned assets in a job to have the same partition definition.
                                </p>
                                <div className="mt-2 space-y-2">
                                  {Array.from(partitionGroups.entries()).map(([config, assets], idx) => {
                                    const [partitionType, startDate, timezone] = config.split('|');
                                    return (
                                      <div key={idx} className="text-xs">
                                        <div className="font-medium text-amber-900">
                                          {partitionType}
                                          {startDate !== 'none' && ` (start: ${startDate}, tz: ${timezone})`}:
                                        </div>
                                        <div className="ml-2 text-amber-700">
                                          {assets.join(', ')}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <div className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md p-3">
                      No assets found. Use Filter Expression mode or load assets first.
                    </div>
                  );
                })()
              ) : (
                /* Filter expression mode */
                <div className="space-y-2">
                  <input
                    type="text"
                    value={job.asset_selection.join(', ')}
                    onChange={(e) =>
                      setJob({
                        ...job,
                        asset_selection: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="* or tag:team=marketing or owner:user@company.com"
                  />
                  <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md p-2">
                    <strong>Examples:</strong>
                    <ul className="mt-1 space-y-0.5 ml-4 list-disc">
                      <li><code className="bg-white px-1 rounded">*</code> - All assets</li>
                      <li><code className="bg-white px-1 rounded">tag:team=marketing</code> - Assets with tag</li>
                      <li><code className="bg-white px-1 rounded">owner:user@company.com</code> - Assets by owner</li>
                      <li><code className="bg-white px-1 rounded">group:analytics</code> - Assets in group</li>
                      <li><code className="bg-white px-1 rounded">+my_asset</code> - Asset + downstream</li>
                      <li><code className="bg-white px-1 rounded">my_asset+</code> - Asset + upstream</li>
                    </ul>
                    <p className="mt-1">
                      <a
                        href="https://docs.dagster.io/guides/build/assets/asset-selection-syntax/reference"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        View full syntax →
                      </a>
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={job.description}
                onChange={(e) => setJob({ ...job, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="Job to materialize..."
              />
            </div>

            <button
              onClick={handleGenerate}
              disabled={generateJobMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Sensor Tab */}
          <Tabs.Content value="sensor" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sensor Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={sensor.sensor_name}
                onChange={(e) => setSensor({ ...sensor, sensor_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_sensor"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sensor Type <span className="text-red-500">*</span>
              </label>
              <select
                value={sensor.sensor_type}
                onChange={(e) => {
                  const newType = e.target.value;
                  setSensor({ ...sensor, sensor_type: newType as any });

                  // Check if this is a community sensor
                  const isCommunity = communitySensors.some(c => c.id === newType);
                  setSelectedCommunitySensor(isCommunity ? newType : null);
                  if (!isCommunity) {
                    setCommunitySensorAttributes({});
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <optgroup label="Basic Sensors">
                  <option value="custom">Custom</option>
                  <option value="file">File Sensor</option>
                  <option value="run_status">Run Status Sensor</option>
                  <option value="asset">Asset Sensor</option>
                </optgroup>
                <optgroup label="Convenience Sensors">
                  <option value="s3">S3 Bucket Sensor</option>
                  <option value="email">Email Inbox Sensor</option>
                  <option value="filesystem">File System Sensor</option>
                  <option value="database">Database Table Sensor</option>
                  <option value="webhook">Webhook Sensor</option>
                </optgroup>
                {communitySensors.length > 0 && (
                  <optgroup label="Installed Community Sensors">
                    {communitySensors.map((component) => (
                      <option key={component.id} value={component.id}>
                        {component.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {sensor.sensor_type === 'run_status' ? 'Job to Trigger' : 'Job Name'} <span className="text-red-500">*</span>
              </label>
              {(() => {
                const availableJobs = getAvailableJobs();
                return availableJobs.length > 0 ? (
                  <select
                    value={sensor.job_name}
                    onChange={(e) => setSensor({ ...sensor, job_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="">Select a job...</option>
                    {availableJobs.map((job) => (
                      <option key={job.name} value={job.name}>
                        {job.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      type="text"
                      value={sensor.job_name}
                      onChange={(e) => setSensor({ ...sensor, job_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="my_job"
                    />
                    <p className="text-xs text-amber-600 mt-1 flex items-center">
                      <Plus className="w-3 h-3 mr-1" />
                      No jobs found. Create a job first or enter a job name manually.
                    </p>
                  </>
                );
              })()}
              {sensor.sensor_type === 'run_status' && (
                <p className="text-xs text-gray-500 mt-1">
                  The job to run when the monitored job reaches the specified status
                </p>
              )}
            </div>

            {sensor.sensor_type === 'file' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">File Path</label>
                <input
                  type="text"
                  value={sensor.file_path}
                  onChange={(e) => setSensor({ ...sensor, file_path: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="/path/to/file"
                />
              </div>
            )}

            {sensor.sensor_type === 'run_status' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Monitored Job Name <span className="text-red-500">*</span>
                  </label>
                  {(() => {
                    const availableJobs = getAvailableJobs();
                    return availableJobs.length > 0 ? (
                      <select
                        value={sensor.monitored_job_name}
                        onChange={(e) => setSensor({ ...sensor, monitored_job_name: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      >
                        <option value="">Select a job to monitor...</option>
                        {availableJobs.map((job) => (
                          <option key={job.name} value={job.name}>
                            {job.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={sensor.monitored_job_name}
                          onChange={(e) => setSensor({ ...sensor, monitored_job_name: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder="upstream_job"
                        />
                        <p className="text-xs text-amber-600 mt-1 flex items-center">
                          <Plus className="w-3 h-3 mr-1" />
                          No jobs found. Create a job first or enter a job name manually.
                        </p>
                      </>
                    );
                  })()}
                  <p className="text-xs text-gray-500 mt-1">
                    The job whose run status to monitor
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Run Status to Monitor
                  </label>
                  <select
                    value={sensor.run_status}
                    onChange={(e) => setSensor({ ...sensor, run_status: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="FAILURE">FAILURE</option>
                    <option value="CANCELED">CANCELED</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Trigger when monitored job reaches this status
                  </p>
                </div>
              </>
            )}

            {sensor.sensor_type === 'asset' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">
                    Asset Key <span className="text-red-500">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setAssetSensorMode(assetSensorMode === 'select' ? 'external' : 'select')}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    {assetSensorMode === 'select' ? 'Use external asset' : 'Select from project'}
                  </button>
                </div>

                {assetSensorMode === 'select' ? (
                  <>
                    {currentProject?.graph.nodes.filter((node: any) => node.node_kind === 'asset' || node.type === 'asset').length > 0 ? (
                      <select
                        value={sensor.asset_key || ''}
                        onChange={(e) => setSensor({ ...sensor, asset_key: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      >
                        <option value="">Select an asset...</option>
                        {currentProject.graph.nodes
                          .filter((node: any) => node.node_kind === 'asset' || node.type === 'asset')
                          .map((node: any) => (
                            <option key={node.id} value={node.data.asset_key || node.id}>
                              {node.data.asset_key || node.data.label || node.id}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={sensor.asset_key || ''}
                          onChange={(e) => setSensor({ ...sensor, asset_key: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder="my_asset"
                        />
                        <p className="text-xs text-amber-600 mt-1">
                          No assets found in project. Enter asset key manually or add assets first.
                        </p>
                      </>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      Select an asset from your current project to monitor
                    </p>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={sensor.asset_key || ''}
                      onChange={(e) => setSensor({ ...sensor, asset_key: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="other_project/my_asset"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Enter an asset key from another Dagster project for cross-project monitoring
                    </p>
                  </>
                )}
              </div>
            )}

            {/* S3 Sensor Fields */}
            {sensor.sensor_type === 's3' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    S3 Bucket Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.bucket_name || ''}
                    onChange={(e) => setSensor({ ...sensor, bucket_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="my-data-bucket"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Object Prefix</label>
                  <input
                    type="text"
                    value={sensor.prefix || ''}
                    onChange={(e) => setSensor({ ...sensor, prefix: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="data/incoming/"
                  />
                  <p className="text-xs text-gray-500 mt-1">Filter objects by prefix</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pattern Match (Regex)</label>
                  <input
                    type="text"
                    value={sensor.pattern || ''}
                    onChange={(e) => setSensor({ ...sensor, pattern: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder=".*\.csv$"
                  />
                  <p className="text-xs text-gray-500 mt-1">Regex pattern to match object keys</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">AWS Region</label>
                  <input
                    type="text"
                    value={sensor.aws_region || ''}
                    onChange={(e) => setSensor({ ...sensor, aws_region: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="us-east-1"
                  />
                </div>
              </>
            )}

            {/* Email Sensor Fields */}
            {sensor.sensor_type === 'email' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    IMAP Host <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.imap_host || ''}
                    onChange={(e) => setSensor({ ...sensor, imap_host: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="imap.gmail.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">IMAP Port</label>
                  <input
                    type="number"
                    value={sensor.imap_port || 993}
                    onChange={(e) => setSensor({ ...sensor, imap_port: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="993"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Username <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.email_user || ''}
                    onChange={(e) => setSensor({ ...sensor, email_user: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="${EMAIL_USER}"
                  />
                  <p className="text-xs text-gray-500 mt-1">Use $&#123;VAR&#125; for environment variables</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Password <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    value={sensor.email_password || ''}
                    onChange={(e) => setSensor({ ...sensor, email_password: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="${EMAIL_PASSWORD}"
                  />
                  <p className="text-xs text-gray-500 mt-1">Use $&#123;VAR&#125; for environment variables</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subject Pattern (Regex)</label>
                  <input
                    type="text"
                    value={sensor.subject_pattern || ''}
                    onChange={(e) => setSensor({ ...sensor, subject_pattern: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="^\\[Alert\\].*"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From Pattern (Regex)</label>
                  <input
                    type="text"
                    value={sensor.from_pattern || ''}
                    onChange={(e) => setSensor({ ...sensor, from_pattern: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder=".*@company\\.com$"
                  />
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="mark_as_read"
                    checked={sensor.mark_as_read ?? true}
                    onChange={(e) => setSensor({ ...sensor, mark_as_read: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="mark_as_read" className="text-sm text-gray-700">
                    Mark emails as read after processing
                  </label>
                </div>
              </>
            )}

            {/* Filesystem Sensor Fields */}
            {sensor.sensor_type === 'filesystem' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Directory Path <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.directory_path || ''}
                    onChange={(e) => setSensor({ ...sensor, directory_path: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="/data/incoming"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">File Pattern</label>
                  <input
                    type="text"
                    value={sensor.file_pattern || '*'}
                    onChange={(e) => setSensor({ ...sensor, file_pattern: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="*.csv"
                  />
                  <p className="text-xs text-gray-500 mt-1">Glob pattern to match files</p>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="recursive"
                    checked={sensor.recursive ?? false}
                    onChange={(e) => setSensor({ ...sensor, recursive: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="recursive" className="text-sm text-gray-700">
                    Monitor subdirectories recursively
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="move_after_processing"
                    checked={sensor.move_after_processing ?? false}
                    onChange={(e) => setSensor({ ...sensor, move_after_processing: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="move_after_processing" className="text-sm text-gray-700">
                    Move files after processing
                  </label>
                </div>
                {sensor.move_after_processing && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Archive Directory</label>
                    <input
                      type="text"
                      value={sensor.archive_directory || ''}
                      onChange={(e) => setSensor({ ...sensor, archive_directory: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="/data/archive"
                    />
                  </div>
                )}
              </>
            )}

            {/* Database Sensor Fields */}
            {sensor.sensor_type === 'database' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Connection String <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.connection_string || ''}
                    onChange={(e) => setSensor({ ...sensor, connection_string: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="${DATABASE_URL}"
                  />
                  <p className="text-xs text-gray-500 mt-1">SQLAlchemy connection string</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Table Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.table_name || ''}
                    onChange={(e) => setSensor({ ...sensor, table_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="incoming_data"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Timestamp Column <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.timestamp_column || ''}
                    onChange={(e) => setSensor({ ...sensor, timestamp_column: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="created_at"
                  />
                  <p className="text-xs text-gray-500 mt-1">Column for tracking new rows</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Query Condition</label>
                  <input
                    type="text"
                    value={sensor.query_condition || ''}
                    onChange={(e) => setSensor({ ...sensor, query_condition: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="status = 'pending'"
                  />
                  <p className="text-xs text-gray-500 mt-1">Additional SQL WHERE condition</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Batch Size</label>
                  <input
                    type="number"
                    value={sensor.batch_size || 100}
                    onChange={(e) => setSensor({ ...sensor, batch_size: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="100"
                  />
                  <p className="text-xs text-gray-500 mt-1">Maximum rows to process per run</p>
                </div>
              </>
            )}

            {/* Webhook Sensor Fields */}
            {sensor.sensor_type === 'webhook' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Webhook Path <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sensor.webhook_path || ''}
                    onChange={(e) => setSensor({ ...sensor, webhook_path: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="/webhooks/my-webhook"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Auth Token</label>
                  <input
                    type="password"
                    value={sensor.auth_token || ''}
                    onChange={(e) => setSensor({ ...sensor, auth_token: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="${WEBHOOK_TOKEN}"
                  />
                  <p className="text-xs text-gray-500 mt-1">Optional bearer token for authentication</p>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="validate_signature"
                    checked={sensor.validate_signature ?? false}
                    onChange={(e) => setSensor({ ...sensor, validate_signature: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="validate_signature" className="text-sm text-gray-700">
                    Validate webhook signature (GitHub style)
                  </label>
                </div>
                {sensor.validate_signature && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Signature Header</label>
                      <input
                        type="text"
                        value={sensor.signature_header || 'X-Hub-Signature-256'}
                        onChange={(e) => setSensor({ ...sensor, signature_header: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        placeholder="X-Hub-Signature-256"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Secret Key</label>
                      <input
                        type="password"
                        value={sensor.secret_key || ''}
                        onChange={(e) => setSensor({ ...sensor, secret_key: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        placeholder="${WEBHOOK_SECRET}"
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {/* Community Sensor Dynamic Form */}
            {selectedCommunitySensor && (
              <>
                {schemaLoading ? (
                  <div className="bg-gray-50 border border-gray-200 rounded-md p-4 text-center">
                    <p className="text-sm text-gray-600">Loading sensor configuration...</p>
                  </div>
                ) : communitySensorSchema ? (
                  <>
                    <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
                      <p className="text-sm text-blue-800 font-medium">
                        {communitySensorSchema.name}
                      </p>
                      <p className="text-xs text-blue-600 mt-1">
                        {communitySensorSchema.description}
                      </p>
                    </div>

                    {Object.entries(communitySensorSchema.attributes).map(([key, attr]) => (
                    <div key={key}>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {attr.label} {attr.required && <span className="text-red-500">*</span>}
                      </label>

                      {attr.type === 'select' || attr.enum ? (
                        <select
                          value={communitySensorAttributes[key] || ''}
                          onChange={(e) =>
                            setCommunitySensorAttributes({ ...communitySensorAttributes, [key]: e.target.value })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        >
                          <option value="">Select...</option>
                          {attr.enum?.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : attr.type === 'number' ? (
                        <input
                          type="number"
                          value={communitySensorAttributes[key] ?? ''}
                          onChange={(e) =>
                            setCommunitySensorAttributes({
                              ...communitySensorAttributes,
                              [key]: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          min={attr.min}
                          max={attr.max}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder={attr.placeholder}
                        />
                      ) : attr.type === 'boolean' ? (
                        <input
                          type="checkbox"
                          checked={communitySensorAttributes[key] || false}
                          onChange={(e) =>
                            setCommunitySensorAttributes({ ...communitySensorAttributes, [key]: e.target.checked })
                          }
                          className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                        />
                      ) : (
                        <input
                          type={attr.sensitive ? 'password' : 'text'}
                          value={communitySensorAttributes[key] || ''}
                          onChange={(e) =>
                            setCommunitySensorAttributes({ ...communitySensorAttributes, [key]: e.target.value })
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder={attr.placeholder}
                        />
                      )}

                      {attr.description && (
                        <p className="text-xs text-gray-500 mt-1">{attr.description}</p>
                      )}
                    </div>
                    ))}
                  </>
                ) : (
                  <div className="bg-red-50 border border-red-200 rounded-md p-4 text-center">
                    <p className="text-sm text-red-600">Failed to load sensor configuration</p>
                  </div>
                )}
              </>
            )}

            {/* Only show these common fields if NOT a community sensor */}
            {!selectedCommunitySensor && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <input
                    type="text"
                    value={sensor.description}
                    onChange={(e) => setSensor({ ...sensor, description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="Sensor to trigger..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Minimum Interval (seconds)
                  </label>
                  <input
                    type="number"
                    value={sensor.minimum_interval_seconds}
                    onChange={(e) =>
                      setSensor({ ...sensor, minimum_interval_seconds: parseInt(e.target.value) })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="30"
                  />
                </div>
              </>
            )}

            <button
              onClick={handleGenerate}
              disabled={generateSensorMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Asset Check Tab */}
          <Tabs.Content value="asset_check" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Check Type <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedCommunityAssetCheck || assetCheck.check_type}
                onChange={(e) => {
                  const value = e.target.value;
                  const isCommunity = communityAssetChecks.some(c => c.id === value);

                  if (isCommunity) {
                    setSelectedCommunityAssetCheck(value);
                    setAssetCheck({ ...assetCheck, check_type: 'community' as any });
                  } else {
                    setSelectedCommunityAssetCheck(null);
                    setAssetCheck({ ...assetCheck, check_type: value as any });
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="">Select check type...</option>

                <optgroup label="Basic Checks">
                  <option value="row_count">Row Count</option>
                  <option value="freshness">Freshness</option>
                  <option value="schema">Schema</option>
                  <option value="custom">Custom</option>
                </optgroup>

                {communityAssetChecks.length > 0 && (
                  <optgroup label="Community Asset Checks">
                    {communityAssetChecks.map((component) => (
                      <option key={component.id} value={component.id}>
                        {component.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {/* Show Instance Name field for Enhanced Data Quality Checks to avoid overwriting */}
            {selectedCommunityAssetCheck === 'enhanced_data_quality_checks' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Instance Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={communityAssetCheckInstanceName}
                  onChange={(e) => setCommunityAssetCheckInstanceName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="enhanced_data_quality_checks_123456"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Each instance needs a unique name to avoid overwriting previous configurations
                </p>
              </div>
            ) : (
              selectedCommunityAssetCheck === null && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Check Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={assetCheck.check_name}
                    onChange={(e) => setAssetCheck({ ...assetCheck, check_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="my_check"
                  />
                </div>
              )
            )}

            {/* Hide Asset Name field for Enhanced Data Quality Checks (it has its own asset selection) */}
            {selectedCommunityAssetCheck !== 'enhanced_data_quality_checks' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Asset Name <span className="text-red-500">*</span>
                </label>
                <select
                  value={assetCheck.asset_name}
                  onChange={(e) => setAssetCheck({ ...assetCheck, asset_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="">Select an asset...</option>
                  {currentProject?.graph.nodes
                    .filter((node: any) => node.node_kind === 'asset' || node.type === 'asset')
                    .map((node: any) => (
                      <option key={node.id} value={node.data.asset_key || node.id}>
                        {node.data.asset_key || node.data.label || node.id}
                      </option>
                    ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Select an asset to add a quality check to
                </p>
              </div>
            )}

            {assetCheck.check_type === 'row_count' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Minimum Row Count
                </label>
                <input
                  type="number"
                  value={assetCheck.threshold}
                  onChange={(e) =>
                    setAssetCheck({ ...assetCheck, threshold: parseInt(e.target.value) })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="0"
                />
              </div>
            )}

            {assetCheck.check_type === 'freshness' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Max Age (hours)
                </label>
                <input
                  type="number"
                  value={assetCheck.max_age_hours}
                  onChange={(e) =>
                    setAssetCheck({ ...assetCheck, max_age_hours: parseInt(e.target.value) })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="24"
                />
              </div>
            )}

            {/* Community Asset Check Configuration */}
            {selectedCommunityAssetCheck && (
              <>
                {/* Special handling for Enhanced Data Quality Checks */}
                {selectedCommunityAssetCheck === 'enhanced_data_quality_checks' ? (
                  <div className="pt-2 border-t border-gray-200">
                    <EnhancedDataQualityChecksBuilder
                      assets={currentProject?.graph.nodes
                        .filter((node: any) => node.node_kind === 'asset' || node.type === 'asset')
                        .map((node: any) => node.data.asset_key || node.id) || []}
                      onConfigChange={(config) => setCommunityAssetCheckAttributes(config)}
                    />
                  </div>
                ) : (
                  <>
                    {assetCheckSchemaLoading ? (
                      <div className="bg-gray-50 border border-gray-200 rounded-md p-4 text-center">
                        <p className="text-sm text-gray-600">Loading check configuration...</p>
                      </div>
                    ) : communityAssetCheckSchema ? (
                      <div className="space-y-3 pt-2 border-t border-gray-200">
                        <p className="text-sm font-medium text-gray-700">Configuration</p>
                        {Object.entries(communityAssetCheckSchema.attributes).map(([key, attr]: [string, any]) => (
                          <div key={key}>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {attr.label} {attr.required && <span className="text-red-500">*</span>}
                            </label>

                            {attr.type === 'select' || attr.enum ? (
                              <select
                                value={communityAssetCheckAttributes[key] || ''}
                                onChange={(e) =>
                                  setCommunityAssetCheckAttributes({ ...communityAssetCheckAttributes, [key]: e.target.value })
                                }
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                <option value="">Select...</option>
                                {attr.enum?.map((option: string) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : attr.type === 'number' ? (
                              <input
                                type="number"
                                value={communityAssetCheckAttributes[key] ?? ''}
                                onChange={(e) =>
                                  setCommunityAssetCheckAttributes({
                                    ...communityAssetCheckAttributes,
                                    [key]: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                min={attr.min}
                                max={attr.max}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder={attr.placeholder}
                              />
                            ) : attr.type === 'boolean' ? (
                              <input
                                type="checkbox"
                                checked={communityAssetCheckAttributes[key] || false}
                                onChange={(e) =>
                                  setCommunityAssetCheckAttributes({ ...communityAssetCheckAttributes, [key]: e.target.checked })
                                }
                                className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                              />
                            ) : attr.type === 'object' ? (
                              <textarea
                                value={typeof communityAssetCheckAttributes[key] === 'object' ? JSON.stringify(communityAssetCheckAttributes[key], null, 2) : communityAssetCheckAttributes[key] || ''}
                                onChange={(e) => {
                                  try {
                                    const parsed = JSON.parse(e.target.value);
                                    setCommunityAssetCheckAttributes({ ...communityAssetCheckAttributes, [key]: parsed });
                                  } catch {
                                    setCommunityAssetCheckAttributes({ ...communityAssetCheckAttributes, [key]: e.target.value });
                                  }
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                                placeholder={attr.placeholder}
                                rows={4}
                              />
                            ) : (
                              <input
                                type={attr.sensitive ? 'password' : 'text'}
                                value={communityAssetCheckAttributes[key] || ''}
                                onChange={(e) =>
                                  setCommunityAssetCheckAttributes({ ...communityAssetCheckAttributes, [key]: e.target.value })
                                }
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder={attr.placeholder}
                              />
                            )}

                            {attr.description && (
                              <p className="mt-1 text-xs text-gray-500">{attr.description}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-center">
                        <p className="text-sm text-red-600">Failed to load check configuration</p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* Hide Description field for Enhanced Data Quality Checks (not needed) */}
            {selectedCommunityAssetCheck !== 'enhanced_data_quality_checks' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={assetCheck.description}
                  onChange={(e) => setAssetCheck({ ...assetCheck, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="Check that..."
                />
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={generateAssetCheckMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Freshness Policy Tab */}
          <Tabs.Content value="freshness_policy" className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Policy Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={freshnessPolicy.policy_name}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, policy_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="my_freshness_policy"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={freshnessPolicy.description}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={2}
                placeholder="Describe this freshness policy..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Maximum Lag (minutes)
              </label>
              <input
                type="number"
                value={freshnessPolicy.maximum_lag_minutes}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, maximum_lag_minutes: parseInt(e.target.value) || 60 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Maximum acceptable time delay in minutes
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Maximum Lag Environment Variable (optional)
              </label>
              <input
                type="text"
                value={freshnessPolicy.maximum_lag_env_var}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, maximum_lag_env_var: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="MAX_LAG_MINUTES"
              />
              <p className="text-xs text-gray-500 mt-1">
                Environment variable name to override maximum lag
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cron Schedule (optional)
              </label>
              <input
                type="text"
                value={freshnessPolicy.cron_schedule}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, cron_schedule: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                placeholder="0 */6 * * *"
              />
              <p className="text-xs text-gray-500 mt-1">
                Expected update cadence (e.g., "0 */6 * * *" for every 6 hours)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cron Schedule Environment Variable (optional)
              </label>
              <input
                type="text"
                value={freshnessPolicy.cron_env_var}
                onChange={(e) => setFreshnessPolicy({ ...freshnessPolicy, cron_env_var: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="FRESHNESS_CRON"
              />
              <p className="text-xs text-gray-500 mt-1">
                Environment variable name to override cron schedule
              </p>
            </div>

            <button
              onClick={handleGenerate}
              disabled={generateFreshnessPolicyMutation.isPending}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              <FileCode className="w-4 h-4" />
              <span>Generate Code</span>
            </button>
          </Tabs.Content>

          {/* Community Tab */}
          <Tabs.Content value="community" className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <CommunityTemplates />
          </Tabs.Content>

          {/* Pipeline Templates Tab */}
          <Tabs.Content value="pipelines" className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <PipelineTemplates />
          </Tabs.Content>
        </Tabs.Root>
      </div>

      {/* Right Panel - Code Preview */}
      {activeTab !== 'community' && activeTab !== 'pipelines' && (
      <div className="w-1/2 flex flex-col">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Generated Code</h3>
          {generatedCode && (
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending || !currentProject}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              <Save className="w-3 h-3" />
              <span>Save to Project</span>
            </button>
          )}
        </div>

        <div className="flex-1">
          {generatedCode ? (
            <Editor
              height="100%"
              language="python"
              value={generatedCode}
              onChange={(value) => setGeneratedCode(value || '')}
              theme="vs-light"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <FileCode className="w-12 h-12 mx-auto mb-2 text-gray-400" />
                <p className="text-sm">Fill in the form and click Generate Code</p>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
