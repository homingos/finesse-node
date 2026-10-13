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
