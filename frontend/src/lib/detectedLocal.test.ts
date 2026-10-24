import { describe, expect, it } from 'vitest';
import { chatModels, describeServer, pickDefaultModel } from './detectedLocal';

describe('chatModels', () => {
  it('drops embedding, reranking and audio models', () => {
    expect(chatModels(['nomic-embed-text:latest', 'llama3.1:8b', 'bge-m3', 'mxbai-embed-large', 'qwen2.5:14b', 'whisper-large-v3', 'bge-reranker'])).toEqual(['llama3.1:8b', 'qwen2.5:14b']);
  });
  it('keeps ordinary names that merely contain letters of those words', () => {
    expect(chatModels(['gemma2:9b', 'phi3:mini', 'mistral:latest'])).toEqual(['gemma2:9b', 'phi3:mini', 'mistral:latest']);
  });
});

describe('pickDefaultModel', () => {
  it('prefers the biggest chat model by the size in its name', () => {
    expect(pickDefaultModel(['llama3.1:8b', 'llama3.1:70b', 'qwen2.5:14b'])).toBe('llama3.1:70b');
  });
  it('never picks an embedding model, even when it is first', () => {
    expect(pickDefaultModel(['nomic-embed-text:latest', 'llama3.2:3b'])).toBe('llama3.2:3b');
  });
  it('understands sizes written with decimals or dashes', () => {
    expect(pickDefaultModel(['model-0.5b', 'model-1.5b', 'model-7b-instruct'])).toBe('model-7b-instruct');
  });
  it('falls back to the first chat model when no size is in the names', () => {
    expect(pickDefaultModel(['mistral:latest', 'gemma:latest'])).toBe('mistral:latest');
  });
  it('is empty when there is nothing to chat with', () => {
    expect(pickDefaultModel([])).toBe('');
    expect(pickDefaultModel(['nomic-embed-text'])).toBe('');
  });
});

describe('describeServer', () => {
  it('counts only chat models', () => {
    expect(describeServer({ name: 'Ollama', base_url: 'x', models: ['llama3.1:8b', 'nomic-embed-text'] })).toEqual({ usable: true, text: 'Found Ollama with 1 model.' });
    expect(describeServer({ name: 'LM Studio', base_url: 'x', models: ['a', 'b'] }).text).toBe('Found LM Studio with 2 models.');
  });
  it('explains what to do when the server has no chat model yet', () => {
    const d = describeServer({ name: 'Ollama', base_url: 'x', models: ['nomic-embed-text'] });
    expect(d.usable).toBe(false);
    expect(d.text).toContain('ollama pull');
    expect(describeServer({ name: 'Ollama', base_url: 'x', models: [] }).usable).toBe(false);
  });
});
