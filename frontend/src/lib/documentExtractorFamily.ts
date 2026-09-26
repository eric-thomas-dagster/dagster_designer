// The document/image/audio extractor family -- components whose output
// is worth reviewing side-by-side with the source file (an image or
// audio path plus whatever got extracted from it). Mirrors the same
// "hardcode the family, gate a button on it" pattern as
// AGENTIC_PIPELINE_FAMILY (see ComponentConfigModal's "Edit with Genie"
// button) -- see DocumentExtractionReview.
export const DOCUMENT_EXTRACTOR_FAMILY = new Set([
  'ocr_extractor',
  'document_text_extractor',
  'document_ai_extractor',
  'vision_api_asset',
  'structured_document_extractor',
  'image_llm_extractor',
  'instructor_extractor',
  'litellm_structured_output',
  'entity_extractor',
  'document_layout_analyzer',
  'document_chunker',
  'document_summarizer',
  'audio_transcriber',
]);
