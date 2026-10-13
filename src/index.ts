export { Finesse } from "./client.js";
export type { ClientOptions, RequestOptions } from "./core.js";
export {
  FinesseError,
  APIConnectionError,
  APITimeoutError,
  APIStatusError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  RateLimitError,
  InternalServerError,
  StreamError,
  CloneFailedError,
  CloneTimeoutError,
} from "./errors.js";
export { fileFromPath, type FileInput } from "./files.js";
export {
  RealtimeError,
  RealtimeSession,
  RealtimeContext,
  type RealtimeEvent,
  type UnknownEvent,
  type TaskStarted,
  type AudioEvent,
  type SentenceDone,
  type TaskDone,
  type TaskCancelled,
  type ContextOptions,
  type ConnectOptions,
} from "./realtime.js";
export { VoicePage, VoicePagePromise } from "./resources/voices.js";
export type {
  ListVoicesParams,
  CreateVoiceParams,
  UpdateVoiceParams,
  CloneVoiceParams,
  EnrollVoiceParams,
} from "./resources/voices.js";
export type { WaitOptions } from "./resources/jobs.js";
export { SpeechStream } from "./resources/speech.js";
export { isReady } from "./types.js";
export type {
  Voice,
  VoiceSettings,
  CloneJob,
  CloneResult,
  Audio,
  AudioChunk,
  StreamDone,
  SpeechParams,
  OutputFormat,
} from "./types.js";
export { VERSION } from "./version.js";
