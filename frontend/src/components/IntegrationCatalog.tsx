import { useState, useMemo } from 'react';
import { Search, ExternalLink, Database, Cloud, Cpu, Bell, Package, Download, Check, X, ChevronRight, Code } from 'lucide-react';

interface Integration {
  name: string;
  package: string;
  category: string;
  description: string;
  docs_url: string;
  component_based: boolean;
  features: string[];
}

interface IntegrationCatalogProps {
  projectId?: string;
}

const INTEGRATIONS: Integration[] = [
  // Data Ingestion & Reverse ETL
  {
    name: 'Airbyte',
    package: 'dagster-airbyte',
    category: 'Data Ingestion',
    description: 'Open-source data integration with Airbyte',
    docs_url: 'https://docs.dagster.io/integrations/airbyte',
    component_based: true,
    features: ['Open source', 'Self-hosted', 'Custom connectors'],
  },
  {
    name: 'Census',
    package: 'dagster-census',
    category: 'Data Ingestion',
    description: 'Reverse ETL platform',
    docs_url: 'https://docs.dagster.io/integrations/census',
    component_based: true,
    features: ['Reverse ETL', 'Data activation', 'Sync'],
  },
  {
    name: 'Fivetran',
    package: 'dagster-fivetran',
    category: 'Data Ingestion',
    description: 'Sync data from 500+ sources with Fivetran',
    docs_url: 'https://docs.dagster.io/integrations/fivetran',
    component_based: true,
    features: ['State-backed', 'Incremental loading', '500+ connectors'],
  },
  {
    name: 'Hightouch',
    package: 'dagster-hightouch',
    category: 'Data Ingestion',
    description: 'Data activation and reverse ETL',
    docs_url: 'https://docs.dagster.io/integrations/hightouch',
    component_based: true,
    features: ['Reverse ETL', 'Sync engine', 'Data activation'],
  },
  {
    name: 'Sling',
    package: 'dagster-sling',
    category: 'Data Ingestion',
    description: 'Database replication and data movement',
    docs_url: 'https://docs.dagster.io/integrations/sling',
    component_based: true,
    features: ['Database-to-database', 'Fast replication', 'YAML config'],
  },
  {
    name: 'dlt',
    package: 'dagster-dlt',
    category: 'Data Ingestion',
    description: 'Modern Python-first data loading',
    docs_url: 'https://docs.dagster.io/integrations/dlt',
    component_based: true,
    features: ['State-backed', 'Python-based', 'Extensible'],
  },
  {
    name: 'Meltano',
    package: 'dagster-meltano',
    category: 'Data Ingestion',
    description: 'Open-source ELT platform',
    docs_url: 'https://docs.dagster.io/integrations/meltano',
    component_based: true,
    features: ['Singer taps', 'ELT', 'Open source'],
  },

  // Transformation
  {
    name: 'dbt',
    package: 'dagster-dbt',
    category: 'Transformation',
    description: 'Transform data with dbt',
    docs_url: 'https://docs.dagster.io/integrations/dbt',
    component_based: true,
    features: ['Asset factory', 'Dependencies', 'Tests'],
  },

  // Data Warehouses & Databases
  {
    name: 'Snowflake',
    package: 'dagster-snowflake',
    category: 'Data Warehouse',
    description: 'Cloud data warehouse',
    docs_url: 'https://docs.dagster.io/integrations/snowflake',
    component_based: true,
    features: ['SQL assets', 'IO manager', 'Pandas integration'],
  },
  {
    name: 'BigQuery',
    package: 'dagster-gcp',
    category: 'Data Warehouse',
    description: 'Google Cloud data warehouse (included in dagster-gcp)',
    docs_url: 'https://docs.dagster.io/integrations/bigquery',
    component_based: false,
    features: ['SQL assets', 'IO manager', 'GCP integration'],
  },
  {
    name: 'Databricks',
    package: 'dagster-databricks',
    category: 'Data Warehouse',
    description: 'Unified analytics platform',
    docs_url: 'https://docs.dagster.io/integrations/databricks',
    component_based: false,
    features: ['Spark', 'Delta Lake', 'MLflow'],
  },
  {
    name: 'DuckDB',
    package: 'dagster-duckdb',
    category: 'Data Warehouse',
    description: 'In-process analytical database',
    docs_url: 'https://docs.dagster.io/integrations/duckdb',
    component_based: false,
    features: ['Fast queries', 'Pandas integration', 'Lightweight'],
  },
  {
    name: 'PostgreSQL',
    package: 'dagster-postgres',
    category: 'Database',
    description: 'PostgreSQL integration',
    docs_url: 'https://docs.dagster.io/integrations/postgres',
    component_based: false,
    features: ['IO manager', 'SQL assets', 'Relational'],
  },
  {
    name: 'MySQL',
    package: 'dagster-mysql',
    category: 'Database',
    description: 'MySQL integration',
    docs_url: 'https://docs.dagster.io/integrations/mysql',
    component_based: false,
    features: ['IO manager', 'SQL assets', 'Relational'],
  },
  {
    name: 'Teradata',
    package: 'dagster-teradata',
    category: 'Database',
    description: 'Teradata database integration',
    docs_url: 'https://docs.dagster.io/integrations/teradata',
    component_based: false,
    features: ['Enterprise database', 'SQL assets', 'Analytics'],
  },

  // Data Formats & Storage
  {
    name: 'Delta Lake',
    package: 'dagster-deltalake',
    category: 'Data Format',
    description: 'Open lakehouse storage framework',
    docs_url: 'https://docs.dagster.io/integrations/delta-lake',
    component_based: false,
    features: ['ACID transactions', 'Time travel', 'Schema evolution'],
  },
  {
    name: 'Iceberg',
    package: 'dagster-iceberg',
    category: 'Data Format',
    description: 'Table format for large analytic datasets',
    docs_url: 'https://docs.dagster.io/integrations/iceberg',
    component_based: false,
    features: ['Table format', 'Schema evolution', 'Partitioning'],
  },

  // Cloud Platforms
  {
    name: 'AWS',
    package: 'dagster-aws',
    category: 'Cloud',
    description: 'Amazon Web Services integration',
    docs_url: 'https://docs.dagster.io/integrations/aws',
    component_based: false,
    features: ['S3', 'ECS', 'Redshift', 'Glue', 'EMR'],
  },
  {
    name: 'GCP',
    package: 'dagster-gcp',
    category: 'Cloud',
    description: 'Google Cloud Platform integration',
    docs_url: 'https://docs.dagster.io/integrations/gcp',
    component_based: false,
    features: ['GCS', 'BigQuery', 'Dataproc', 'Cloud Run'],
  },
  {
    name: 'Azure',
    package: 'dagster-azure',
    category: 'Cloud',
    description: 'Microsoft Azure integration',
    docs_url: 'https://docs.dagster.io/integrations/azure',
    component_based: false,
    features: ['Blob Storage', 'Data Lake', 'ADLS'],
  },

  // Compute & Orchestration
  {
    name: 'Kubernetes',
    package: 'dagster-k8s',
    category: 'Compute',
    description: 'Run Dagster on Kubernetes',
    docs_url: 'https://docs.dagster.io/integrations/kubernetes',
    component_based: false,
    features: ['Pod execution', 'Scaling', 'Distributed'],
  },
  {
    name: 'Docker',
    package: 'dagster-docker',
    category: 'Compute',
    description: 'Run ops in Docker containers',
    docs_url: 'https://docs.dagster.io/integrations/docker',
    component_based: false,
    features: ['Container execution', 'Isolation', 'Reproducible'],
  },
  {
    name: 'Modal',
    package: 'dagster-modal',
    category: 'Compute',
    description: 'Serverless compute for data and ML',
    docs_url: 'https://docs.dagster.io/integrations/modal',
    component_based: false,
    features: ['Serverless', 'GPU support', 'Containers'],
  },
  {
    name: 'Ray',
    package: 'dagster-ray',
    category: 'Compute',
    description: 'Distributed compute framework',
    docs_url: 'https://docs.dagster.io/integrations/ray',
    component_based: false,
    features: ['Distributed', 'ML workloads', 'Parallel'],
  },
  {
    name: 'Celery',
    package: 'dagster-celery',
    category: 'Compute',
    description: 'Distributed task queue',
    docs_url: 'https://docs.dagster.io/integrations/celery',
    component_based: false,
    features: ['Distributed', 'Task queue', 'Worker pools'],
  },
  {
    name: 'Dask',
    package: 'dagster-dask',
    category: 'Compute',
    description: 'Parallel computing with Dask',
    docs_url: 'https://docs.dagster.io/integrations/dask',
    component_based: false,
    features: ['Parallel execution', 'Distributed', 'Pandas-like API'],
  },
  {
    name: 'PySpark',
    package: 'dagster-pyspark',
    category: 'Compute',
    description: 'Apache Spark integration',
    docs_url: 'https://docs.dagster.io/integrations/pyspark',
    component_based: false,
    features: ['Distributed processing', 'Big data', 'DataFrames'],
  },

  // Monitoring & Observability
  {
    name: 'Datadog',
    package: 'dagster-datadog',
    category: 'Monitoring',
    description: 'Monitoring and observability',
    docs_url: 'https://docs.dagster.io/integrations/datadog',
    component_based: false,
    features: ['Metrics', 'Logs', 'APM', 'Alerts'],
  },
  {
    name: 'Prometheus',
    package: 'dagster-prometheus',
    category: 'Monitoring',
    description: 'Open-source monitoring and alerting',
    docs_url: 'https://docs.dagster.io/integrations/prometheus',
    component_based: false,
    features: ['Metrics', 'Time series', 'Alerts'],
  },

  // Communication & Alerting
  {
    name: 'Slack',
    package: 'dagster-slack',
    category: 'Communication',
    description: 'Send notifications to Slack',
    docs_url: 'https://docs.dagster.io/integrations/slack',
    component_based: false,
    features: ['Notifications', 'Alerts', 'Webhooks'],
  },
  {
    name: 'Microsoft Teams',
    package: 'dagster-msteams',
    category: 'Communication',
    description: 'Send notifications to Microsoft Teams',
    docs_url: 'https://docs.dagster.io/integrations/msteams',
    component_based: false,
    features: ['Notifications', 'Alerts', 'Cards'],
  },
  {
    name: 'PagerDuty',
    package: 'dagster-pagerduty',
    category: 'Communication',
    description: 'Incident management with PagerDuty',
    docs_url: 'https://docs.dagster.io/integrations/pagerduty',
    component_based: false,
    features: ['Incident alerts', 'On-call', 'Escalation'],
  },
  {
    name: 'Twilio',
    package: 'dagster-twilio',
    category: 'Communication',
    description: 'SMS and voice notifications',
    docs_url: 'https://docs.dagster.io/integrations/twilio',
    component_based: false,
    features: ['SMS', 'Voice', 'Programmable'],
  },

  // AI & ML
  {
    name: 'OpenAI',
    package: 'dagster-openai',
    category: 'AI',
    description: 'OpenAI API integration',
    docs_url: 'https://docs.dagster.io/integrations/openai',
    component_based: false,
    features: ['GPT', 'Embeddings', 'AI models'],
  },
  {
    name: 'Anthropic',
    package: 'dagster-anthropic',
    category: 'AI',
    description: 'Anthropic Claude API integration',
    docs_url: 'https://docs.dagster.io/integrations/anthropic',
    component_based: false,
    features: ['Claude', 'AI models', 'API'],
  },
  {
    name: 'Gemini',
    package: 'dagster-gemini',
    category: 'AI',
    description: 'Google Gemini AI integration',
    docs_url: 'https://docs.dagster.io/integrations/gemini',
    component_based: false,
    features: ['Gemini', 'Multimodal', 'AI models'],
  },
  {
    name: 'MLflow',
    package: 'dagster-mlflow',
    category: 'ML',
    description: 'ML experiment tracking',
    docs_url: 'https://docs.dagster.io/integrations/mlflow',
    component_based: false,
    features: ['Experiment tracking', 'Model registry', 'Metrics'],
  },
  {
    name: 'Weights & Biases',
    package: 'dagster-wandb',
    category: 'ML',
    description: 'ML experiment tracking and collaboration',
    docs_url: 'https://docs.dagster.io/integrations/wandb',
    component_based: false,
    features: ['Experiment tracking', 'Visualizations', 'Collaboration'],
  },

  // Vector Databases
  {
    name: 'Chroma',
    package: 'dagster-chroma',
    category: 'Vector DB',
    description: 'Open-source embedding database',
    docs_url: 'https://docs.dagster.io/integrations/chroma',
    component_based: false,
    features: ['Embeddings', 'RAG', 'Semantic search'],
  },
  {
    name: 'Qdrant',
    package: 'dagster-qdrant',
    category: 'Vector DB',
    description: 'Vector similarity search engine',
    docs_url: 'https://docs.dagster.io/integrations/qdrant',
    component_based: false,
    features: ['Vector search', 'Embeddings', 'Fast'],
  },
  {
    name: 'Weaviate',
    package: 'dagster-weaviate',
    category: 'Vector DB',
    description: 'Vector database for AI applications',
    docs_url: 'https://docs.dagster.io/integrations/weaviate',
    component_based: false,
    features: ['Vector search', 'GraphQL', 'Hybrid search'],
  },

  // Business Intelligence & Analytics
  {
    name: 'Looker',
    package: 'dagster-looker',
    category: 'BI',
    description: 'Business intelligence and analytics',
    docs_url: 'https://docs.dagster.io/integrations/looker',
    component_based: true,
    features: ['BI', 'Dashboards', 'LookML'],
  },
  {
    name: 'Tableau',
    package: 'dagster-tableau',
    category: 'BI',
    description: 'Data visualization and BI',
    docs_url: 'https://docs.dagster.io/integrations/tableau',
    component_based: true,
    features: ['Visualizations', 'Dashboards', 'Analytics'],
  },
  {
    name: 'Power BI',
    package: 'dagster-powerbi',
    category: 'BI',
    description: 'Microsoft business intelligence',
    docs_url: 'https://docs.dagster.io/integrations/powerbi',
    component_based: true,
    features: ['Visualizations', 'Reports', 'Microsoft'],
  },
  {
    name: 'Hex',
    package: 'dagster-hex',
    category: 'BI',
    description: 'Data workspace and notebooks',
    docs_url: 'https://docs.dagster.io/integrations/hex',
    component_based: true,
    features: ['Notebooks', 'SQL', 'Collaboration'],
  },
  {
    name: 'Evidence',
    package: 'dagster-evidence',
    category: 'BI',
    description: 'Code-based business intelligence',
    docs_url: 'https://docs.dagster.io/integrations/evidence',
    component_based: false,
    features: ['Markdown', 'SQL', 'Reports'],
  },
  {
    name: 'Cube',
    package: 'dagster-cube',
    category: 'BI',
    description: 'Semantic layer for analytics',
    docs_url: 'https://docs.dagster.io/integrations/cube',
    component_based: true,
    features: ['Semantic layer', 'Caching', 'APIs'],
  },
  {
    name: 'Sigma',
    package: 'dagster-sigma',
    category: 'BI',
    description: 'Cloud analytics platform',
    docs_url: 'https://docs.dagster.io/integrations/sigma',
    component_based: true,
    features: ['Spreadsheet UI', 'SQL', 'Cloud'],
  },
  {
    name: 'Omni',
    package: 'dagster-omni',
    category: 'BI',
    description: 'Self-service analytics platform',
    docs_url: 'https://docs.dagster.io/integrations/omni',
    component_based: true,
    features: ['Self-service', 'SQL', 'Dashboards'],
  },

  // Data Quality & Governance
  {
    name: 'Pandera',
    package: 'dagster-pandera',
    category: 'Data Quality',
    description: 'DataFrame validation with Pandera',
    docs_url: 'https://docs.dagster.io/integrations/pandera',
    component_based: false,
    features: ['Schema validation', 'Type checking', 'Pandas'],
  },
  {
    name: 'Open Metadata',
    package: 'dagster-openmetadata',
    category: 'Governance',
    description: 'Open-source metadata and governance',
    docs_url: 'https://docs.dagster.io/integrations/openmetadata',
    component_based: false,
    features: ['Metadata', 'Lineage', 'Governance'],
  },
  {
    name: 'Secoda',
    package: 'dagster-secoda',
    category: 'Governance',
    description: 'Data catalog and documentation',
    docs_url: 'https://docs.dagster.io/integrations/secoda',
    component_based: false,
    features: ['Catalog', 'Documentation', 'Search'],
  },
  {
    name: 'LakeFS',
    package: 'dagster-lakefs',
    category: 'Governance',
    description: 'Data version control for data lakes',
    docs_url: 'https://docs.dagster.io/integrations/lakefs',
    component_based: false,
    features: ['Version control', 'Branching', 'Git for data'],
  },

  // Data Processing & Utilities
  {
    name: 'Pandas',
    package: 'dagster-pandas',
    category: 'Data Processing',
    description: 'DataFrame processing with Pandas',
    docs_url: 'https://docs.dagster.io/integrations/pandas',
    component_based: false,
    features: ['DataFrame assets', 'Type checking', 'Validation'],
  },
  {
    name: 'Polars',
    package: 'dagster-polars',
    category: 'Data Processing',
    description: 'Fast DataFrame processing',
    docs_url: 'https://docs.dagster.io/integrations/polars',
    component_based: false,
    features: ['Fast', 'DataFrame assets', 'Rust-powered'],
  },
  {
    name: 'Shell',
    package: 'dagster-shell',
    category: 'Utilities',
    description: 'Execute shell commands',
    docs_url: 'https://docs.dagster.io/integrations/shell',
    component_based: false,
    features: ['Command execution', 'Scripts', 'System calls'],
  },
  {
    name: 'SSH/SFTP',
    package: 'dagster-ssh',
    category: 'Utilities',
    description: 'SSH and SFTP integration',
    docs_url: 'https://docs.dagster.io/integrations/ssh',
    component_based: false,
    features: ['SSH', 'SFTP', 'Remote execution'],
  },
  {
    name: 'GitHub',
    package: 'dagster-github',
    category: 'Utilities',
    description: 'GitHub API integration',
    docs_url: 'https://docs.dagster.io/integrations/github',
    component_based: false,
    features: ['API', 'Actions', 'Webhooks'],
  },
  {
    name: 'Jupyter',
    package: 'dagstermill',
    category: 'Utilities',
    description: 'Jupyter notebook integration',
    docs_url: 'https://docs.dagster.io/integrations/dagstermill',
    component_based: false,
    features: ['Notebooks', 'Papermill', 'Interactive'],
  },
  {
    name: 'Embedded ELT',
    package: 'dagster-embedded-elt',
    category: 'Utilities',
    description: 'Build custom ELT pipelines',
    docs_url: 'https://docs.dagster.io/integrations/embedded-elt',
    component_based: false,
    features: ['Custom ELT', 'Sling integration', 'dlt integration'],
  },
];

const CATEGORIES = [
  'All',
  'Data Ingestion',
  'Transformation',
  'Data Warehouse',
  'Database',
  'Data Format',
  'Cloud',
  'Compute',
  'Monitoring',
  'Communication',
  'AI',
  'ML',
  'Vector DB',
  'BI',
  'Data Quality',
  'Governance',
  'Data Processing',
  'Utilities',
];

const getCategoryIcon = (category: string) => {
  switch (category) {
    case 'Data Ingestion':
    case 'Data Warehouse':
    case 'Database':
    case 'Data Processing':
      return Database;
    case 'Cloud':
      return Cloud;
    case 'Compute':
      return Cpu;
    case 'Monitoring':
      return Bell;
    default:
      return Package;
  }
};

export function IntegrationCatalog({ projectId }: IntegrationCatalogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);

  const filteredIntegrations = useMemo(() => {
    return INTEGRATIONS.filter((integration) => {
      const matchesSearch =
        integration.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        integration.package.toLowerCase().includes(searchQuery.toLowerCase()) ||
        integration.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory =
        selectedCategory === 'All' || integration.category === selectedCategory;

      return matchesSearch && matchesCategory;
    });
  }, [searchQuery, selectedCategory]);

  const handleInstall = async (packageName: string) => {
    if (!projectId || installing.has(packageName)) return;

    setInstalling(prev => new Set(prev).add(packageName));

    try {
      const response = await fetch(`/api/v1/integrations/${projectId}/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ package: packageName }),
      });

      const data = await response.json();

      if (data.success) {
        setInstalled(prev => new Set(prev).add(packageName));
        alert(`Successfully installed ${packageName}!`);
      } else {
        alert(`Failed to install ${packageName}: ${data.message}`);
      }
    } catch (error) {
      console.error('Error installing integration:', error);
      alert(`Error installing ${packageName}. Please try again.`);
    } finally {
      setInstalling(prev => {
        const next = new Set(prev);
        next.delete(packageName);
        return next;
      });
    }
  };

  const handleCopyInstall = (packageName: string) => {
    navigator.clipboard.writeText(`uv pip install ${packageName}`);
    alert(`Copied: uv pip install ${packageName}`);
  };

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Search and Filter */}
      <div className="p-3 border-b border-gray-200 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search integrations..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Category Filter */}
        <div className="flex items-center space-x-2 overflow-x-auto">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-3 py-1.5 text-sm rounded-full whitespace-nowrap ${
                selectedCategory === category
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="p-4 border-b border-gray-200 bg-gray-50">
        <div className="text-sm text-gray-600">
          Showing <span className="font-semibold">{filteredIntegrations.length}</span> of{' '}
          <span className="font-semibold">{INTEGRATIONS.length}</span> integrations
        </div>
      </div>

      {/* Integration List */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {filteredIntegrations.map((integration) => {
            const Icon = getCategoryIcon(integration.category);

            return (
              <div
                key={`${integration.package}-${integration.name}`}
                className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-lg transition-shadow cursor-pointer flex flex-col"
                onClick={() => setSelectedIntegration(integration)}
              >
                {/* Header with icon and title */}
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-start space-x-3 flex-1">
                    <div className="p-2 bg-blue-50 rounded-lg flex-shrink-0">
                      <Icon className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-lg truncate">
                        {integration.name}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                        {integration.package}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0 ml-2">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded whitespace-nowrap">
                      {integration.category}
                    </span>
                    {integration.component_based && (
                      <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded whitespace-nowrap">
                        Component
                      </span>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                  {integration.description}
                </p>

                {/* Features */}
                <div className="flex flex-wrap gap-1 mb-3">
                  {integration.features.slice(0, 3).map((feature) => (
                    <span
                      key={feature}
                      className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded"
                    >
                      {feature}
                    </span>
                  ))}
                </div>

                {/* Actions - pushed to bottom */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedIntegration(integration);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mt-auto"
                >
                  <ChevronRight className="w-4 h-4" />
                  View Details
                </button>
              </div>
            );
          })}
        </div>

        {filteredIntegrations.length === 0 && (
          <div className="flex items-center justify-center h-64 text-gray-500">
            <div className="text-center">
              <Package className="w-12 h-12 mx-auto mb-2 text-gray-400" />
              <p className="text-sm">No integrations found</p>
              <p className="text-xs mt-1">Try a different search or category</p>
            </div>
          </div>
        )}
      </div>

      {/* Integration Detail Modal */}
      {selectedIntegration && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-lg max-w-4xl w-full my-8 flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-6 border-b">
              <div className="flex items-start justify-between">
                <div className="flex items-start space-x-4">
                  <div className="p-3 bg-blue-50 rounded-lg">
                    {(() => {
                      const Icon = getCategoryIcon(selectedIntegration.category);
                      return <Icon className="w-8 h-8 text-blue-600" />;
                    })()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <h2 className="text-2xl font-bold">{selectedIntegration.name}</h2>
                      <span className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        {selectedIntegration.category}
                      </span>
                      {selectedIntegration.component_based && (
                        <span className="text-sm bg-green-100 text-green-800 px-2 py-1 rounded">
                          Component
                        </span>
                      )}
                    </div>
                    <p className="text-gray-600">{selectedIntegration.description}</p>
                    <div className="flex items-center gap-2 mt-2 text-sm text-gray-500">
                      <code className="bg-gray-100 px-2 py-1 rounded">{selectedIntegration.package}</code>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedIntegration(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-6">
                {/* Features */}
                <div>
                  <h3 className="text-lg font-semibold mb-3">Features</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {selectedIntegration.features.map((feature) => (
                      <div key={feature} className="flex items-center gap-2">
                        <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                        <span className="text-sm text-gray-700">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Installation */}
                <div>
                  <h3 className="text-lg font-semibold mb-3">Installation</h3>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">Using pip:</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`pip install ${selectedIntegration.package}`);
                          alert('Copied to clipboard!');
                        }}
                        className="text-xs text-blue-600 hover:text-blue-700"
                      >
                        Copy
                      </button>
                    </div>
                    <code className="text-sm text-gray-800">pip install {selectedIntegration.package}</code>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 mt-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">Using uv:</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`uv pip install ${selectedIntegration.package}`);
                          alert('Copied to clipboard!');
                        }}
                        className="text-xs text-blue-600 hover:text-blue-700"
                      >
                        Copy
                      </button>
                    </div>
                    <code className="text-sm text-gray-800">uv pip install {selectedIntegration.package}</code>
                  </div>
                </div>

                {/* Links */}
                <div>
                  <h3 className="text-lg font-semibold mb-3">Resources</h3>
                  <div className="flex flex-col gap-2">
                    <a
                      href={selectedIntegration.docs_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Integration Guide
                    </a>
                    <a
                      href={`https://docs.dagster.io/api/libraries/${selectedIntegration.package}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
                    >
                      <Code className="w-4 h-4" />
                      API Reference
                    </a>
                    <a
                      href={`https://github.com/dagster-io/dagster/tree/master/python_modules/libraries/${selectedIntegration.package}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
                    >
                      <Code className="w-4 h-4" />
                      View Source Code
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-6 border-t flex justify-end gap-3 bg-gray-50">
              <button
                onClick={() => setSelectedIntegration(null)}
                className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
              {projectId ? (
                <button
                  onClick={() => {
                    handleInstall(selectedIntegration.package);
                  }}
                  disabled={installing.has(selectedIntegration.package) || installed.has(selectedIntegration.package)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                    installed.has(selectedIntegration.package)
                      ? 'bg-green-100 text-green-700 cursor-not-allowed'
                      : installing.has(selectedIntegration.package)
                      ? 'bg-gray-300 text-gray-600 cursor-wait'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {installing.has(selectedIntegration.package) ? (
                    <>
                      <Download className="w-4 h-4 animate-pulse" />
                      Installing...
                    </>
                  ) : installed.has(selectedIntegration.package) ? (
                    <>
                      <Check className="w-4 h-4" />
                      Installed
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Install to Project
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={() => handleCopyInstall(selectedIntegration.package)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Copy Install Command
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
