export { mp3DurationSeconds } from './audio.js';
export { decodeBase64, encodeBase64 } from './base64.js';
export { ProviderError, type ProviderErrorKind } from './errors.js';
export type { HttpFetch, HttpRequest, HttpResponse } from './http.js';
export {
  OPENROUTER_ID,
  createOpenRouterProvider,
  type OpenRouterOptions,
} from './openrouter/provider.js';
export {
  MODALITIES,
  modalityOf,
  type Attachment,
  type CallOptions,
  type CancelSignal,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type FinishReason,
  type GeneratedImage,
  type GenerationProvider,
  type ImageRequest,
  type ImageResponse,
  type Modality,
  type MediaInput,
  type ModelInfo,
  type VideoAbilities,
  type VideoJob,
  type VideoRequest,
  type SoundRequest,
  type SoundResponse,
  type SpeechRequest,
  type SpeechResponse,
  type TranscribedWord,
  type TranscriptionRequest,
  type TranscriptionResponse,
  type ToolCall,
  type Usage,
} from './types.js';
export {
  describeVideoModel,
  fitDuration,
  fitResolution,
  type VideoModelNotes,
} from './video-models.js';
