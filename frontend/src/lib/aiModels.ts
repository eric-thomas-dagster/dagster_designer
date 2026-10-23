/** Which models the pickers offer, given which providers are configured. */

export interface ModelOption {
  value: string;
  label: string;
}

export interface ProviderFlags {
  openai_available: boolean;
  anthropic_available: boolean;
  local_available?: boolean;
  local_model?: string;
}

/** The picker entry for the user's local server. The backend reads the `local:` prefix; an empty name means "the default
 * model from Settings". */
export function localModelOption(p: ProviderFlags): ModelOption | null {
  if (!p.local_available) return null;
  const name = (p.local_model || '').trim();
  return { value: `local:${name}`, label: name ? `Local: ${name}` : 'Local model (set a default in Settings)' };
}

/** Hosted models whose provider has a key, then the local model last -- so a hosted default stays first, and a local-only
 * setup defaults to the local model. `providers` still loading => everything, as the pickers always did. */
export function availableModels(options: ModelOption[], providers: ProviderFlags | null | undefined): ModelOption[] {
  if (!providers) return options;
  const hosted = options.filter((m) => (m.value.startsWith('claude') ? providers.anthropic_available : providers.openai_available));
  const local = localModelOption(providers);
  return local ? [...hosted, local] : hosted;
}

/** True when anything at all can answer: a hosted key or a local server. */
export function anyProviderConfigured(p: ProviderFlags | null | undefined): boolean {
  return !!p && (p.openai_available || p.anthropic_available || !!p.local_available);
}
