# @flam/finesse

TypeScript SDK for the Finesse voice API: clone voices, synthesize speech, and stream speech in
realtime over a WebSocket. Works in Node 18+, Bun and Deno. Realtime in Node needs the `ws`
package; Bun and Deno use their built-in WebSocket.

> Private preview. Install from GitHub until the package is published.

```bash
npm install github:homingos/finesse-node ws
# or
pnpm add github:homingos/finesse-node ws
```

## Quickstart

```ts
import { Finesse, isReady } from "@flam/finesse";
import { writeFile } from "node:fs/promises";

const client = new Finesse(); // reads FINESSE_API_KEY

let voiceId = "";
for await (const v of client.voices.list()) {
  if (isReady(v)) {
    voiceId = v.id;
    break;
  }
}
const audio = await client.speech.create({ voice_id: voiceId, text: "Hello from Finesse!" });
await writeFile("hello.wav", audio.data);
```

| Option       | Environment variable | Default                              |
| ------------ | -------------------- | ------------------------------------ |
| `apiKey`     | `FINESSE_API_KEY`    | required                             |
| `baseURL`    | `FINESSE_BASE_URL`   | `https://fi.production.flamapis.com` |
| `timeout`    |                      | 120 000 ms                           |
| `maxRetries` |                      | 2                                    |
| `fetch`      |                      | global `fetch`                       |

Use `https://fi.development.flamapis.com` as `baseURL` for the development environment.
Request and response fields use the API's own names (`voice_id`, `output_format`, ...).

Every request method takes per-call overrides as its last argument:

```ts
await client.speech.create(
  { voice_id, text: "Hello!" },
  { timeout: 30_000, maxRetries: 0, headers: { "X-Request-Id": "abc" }, signal },
);
```

`signal` (an `AbortSignal`) stops the request, its retries and any waiting. On `jobs.wait`,
`voices.waitUntilReady` and `cloneAndWait`, `timeout` is the overall wait.

## Voices

```ts
for await (const voice of client.voices.list()) {
  console.log(voice.id, voice.name, voice.status, voice.labels); // walks every page
}
const voice = await client.voices.get("665f1a2b3c4d5e6f7a8b9c0d");
await client.voices.update(voice.id, { name: "Narrator (UK)", labels: { accent: "british" } });
await client.voices.delete(voice.id);
```

## Cloning

```ts
import { fileFromPath } from "@flam/finesse";

const voice = await client.voices.cloneAndWait(
  { name: "Ana", file: await fileFromPath("reference.wav"), language: "en" },
  { onUpdate: (job) => console.log(job.status) },
);
```

`file` can also be a `Blob`/`File`, bytes, or `{ data, filename, contentType }`. `clone()`
returns immediately with the voice (`processing`) and a `job_id`; `waitUntilReady()` blocks
later. The first clone after the cloner has been idle can take a couple of minutes.

## Speech

```ts
const audio = await client.speech.create({ voice_id, text: "Hello!" });
audio.data; // Uint8Array (WAV)
audio.sampleRate; // 24000
audio.generationId; // id in your generation history

const stream = client.speech.stream({ voice_id, text: "Hello, streamed." });
for await (const chunk of stream) play(chunk.pcm); // raw s16le, 24 kHz
console.log(stream.done?.audio_duration_s);
```

## Realtime

One session is one WebSocket that can run several turns (_contexts_) at once.

```ts
const rt = await client.realtime.connect();

for await (const event of rt.say({ voice_id, text: "Hi! How can I help?" })) {
  if (event.type === "audio") play(event.pcm); // s16le, 24 kHz mono
}

// Stream text as your LLM produces it, and cancel when the user interrupts:
const ctx = rt.context({ voice_id });
for await (const token of llmTokens()) await ctx.send(token);
await ctx.finish();
for await (const pcm of ctx.audio()) {
  if (userStartedTalking()) await ctx.cancel(); // audio still in flight is dropped
  play(pcm);
}

await rt.close();
```

If the connection drops, running contexts throw `RealtimeError` (check `.retryable`), and the
next context reconnects automatically. A workspace can hold up to 4 sessions at once; a fifth
throws `RateLimitError` with `code === "too_many_sessions"`, so run several contexts on one
session instead. Events are buffered per context so a slow one never stalls the others: iterate
every context you start, or `cancel()` it.

Node (with `ws`) and Bun send the API key as a header. Browsers and Deno cannot set headers on a
WebSocket handshake, so there the key goes in the URL. The client refuses to run in a browser
unless you pass `dangerouslyAllowBrowser: true`; call Finesse from your server instead.

## Errors

```ts
import { APIStatusError, PaymentRequiredError } from "@flam/finesse";

try {
  await client.speech.create({ voice_id, text: "Hi" });
} catch (e) {
  if (e instanceof PaymentRequiredError) console.log(e.code, e.billingRemaining);
  else if (e instanceof APIStatusError) console.log(e.status, e.message);
  else throw e;
}
```

| Error                                    | When                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `BadRequestError`                        | 400: invalid input, text over 10,000 characters, voice not enrolled |
| `AuthenticationError`                    | 401: missing, unknown or revoked API key                            |
| `PaymentRequiredError`                   | 402: `insufficient_credits` or `quota_exhausted`                    |
| `PermissionDeniedError`                  | 403: `feature_disabled`, or `plan_limit_reached` (see `.feature`)   |
| `NotFoundError`                          | 404                                                                 |
| `RateLimitError`                         | 429                                                                 |
| `InternalServerError`                    | 5xx                                                                 |
| `APIConnectionError` / `APITimeoutError` | no response                                                         |
| `StreamError`                            | a speech stream failed after it started                             |
| `RealtimeError`                          | a realtime context or session failed                                |
| `CloneFailedError` / `CloneTimeoutError` | waiting for a clone                                                 |

Transient failures are retried twice with backoff. Reads, updates and deletes retry on network
errors, timeouts, 408, 429 and 5xx. Creates, uploads and synthesis are billed or create things,
so they retry only when the server certainly did no work: the connection never opened, 429, 502
or 503. A synthesis that fails is refunded.

## Development

```bash
pnpm install
pnpm test          # unit tests (no network)
pnpm typecheck && pnpm lint && pnpm build

# Contract tests against the development API (billed per character):
FINESSE_LIVE=1 FINESSE_API_KEY=flv_... \
FINESSE_BASE_URL=https://fi.development.flamapis.com pnpm vitest run tests/live
```
