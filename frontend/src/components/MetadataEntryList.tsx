import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { SimpleMarkdown } from './SimpleMarkdown';
import type { MetadataEntry } from '@/services/api';

/** Renders one materialization/observation/check's typed metadata --
 *  Dagster's metadata system lets a run attach a float, int, markdown
 *  blob, URL, path, JSON, bool, or timestamp to an event, and the real
 *  Dagster+ UI renders each differently. Collapsed by default (a check
 *  or materialization can carry a dozen entries); expand to see all. */
export function MetadataEntryList({ entries }: { entries: MetadataEntry[] | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!entries || entries.length === 0) return null;
  const shown = expanded ? entries : entries.slice(0, 3);
  return (
    <div className="mt-1.5 border-t border-gray-100 pt-1.5">
      <dl className="space-y-1">
        {shown.map((e, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px]">
            <dt className="text-gray-500 font-mono flex-shrink-0 min-w-[80px] max-w-[160px] truncate" title={e.label}>
              {e.label}
            </dt>
            <dd className="flex-1 min-w-0 text-gray-800">
              <MetadataEntryValue entry={e} />
            </dd>
          </div>
        ))}
      </dl>
      {entries.length > 3 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10px] text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-0.5"
        >
          <ChevronDown className={`w-2.5 h-2.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Show less' : `+${entries.length - 3} more`}
        </button>
      )}
    </div>
  );
}

function MetadataEntryValue({ entry }: { entry: MetadataEntry }) {
  const { type, value, description } = entry;
  if (value == null) {
    return <span className="text-gray-400 italic">{description || '—'}</span>;
  }
  switch (type) {
    case 'markdown':
      return <SimpleMarkdown text={String(value)} />;
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-0.5 break-all">
          {String(value)} <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
        </a>
      );
    case 'path':
      return <span className="font-mono text-gray-700 break-all">{String(value)}</span>;
    case 'json':
      return <pre className="font-mono text-[10px] bg-gray-50 border border-gray-100 rounded p-1.5 overflow-x-auto whitespace-pre-wrap">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
    case 'bool':
      return <span className={value ? 'text-emerald-700' : 'text-gray-500'}>{value ? 'true' : 'false'}</span>;
    case 'timestamp':
      return <span className="font-mono">{new Date(Number(value) * 1000).toLocaleString()}</span>;
    case 'float':
    case 'int':
      return <span className="font-mono tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</span>;
    default:
      return <span className="break-all">{String(value)}</span>;
  }
}
