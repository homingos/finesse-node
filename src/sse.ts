import { APITimeoutError } from "./errors.js";

/** A minimal Server-Sent Events parser (only what `speech.stream` needs). */

export interface SSEEvent {
  event: string;
  data: string;
}

/** Parse an SSE body. A read that waits longer than `idleTimeoutMs` throws `APITimeoutError`. */
export async function* iterSSE(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];

  function* feed(line: string): Generator<SSEEvent> {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") {
      if (data.length || event !== null) yield { event: event ?? "message", data: data.join("\n") };
      event = null;
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new APITimeoutError()), idleTimeoutMs);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield* feed(line);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield* feed(buffer);
    yield* feed("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
