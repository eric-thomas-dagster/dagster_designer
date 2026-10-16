import type { Project } from '@/types';

/** Labels of the assets that directly depend on the given asset (by node id or asset key), from the project graph. */
export function downstreamAssetLabels(project: Project | null | undefined, idOrKey: string): string[] {
  if (!project?.graph) return [];
  const nodes = project.graph.nodes;
  const target = nodes.find((n) => n.id === idOrKey || (n.data as any)?.asset_key === idOrKey);
  if (!target) return [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const out = new Set<string>();
  for (const e of project.graph.edges) {
    if (e.source !== target.id) continue;
    const n = byId.get(e.target);
    if (n && n.node_kind === 'asset') out.add(String((n.data as any)?.asset_key || (n.data as any)?.label || n.id));
  }
  return [...out].sort();
}

/** Short "a, b, c and 4 more" list for a confirmation message. */
export function summarizeNames(names: string[], max = 8): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
