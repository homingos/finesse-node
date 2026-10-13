# Changelog

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
