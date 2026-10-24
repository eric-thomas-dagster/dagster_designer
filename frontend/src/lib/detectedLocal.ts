/** Helpers for offering a local model server that is already running (Ollama, LM Studio, ...). */

export interface DetectedServer {
  name: string;
  base_url: string;
  models: string[];
}

// Servers list every model they have, including ones that can't chat. Picking one of these as "the model" would just fail.
const NOT_A_CHAT_MODEL = /(embed|embedding|bge-|minilm|e5-|gte-|rerank|whisper|tts|clip|stable-diffusion)/i;

export function chatModels(models: string[]): string[] {
  return models.filter((m) => !NOT_A_CHAT_MODEL.test(m));
}

// Larger / stronger first: planning needs strict JSON and long prompts, and small models are the usual cause of bad plans.
const SIZE = /(\d+(?:\.\d+)?)\s*b\b/i;

function modelSize(name: string): number {
  const m = SIZE.exec(name.replace(/[:_-]/g, ' '));
  return m ? parseFloat(m[1]) : 0;
}

/** The model to preselect: the biggest chat model by the size in its name, else the first. */
export function pickDefaultModel(models: string[]): string {
  const chat = chatModels(models);
  if (chat.length === 0) return '';
  return [...chat].sort((a, b) => modelSize(b) - modelSize(a))[0];
}

/** What to say about a detected server, or null when there's nothing to offer. */
export function describeServer(s: DetectedServer): { usable: boolean; text: string } {
  const chat = chatModels(s.models);
  if (chat.length === 0) {
    return { usable: false, text: `${s.name} is running but has no chat model yet — download one (for Ollama: \`ollama pull llama3.1\`), then try again.` };
  }
  return { usable: true, text: `Found ${s.name} with ${chat.length} model${chat.length === 1 ? '' : 's'}.` };
}
