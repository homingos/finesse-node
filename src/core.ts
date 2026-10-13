import { APIConnectionError, APITimeoutError, FinesseError, makeStatusError } from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://fi.production.flamapis.com";
export const API_PREFIX = "/flam-voice-svc/api/v1/public";
/** Synthesis on a cold GPU can take tens of seconds before the first byte. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
export const CLIENT_NAME = `flam-finesse-node/${VERSION}`;

// GET/PATCH/DELETE are safe to repeat: retry timeouts, 429 (the engine's rate limit) and 5xx.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
// POSTs create voices and bill synthesis. Only retry when the server certainly did no work:
// 429, 502 (engine unavailable or warming up; failed synthesis is refunded) and 503, or when
// the connection never opened. A timeout after the request was sent is not retried.
const POST_RETRY_STATUSES = new Set([429, 502, 503]);
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const MAX_BACKOFF_MS = 8_000;

export type Fetch = typeof globalThis.fetch;

export interface ClientOptions {
  /** Workspace API key (`flv_...`). Defaults to `FINESSE_API_KEY`. */
  apiKey?: string;
  /** API host. Defaults to `FINESSE_BASE_URL`, then production. */
  baseURL?: string;
  /** Per-request timeout in ms. Default 120 000. */
  timeout?: number;
  /** Retries for transient failures. Default 2. Reads, updates and deletes retry on network
   * errors, timeouts, 408, 429 and 5xx. Creates, uploads and synthesis retry only when the
   * server did no work: the connection never opened, 429, 502 or 503. */
  maxRetries?: number;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /** A custom `fetch` (proxies, tests). */
  fetch?: Fetch;
  /** Allow running in a browser. Your API key would be visible to anyone using the page, so
   * only do this for internal tools. */
  dangerouslyAllowBrowser?: boolean;
  /** Log requests and retries: `"debug"`, `"info"` or `"off"`. Defaults to `FINESSE_LOG`, then
   * `"off"`. The API key, bodies and audio are never logged. */
  logLevel?: LogLevel;
  /** Where log lines go. Defaults to `console`. */
  logger?: Logger;
}

export type LogLevel = "debug" | "info" | "off";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
}

/** Per-call overrides that every request method accepts as its last argument. */
export interface RequestOptions {
  /** Abort the request, its retries and any waiting. Rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Timeout in ms for this call (for streams, the longest wait between chunks). */
  timeout?: number;
  /** Retries for this call. */
  maxRetries?: number;
  /** Extra headers for this call; they override the client's. */
  headers?: Record<string, string>;
}

interface CallOptions extends RequestOptions {
  /** Send one Idempotency-Key for every attempt, so the call can be retried like a read. */
  idempotent?: boolean;
  query?: Record<string, string | number>;
  json?: unknown;
  form?: () => FormData;
  stream?: boolean;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export function isBrowser(): boolean {
  return (
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

export class Core {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly headers: Record<string, string>;
  readonly fetch: Fetch;
  readonly logLevel: LogLevel;
  readonly logger: Logger;
  /** @internal Called with each successful response (used by `withRawResponse`). */
  onResponse: ((response: Response) => void) | null = null;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("FINESSE_API_KEY");
    if (!apiKey) {
      throw new FinesseError(
        "No API key. Pass { apiKey } or set the FINESSE_API_KEY environment variable.",
      );
    }
    if (isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new FinesseError(
        "Running in a browser would expose your API key. Call Finesse from your server, or " +
          "pass { dangerouslyAllowBrowser: true } for internal tools.",
      );
    }
    this.apiKey = apiKey;
    this.baseURL = (options.baseURL || env("FINESSE_BASE_URL") || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.headers = {
      "X-API-Key": apiKey,
      "X-Finesse-Client": CLIENT_NAME,
      Accept: "application/json",
      ...(isBrowser() ? {} : { "User-Agent": CLIENT_NAME }),
      ...options.defaultHeaders,
    };
    const f = options.fetch ?? globalThis.fetch;
    if (!f)
      throw new FinesseError("No fetch available. Pass { fetch } (Node 18+ has one built in).");
    this.fetch = f.bind(globalThis);
    const level = (options.logLevel ?? env("FINESSE_LOG")?.toLowerCase() ?? "off") as LogLevel;
    this.logLevel = level === "debug" || level === "info" ? level : "off";
    this.logger = options.logger ?? console;
  }

  /** @internal A view of this core with other defaults, sharing everything else. */
  withOptions(overrides: {
    timeout?: number;
    maxRetries?: number;
    headers?: Record<string, string>;
  }): Core {
    const view = Object.create(Object.getPrototypeOf(this)) as Core;
    Object.assign(view, this, {
      timeout: overrides.timeout ?? this.timeout,
      maxRetries: overrides.maxRetries ?? this.maxRetries,
      headers: { ...this.headers, ...overrides.headers },
    });
    return view;
  }

  private debug(message: string): void {
    if (this.logLevel === "debug") this.logger.debug(`[finesse] ${message}`);
  }

  private info(message: string): void {
    if (this.logLevel !== "off") this.logger.info(`[finesse] ${message}`);
  }

  url(path: string, query?: Record<string, string | number>): string {
    const url = new URL(`${this.baseURL}${API_PREFIX}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    return url.toString();
  }

  get wsBaseURL(): string {
    return this.baseURL.replace(/^http(s?):\/\//, "ws$1://");
  }

  /** Send a request, retrying transient failures, and throw on an error status. With
   * `stream: true` the caller owns the response body. A caller `signal` stops the request and
   * any further retries, and rejects with the signal's reason. */
  async request(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
    const { signal } = opts;
    const timeout = opts.timeout ?? this.timeout;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    // An idempotent call carries one key for all of its attempts (the caller's, if they set
    // one), so the server runs it at most once and every failure is safe to retry.
    const baseHeaders: Record<string, string> = { ...this.headers, ...opts.headers };
    let retryAs = method;
    if (opts.idempotent && method === "POST") {
      retryAs = "GET";
      if (!Object.keys(baseHeaders).some((k) => k.toLowerCase() === "idempotency-key")) {
        baseHeaders["Idempotency-Key"] = randomUUID();
      }
    }
    let inProgressUntil: number | null = null;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const headers: Record<string, string> = { ...baseHeaders };
      let body: BodyInit | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        body = opts.form(); // rebuilt per attempt; fetch sets the multipart boundary
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new TimeoutSignal()), timeout);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      // Returns when the failed attempt should be retried; throws otherwise.
      const retryAfterError = async (err: unknown, sent: boolean): Promise<void> => {
        throwIfAborted(signal);
        const timedOut = controller.signal.reason instanceof TimeoutSignal;
        const retry = retryAs !== "POST" || (!sent && !timedOut && isUnsent(err));
        if (attempt < maxRetries && retry) {
          await sleep(retryDelay(attempt, null), signal);
          return;
        }
        if (timedOut) throw new APITimeoutError({ cause: err });
        throw new APIConnectionError(errorMessage(err), { cause: err });
      };

      const url = this.url(path, opts.query);
      const where = `${method} ${url.split("?")[0]}`;
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        release();
        await retryAfterError(err, false);
        this.info(`retrying ${where} (attempt ${attempt + 1} failed: ${errorMessage(err)})`);
        continue;
      }
      this.debug(
        `${where} -> ${response.status} in ${Date.now() - started} ms` +
          (attempt ? `, attempt ${attempt + 1}` : "") +
          ` (request id ${response.headers.get("x-request-id") ?? "-"})`,
      );

      if (response.ok && opts.stream) {
        // From here the stream reader applies the timeout between chunks instead, so a long
        // stream is not cut off. The caller's signal still aborts it until it is released.
        clearTimeout(timer);
        streamCleanups.set(response, () => signal?.removeEventListener("abort", onAbort));
        this.onResponse?.(response);
        return response;
      }
      // Read the whole body while the timeout still applies.
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (err) {
        release();
        await retryAfterError(err, true);
        this.info(`retrying ${where} (attempt ${attempt + 1} failed: ${errorMessage(err)})`);
        continue;
      }
      release();
      if (response.ok) {
        const empty = response.status === 204 || response.status === 205 || response.status === 304;
        const buffered = new Response(empty ? null : buffer, {
          status: response.status,
          headers: response.headers,
        });
        this.onResponse?.(buffered);
        return buffered;
      }
      const text = new TextDecoder().decode(buffer);

      if (opts.idempotent && response.status === 409 && isInProgress(text)) {
        // The first attempt is still running on the server: wait for it, for as long as a
        // single request may take, without spending a retry.
        inProgressUntil ??= Date.now() + timeout;
        if (Date.now() < inProgressUntil) {
          const delay = retryDelay(0, response);
          this.info(`waiting for ${where}: the first attempt is still running`);
          await sleep(delay, signal);
          attempt--;
          continue;
        }
      }
      const statuses = retryAs === "POST" ? POST_RETRY_STATUSES : RETRY_STATUSES;
      if (attempt < maxRetries && statuses.has(response.status)) {
        const delay = retryDelay(attempt, response);
        this.info(
          `retrying ${where} in ${Math.round(delay)} ms (attempt ${attempt + 1} failed: HTTP ${response.status})`,
        );
        await sleep(delay, signal);
        continue;
      }
      throw makeStatusError(response.status, text, response.headers, response.statusText);
    }
  }

  /** Request and decode a JSON success body, stripping the `{status, error, data}` envelope. */
  async json<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
    const response = await this.request(method, path, opts);
    return unwrap(await response.json()) as T;
  }
}

/** Called by stream readers once they finish with a streamed response. */
export const streamCleanups = new WeakMap<Response, () => void>();

export function releaseStream(response: Response): void {
  streamCleanups.get(response)?.();
  streamCleanups.delete(response);
}

class TimeoutSignal extends Error {}

function isInProgress(text: string): boolean {
  try {
    return (JSON.parse(text) as { code?: unknown })?.code === "idempotency_in_progress";
  } catch {
    return false;
  }
}

function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function unwrap(body: unknown): unknown {
  if (
    body &&
    typeof body === "object" &&
    "data" in body &&
    (body as { error?: unknown }).error === false
  ) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function isUnsent(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && UNSENT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function errorMessage(err: unknown): string {
  const cause = (err as { cause?: { message?: string } })?.cause?.message;
  return cause || (err instanceof Error ? err.message : "") || "Connection error.";
}

export function retryDelay(attempt: number, response: Response | null): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    let ms = Number(retryAfter) * 1000;
    if (Number.isNaN(ms)) ms = Date.parse(retryAfter) - Date.now();
    if (ms >= 0 && ms <= 60_000) return ms;
  }
  const base = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  return base * (1 - 0.25 * Math.random());
}

let wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleep `ms`, rejecting with the signal's reason if it aborts first. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return wait(ms);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Test seam: replace the backoff wait. */
export function _setSleep(fn: (ms: number) => Promise<void>): void {
  wait = fn;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted.", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Escape an id for use as one URL path segment, so it cannot change the route. */
export function pathId(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new FinesseError(`Invalid id: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}
