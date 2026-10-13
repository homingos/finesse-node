import { pathId, type Core } from "../core.js";
import { toBlob, type FileInput } from "../files.js";
import { toVoice, type CloneResult, type Voice } from "../types.js";
import { Jobs, type WaitOptions } from "./jobs.js";

export interface ListVoicesParams {
  /** 1-based page. Default 1. */
  page?: number;
  /** Voices per page, at most 100. Default 50. */
  page_size?: number;
}

export interface CreateVoiceParams {
  name: string;
  description?: string;
  language?: string;
  labels?: Record<string, string>;
  model?: string;
}

export interface UpdateVoiceParams {
  name?: string;
  description?: string;
  language?: string;
  /** Replaces the whole label set (`{}` clears it). */
  labels?: Record<string, string>;
}

export interface CloneVoiceParams {
  name: string;
  /** Reference clip, at most 20 MiB. */
  file: FileInput;
  description?: string;
  language?: string;
  labels?: Record<string, string>;
  /** Transcript of the reference clip. */
  ref_text?: string;
  remove_background_noise?: boolean;
}

export interface EnrollVoiceParams {
  file: FileInput;
  ref_text?: string;
  language?: string;
}

/** One page of voices. `for await (const voice of page)` walks this page and every page after
 * it, fetching as needed. */
export class VoicePage implements AsyncIterable<Voice> {
  readonly voices: Voice[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
  readonly has_more: boolean;

  constructor(
    data: Record<string, unknown>,
    private readonly fetchPage: (page: number) => Promise<VoicePage>,
  ) {
    this.voices = ((data.voices as unknown[]) ?? []).map(toVoice);
    this.page = Number(data.page ?? 1);
    this.page_size = Number(data.page_size ?? this.voices.length);
    this.total = Number(data.total ?? this.voices.length);
    this.has_more = Boolean(data.has_more);
  }

  nextPage(): Promise<VoicePage> {
    return this.fetchPage(this.page + 1);
  }

  async *iterPages(): AsyncGenerator<VoicePage> {
    let page: VoicePage = this;
    for (;;) {
      yield page;
      if (!page.has_more || page.voices.length === 0) return;
      page = await page.nextPage();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Voice> {
    for await (const page of this.iterPages()) yield* page.voices;
  }
}

function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function form(fields: Record<string, string | undefined>, file: FileInput): () => FormData {
  const { blob, filename } = toBlob(file);
  return () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v);
    fd.append("file", blob, filename);
    return fd;
  };
}

/** Create, list, clone and manage voices. */
export class Voices {
  constructor(
    private readonly core: Core,
    private readonly jobs: Jobs,
  ) {}

  /** Your voices (newest first), then the public platform voices. */
  async list(params: ListVoicesParams = {}): Promise<VoicePage> {
    const pageSize = params.page_size ?? 50;
    const fetchPage = async (page: number): Promise<VoicePage> => {
      const data = await this.core.json<Record<string, unknown>>("GET", "/voices", {
        query: { page, page_size: pageSize },
      });
      return new VoicePage(data, fetchPage);
    };
    return fetchPage(params.page ?? 1);
  }

  /** One of your voices or a public platform voice. */
  async get(voiceId: string, options: { signal?: AbortSignal } = {}): Promise<Voice> {
    return toVoice(
      await this.core.json("GET", `/voices/${pathId(voiceId)}`, { signal: options.signal }),
    );
  }

  /** Create an empty `draft` voice. Give it a clip with {@link enroll}, or use {@link clone}. */
  async create(params: CreateVoiceParams): Promise<Voice> {
    return toVoice(await this.core.json("POST", "/voices", { json: defined({ ...params }) }));
  }

  /** Change a voice's metadata. Only the fields you pass change. */
  async update(voiceId: string, params: UpdateVoiceParams): Promise<Voice> {
    const json = defined({ ...params });
    return toVoice(await this.core.json("PATCH", `/voices/${pathId(voiceId)}`, { json }));
  }

  /** Delete one of your voices. */
  async delete(voiceId: string): Promise<void> {
    await this.core.request("DELETE", `/voices/${pathId(voiceId)}`);
  }

  /** Create a voice from a reference clip. Returns at once with the voice in `processing` and a
   * `job_id`; see {@link waitUntilReady} or {@link cloneAndWait}. */
  async clone(params: CloneVoiceParams): Promise<CloneResult> {
    const fields = {
      name: params.name,
      description: params.description,
      language: params.language,
      ref_text: params.ref_text,
      labels: params.labels ? JSON.stringify(params.labels) : undefined,
      remove_background_noise:
        params.remove_background_noise === undefined
          ? undefined
          : String(params.remove_background_noise),
    };
    const result = await this.core.json<CloneResult>("POST", "/voices/clone", {
      form: form(fields, params.file),
    });
    return { ...result, voice: toVoice(result.voice) };
  }

  /** Clone a reference clip into an existing voice of yours. Returns at once. */
  async enroll(voiceId: string, params: EnrollVoiceParams): Promise<CloneResult> {
    const fields = { ref_text: params.ref_text, language: params.language };
    const result = await this.core.json<CloneResult>("POST", `/voices/${pathId(voiceId)}/enroll`, {
      form: form(fields, params.file),
    });
    return { ...result, voice: toVoice(result.voice) };
  }

  /** Wait for a clone job to finish and return the voice, now `ready`. */
  async waitUntilReady(clone: CloneResult, options: WaitOptions = {}): Promise<Voice> {
    await this.jobs.wait(clone.job_id, options);
    return this.get(clone.voice.id, { signal: options.signal });
  }

  /** {@link clone}, then {@link waitUntilReady}. Returns the ready voice. */
  async cloneAndWait(params: CloneVoiceParams, options: WaitOptions = {}): Promise<Voice> {
    return this.waitUntilReady(await this.clone(params), options);
  }
}
