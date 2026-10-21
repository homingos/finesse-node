# Changelog

## 0.1.2 (unreleased)

- `output_format: "mulaw"` (raw G.711 µ-law) for telephony, with `sample_rate: 8000`, on
  `speech` and realtime contexts. 8 kHz is now produced as asked; the README shows Twilio Media
  Streams.

## 0.1.1 (unreleased)

- Published on npm as `@flamai/finesse` (was private, installed from GitHub).
- Token clients (`accessToken`) retry only `429` and connections that never opened. The
  service spends the token before running the request, so retrying a later `5xx` or dropped
  connection only got `401 token_invalid` and hid the real error.
- A `402` from the credit check inside synthesis has `code === "insufficient_credits"` again,
  not the generic `payment_required`. `code` documents every code the API returns.
- Realtime: text that would make a frame larger than 1 MiB is split across `task_continue`
  frames (never inside a character), instead of the service closing the socket with `1009`.
- Realtime: Deno 2.5+ sends the API key as a header. Where the key still goes in the
  deprecated `?api_key=` parameter (browsers, older Deno), the SDK logs a warning once.
- Types: `Voice` drops `metadata` and `deleted_at`, `CloneJob` drops `result` (the API no longer
  returns them); `Voice` gains `created_via_key_prefix`.
- Docs: `num_step` is 1-32, `sample_rate` 8000-48000, clone clips at least 10 s, `ref_text` at
  most 4000 characters, and media URLs may be short-lived signed URLs.

## 0.1.0 (unreleased)

- Voices, cloning with job waiting, one-shot and streamed speech.
- Realtime WebSocket sessions: concurrent contexts, streamed text, cancel, reconnect.
- One error hierarchy over the API's error shapes; billing-safe retries with backoff.
- Per-call `{ signal, timeout, maxRetries, headers }` on every request method.
- `for await (const voice of client.voices.list())` without awaiting the first page.
- Creating, cloning, enrolling and synthesis send an `Idempotency-Key` and retry like reads;
  a retry while the first attempt runs waits for it.
- `client.withRawResponse`, `client.withOptions()`, `logLevel` / `FINESSE_LOG` logging, and
  `requestId` on errors.
- `voices.clone`, `voices.enroll` and `voices.cloneAndWait` require `consent: true`: the
  caller attests they are the speaker or hold their permission. The API rejects clones without
  it.
- Short-lived tokens: `client.tokens.create()` mints a single-use `fin_tok_` token.
  `new Finesse({ accessToken })` uses one, and runs in a browser without
  `dangerouslyAllowBrowser`; `realtime.connect({ accessToken, getAccessToken })` sends it as a
  WebSocket subprotocol and fetches a fresh one for every reconnect.
- Errors: `ConflictError` (409), `PayloadTooLargeError` (413) and `UnprocessableEntityError`
  (422); `retryAfter` on every HTTP error; `code` documents the API's codes
  (`insufficient_scope`, `key_expired`, `token_invalid`, `rate_limited`, `concurrency_limited`,
  `upstream_busy`, ...).
- Realtime: close reasons `upstream_busy`, `upstream_unavailable` and `upstream_error` surface
  as retryable `RealtimeError` codes.
