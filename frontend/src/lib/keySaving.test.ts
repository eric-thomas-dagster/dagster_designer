import { describe, expect, it } from 'vitest';
import { clearKey, saveKeys, type KeyBody } from './keySaving';

function fakes(opts: { keychainWorks?: boolean; failFor?: string[] } = {}) {
  const calls: KeyBody[] = [];
  const stored: Record<string, string> = {};
  const deleted: string[] = [];
  return {
    calls, stored, deleted,
    deps: {
      secretSet: async (name: string, value: string) => {
        if (opts.keychainWorks === false || opts.failFor?.includes(name)) return false;
        stored[name] = value;
        return true;
      },
      secretDelete: async (name: string) => { deleted.push(name); },
      setKeys: async (body: KeyBody) => { calls.push(body); return `status-${calls.length}`; },
    },
  };
}

describe('saveKeys', () => {
  it('without a keychain, saves everything the old way in one request', async () => {
    const f = fakes({ keychainWorks: false });
    const status = await saveKeys({ openai_api_key: 'sk-1', local_base_url: 'http://x' }, f.deps);
    expect(f.calls).toEqual([{ openai_api_key: 'sk-1', local_base_url: 'http://x' }]);
    expect(f.stored).toEqual({});
    expect(status).toBe('status-1');
  });

  it('with a keychain, keeps the secret out of the saved request and applies it live only', async () => {
    const f = fakes();
    await saveKeys({ openai_api_key: ' sk-1 ', local_base_url: 'http://x', local_model: 'llama3.1' }, f.deps);
    expect(f.stored).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(f.calls).toEqual([
      { openai_api_key: 'sk-1', persist: false },
      { local_base_url: 'http://x', local_model: 'llama3.1' },
    ]);
    expect(JSON.stringify(f.calls[1])).not.toContain('sk-1');
  });

  it('a secret the keychain refuses falls back to being saved normally, without losing the others', async () => {
    const f = fakes({ failFor: ['ANTHROPIC_API_KEY'] });
    await saveKeys({ openai_api_key: 'sk-1', anthropic_api_key: 'sk-ant' }, f.deps);
    expect(f.stored).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(f.calls).toEqual([{ openai_api_key: 'sk-1', persist: false }, { anthropic_api_key: 'sk-ant' }]);
  });

  it('only keychain-bound secrets means a single live-only request', async () => {
    const f = fakes();
    await saveKeys({ openai_api_key: 'a', anthropic_api_key: 'b' }, f.deps);
    expect(f.calls).toEqual([{ openai_api_key: 'a', anthropic_api_key: 'b', persist: false }]);
  });

  it('a blank secret is removed from the keychain and cleared normally', async () => {
    const f = fakes();
    await saveKeys({ local_api_key: '  ' }, f.deps);
    expect(f.deleted).toEqual(['LOCAL_LLM_API_KEY']);
    expect(f.calls).toEqual([{ local_api_key: '' }]);
  });

  it('non-secret fields never touch the keychain, and undefined fields are skipped', async () => {
    const f = fakes();
    await saveKeys({ local_base_url: 'http://x', local_prefer: true, anthropic_workspace_id: undefined }, f.deps);
    expect(f.stored).toEqual({});
    expect(f.calls).toEqual([{ local_base_url: 'http://x', local_prefer: true }]);
  });

  it('an empty change does nothing', async () => {
    const f = fakes();
    expect(await saveKeys({}, f.deps)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('returns the status from the last request', async () => {
    const f = fakes();
    expect(await saveKeys({ openai_api_key: 'a', local_model: 'm' }, f.deps)).toBe('status-2');
  });
});

describe('clearKey', () => {
  it('removes a secret from the keychain and from the file and the running backend', async () => {
    const f = fakes();
    await clearKey('openai_api_key', f.deps);
    expect(f.deleted).toEqual(['OPENAI_API_KEY']);
    expect(f.calls).toEqual([{ openai_api_key: '' }]); // persist defaults to true on the backend: also clears .env
  });
  it('a field that is not a secret never touches the keychain', async () => {
    const f = fakes();
    await clearKey('anthropic_workspace_id', f.deps);
    expect(f.deleted).toEqual([]);
    expect(f.calls).toEqual([{ anthropic_workspace_id: '' }]);
  });
});
