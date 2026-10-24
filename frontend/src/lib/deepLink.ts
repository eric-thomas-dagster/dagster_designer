/**
 * `dagster-designer://` links: open a project, or an asset in a project, in the desktop app.
 *
 *   dagster-designer://project?project=<name>
 *   dagster-designer://asset?project=<name>&key=<asset key>
 *
 * Projects are found by name (ids are different on every machine). A link comes from outside the app, so parsing is strict:
 * anything that isn't exactly one of these shapes is rejected rather than guessed at.
 */

export const DEEP_LINK_SCHEME = 'dagster-designer';

export type DeepLink =
  | { kind: 'project'; project: string }
  | { kind: 'asset'; project: string; assetKey: string };

const MAX_PROJECT = 200;
const MAX_KEY = 500;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function clean(value: string | null, max: number): string | null {
  if (value === null) return null;
  const v = value.trim();
  return v.length > 0 && v.length <= max && !CONTROL_CHARS.test(v) ? v : null;
}

/** The link's meaning, or null when it isn't a valid Dagster Designer link. */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const project = clean(url.searchParams.get('project'), MAX_PROJECT);
  if (!project) return null;
  switch (url.hostname.toLowerCase()) {
    case 'project':
      return { kind: 'project', project };
    case 'asset': {
      const assetKey = clean(url.searchParams.get('key'), MAX_KEY);
      return assetKey ? { kind: 'asset', project, assetKey } : null;
    }
    default:
      return null;
  }
}

export function buildProjectLink(project: string): string {
  return `${DEEP_LINK_SCHEME}://project?${new URLSearchParams({ project })}`;
}

export function buildAssetLink(project: string, assetKey: string): string {
  return `${DEEP_LINK_SCHEME}://asset?${new URLSearchParams({ project, key: assetKey })}`;
}

interface NamedProject {
  id: string;
  name: string;
  directory_name?: string | null;
}

/** The local project a link means: its name, ignoring case. When several share a name, the link is ambiguous and nothing is chosen. */
export function findProjectForLink<T extends NamedProject>(projects: T[], name: string): { project: T | null; ambiguous: boolean } {
  const wanted = name.trim().toLowerCase();
  const matches = projects.filter((p) => p.name.trim().toLowerCase() === wanted);
  if (matches.length === 1) return { project: matches[0], ambiguous: false };
  return { project: null, ambiguous: matches.length > 1 };
}
