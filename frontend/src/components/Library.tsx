import { useState } from 'react';
import { Blocks, Package } from 'lucide-react';
import { CommunityTemplates } from './CommunityTemplates';
import { IntegrationCatalog } from './IntegrationCatalog';
import { useProjectStore } from '@/hooks/useProject';

type LibraryTab = 'components' | 'integrations';

export function Library() {
  const { currentProject } = useProjectStore();
  const [tab, setTab] = useState<LibraryTab>('components');

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Sub-nav — flush left to match Automation tab style */}
      <div className="flex-shrink-0 border-b border-gray-200 flex items-center">
        <button
          onClick={() => setTab('components')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            tab === 'components'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <Blocks className="w-4 h-4" />
          <span>Components</span>
          <span className="text-xs text-gray-400">896 community templates</span>
        </button>
        <button
          onClick={() => setTab('integrations')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            tab === 'integrations'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <Package className="w-4 h-4" />
          <span>Integrations</span>
          <span className="text-xs text-gray-400">Dagster ecosystem packages</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'components' && <CommunityTemplates />}
        {tab === 'integrations' && <IntegrationCatalog projectId={currentProject?.id} />}
      </div>
    </div>
  );
}
