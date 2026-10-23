import { describe, it, expect } from 'vitest';
import { anyProviderConfigured, availableModels, localModelOption } from './aiModels';

const OPTIONS = [
  { value: 'claude-sonnet-4-5', label: 'Claude' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];
const none = { openai_available: false, anthropic_available: false };

describe('availableModels', () => {
  it('offers everything while providers are still loading', () => {
    expect(availableModels(OPTIONS, null)).toEqual(OPTIONS);
  });
  it('keeps only hosted models whose provider has a key', () => {
    expect(availableModels(OPTIONS, { ...none, openai_available: true }).map((m) => m.value)).toEqual(['gpt-4o']);
    expect(availableModels(OPTIONS, { ...none, anthropic_available: true }).map((m) => m.value)).toEqual(['claude-sonnet-4-5']);
  });
  it('puts the local model last so a hosted default stays first', () => {
    const got = availableModels(OPTIONS, { openai_available: true, anthropic_available: true, local_available: true, local_model: 'llama3.1' });
    expect(got.map((m) => m.value)).toEqual(['claude-sonnet-4-5', 'gpt-4o', 'local:llama3.1']);
  });
  it('a local-only setup defaults to the local model', () => {
    expect(availableModels(OPTIONS, { ...none, local_available: true, local_model: 'qwen2.5' })).toEqual([{ value: 'local:qwen2.5', label: 'Local: qwen2.5' }]);
  });
  it('is empty when nothing is configured', () => {
    expect(availableModels(OPTIONS, none)).toEqual([]);
  });
});

describe('localModelOption', () => {
  it('is absent without a local server', () => expect(localModelOption(none)).toBeNull());
  it('uses the settings default when no model is named', () => {
    expect(localModelOption({ ...none, local_available: true })).toEqual({ value: 'local:', label: 'Local model (set a default in Settings)' });
  });
});

describe('anyProviderConfigured', () => {
  it('counts a local server', () => {
    expect(anyProviderConfigured(none)).toBe(false);
    expect(anyProviderConfigured({ ...none, local_available: true })).toBe(true);
    expect(anyProviderConfigured(null)).toBe(false);
  });
});
