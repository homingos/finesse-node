# Changelog

## 0.1.0 (unreleased)

- Voices, cloning with job waiting, one-shot and streamed speech.
- Realtime WebSocket sessions: concurrent contexts, streamed text, cancel, reconnect.
- One error hierarchy over the API's error shapes; billing-safe retries with backoff.
- Per-call `{ signal, timeout, maxRetries, headers }` on every request method.
- `for await (const voice of client.voices.list())` without awaiting the first page.
- `client.withRawResponse`, `client.withOptions()` and `logLevel` / `FINESSE_LOG` logging.
