/**
 * Saving API keys: into the OS keychain when the desktop app has one, otherwise the way it always worked (the backend's .env).
 *
 * A key that went into the keychain is applied to the running backend with `persist: false`, so it is never written to disk;
 * the desktop shell hands it to the backend at launch. Everything that isn't a secret (a model's URL, its name) is saved as before.
 */

/** Request fields that hold a secret, and the environment variable the backend (and the keychain entry) calls them. */
export const SECRET_FIELDS: Record<string, string> = {
  openai_api_key: 'OPENAI_API_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  local_api_key: 'LOCAL_LLM_API_KEY',
};

export type KeyBody = Record<string, string | boolean | undefined>;

export interface KeySaveDeps<T> {
  /** True when the keychain took the value. */
  secretSet: (envName: string, value: string) => Promise<boolean>;
  secretDelete: (envName: string) => Promise<void>;
  setKeys: (body: KeyBody) => Promise<T>;
}

/**
 * Saves a set of changes. Secrets with a value go to the keychain when it will take them (and are then applied live only);
 * a blank secret clears it from both places; everything else is saved normally. Returns the last status the backend gave.
 */
export async function saveKeys<T>(body: KeyBody, deps: KeySaveDeps<T>): Promise<T | null> {
  const live: KeyBody = {}; // in the keychain: apply to the running backend only
  const saved: KeyBody = {}; // the normal way
  for (const [field, value] of Object.entries(body)) {
    const env = SECRET_FIELDS[field];
    if (env && typeof value === 'string') {
      if (value.trim() === '') {
        await deps.secretDelete(env);
        saved[field] = '';
      } else if (await deps.secretSet(env, value.trim())) {
        live[field] = value.trim();
      } else {
        saved[field] = value;
      }
    } else if (value !== undefined) {
      saved[field] = value;
    }
  }
  let status: T | null = null;
  if (Object.keys(live).length > 0) status = await deps.setKeys({ ...live, persist: false });
  if (Object.keys(saved).length > 0) status = await deps.setKeys(saved);
  return status;
}

/** Removes one key everywhere it could be: the keychain, the running backend and the .env file. */
export async function clearKey<T>(field: string, deps: KeySaveDeps<T>): Promise<T> {
  const env = SECRET_FIELDS[field];
  if (env) await deps.secretDelete(env);
  return deps.setKeys({ [field]: '' });
}
