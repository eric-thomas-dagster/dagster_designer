import { FileText, Database, Cloud, Globe, Sparkles, Boxes } from 'lucide-react';

// Shared between IngestionsPanel (the list) and IngestionDetailPage (the
// full-page detail view opened from a row). Lives in its own module so
// neither of those two files has to import the other directly -- they used
// to, which made IngestionsPanel -> IngestionDetailPage -> IngestionsPanel
// a real circular import (tsc's type-checking doesn't catch this as an
// error, but it risks a runtime "Cannot access before initialization"
// depending on module evaluation order).

export type SourceKind = 'files' | 'databases' | 'saas' | 'apis' | 'synthetic' | 'other';

// Same bin heuristics as AddDataDialog — keeping them local avoids a
// cyclic dep and lets the two views drift independently if we ever want
// different labels here.
export const KIND_META: Record<SourceKind, { label: string; icon: any; color: string }> = {
  files:      { label: 'Files & object storage', icon: FileText, color: 'bg-blue-500' },
  databases:  { label: 'Databases & warehouses', icon: Database, color: 'bg-emerald-500' },
  saas:       { label: 'SaaS connectors',        icon: Cloud,    color: 'bg-purple-500' },
  apis:       { label: 'APIs & webhooks',        icon: Globe,    color: 'bg-orange-500' },
  synthetic:  { label: 'Synthetic & demo data',  icon: Sparkles, color: 'bg-pink-500' },
  other:      { label: 'Other sources',          icon: Boxes,    color: 'bg-gray-400' },
};

export function formatRelative(ts: string): string {
  const dt = Date.now() - new Date(ts).getTime();
  if (dt < 60_000) return 'just now';
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 24 * 3600_000) return `${Math.floor(dt / 3600_000)}h ago`;
  if (dt < 7 * 24 * 3600_000) return `${Math.floor(dt / (24 * 3600_000))}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Fact({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'success' | 'warning';
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-700'
    : tone === 'warning' ? 'text-amber-700'
    : 'text-gray-800';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${toneClass} break-all`}>{value}</span>
    </div>
  );
}
