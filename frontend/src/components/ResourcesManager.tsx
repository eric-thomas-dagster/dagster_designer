import { useState, useEffect } from 'react';
import { Settings, Database, HardDrive, Code, Key, CheckCircle, XCircle, Download } from 'lucide-react';
import { templatesApi, IOManagerParams, ResourceParams, integrationsApi, IntegrationStatusResponse } from '../services/api';
import { useProjectStore } from '../hooks/useProject';
import { Editor } from '@monaco-editor/react';
import { EnvVarsManager } from './EnvVarsManager';

type ResourceType = 'io_manager' | 'resource' | 'env_vars';

// Mapping of IO manager types to required packages
const IO_MANAGER_PACKAGES: Record<string, string[]> = {
  'snowflake': ['dagster-snowflake'],
  'snowflake_pandas': ['dagster-snowflake', 'dagster-snowflake-pandas'],
  'snowflake_polars': ['dagster-snowflake', 'dagster-snowflake-polars'],
  'snowflake_pyspark': ['dagster-snowflake-pyspark'],
  'deltalake': ['dagster-deltalake'],
  'deltalake_pandas': ['dagster-deltalake', 'dagster-deltalake-pandas'],
  'deltalake_polars': ['dagster-deltalake-polars'],
  'iceberg': ['dagster-iceberg'],
  'duckdb': ['dagster-duckdb'],
  'duckdb_pandas': ['dagster-duckdb', 'dagster-duckdb-pandas'],
  'duckdb_polars': ['dagster-duckdb', 'dagster-duckdb-polars'],
  'duckdb_pyspark': ['dagster-duckdb-pyspark'],
  'polars': ['dagster-polars'],
};

// Mapping of resource types to required packages
const RESOURCE_PACKAGES: Record<string, string[]> = {
  'airbyte': ['dagster-airbyte'],
  'fivetran': ['dagster-fivetran'],
  'census': ['dagster-census'],
  'hightouch': ['dagster-hightouch'],
  'databricks': ['dagster-databricks'],
  'snowflake_resource': ['dagster-snowflake'],
  'aws_s3': ['dagster-aws'],
  'aws_athena': ['dagster-aws'],
  'gcp_bigquery': ['dagster-gcp'],
  'gcp_gcs': ['dagster-gcp'],
  'azure_blob': ['dagster-azure'],
  'dbt': ['dagster-dbt'],
  'sling': ['dagster-embedded-elt'],
};

export function ResourcesManager() {
  const { currentProject } = useProjectStore();
  const [activeTab, setActiveTab] = useState<ResourceType>('io_manager');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [packageStatus, setPackageStatus] = useState<Record<string, IntegrationStatusResponse>>({});
  const [checkingPackages, setCheckingPackages] = useState(false);
  const [installingPackage, setInstallingPackage] = useState<string | null>(null);

  // IO Manager state
  const [ioManager, setIOManager] = useState<IOManagerParams>({
    io_manager_name: '',
    io_manager_type: 'filesystem',
    description: '',
    base_path: 'data',
    database_path: 'data/dagster.duckdb',
    account: '',
    user: '',
    password: '',
    database: '',
    schema: 'public',
    warehouse: '',
    table_path: '',
    config_params: {},
  });

  // Resource state
  const [resource, setResource] = useState<ResourceParams>({
    resource_name: '',
    resource_type: 'database',
    description: '',
    connection_string: '',
    api_key: '',
    api_url: '',
    account_id: '',
    region: '',
    project_id: '',
    workspace_id: '',
    host: '',
    token: '',
    config_params: {},
  });

  const handleGenerate = async () => {
    try {
      let response;
      if (activeTab === 'io_manager') {
        response = await templatesApi.generateIOManager(ioManager);
      } else {
        response = await templatesApi.generateResource(resource);
      }
      setCode(response.code);
    } catch (error) {
      console.error('Failed to generate code:', error);
      alert('Failed to generate code. Check console for details.');
    }
  };

  const handleSave = async () => {
    if (!currentProject || !code) {
      return;
    }

    setSaving(true);
    setSaveMessage('');

    try {
      const name = activeTab === 'io_manager' ? ioManager.io_manager_name : resource.resource_name;
      const result = await templatesApi.save({
        project_id: currentProject.id,
        primitive_type: activeTab,
        name,
        code,
      });

      setSaveMessage(result.message);
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save:', error);
      alert('Failed to save. Check console for details.');
    } finally {
      setSaving(false);
    }
  };

  const handleLoadExample = async (exampleParams: any) => {
    if (activeTab === 'io_manager') {
      setIOManager(exampleParams);
    } else {
      setResource(exampleParams);
    }

    // Auto-generate code for the example
    try {
      let response;
      if (activeTab === 'io_manager') {
        response = await templatesApi.generateIOManager(exampleParams);
      } else {
        response = await templatesApi.generateResource(exampleParams);
      }
      setCode(response.code);
    } catch (error) {
      console.error('Failed to load example:', error);
    }
  };

  // Check package status for the current selection
  const checkPackageStatus = async () => {
    if (!currentProject) return;

    const type = activeTab === 'io_manager' ? ioManager.io_manager_type : resource.resource_type;
    const packages = activeTab === 'io_manager'
      ? IO_MANAGER_PACKAGES[type] || []
      : RESOURCE_PACKAGES[type] || [];

    if (packages.length === 0) return;

    setCheckingPackages(true);
    const statuses: Record<string, IntegrationStatusResponse> = {};

    try {
      for (const pkg of packages) {
        const status = await integrationsApi.getStatus(currentProject.id, pkg);
        statuses[pkg] = status;
      }
      setPackageStatus(statuses);
    } catch (error) {
      console.error('Failed to check package status:', error);
    } finally {
      setCheckingPackages(false);
    }
  };

  // Install a package
  const handleInstallPackage = async (packageName: string) => {
    if (!currentProject) return;

    setInstallingPackage(packageName);
    try {
      const result = await integrationsApi.install(currentProject.id, packageName);

      if (result.success) {
        alert(`Successfully installed ${packageName}!`);
        // Refresh package status
        await checkPackageStatus();
      } else {
        alert(`Failed to install ${packageName}:\n${result.message}\n\nCheck console for details.`);
        console.error('Installation failed:', result.stderr);
      }
    } catch (error) {
      console.error('Failed to install package:', error);
      alert('Failed to install package. Check console for details.');
    } finally {
      setInstallingPackage(null);
    }
  };

  // Check package status when type changes
  useEffect(() => {
    if (currentProject && activeTab !== 'env_vars') {
      checkPackageStatus();
    }
  }, [activeTab === 'io_manager' ? ioManager.io_manager_type : resource.resource_type, currentProject, activeTab]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-900 flex items-center space-x-2">
          <Settings className="w-6 h-6" />
          <span>Resources & Configuration</span>
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          Manage resources, IO managers, and environment variables for your project
        </p>
      </div>

      {/* Tab Selector - Always Visible */}
      <div className="bg-white border-b border-gray-200">
        <div className="flex space-x-2 px-6">
          <button
            onClick={() => setActiveTab('io_manager')}
            className={`flex items-center space-x-2 px-4 py-3 border-b-2 transition-colors ${
              activeTab === 'io_manager'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            <span className="font-medium">IO Managers</span>
          </button>
          <button
            onClick={() => setActiveTab('resource')}
            className={`flex items-center space-x-2 px-4 py-3 border-b-2 transition-colors ${
              activeTab === 'resource'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <Database className="w-4 h-4" />
            <span className="font-medium">Resources</span>
          </button>
          <button
            onClick={() => setActiveTab('env_vars')}
            className={`flex items-center space-x-2 px-4 py-3 border-b-2 transition-colors ${
              activeTab === 'env_vars'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <Key className="w-4 h-4" />
            <span className="font-medium">Environment Variables</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      {activeTab === 'env_vars' ? (
        currentProject && <EnvVarsManager projectId={currentProject.id} />
      ) : (
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Configuration */}
        <div className="w-1/2 border-r border-gray-200 bg-white overflow-y-auto">
          <div className="p-6">

            {/* IO Manager Form */}
            {activeTab === 'io_manager' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    IO Manager Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={ioManager.io_manager_name}
                    onChange={(e) => setIOManager({ ...ioManager, io_manager_name: e.target.value })}
                    placeholder="my_io_manager"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    IO Manager Type
                  </label>
                  <select
                    value={ioManager.io_manager_type}
                    onChange={(e) => setIOManager({ ...ioManager, io_manager_type: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="filesystem">Filesystem</option>
                    <optgroup label="DuckDB">
                      <option value="duckdb">DuckDB (Base)</option>
                      <option value="duckdb_pandas">DuckDB + Pandas</option>
                      <option value="duckdb_polars">DuckDB + Polars</option>
                      <option value="duckdb_pyspark">DuckDB + PySpark</option>
                    </optgroup>
                    <optgroup label="Snowflake">
                      <option value="snowflake">Snowflake (Base)</option>
                      <option value="snowflake_pandas">Snowflake + Pandas</option>
                      <option value="snowflake_polars">Snowflake + Polars</option>
                      <option value="snowflake_pyspark">Snowflake + PySpark</option>
                    </optgroup>
                    <optgroup label="Delta Lake">
                      <option value="deltalake">Delta Lake (Base)</option>
                      <option value="deltalake_pandas">Delta Lake + Pandas</option>
                      <option value="deltalake_polars">Delta Lake + Polars</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="polars">Polars Parquet</option>
                      <option value="iceberg">Iceberg</option>
                      <option value="custom">Custom</option>
                    </optgroup>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={ioManager.description}
                    onChange={(e) => setIOManager({ ...ioManager, description: e.target.value })}
                    placeholder="Describe this IO manager..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={2}
                  />
                </div>

                {/* Package Status */}
                {IO_MANAGER_PACKAGES[ioManager.io_manager_type] && IO_MANAGER_PACKAGES[ioManager.io_manager_type].length > 0 && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">Required Packages</h4>
                    {checkingPackages ? (
                      <p className="text-sm text-blue-800">Checking package status...</p>
                    ) : (
                      <div className="space-y-2">
                        {IO_MANAGER_PACKAGES[ioManager.io_manager_type].map((pkg) => {
                          const status = packageStatus[pkg];
                          if (!status) return null;

                          return (
                            <div
                              key={pkg}
                              className={`p-2 rounded-md border ${
                                status.installed
                                  ? 'bg-green-50 border-green-200'
                                  : 'bg-yellow-50 border-yellow-200'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-2">
                                  {status.installed ? (
                                    <CheckCircle className="w-4 h-4 text-green-600" />
                                  ) : (
                                    <XCircle className="w-4 h-4 text-yellow-600" />
                                  )}
                                  <div>
                                    <p className="text-sm font-medium text-gray-900">{pkg}</p>
                                    <p className="text-xs text-gray-600">
                                      {status.installed
                                        ? `Installed (v${status.version || 'unknown'})`
                                        : 'Not installed'}
                                    </p>
                                  </div>
                                </div>

                                {!status.installed && (
                                  <button
                                    onClick={() => handleInstallPackage(pkg)}
                                    disabled={installingPackage === pkg}
                                    className="flex items-center space-x-1 px-2 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    <Download className="w-3 h-3" />
                                    <span>{installingPackage === pkg ? 'Installing...' : 'Install'}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Filesystem Config */}
                {ioManager.io_manager_type === 'filesystem' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Base Path
                    </label>
                    <input
                      type="text"
                      value={ioManager.base_path}
                      onChange={(e) => setIOManager({ ...ioManager, base_path: e.target.value })}
                      placeholder="data"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                )}

                {/* Polars Config */}
                {ioManager.io_manager_type === 'polars' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Base Directory
                    </label>
                    <input
                      type="text"
                      value={ioManager.base_path}
                      onChange={(e) => setIOManager({ ...ioManager, base_path: e.target.value })}
                      placeholder="data"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                )}

                {/* DuckDB Config */}
                {(ioManager.io_manager_type === 'duckdb' ||
                  ioManager.io_manager_type === 'duckdb_pandas' ||
                  ioManager.io_manager_type === 'duckdb_polars' ||
                  ioManager.io_manager_type === 'duckdb_pyspark') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Database Path
                      </label>
                      <input
                        type="text"
                        value={ioManager.database_path}
                        onChange={(e) => setIOManager({ ...ioManager, database_path: e.target.value })}
                        placeholder="data/dagster.duckdb"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Schema
                      </label>
                      <input
                        type="text"
                        value={ioManager.schema}
                        onChange={(e) => setIOManager({ ...ioManager, schema: e.target.value })}
                        placeholder="public"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  </>
                )}

                {/* Snowflake Config */}
                {(ioManager.io_manager_type === 'snowflake' ||
                  ioManager.io_manager_type === 'snowflake_pandas' ||
                  ioManager.io_manager_type === 'snowflake_polars' ||
                  ioManager.io_manager_type === 'snowflake_pyspark') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={ioManager.account}
                        onChange={(e) => setIOManager({ ...ioManager, account: e.target.value })}
                        placeholder="myaccount.us-east-1"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Credentials will be stored in environment variables
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Database
                      </label>
                      <input
                        type="text"
                        value={ioManager.database}
                        onChange={(e) => setIOManager({ ...ioManager, database: e.target.value })}
                        placeholder="my_database"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Schema
                      </label>
                      <input
                        type="text"
                        value={ioManager.schema}
                        onChange={(e) => setIOManager({ ...ioManager, schema: e.target.value })}
                        placeholder="public"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Warehouse
                      </label>
                      <input
                        type="text"
                        value={ioManager.warehouse}
                        onChange={(e) => setIOManager({ ...ioManager, warehouse: e.target.value })}
                        placeholder="compute_wh"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  </>
                )}

                {/* Delta Lake Config */}
                {(ioManager.io_manager_type === 'deltalake' ||
                  ioManager.io_manager_type === 'deltalake_pandas' ||
                  ioManager.io_manager_type === 'deltalake_polars') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Root URI / Table Path
                    </label>
                    <input
                      type="text"
                      value={ioManager.table_path}
                      onChange={(e) => setIOManager({ ...ioManager, table_path: e.target.value })}
                      placeholder="data/deltalake or s3://bucket/deltalake"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Local path or cloud storage URI
                    </p>
                  </div>
                )}

                {/* Iceberg Config */}
                {ioManager.io_manager_type === 'iceberg' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Catalog URI
                    </label>
                    <input
                      type="text"
                      value={ioManager.table_path}
                      onChange={(e) => setIOManager({ ...ioManager, table_path: e.target.value })}
                      placeholder="sqlite:///catalog.db"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Catalog URI (SQLite, PostgreSQL, etc.)
                    </p>
                  </div>
                )}

                {/* Examples */}
                <div className="mt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Examples
                  </label>
                  <div className="space-y-2">
                    <button
                      onClick={() => handleLoadExample({
                        io_manager_name: 'duckdb_pandas_io',
                        io_manager_type: 'duckdb_pandas',
                        description: 'DuckDB IO manager for Pandas DataFrames',
                        database_path: 'data/dagster.duckdb',
                        schema: 'public',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">DuckDB + Pandas</div>
                      <div className="text-xs text-gray-600">Store Pandas DataFrames in DuckDB</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        io_manager_name: 'snowflake_io',
                        io_manager_type: 'snowflake_pandas',
                        description: 'Snowflake IO manager for Pandas DataFrames',
                        account: 'myaccount.us-east-1',
                        database: 'analytics',
                        schema: 'public',
                        warehouse: 'compute_wh',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">Snowflake + Pandas</div>
                      <div className="text-xs text-gray-600">Store DataFrames in Snowflake</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        io_manager_name: 'deltalake_io',
                        io_manager_type: 'deltalake_pandas',
                        description: 'Delta Lake IO manager for Pandas DataFrames',
                        table_path: 'data/deltalake',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">Delta Lake + Pandas</div>
                      <div className="text-xs text-gray-600">Store DataFrames in Delta Lake</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        io_manager_name: 'polars_io',
                        io_manager_type: 'polars',
                        description: 'Polars IO manager for Polars DataFrames',
                        base_path: 'data/polars',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">Polars Parquet</div>
                      <div className="text-xs text-gray-600">Store Polars DataFrames as Parquet</div>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Resource Form */}
            {activeTab === 'resource' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Resource Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={resource.resource_name}
                    onChange={(e) => setResource({ ...resource, resource_name: e.target.value })}
                    placeholder="my_resource"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Resource Type
                  </label>
                  <select
                    value={resource.resource_type}
                    onChange={(e) => setResource({ ...resource, resource_type: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <optgroup label="General">
                      <option value="database">Database</option>
                      <option value="api_client">API Client</option>
                    </optgroup>
                    <optgroup label="Data Integration">
                      <option value="airbyte">Airbyte</option>
                      <option value="fivetran">Fivetran</option>
                      <option value="census">Census</option>
                      <option value="hightouch">Hightouch</option>
                      <option value="sling">Sling</option>
                    </optgroup>
                    <optgroup label="Data Platforms">
                      <option value="databricks">Databricks</option>
                      <option value="snowflake_resource">Snowflake</option>
                      <option value="dbt">dbt</option>
                    </optgroup>
                    <optgroup label="AWS">
                      <option value="aws_s3">AWS S3</option>
                      <option value="aws_athena">AWS Athena</option>
                    </optgroup>
                    <optgroup label="GCP">
                      <option value="gcp_bigquery">GCP BigQuery</option>
                      <option value="gcp_gcs">GCP Cloud Storage</option>
                    </optgroup>
                    <optgroup label="Azure">
                      <option value="azure_blob">Azure Blob Storage</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="custom">Custom</option>
                    </optgroup>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={resource.description}
                    onChange={(e) => setResource({ ...resource, description: e.target.value })}
                    placeholder="Describe this resource..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={2}
                  />
                </div>

                {/* Package Status */}
                {RESOURCE_PACKAGES[resource.resource_type] && RESOURCE_PACKAGES[resource.resource_type].length > 0 && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">Required Packages</h4>
                    {checkingPackages ? (
                      <p className="text-sm text-blue-800">Checking package status...</p>
                    ) : (
                      <div className="space-y-2">
                        {RESOURCE_PACKAGES[resource.resource_type].map((pkg) => {
                          const status = packageStatus[pkg];
                          if (!status) return null;

                          return (
                            <div
                              key={pkg}
                              className={`p-2 rounded-md border ${
                                status.installed
                                  ? 'bg-green-50 border-green-200'
                                  : 'bg-yellow-50 border-yellow-200'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-2">
                                  {status.installed ? (
                                    <CheckCircle className="w-4 h-4 text-green-600" />
                                  ) : (
                                    <XCircle className="w-4 h-4 text-yellow-600" />
                                  )}
                                  <div>
                                    <p className="text-sm font-medium text-gray-900">{pkg}</p>
                                    <p className="text-xs text-gray-600">
                                      {status.installed
                                        ? `Installed (v${status.version || 'unknown'})`
                                        : 'Not installed'}
                                    </p>
                                  </div>
                                </div>

                                {!status.installed && (
                                  <button
                                    onClick={() => handleInstallPackage(pkg)}
                                    disabled={installingPackage === pkg}
                                    className="flex items-center space-x-1 px-2 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    <Download className="w-3 h-3" />
                                    <span>{installingPackage === pkg ? 'Installing...' : 'Install'}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Database Config */}
                {resource.resource_type === 'database' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Connection String
                    </label>
                    <input
                      type="text"
                      value={resource.connection_string}
                      onChange={(e) => setResource({ ...resource, connection_string: e.target.value })}
                      placeholder="data/database.duckdb"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                )}

                {/* API Client Config */}
                {resource.resource_type === 'api_client' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        API URL
                      </label>
                      <input
                        type="text"
                        value={resource.api_url}
                        onChange={(e) => setResource({ ...resource, api_url: e.target.value })}
                        placeholder="https://api.example.com"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={resource.api_key}
                        onChange={(e) => setResource({ ...resource, api_key: e.target.value })}
                        placeholder="Enter API key..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  </>
                )}

                {/* Airbyte Config */}
                {resource.resource_type === 'airbyte' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Host
                      </label>
                      <input
                        type="text"
                        value={resource.host}
                        onChange={(e) => setResource({ ...resource, host: e.target.value })}
                        placeholder="localhost"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Port
                      </label>
                      <input
                        type="text"
                        value={resource.api_url}
                        onChange={(e) => setResource({ ...resource, api_url: e.target.value })}
                        placeholder="8000"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      Credentials stored in environment variables (AIRBYTE_USERNAME, AIRBYTE_PASSWORD)
                    </p>
                  </>
                )}

                {/* Fivetran, Census, Hightouch - API Key based */}
                {(resource.resource_type === 'fivetran' || resource.resource_type === 'census' || resource.resource_type === 'hightouch') && (
                  <p className="text-xs text-gray-500">
                    API credentials will be stored in environment variables
                  </p>
                )}

                {/* Databricks Config */}
                {resource.resource_type === 'databricks' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Host <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={resource.host}
                        onChange={(e) => setResource({ ...resource, host: e.target.value })}
                        placeholder="https://your-workspace.cloud.databricks.com"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      Token will be stored in DATABRICKS_TOKEN environment variable
                    </p>
                  </>
                )}

                {/* Snowflake Resource Config */}
                {resource.resource_type === 'snowflake_resource' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={resource.account_id}
                        onChange={(e) => setResource({ ...resource, account_id: e.target.value })}
                        placeholder="myaccount.us-east-1"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Database
                      </label>
                      <input
                        type="text"
                        value={resource.connection_string}
                        onChange={(e) => setResource({ ...resource, connection_string: e.target.value })}
                        placeholder="analytics"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Warehouse
                      </label>
                      <input
                        type="text"
                        value={resource.workspace_id}
                        onChange={(e) => setResource({ ...resource, workspace_id: e.target.value })}
                        placeholder="compute_wh"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      Credentials stored in environment variables (SNOWFLAKE_USER, SNOWFLAKE_PASSWORD)
                    </p>
                  </>
                )}

                {/* AWS S3 Config */}
                {resource.resource_type === 'aws_s3' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Region
                      </label>
                      <input
                        type="text"
                        value={resource.region}
                        onChange={(e) => setResource({ ...resource, region: e.target.value })}
                        placeholder="us-east-1"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      AWS credentials stored in environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
                    </p>
                  </>
                )}

                {/* AWS Athena Config */}
                {resource.resource_type === 'aws_athena' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Region
                      </label>
                      <input
                        type="text"
                        value={resource.region}
                        onChange={(e) => setResource({ ...resource, region: e.target.value })}
                        placeholder="us-east-1"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Database
                      </label>
                      <input
                        type="text"
                        value={resource.connection_string}
                        onChange={(e) => setResource({ ...resource, connection_string: e.target.value })}
                        placeholder="default"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Workgroup
                      </label>
                      <input
                        type="text"
                        value={resource.workspace_id}
                        onChange={(e) => setResource({ ...resource, workspace_id: e.target.value })}
                        placeholder="primary"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      AWS credentials stored in environment variables
                    </p>
                  </>
                )}

                {/* GCP BigQuery Config */}
                {resource.resource_type === 'gcp_bigquery' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Project ID <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={resource.project_id}
                        onChange={(e) => setResource({ ...resource, project_id: e.target.value })}
                        placeholder="my-gcp-project"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Location
                      </label>
                      <input
                        type="text"
                        value={resource.region}
                        onChange={(e) => setResource({ ...resource, region: e.target.value })}
                        placeholder="US"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  </>
                )}

                {/* GCP Cloud Storage Config */}
                {resource.resource_type === 'gcp_gcs' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Project ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={resource.project_id}
                      onChange={(e) => setResource({ ...resource, project_id: e.target.value })}
                      placeholder="my-gcp-project"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                )}

                {/* Azure Blob Config */}
                {resource.resource_type === 'azure_blob' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Storage Account <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={resource.account_id}
                        onChange={(e) => setResource({ ...resource, account_id: e.target.value })}
                        placeholder="mystorageaccount"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      Storage key stored in AZURE_STORAGE_KEY environment variable
                    </p>
                  </>
                )}

                {/* dbt Config */}
                {resource.resource_type === 'dbt' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Project Directory
                      </label>
                      <input
                        type="text"
                        value={resource.connection_string}
                        onChange={(e) => setResource({ ...resource, connection_string: e.target.value })}
                        placeholder="dbt_project"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Profiles Directory
                      </label>
                      <input
                        type="text"
                        value={resource.api_url}
                        onChange={(e) => setResource({ ...resource, api_url: e.target.value })}
                        placeholder="~/.dbt"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  </>
                )}

                {/* Examples */}
                <div className="mt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Examples
                  </label>
                  <div className="space-y-2">
                    <button
                      onClick={() => handleLoadExample({
                        resource_name: 'airbyte_resource',
                        resource_type: 'airbyte',
                        description: 'Airbyte data integration',
                        host: 'localhost',
                        api_url: '8000',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">Airbyte</div>
                      <div className="text-xs text-gray-600">Data integration platform</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        resource_name: 'snowflake_resource',
                        resource_type: 'snowflake_resource',
                        description: 'Snowflake data warehouse',
                        account_id: 'myaccount.us-east-1',
                        connection_string: 'analytics',
                        workspace_id: 'compute_wh',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">Snowflake</div>
                      <div className="text-xs text-gray-600">Cloud data warehouse</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        resource_name: 'bigquery_resource',
                        resource_type: 'gcp_bigquery',
                        description: 'Google BigQuery',
                        project_id: 'my-gcp-project',
                        region: 'US',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">BigQuery</div>
                      <div className="text-xs text-gray-600">GCP data warehouse</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        resource_name: 's3_resource',
                        resource_type: 'aws_s3',
                        description: 'AWS S3 storage',
                        region: 'us-east-1',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">AWS S3</div>
                      <div className="text-xs text-gray-600">Object storage</div>
                    </button>
                    <button
                      onClick={() => handleLoadExample({
                        resource_name: 'dbt_resource',
                        resource_type: 'dbt',
                        description: 'dbt transformation tool',
                        connection_string: 'dbt_project',
                        api_url: '~/.dbt',
                      })}
                      className="w-full text-left px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      <div className="font-medium text-sm">dbt</div>
                      <div className="text-xs text-gray-600">Data transformation</div>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Generate Button */}
            <div className="mt-6">
              <button
                onClick={handleGenerate}
                disabled={
                  (activeTab === 'io_manager' && !ioManager.io_manager_name) ||
                  (activeTab === 'resource' && !resource.resource_name)
                }
                className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Code className="w-4 h-4" />
                <span>Generate Code</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Panel - Code Editor */}
        <div className="w-1/2 flex flex-col bg-white">
          <div className="border-b border-gray-200 px-6 py-3 flex items-center justify-between bg-gray-50">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Generated Code
            </h3>
            <div className="flex items-center space-x-2">
              {saveMessage && (
                <span className="text-sm text-green-600">{saveMessage}</span>
              )}
              <button
                onClick={handleSave}
                disabled={!code || !currentProject || saving}
                className="px-4 py-1.5 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save to Project'}
              </button>
            </div>
          </div>
          <div className="flex-1">
            <Editor
              height="100%"
              defaultLanguage="python"
              value={code}
              onChange={(value) => setCode(value || '')}
              theme="vs-light"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
