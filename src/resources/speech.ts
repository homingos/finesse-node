import { pathId, releaseStream, type Core } from "../core.js";
import { APIConnectionError, FinesseError, StreamError } from "../errors.js";
import { iterSSE } from "../sse.js";
import type { Audio, AudioChunk, SpeechParams, StreamDone } from "../types.js";

function body(params: SpeechParams): Record<string, unknown> {
  const { voice_id: _ignored, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}

function intHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function base64ToBytes(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new StreamError("bad_chunk", "The stream sent an undecodable audio chunk.");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Speech streamed as raw PCM chunks: `for await (const chunk of stream)`. `done` is set once
 * it finishes. The request is sent when iteration starts. Errors before the stream starts
 * throw the usual `APIStatusError`; failures after it throw {@link StreamError}. */
export class SpeechStream implements AsyncIterable<AudioChunk> {
  sampleRate: number | null = null;
  audioFormat: string | null = null;
  /** Final event (duration, generation id, stored clip URL), once the stream finished. */
  done: StreamDone | null = null;
  billingRemaining: number | null = null;
  private consumed = false;

  constructor(
    private readonly core: Core,
    private readonly path: string,
    private readonly json: Record<string, unknown>,
    private readonly signal?: AbortSignal,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AudioChunk> {
    if (this.consumed) throw new FinesseError("This stream was already consumed; start a new one.");
    this.consumed = true;
    const response = await this.core.request("POST", this.path, {
      json: this.json,
      stream: true,
      signal: this.signal,
    });
    this.billingRemaining = intHeader(response.headers, "x-billing-remaining");
    try {
      if (!response.body) throw new StreamError("stream_incomplete", "The response had no body.");
      for await (const ev of iterSSE(response.body, this.core.timeout)) {
        const chunk = this.handle(ev.event, ev.data);
        if (chunk) yield chunk;
      }
      if (!this.done) {
        throw new StreamError("stream_incomplete", "The stream ended before it finished.");
      }
    } catch (err) {
      if (err instanceof FinesseError) throw err;
      throw new APIConnectionError(
        err instanceof Error ? err.message : "The stream was interrupted.",
        { cause: err },
      );
    } finally {
      releaseStream(response);
    }
  }

  /** Consume the stream and return all PCM joined together. */
  async readAll(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this) parts.push(chunk.pcm);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  private handle(event: string, data: string): AudioChunk | null {
    let payload: unknown;
    try {
      payload = data ? JSON.parse(data) : {};
    } catch {
      return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const p = payload as Record<string, unknown>;
    const kind = (typeof p.type === "string" && p.type) || event;
    if (kind === "start") {
      if (typeof p.sample_rate === "number") this.sampleRate = p.sample_rate;
      if (typeof p.audio_format === "string") this.audioFormat = p.audio_format;
    } else if (kind === "chunk") {
      return {
        pcm: base64ToBytes(typeof p.audio_b64 === "string" ? p.audio_b64 : ""),
        sampleRate: typeof p.sample_rate === "number" ? p.sample_rate : this.sampleRate,
        audioFormat: typeof p.audio_format === "string" ? p.audio_format : this.audioFormat,
        index: typeof p.index === "number" ? p.index : null,
      };
    } else if (kind === "done") {
      this.done = p as StreamDone;
    } else if (kind === "error") {
      throw new StreamError(
        typeof p.code === "string" && p.code ? p.code : "stream_error",
        typeof p.message === "string" ? p.message : "",
      );
    }
    return null;
  }
}

/** Text-to-speech. */
export class Speech {
  constructor(private readonly core: Core) {}

  /** Synthesize `text` and return the whole clip (`wav` unless `output_format` says otherwise). */
  async create(params: SpeechParams, options: { signal?: AbortSignal } = {}): Promise<Audio> {
    const response = await this.core.request("POST", `/voices/${pathId(params.voice_id)}/speak`, {
      json: body(params),
      signal: options.signal,
    });
    const h = response.headers;
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: h.get("content-type") ?? "audio/wav",
      sampleRate: intHeader(h, "x-sample-rate"),
      generationId: h.get("x-generation-id") || null,
      audioURL: h.get("x-audio-url") || null,
      billingRemaining: intHeader(h, "x-billing-remaining"),
    };
  }

  /** Stream speech as raw PCM chunks (`s16le` unless `output_format` says otherwise):
   *
   * ```ts
   * for await (const chunk of client.speech.stream({ voice_id, text: "Hello" })) play(chunk.pcm);
   * ```
   */
  stream(params: SpeechParams, options: { signal?: AbortSignal } = {}): SpeechStream {
    return new SpeechStream(
      this.core,
      `/voices/${pathId(params.voice_id)}/stream`,
      body(params),
      options.signal,
    );
  }
}
