/**
 * Realtime speech over one WebSocket. One session is one socket; each turn of speech runs in a
 * *context*, and a socket can run several contexts at once (up to 4). Audio arrives as raw PCM,
 * `s16le` at 24 kHz unless you ask for something else.
 *
 * ```ts
 * const rt = await client.realtime.connect();
 * for await (const event of rt.say({ voice_id, text: "Hello there." })) {
 *   if (event.type === "audio") play(event.pcm);
 * }
 * await rt.close();
 * ```
 *
 * In Node this needs the `ws` package (`npm i ws`), which sends the API key as a header. Bun's
 * built-in WebSocket does too. Deno and browsers cannot set handshake headers, so there the key
 * goes in the URL.
 */

import { API_PREFIX, isBrowser, type Core } from "./core.js";
import { APIConnectionError, APITimeoutError, FinesseError, makeStatusError } from "./errors.js";

export const DEFAULT_OPEN_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

// Going Away, abnormal closure, internal error, service restart, try again later, engine busy.
const RETRYABLE_CLOSES = new Set([1001, 1006, 1011, 1012, 1013, 4429]);
const RETRYABLE_CODES = new Set([
  "upstream_closed",
  "connection_lost",
  "service_busy",
  "stream_billing_error",
]);

/** A realtime context or session failed. */
export class RealtimeError extends FinesseError {
  /** `voice_not_found`, `insufficient_credits`, `upstream_closed`, `connection_lost`,
   * `service_busy`, a `task_failed` code, ... */
  readonly code: string;
  /** The context it applies to, or `null` for the whole session. */
  readonly contextId: string | null;
  /** The WebSocket close code, when the socket closed. */
  closeCode: number | null;

  constructor(
    code: string,
    message = "",
    options: { contextId?: string | null; closeCode?: number | null } = {},
  ) {
    super(message && message !== code ? `${message} (${code})` : code);
    this.code = code;
    this.contextId = options.contextId ?? null;
    this.closeCode = options.closeCode ?? null;
  }

  /** Whether reconnecting and trying again can succeed. */
  get retryable(): boolean {
    return (
      RETRYABLE_CODES.has(this.code) ||
      (this.closeCode !== null && RETRYABLE_CLOSES.has(this.closeCode))
    );
  }
}

function closeError(code: number | null, reason: string): RealtimeError | null {
  const c = { closeCode: code };
  if (code === 1000) return null;
  if (code === 1008) return new RealtimeError(reason || "policy_violation", reason, c);
  if (code === 1009) return new RealtimeError("message_too_big", "A message was too large.", c);
  if (code === 1011) return new RealtimeError(reason || "upstream_closed", reason, c);
  if (code === 4401) {
    return new RealtimeError(
      "service_auth_failed",
      "The service could not start the session (a problem on our side).",
      c,
    );
  }
  if (code === 4429) {
    return new RealtimeError(
      "service_busy",
      "The service is at its connection limit. Try again shortly.",
      c,
    );
  }
  if (code === null || code === 1005 || code === 1006) {
    return new RealtimeError("connection_lost", "The connection dropped.", { closeCode: 1006 });
  }
  if (code === 1001 || code === 1012 || code === 1013) {
    return new RealtimeError(
      "connection_lost",
      "The service closed the connection (restart or overload).",
      c,
    );
  }
  return new RealtimeError(reason || "connection_closed", reason, c);
}

export interface TaskStarted {
  type: "task_started";
  context_id: string;
  sample_rate?: number;
  audio_format?: string;
}
export interface AudioEvent {
  type: "audio";
  context_id: string;
  /** Raw PCM in the context's `audio_format` / `sample_rate`. */
  pcm: Uint8Array;
  sample_rate: number | null;
  audio_format: string | null;
  sentence_index?: number;
  chunk_index?: number;
  audio_duration_s?: number;
}
export interface SentenceDone {
  type: "sentence_done";
  context_id: string;
  sentence_index?: number;
  text?: string;
  audio_duration_s?: number;
}
/** The context finished. Last event of a context. */
export interface TaskDone {
  type: "task_done";
  context_id: string;
  num_sentences?: number;
  total_audio_duration_s?: number;
  profile?: Record<string, unknown>;
  trace_id?: string;
}
/** The context was cancelled. Last event of a cancelled context. */
export interface TaskCancelled {
  type: "task_cancelled";
  context_id: string;
  sentences_completed?: number;
  sentences_dropped?: number;
  trace_id?: string;
}
/** An engine event this SDK version does not know yet. `event_type` is its `type` on the wire
 * and `data` the whole frame. */
export interface UnknownEvent {
  type: "unknown";
  context_id: string;
  event_type: string;
  data: Record<string, unknown>;
}
/** Every event a context yields. Narrow it on `type`. */
export type RealtimeEvent =
  TaskStarted | AudioEvent | SentenceDone | TaskDone | TaskCancelled | UnknownEvent;

export interface ContextOptions {
  /** One of your voices or a public platform voice. */
  voice_id: string;
  context_id?: string;
  language?: string;
  /** `s16le` (default), `s24le`, `s32le`, `f32le`, `f64le` or `opus`. */
  output_format?: "s16le" | "s24le" | "s32le" | "f32le" | "f64le" | "opus";
  /** Output rate in Hz; the native rate is 24000 and lower values still produce 24000. */
  sample_rate?: number;
  num_step?: number;
  guidance_scale?: number;
  /** Speaking rate. */
  length_scale?: number;
  /** Speak a pending sentence after this many ms without new text. */
  idle_flush_ms?: number;
}

export interface ConnectOptions {
  /** Reconnect on the next context after a retryable drop. Default true. */
  autoReconnect?: boolean;
  /** Ms to open the socket. Default 60 000: the service connects to the engine first, which
   * takes longer when the engine is cold. */
  openTimeout?: number;
  /** A WebSocket implementation (defaults to the `ws` package in Node, the global elsewhere). */
  WebSocket?: unknown;
}

const END = Symbol("end");
const KNOWN_EVENTS = new Set(["task_started", "sentence_done", "task_done", "task_cancelled"]);
type Item = RealtimeEvent | RealtimeError | typeof END;

/**
 * One turn of speech. Create it with {@link RealtimeSession.context}. `send` text (the first
 * call opens the context), `finish` when the turn's text is complete, and iterate it for its
 * events. Iteration ends after `task_done` or `task_cancelled`, and throws
 * {@link RealtimeError} if the context fails.
 *
 * Events are buffered without limit so that one slow context never stalls the others on the
 * same socket. Iterate every context you start, or `cancel()` the ones you abandon. Iterate a
 * context from one place only: events are consumed as they are read.
 */
export class RealtimeContext implements AsyncIterable<RealtimeEvent> {
  readonly id: string;
  cancelled = false;
  sampleRate: number | null = null;
  audioFormat: string | null = null;
  /** @internal */ started = false;
  /** @internal The socket this context runs on. */ socket: unknown = null;
  /** @internal */ ended = false;
  private finished = false;
  private readonly items: Item[] = [];
  private waiter: (() => void) | null = null;
  private sending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly session: RealtimeSession,
    /** @internal */ readonly options: Record<string, unknown>,
    id: string,
  ) {
    this.id = id;
  }

  /** Send text. Text is billed per character as it is sent. Pass `{ finalize: true }` with the
   * turn's last text (or call {@link finish}). */
  send(text: string, options: { finalize?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (this.cancelled) {
        throw new RealtimeError("context_cancelled", "This context was cancelled.", {
          contextId: this.id,
        });
      }
      if (this.finished) {
        throw new RealtimeError("context_finished", "This context was already finalized.", {
          contextId: this.id,
        });
      }
      const finalize = options.finalize ?? false;
      if (!this.started) {
        this.started = true;
        try {
          await this.session._start(this, text, finalize);
        } catch (err) {
          this.started = false; // nothing was sent; the context can be retried
          throw err;
        }
      } else {
        this.session._send({ type: "task_continue", context_id: this.id, text, finalize });
      }
      if (finalize) this.finished = true;
    });
  }

  /** No more text for this turn: speak what is buffered, then end the context. */
  finish(): Promise<void> {
    return this.serial(async () => {
      if (!this.started) {
        throw new RealtimeError("context_not_started", "Send text before finishing.", {
          contextId: this.id,
        });
      }
      if (!this.finished) {
        this.session._send({ type: "task_continue", context_id: this.id, finalize: true });
        this.finished = true;
      }
    });
  }

  /** Stop this context now. Audio still in flight for it is dropped; iterating it ends with
   * `task_cancelled`. */
  async cancel(): Promise<void> {
    if (this.ended || this.cancelled) return;
    this.cancelled = true; // from now on, audio for this context is dropped
    this.finished = true; // and no more text is accepted
    // Runs after any send already queued, so a start that is in flight is cancelled too.
    await this.serial(async () => {
      if (!this.started) {
        this._end(); // nothing reached the server: just end the context
        return;
      }
      try {
        this.session._send({ type: "task_cancel", context_id: this.id });
      } catch {
        /* the socket is gone, which ends the context anyway */
      }
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    for (;;) {
      while (this.items.length === 0) {
        await new Promise<void>((resolve) => (this.waiter = resolve));
      }
      const item = this.items.shift()!;
      if (item === END) return;
      if (item instanceof RealtimeError) throw item;
      yield item;
    }
  }

  /** Iterate only the PCM of this context. */
  async *audio(): AsyncGenerator<Uint8Array> {
    for await (const event of this) if (event.type === "audio") yield event.pcm;
  }

  /** @internal */
  _put(event: RealtimeEvent): void {
    if (event.type === "task_started") {
      this.sampleRate = typeof event.sample_rate === "number" ? event.sample_rate : null;
      this.audioFormat = typeof event.audio_format === "string" ? event.audio_format : null;
    }
    this.push(event);
    if (event.type === "task_done" || event.type === "task_cancelled") this._end();
  }

  /** @internal */
  _fail(error: RealtimeError): void {
    if (this.ended) return;
    this.push(error);
    this._end();
  }

  /** @internal */
  _end(): void {
    if (this.ended) return;
    this.ended = true;
    this.push(END);
    this.session._forget(this);
  }

  private push(item: Item): void {
    this.items.push(item);
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sending.then(fn, fn);
    this.sending = run.catch(() => undefined);
    return run;
  }
}

interface Socket {
  readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}
type SocketCtor = new (url: string, protocols?: unknown, options?: unknown) => Socket;

const OPEN = 1;

interface Dialer {
  /** Open a socket; `headers` is null when the key must go in the URL instead. */
  open(url: string, headers: Record<string, string> | null, timeoutMs: number): Socket;
  headers: boolean;
}

function versions(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { versions?: Record<string, string | undefined> } }).process
      ?.versions ?? {}
  );
}

function globalDialer(headers: boolean): Dialer {
  const G = (globalThis as { WebSocket?: unknown }).WebSocket as SocketCtor | undefined;
  if (!G) throw new FinesseError("No WebSocket implementation available.");
  return {
    headers,
    // Bun's WebSocket takes headers as a second-argument option.
    open: (url, h) => (h ? new G(url, { headers: h }) : new G(url)),
  };
}

async function defaultDialer(): Promise<Dialer> {
  if (isBrowser()) return globalDialer(false); // browsers cannot set handshake headers
  const v = versions();
  if (v.bun) return globalDialer(true);
  if ((globalThis as { Deno?: unknown }).Deno || !v.node) return globalDialer(false);
  let mod: { default?: unknown; WebSocket?: unknown };
  try {
    mod = (await import("ws")) as typeof mod;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new FinesseError("Realtime in Node needs the `ws` package: npm install ws");
    }
    throw err;
  }
  const WS = (mod.default ?? mod.WebSocket) as SocketCtor;
  return {
    headers: true,
    open: (url, h, timeoutMs) =>
      new WS(url, undefined, { headers: h, handshakeTimeout: timeoutMs }),
  };
}

/**
 * A realtime session. Get one with `await client.realtime.connect()` and `close()` it when done.
 * After a retryable drop the next context reconnects automatically (unless
 * `autoReconnect: false`); contexts running at the time fail with {@link RealtimeError}.
 */
export class RealtimeSession {
  private ws: Socket | null = null;
  private opening: Promise<void> | null = null;
  private readonly contexts = new Map<string, RealtimeContext>();
  private pendingAudio: Record<string, unknown> | null = null;
  private fatal: RealtimeError | null = null;
  private error: RealtimeError | null = null;
  private openedOnce = false;
  private closed = false;
  private closedWaiters: (() => void)[] = [];

  constructor(
    private readonly core: Core,
    private readonly options: ConnectOptions = {},
  ) {}

  get url(): string {
    return `${this.core.wsBaseURL}${API_PREFIX}/stream`;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === OPEN;
  }

  /**
   * Open the socket (no-op when open). Throws `AuthenticationError`, `PaymentRequiredError` or
   * `PermissionDeniedError` when the handshake is refused, `RateLimitError` with
   * `code === "too_many_sessions"` when the workspace already has its maximum of sessions,
   * and `APIConnectionError` / `APITimeoutError` when the service can't be reached.
   */
  open(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.closed)
      return Promise.reject(new RealtimeError("session_closed", "This session was closed."));
    if (this.openedOnce && this.options.autoReconnect === false) {
      return Promise.reject(
        this.error ?? new RealtimeError("connection_closed", "The session is closed."),
      );
    }
    this.opening ??= this.dial().finally(() => (this.opening = null));
    return this.opening;
  }

  /** Create a context. Nothing is sent until its first `send`. */
  context(options: ContextOptions): RealtimeContext {
    const { context_id, ...rest } = options;
    const opts: Record<string, unknown> = { output_format: "s16le" };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) opts[k] = v;
    return new RealtimeContext(this, opts, context_id ?? randomId());
  }

  /** Speak `text` as one complete turn and yield its events. Breaking out of the loop cancels
   * the turn. */
  async *say(options: ContextOptions & { text: string }): AsyncGenerator<RealtimeEvent> {
    const { text, ...rest } = options;
    const ctx = this.context(rest);
    await ctx.send(text, { finalize: true });
    try {
      yield* ctx;
    } finally {
      if (!ctx.ended) await ctx.cancel();
    }
  }

  /** End the session: tell the service, then close the socket. */
  async close(): Promise<void> {
    this.closed = true;
    await this.opening?.catch(() => undefined); // an in-flight open tears itself down
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) {
      try {
        ws.send(JSON.stringify({ type: "session_end" }));
      } catch {
        /* already closing */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        this.closedWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.ws && this.ws.readyState <= OPEN) this.ws.close(1000);
  }

  // -- internals --

  /** @internal */
  async _start(ctx: RealtimeContext, text: string, finalize: boolean): Promise<void> {
    await this.open();
    const live = this.contexts.get(ctx.id);
    if (live && live !== ctx) {
      throw new RealtimeError("context_already_exists", "A running context already uses this id.", {
        contextId: ctx.id,
      });
    }
    // Register before sending so no reply can arrive for an unknown context.
    this.contexts.set(ctx.id, ctx);
    ctx.socket = this.ws;
    try {
      this._send({ type: "task_start", context_id: ctx.id, ...ctx.options, text, finalize });
    } catch (err) {
      this.contexts.delete(ctx.id);
      throw err;
    }
  }

  /** @internal */
  _send(msg: Record<string, unknown>): void {
    if (!this.ws || !this.isOpen) {
      throw this.error ?? new RealtimeError("connection_closed", "The session is not open.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** @internal */
  _forget(ctx: RealtimeContext): void {
    if (this.contexts.get(ctx.id) === ctx) this.contexts.delete(ctx.id);
  }

  private async dial(): Promise<void> {
    const timeout = this.options.openTimeout ?? DEFAULT_OPEN_TIMEOUT_MS;
    const custom = this.options.WebSocket as SocketCtor | undefined;
    const dialer: Dialer = custom
      ? {
          headers: !isBrowser(),
          open: (url, h, t) =>
            h ? new custom(url, undefined, { headers: h, handshakeTimeout: t }) : new custom(url),
        }
      : await defaultDialer();
    let url = this.url;
    let headers: Record<string, string> | null = null;
    if (dialer.headers) {
      headers = { ...this.core.headers };
      delete headers.Accept;
    } else {
      // No handshake headers here (browsers, Deno): the service also accepts the key and
      // the client name as query parameters.
      const u = new URL(url);
      u.searchParams.set("api_key", this.core.apiKey);
      u.searchParams.set("client", this.core.headers["X-Finesse-Client"] ?? "");
      url = u.toString();
    }
    const ws = dialer.open(url, headers, timeout);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          ws.onopen = ws.onclose = null;
          // Closing a socket that is still connecting emits one more error; swallow it.
          ws.onerror = () => undefined;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => done(new APITimeoutError()), timeout);
      ws.on?.("unexpected-response", (_req: unknown, res: unknown) => {
        readResponse(res).then(
          ({ status, text, headers }) => done(makeStatusError(status, text, headers)),
          () => done(new APIConnectionError("The service refused the connection.")),
        );
      });
      ws.onopen = () => done();
      let lastError = "";
      ws.onerror = (ev) => {
        const e = ev as { message?: string; error?: { message?: string } };
        lastError = e?.error?.message || e?.message || "";
        setTimeout(() => done(new APIConnectionError(lastError || "Connection error.")), 0);
      };
      ws.onclose = (ev) =>
        done(new APIConnectionError(lastError || `Connection closed (${ev.code}).`));
    });

    if (this.closed) {
      ws.close(1000);
      throw new RealtimeError("session_closed", "This session was closed.");
    }
    this.ws = ws;
    this.pendingAudio = null;
    this.fatal = null;
    this.error = null;
    this.openedOnce = true;
    ws.onerror = () => undefined; // onclose follows and carries the reason
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return; // a replaced socket
      try {
        if (typeof ev.data === "string") this.onMessage(ev.data);
        else this.onAudio(toBytes(ev.data));
      } catch {
        /* a frame we cannot parse must not end the session */
      }
    };
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
  }

  private onClose(ws: Socket, code: number, reason: string): void {
    if (this.ws !== null && this.ws !== ws) {
      // A replaced socket closed late: end only the contexts that ran on it.
      const err = closeError(code, reason ?? "") ?? new RealtimeError("connection_closed");
      for (const ctx of [...this.contexts.values()]) if (ctx.socket === ws) ctx._fail(err);
      return;
    }
    this.ws = null;
    let error = this.fatal;
    if (error) error.closeCode ??= code;
    else error = closeError(code, reason ?? "");
    if (!error && this.contexts.size) {
      error = new RealtimeError("connection_closed", "The session ended.", { closeCode: code });
    }
    this.error = error;
    for (const ctx of [...this.contexts.values()]) {
      ctx._fail(error ?? new RealtimeError("connection_closed"));
    }
    for (const w of this.closedWaiters.splice(0)) w();
  }

  private onAudio(frame: Uint8Array): void {
    const header = this.pendingAudio;
    this.pendingAudio = null;
    if (!header) return;
    const ctx = this.contexts.get(String(header.context_id));
    if (!ctx || ctx.cancelled) return;
    ctx._put({
      type: "audio",
      context_id: ctx.id,
      pcm: frame,
      sample_rate: ctx.sampleRate,
      audio_format: ctx.audioFormat,
      ...numbers(header, ["sentence_index", "chunk_index", "audio_duration_s"]),
    });
  }

  private onMessage(frame: string): void {
    let data: unknown;
    try {
      data = JSON.parse(frame);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const d = data as Record<string, unknown>;
    const kind = d.type;
    if (kind === "audio_chunk") {
      this.pendingAudio = d;
      return;
    }
    const cid = typeof d.context_id === "string" ? d.context_id : null;
    const ctx = cid ? this.contexts.get(cid) : undefined;
    if (kind === "error") {
      const err = new RealtimeError(String(d.code || "error"), String(d.message ?? ""), {
        contextId: cid,
      });
      if (d.fatal) this.fatal ??= err;
      else ctx?._fail(err); // a non-fatal error for a finished context is stale: dropped
      return;
    }
    if (kind === "session_ended") {
      this.fatal ??= new RealtimeError("session_ended", String(d.reason || "The session ended."));
      return;
    }
    if (!ctx || typeof kind !== "string") return;
    if (kind === "task_failed") {
      ctx._fail(
        new RealtimeError(String(d.code || "task_failed"), String(d.message ?? ""), {
          contextId: ctx.id,
        }),
      );
      return;
    }
    ctx._put(
      KNOWN_EVENTS.has(kind)
        ? ({ ...d, type: kind, context_id: ctx.id } as RealtimeEvent)
        : { type: "unknown", context_id: ctx.id, event_type: kind, data: d },
    );
  }
}

/** `client.realtime`: open realtime sessions. */
export class Realtime {
  constructor(private readonly core: Core) {}

  /** Open a session. */
  async connect(options: ConnectOptions = {}): Promise<RealtimeSession> {
    const session = new RealtimeSession(this.core, options);
    await session.open();
    return session;
  }

  /** Create a session without opening it; it opens on first use. */
  session(options: ConnectOptions = {}): RealtimeSession {
    return new RealtimeSession(this.core, options);
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    // ws can deliver fragmented messages as Buffer[]
    const parts = data.map(toBytes);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  throw new TypeError("unexpected frame");
}

function numbers(obj: Record<string, unknown>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) if (typeof obj[k] === "number") out[k] = obj[k] as number;
  return out;
}

async function readResponse(
  res: unknown,
): Promise<{ status: number; text: string; headers: Headers }> {
  const r = res as {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    on(event: string, cb: (chunk?: unknown) => void): void;
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    r.on("data", (c) => chunks.push(c as Uint8Array));
    r.on("end", () => resolve());
    r.on("error", (e) => reject(e));
  });
  const text = new TextDecoder().decode(toBytes(chunks));
  return { status: r.statusCode, text, headers };
}
