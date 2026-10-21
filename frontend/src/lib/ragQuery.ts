import { extractComponentId } from './componentId';

/**
 * Pure helpers behind the guided "Query a knowledge base" builder (rag_pipeline). Kept out of the component so the config
 * it produces is unit-testable: the retriever must describe the SAME index and embedding model the knowledge base was
 * built with, or retrieval silently returns nonsense.
 */

export interface KnowledgeBaseRef {
  /** The context_engineering_pipeline asset that builds it (used for names and receipts' context_name). */
  assetName: string;
  store: { kind: string; collectionName: string; path?: string; apiKeyEnvVar?: string };
  embedding: { provider: string; model?: string; apiKeyEnvVar?: string };
}

export interface KnowledgeBaseSource {
  component_type: string;
  attributes?: Record<string, any>;
}

// rag_pipeline's retrievers can embed with these; litellm (a valid embed provider in the build) has no query-side twin.
export const RAG_EMBEDDING_PROVIDERS = new Set(['openai', 'cohere', 'voyage', 'sentence_transformers']);

/** Knowledge bases in a project that rag_pipeline can query: python-mode builds that write to a vector store with an
 * embedding rag_pipeline understands. Anything else is returned in `unsupported` with the reason, so the UI can say why. */
export function deriveKnowledgeBases(components: KnowledgeBaseSource[]): {
  supported: KnowledgeBaseRef[];
  unsupported: { assetName: string; reason: string }[];
} {
  const supported: KnowledgeBaseRef[] = [];
  const unsupported: { assetName: string; reason: string }[] = [];
  for (const c of components) {
    if (extractComponentId(c.component_type) !== 'context_engineering_pipeline') continue;
    const attrs = c.attributes || {};
    const assetName = String(attrs.asset_name || '');
    if (!assetName) continue;
    if (attrs.execution_mode === 'sql') {
      unsupported.push({ assetName, reason: 'warehouse-native (SQL) builds land in a table, not a vector store' });
      continue;
    }
    const steps: any[] = Array.isArray(attrs.steps) ? attrs.steps : [];
    const write = steps.find((s) => s?.op === 'write_vector_store');
    const embed = steps.find((s) => s?.op === 'embed') || {};
    if (!write) {
      unsupported.push({ assetName, reason: 'it has no write_vector_store step yet' });
      continue;
    }
    const embedProvider = embed.provider || 'sentence_transformers';
    if (!RAG_EMBEDDING_PROVIDERS.has(embedProvider)) {
      unsupported.push({ assetName, reason: `it embeds with ${embedProvider}, which rag_pipeline can't query with` });
      continue;
    }
    const kind = write.provider || 'chromadb';
    supported.push({
      assetName,
      store: {
        kind,
        collectionName: write.collection_name || `${assetName}_kb`,
        path: write.connection_string || undefined,
        apiKeyEnvVar: write.api_key_env_var || undefined,
      },
      embedding: { provider: embedProvider, model: embed.model || undefined, apiKeyEnvVar: embed.api_key_env_var || undefined },
    });
  }
  return { supported, unsupported };
}

export const ANSWER_PROVIDERS: Record<string, { label: string; model: string; apiKeyEnvVar: string }> = {
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', apiKeyEnvVar: 'OPENAI_API_KEY' },
  anthropic: { label: 'Anthropic', model: 'claude-haiku-4-5-20251001', apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
  gemini: { label: 'Google Gemini', model: 'gemini/gemini-2.5-flash', apiKeyEnvVar: 'GEMINI_API_KEY' },
};

export interface RagQueryForm {
  assetName: string;
  upstreamAssetKey: string;
  queryColumn: string;
  answerColumn: string;
  kb: KnowledgeBaseRef;
  topK: number;
  /** null = retrieval only (no answer generated). */
  answer: { provider: string; model: string; apiKeyEnvVar: string; systemPrompt?: string } | null;
  receipts: { resourceKey: string } | null;
}

export const DEFAULT_SYSTEM_PROMPT =
  "Answer using ONLY the provided context. If the answer isn't in the context, say so. Cite the source of each claim.";

export function buildRagQueryConfig(f: RagQueryForm): Record<string, any> {
  const embedding: Record<string, any> = { provider: f.kb.embedding.provider, input_type: 'query' };
  if (f.kb.embedding.model) embedding.model = f.kb.embedding.model;
  if (f.kb.embedding.apiKeyEnvVar) embedding.api_key_env_var = f.kb.embedding.apiKeyEnvVar;
  // input_type is a Voyage-only knob; sending it to other providers would be an unknown field.
  if (f.kb.embedding.provider !== 'voyage') delete embedding.input_type;

  const retriever: Record<string, any> = { kind: f.kb.store.kind, collection_name: f.kb.store.collectionName, embedding };
  if (f.kb.store.path) retriever.path = f.kb.store.path;
  if (f.kb.store.apiKeyEnvVar) retriever.api_key_env_var = f.kb.store.apiKeyEnvVar;

  const steps: Record<string, any>[] = [{ id: 'retrieved', op: 'retrieve', retriever: 'kb', top_k: Math.max(1, Math.round(f.topK)) }];
  const config: Record<string, any> = {
    name: f.assetName,
    asset_name: f.assetName,
    upstream_asset_key: f.upstreamAssetKey,
    query_column: f.queryColumn,
    answer_column: f.answerColumn,
    retrievers: { kb: retriever },
    steps,
  };
  if (f.answer) {
    config.personas = {
      answerer: { provider: f.answer.provider, model: f.answer.model, api_key_env_var: f.answer.apiKeyEnvVar, temperature: 0.0 },
    };
    steps.push({
      id: 'answered',
      op: 'generate',
      source: 'retrieved',
      persona: 'answerer',
      system_prompt: f.answer.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    });
  }
  if (f.receipts) config.receipts = { resource_key: f.receipts.resourceKey, context_name: f.kb.assetName };
  return config;
}
