import { describe, expect, it } from "vitest";
import * as ff from "../src/index.js";
import { error, mock, VOICE } from "./helpers.js";

const VID = VOICE.id;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const START = { type: "start", sample_rate: 24000, audio_format: "s16le" };
const DONE = {
  type: "done",
  audio_duration_s: 1.5,
  generation_id: "g".repeat(24),
  audio_url: "https://x/a.wav",
};
const chunk = (pcm: string, i: number) => ({
  type: "chunk",
  sample_rate: 24000,
  audio_format: "s16le",
  index: i,
  audio_b64: b64(pcm),
});

function sse(events: object[], opts: { crlf?: boolean; split?: number } = {}): Response {
  const nl = opts.crlf ? "\r\n" : "\n";
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  const size = opts.split ?? bytes.length;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-billing-remaining": "500" },
  });
}

const text = (u: Uint8Array) => new TextDecoder().decode(u);

describe("speech", () => {
  it("creates a clip", async () => {
    const m = mock(
      new Response(new TextEncoder().encode("RIFF...."), {
        headers: {
          "content-type": "audio/wav",
          "x-sample-rate": "24000",
          "x-generation-id": "g".repeat(24),
          "x-audio-url": "https://x/a.wav",
          "x-billing-remaining": "900",
        },
      }),
    );
    const audio = await m.client.speech.create({ voice_id: VID, text: "Hello", sample_rate: 8000 });
    expect(m.last().url.pathname.endsWith(`/voices/${VID}/speak`)).toBe(true);
    expect(m.json()).toEqual({ text: "Hello", sample_rate: 8000 });
    expect(text(audio.data)).toBe("RIFF....");
    expect([audio.sampleRate, audio.generationId, audio.billingRemaining, audio.audioURL]).toEqual([
      24000,
      "g".repeat(24),
      900,
      "https://x/a.wav",
    ]);
  });

  it.each([[{}], [{ crlf: true }], [{ split: 7 }]])("streams chunks %o", async (opts) => {
    const m = mock(sse([START, chunk("ab", 0), chunk("cd", 1), DONE], opts));
    const stream = m.client.speech.stream({ voice_id: VID, text: "Hi", num_step: 16 });
    expect(m.requests).toHaveLength(0); // lazy
    const got: string[] = [];
    for await (const c of stream) got.push(text(c.pcm));
    expect(got).toEqual(["ab", "cd"]);
    expect([stream.sampleRate, stream.audioFormat, stream.billingRemaining]).toEqual([
      24000,
      "s16le",
      500,
    ]);
    expect(stream.done?.generation_id).toBe("g".repeat(24));
    expect(m.json()).toEqual({ text: "Hi", num_step: 16 });
  });

  it("reads all and refuses a second pass", async () => {
    const m = mock(sse([START, chunk("ab", 0), chunk("cd", 1), DONE]));
    const stream = m.client.speech.stream({ voice_id: VID, text: "Hi" });
    expect(text(await stream.readAll())).toBe("abcd");
    await expect(stream.readAll()).rejects.toThrow(/already consumed/);
  });

  it("raises error events, incomplete streams and bad chunks", async () => {
    const m = mock(
      sse([START, chunk("ab", 0), { type: "error", code: "rate_limited", message: "busy" }]),
      sse([START, chunk("ab", 0)]),
      sse([START, { type: "chunk", audio_b64: "!!!" }]),
    );
    for (const code of ["rate_limited", "stream_incomplete", "bad_chunk"]) {
      const e = await m.client.speech
        .stream({ voice_id: VID, text: "Hi" })
        .readAll()
        .catch((x) => x);
      expect(e).toBeInstanceOf(ff.StreamError);
      expect(e.code).toBe(code);
    }
  });

  it("throws status errors before the stream starts, and retries 502", async () => {
    const m = mock(error(402, "insufficient_credits"));
    await expect(
      m.client.speech.stream({ voice_id: VID, text: "Hi" }).readAll(),
    ).rejects.toBeInstanceOf(ff.PaymentRequiredError);
    const m2 = mock(error(502, "warming"), sse([START, chunk("ab", 0), DONE]));
    expect(text(await m2.client.speech.stream({ voice_id: VID, text: "Hi" }).readAll())).toBe("ab");
    expect(m2.requests).toHaveLength(2);
  });

  it("wraps a mid-stream network failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(START)}\n\n`));
        c.error(new TypeError("terminated"));
      },
    });
    const m = mock(new Response(body));
    const e = await m.client.speech
      .stream({ voice_id: VID, text: "Hi" })
      .readAll()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ff.APIConnectionError);
  });

  it("times out an idle stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(START)}\n\n`));
      },
    });
    const m = mock(new Response(body));
    const c = m.make({ timeout: 30 });
    await expect(c.speech.stream({ voice_id: VID, text: "Hi" }).readAll()).rejects.toBeInstanceOf(
      ff.APITimeoutError,
    );
  });

  it("does not cut off a long but active stream", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(START)}\n\n`));
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 15));
          c.enqueue(enc.encode(`data: ${JSON.stringify(chunk("x", i))}\n\n`));
        }
        c.enqueue(enc.encode(`data: ${JSON.stringify(DONE)}\n\n`));
        c.close();
      },
    });
    const m = mock(new Response(body));
    const c = m.make({ timeout: 40 }); // total ~90 ms, but never idle for 40 ms
    expect(text(await c.speech.stream({ voice_id: VID, text: "Hi" }).readAll())).toBe("xxxxxx");
  });
});
