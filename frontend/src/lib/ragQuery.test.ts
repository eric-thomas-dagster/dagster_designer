import { describe, it, expect } from 'vitest';
import { buildRagQueryConfig, deriveKnowledgeBases, type KnowledgeBaseRef } from './ragQuery';

const CE = 'my_project.components.context_engineering_pipeline.component.ContextEngineeringPipelineComponent';

const kb = (attrs: Record<string, any>) => ({ component_type: CE, attributes: { asset_name: 'support_kb', ...attrs } });

describe('deriveKnowledgeBases', () => {
  it('reads the index and embedding model from the build so the retriever matches it', () => {
    const { supported } = deriveKnowledgeBases([
      kb({
        steps: [
          { op: 'chunk' },
          { op: 'embed', provider: 'openai', model: 'text-embedding-3-small', api_key_env_var: 'OPENAI_API_KEY' },
          { op: 'write_vector_store', provider: 'chromadb', connection_string: './chroma', collection_name: 'tickets' },
        ],
      }),
    ]);
    expect(supported).toEqual([
      {
        assetName: 'support_kb',
        store: { kind: 'chromadb', collectionName: 'tickets', path: './chroma', apiKeyEnvVar: undefined },
        embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKeyEnvVar: 'OPENAI_API_KEY' },
      },
    ]);
  });

  it('defaults to the local embedder and a collection named after the asset', () => {
    const { supported } = deriveKnowledgeBases([kb({ steps: [{ op: 'embed' }, { op: 'write_vector_store' }] })]);
    expect(supported[0].embedding.provider).toBe('sentence_transformers');
    expect(supported[0].store.collectionName).toBe('support_kb_kb');
  });

  it('explains why a knowledge base cannot be queried instead of silently dropping it', () => {
    const { supported, unsupported } = deriveKnowledgeBases([
      kb({ asset_name: 'sql_kb', execution_mode: 'sql', steps: [{ op: 'chunk' }] }),
      kb({ asset_name: 'half_built', steps: [{ op: 'chunk' }] }),
      kb({ asset_name: 'lite', steps: [{ op: 'embed', provider: 'litellm' }, { op: 'write_vector_store' }] }),
    ]);
    expect(supported).toEqual([]);
    expect(unsupported.map((u) => u.assetName)).toEqual(['sql_kb', 'half_built', 'lite']);
    expect(unsupported[0].reason).toMatch(/SQL/);
    expect(unsupported[1].reason).toMatch(/write_vector_store/);
    expect(unsupported[2].reason).toMatch(/litellm/);
  });

  it('ignores other components', () => {
    expect(deriveKnowledgeBases([{ component_type: 'my_project.components.agentic_pipeline.component.AgenticPipelineComponent', attributes: { asset_name: 'a' } }])).toEqual({ supported: [], unsupported: [] });
  });
});

const KB: KnowledgeBaseRef = {
  assetName: 'support_kb',
  store: { kind: 'chromadb', collectionName: 'tickets', path: './chroma' },
  embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKeyEnvVar: 'OPENAI_API_KEY' },
};
const BASE = { assetName: 'support_qa', upstreamAssetKey: 'questions', queryColumn: 'query', answerColumn: 'answer', kb: KB, topK: 5, answer: null, receipts: null };

describe('buildRagQueryConfig', () => {
  it('retrieval only: one retrieve step, no personas', () => {
    const c = buildRagQueryConfig(BASE);
    expect(c.steps).toEqual([{ id: 'retrieved', op: 'retrieve', retriever: 'kb', top_k: 5 }]);
    expect(c.personas).toBeUndefined();
    expect(c.retrievers.kb).toEqual({
      kind: 'chromadb', collection_name: 'tickets', path: './chroma',
      embedding: { provider: 'openai', model: 'text-embedding-3-small', api_key_env_var: 'OPENAI_API_KEY' },
    });
  });

  it('adds a generate step reading the retrieved docs when an answer is wanted', () => {
    const c = buildRagQueryConfig({ ...BASE, answer: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKeyEnvVar: 'ANTHROPIC_API_KEY' } });
    expect(c.steps[1]).toMatchObject({ id: 'answered', op: 'generate', source: 'retrieved', persona: 'answerer' });
    expect(c.personas.answerer).toMatchObject({ provider: 'anthropic', api_key_env_var: 'ANTHROPIC_API_KEY' });
    expect(c.steps[1].system_prompt).toMatch(/ONLY the provided context/);
  });

  it('only sends input_type to Voyage', () => {
    const voyage = buildRagQueryConfig({ ...BASE, kb: { ...KB, embedding: { provider: 'voyage', model: 'voyage-3-large' } } });
    expect(voyage.retrievers.kb.embedding.input_type).toBe('query');
    expect(buildRagQueryConfig(BASE).retrievers.kb.embedding.input_type).toBeUndefined();
  });

  it('wires receipts to the store resource and names the context after the knowledge base', () => {
    const c = buildRagQueryConfig({ ...BASE, receipts: { resourceKey: 'context_receipts' } });
    expect(c.receipts).toEqual({ resource_key: 'context_receipts', context_name: 'support_kb' });
  });

  it('keeps top_k at least 1', () => {
    expect(buildRagQueryConfig({ ...BASE, topK: 0 }).steps[0].top_k).toBe(1);
  });
});
