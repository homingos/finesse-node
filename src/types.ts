/** Response shapes. Field names match the API (snake_case); timestamps are Unix milliseconds. */

export interface VoiceSettings {
  stability?: number;
  similarity?: number;
  style?: number;
  speed?: number;
  pitch?: number;
  volume?: number;
  use_speaker_boost?: boolean;
  emotion?: string;
  engine_params?: Record<string, unknown>;
}

/** A voice. It can synthesize once `status === "ready"`. */
export interface Voice {
  id: string;
  org_id: string;
  name: string;
  /** `draft`, `processing`, `ready`, `failed`, ... */
  status: string;
  clone_method: string;
  /** `private` for your voices, `public` for platform catalog voices. */
  visibility: string;
  primary_language: string;
  description?: string;
  model?: string;
  /** Human-friendly handle, also usable as `voice` on the OpenAI-compatible endpoint. */
  alias?: string;
  source?: string;
  language?: string;
  gender?: string;
  /** Labels as a plain object (the API sends `[{key, value}]`; the SDK converts it). */
  labels: Record<string, string>;
  settings?: VoiceSettings;
  metadata?: Record<string, unknown>;
  external_ref?: string;
  original_audio_url?: string;
  sample_audio_url?: string;
  avatar_url?: string;
  base_voice_id?: string;
  created_at?: number;
  updated_at?: number;
  last_used_at?: number;
  expires_at?: number;
  deleted_at?: number;
  [key: string]: unknown;
}

/** An asynchronous clone job. */
export interface CloneJob {
  id: string;
  org_id: string;
  /** `pending`, `running`, `succeeded`, `failed`, `cancelled` or `expired`. */
  status: string;
  job_type: string;
  voice_id?: string;
  /** Percent complete. Not updated while running; 100 once succeeded. */
  progress: number;
  attempts: number;
  /** Failure detail, `{message, status_code}`. */
  error?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  started_at?: number;
  finished_at?: number;
  created_at?: number;
  [key: string]: unknown;
}

/** What `voices.clone` / `voices.enroll` return: the voice (`processing`) and its job id. */
export interface CloneResult {
  voice: Voice;
  job_id: string;
}

/** A synthesized clip from `speech.create`. */
export interface Audio {
  data: Uint8Array;
  /** `audio/wav` for WAV, `application/octet-stream` for raw PCM. */
  contentType: string;
  sampleRate: number | null;
  /** Id of the generation history record (when object storage is enabled). */
  generationId: string | null;
  audioURL: string | null;
  billingRemaining: number | null;
}

/** One chunk of raw PCM from `speech.stream`. */
export interface AudioChunk {
  pcm: Uint8Array;
  sampleRate: number | null;
  /** PCM encoding, e.g. `s16le`. */
  audioFormat: string | null;
  index: number | null;
}

/** The final event of `speech.stream`. */
export interface StreamDone {
  audio_duration_s?: number;
  generation_id?: string;
  audio_url?: string;
}

/** `wav` (one-shot default) or raw little-endian PCM. */
/** A short-lived, single-use token from `tokens.create`. Hand `token` to a browser or device:
 * it is good for one `speech.create` / `speech.stream` call or one realtime session, carries
 * the `tts` scope only, and dies when the key that minted it is revoked or expires. */
export interface AccessToken {
  token: string;
  /** Unix epoch ms. */
  expires_at: number;
  ttl_seconds: number;
}

export type OutputFormat = "wav" | "s16le" | "s24le" | "s32le" | "f32le" | "f64le";

export interface SpeechParams {
  /** One of your voices or a public platform voice; it must be ready. */
  voice_id: string;
  /** At most 10,000 characters. Billed per character. */
  text: string;
  language?: string;
  output_format?: OutputFormat;
  /** Output rate in Hz. The native rate is 24000; lower values still return 24000. */
  sample_rate?: number;
  /** Generation steps (default 32); fewer is faster, more is higher quality. */
  num_step?: number;
}

export function toVoice(raw: unknown): Voice {
  const v = { ...(raw as Record<string, unknown>) };
  const labels = v.labels;
  if (Array.isArray(labels)) {
    const map: Record<string, string> = {};
    for (const item of labels) {
      if (item && typeof item === "object" && "key" in item) {
        map[String((item as { key: unknown }).key)] = String(
          (item as { value?: unknown }).value ?? "",
        );
      }
    }
    v.labels = map;
  } else if (!labels || typeof labels !== "object") {
    v.labels = {};
  }
  return v as Voice;
}

export const isReady = (voice: Voice): boolean => voice.status === "ready";
