/**
 * Errors thrown by the SDK. Every error extends {@link FinesseError}; HTTP errors extend
 * {@link APIStatusError} and are split by status so you can catch exactly what you handle:
 *
 * ```ts
 * try {
 *   await client.speech.create({ voice_id, text: "Hi" });
 * } catch (e) {
 *   if (e instanceof PaymentRequiredError) console.log("Out of credits", e.billingRemaining);
 * }
 * ```
 */

export class FinesseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never got a response: DNS, TLS, connection reset, and so on. */
export class APIConnectionError extends FinesseError {}

/** The request timed out. */
export class APITimeoutError extends APIConnectionError {
  constructor(options?: { cause?: unknown }) {
    super("Request timed out.", options);
  }
}

/**
 * The API answered with a 4xx or 5xx status. The API's three error body shapes are normalised:
 *
 * - `{"status": 404, "error": true, "message": "Voice not found", "code": "not_found"}`
 * - `{"error": "insufficient_credits", "unit": "character", "limit": 100, "used": 100}`
 * - `{"error": "plan limit reached", "feature": "max_voices", "limit": 3}`
 */
export class APIStatusError extends FinesseError {
  /** HTTP status. */
  readonly status: number;
  /** Machine-readable code. Branch on this, never on the message. Envelope codes:
   * `invalid_request`, `unauthorized`, `key_expired`, `token_invalid`, `insufficient_scope`,
   * `voice_not_allowed`, `not_found`, `payload_too_large`, `invalid_input`, `rate_limited`,
   * `concurrency_limited`, `upstream_error`, `upstream_busy`, ...; plan denials:
   * `insufficient_credits`, `quota_exhausted`, `feature_disabled`, `plan_limit_reached`;
   * realtime: `too_many_sessions`. `null` when absent. */
  readonly code: string | null;
  /** The decoded JSON body, or the raw text when it is not JSON. */
  readonly body: unknown;
  readonly headers: Headers;
  /** `X-Billing-Remaining` as a number, when sent. */
  readonly billingRemaining: number | null;
  /** The service's `X-Request-Id` for the failed request; quote it to support. */
  readonly requestId: string | null;

  constructor(
    status: number,
    message: string,
    body: unknown,
    code: string | null,
    headers: Headers,
  ) {
    super(code && code !== message ? `${status}: ${message} (${code})` : `${status}: ${message}`);
    this.status = status;
    this.code = code;
    this.body = body;
    this.headers = headers;
    this.billingRemaining = intOrNull(headers.get("x-billing-remaining"));
    const fromBody = (body as { request_id?: unknown } | null)?.request_id;
    this.requestId =
      headers.get("x-request-id") ?? (typeof fromBody === "string" ? fromBody : null);
  }

  /** Seconds the server asked you to wait (`Retry-After`), when it sent one. */
  get retryAfter(): number | null {
    const v = this.headers.get("retry-after");
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Plan limit from an entitlement or plan-limit denial, when present. */
  get limit(): number | null {
    return numberField(this.body, "limit");
  }

  /** Amount already used, from an entitlement denial, when present. */
  get used(): number | null {
    return numberField(this.body, "used");
  }
}

/** 400: invalid request (missing field, text too long, voice not enrolled, ...). */
export class BadRequestError extends APIStatusError {}
/** 401: the API key is missing, unknown or revoked; `key_expired`; or a short-lived token is
 * invalid, expired or already used (`token_invalid`). */
export class AuthenticationError extends APIStatusError {}
/** 402: out of credits (`insufficient_credits`) or quota (`quota_exhausted`). */
export class PaymentRequiredError extends APIStatusError {}
/** 403: the key lacks the route's scope (`insufficient_scope`), a token is limited to other
 * voices (`voice_not_allowed`), the plan lacks the feature (`feature_disabled`), or a cap is
 * reached (`plan_limit_reached`). */
export class PermissionDeniedError extends APIStatusError {
  /** The capped feature for `plan_limit_reached`, e.g. `max_voices`. */
  get feature(): string | null {
    const b = this.body as Record<string, unknown> | null;
    return b && typeof b === "object" && typeof b.feature === "string" ? b.feature : null;
  }
}
/** 404: no such resource, or not visible to this workspace. */
export class NotFoundError extends APIStatusError {}
/** 409: e.g. a request with the same `Idempotency-Key` is still running. */
export class ConflictError extends APIStatusError {}
/** 413: the request body is over 21 MiB (`payload_too_large`). */
export class PayloadTooLargeError extends APIStatusError {}
/** 422: the synthesis service could not use the input (`invalid_input`), or an
 * `Idempotency-Key` was reused for a different request (`idempotency_key_reused`). */
export class UnprocessableEntityError extends APIStatusError {}
/** 429: over the plan's requests per second (`rate_limited`) or concurrent synthesis
 * (`concurrency_limited`), or (realtime) `too_many_sessions`. Wait `retryAfter` seconds. */
export class RateLimitError extends APIStatusError {}
/** 5xx: a server error, or the synthesis service failing (`upstream_error`, 502) or at
 * capacity (`upstream_busy`, 503, with `retryAfter`). Usually safe to retry. */
export class InternalServerError extends APIStatusError {}

/** A speech stream failed after it started. */
export class StreamError extends FinesseError {
  readonly code: string;
  constructor(code: string, message = "") {
    super(message ? `${message} (${code})` : code);
    this.code = code;
  }
}

/** A clone job ended without producing a ready voice. */
export class CloneFailedError extends FinesseError {
  readonly job: { id: string; status: string; error?: Record<string, unknown> | null };
  constructor(job: { id: string; status: string; error?: Record<string, unknown> | null }) {
    const reason = typeof job.error?.message === "string" ? `: ${job.error.message}` : "";
    super(`Clone job ${job.id} ${job.status}${reason}`);
    this.job = job;
  }
}

/** Waiting for a clone job took longer than the timeout. The job may still finish. */
export class CloneTimeoutError extends FinesseError {
  constructor(
    readonly jobId: string,
    readonly timeoutMs: number,
  ) {
    super(`Clone job ${jobId} did not finish within ${timeoutMs / 1000}s`);
  }
}

const MAX_MESSAGE = 300;

const STATUS_ERRORS: Record<number, typeof APIStatusError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  413: PayloadTooLargeError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

/** Build the right {@link APIStatusError} subclass from an error status and its body text. */
export function makeStatusError(
  status: number,
  text: string,
  headers: Headers,
  statusText = "",
): APIStatusError {
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : text;
  } catch {
    /* not JSON */
  }
  let message: string | null = null;
  let code: string | null = null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string" && b.message) {
      message = b.message;
      // The credit check inside synthesis sends the code as the message.
      if (/^[a-z]+(_[a-z]+)+$/.test(b.message)) code = b.message;
    }
    if (typeof b.code === "string" && b.code) {
      code = b.code;
    } else if (typeof b.error === "string" && b.error) {
      code = b.error === "plan limit reached" ? "plan_limit_reached" : b.error;
      message ??= b.error.replace(/_/g, " ");
    } else if (b.error && typeof b.error === "object") {
      const e = b.error as Record<string, unknown>;
      if (typeof e.message === "string" && e.message) message = e.message;
      if (typeof e.code === "string" && e.code) code = e.code;
    }
  } else if (typeof body === "string" && body.trim()) {
    const flat = body.split(/\s+/).join(" ").trim();
    message = flat.length <= MAX_MESSAGE ? flat : flat.slice(0, MAX_MESSAGE - 3) + "...";
  }
  message ||= statusText || `HTTP ${status}`;
  const Cls = STATUS_ERRORS[status] ?? (status >= 500 ? InternalServerError : APIStatusError);
  return new Cls(status, message, body, code, headers);
}

function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function numberField(body: unknown, key: string): number | null {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}
