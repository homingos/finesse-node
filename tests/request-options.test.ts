import { describe, expect, it } from "vitest";
import * as ff from "../src/index.js";
import { envelope, error, mock, VOICE } from "./helpers.js";

const page = (n: number, voices: object[], has_more: boolean) =>
  envelope({ voices, page: n, page_size: 1, total: 2, has_more });

describe("per-call options", () => {
  it("adds headers for one call only", async () => {
    const m = mock(envelope(VOICE), envelope(VOICE));
    await m.client.voices.get(VOICE.id, {
      headers: { "X-Trace": "abc", "X-Finesse-Client": "app/1" },
    });
    await m.client.voices.get(VOICE.id);
    expect(m.requests[0]!.headers.get("x-trace")).toBe("abc");
    expect(m.requests[0]!.headers.get("x-finesse-client")).toBe("app/1");
    expect(m.requests[1]!.headers.get("x-trace")).toBeNull();
    expect(m.requests[1]!.headers.get("x-finesse-client")).toMatch(/^flam-finesse-node\//);
  });

  it("overrides retries for one call", async () => {
    const m = mock(error(503, "busy"), error(503, "a"), error(503, "b"), envelope(VOICE));
    await expect(m.client.voices.get(VOICE.id, { maxRetries: 0 })).rejects.toBeInstanceOf(
      ff.InternalServerError,
    );
    expect(m.requests).toHaveLength(1);
    await m.client.voices.get(VOICE.id); // the client's default (2) still applies
    expect(m.requests).toHaveLength(4);
  });

  it("overrides the timeout for one call", async () => {
    const m = mock(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    await expect(
      m.client.voices.get(VOICE.id, { timeout: 20, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(ff.APITimeoutError);
    expect(Date.now() - started).toBeLessThan(1000); // not the client's 120 s
  });

  it("uses the call's timeout between stream chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
      },
    });
    const m = mock(new Response(body));
    const stream = m.client.speech.stream({ voice_id: VOICE.id, text: "hi" }, { timeout: 20 });
    await expect(stream.readAll()).rejects.toBeInstanceOf(ff.APITimeoutError);
  });

  it("reaches every request method", async () => {
    const result = { voice: VOICE, job_id: "j".repeat(24) };
    const job = { id: "j", org_id: "o", status: "running", job_type: "instant_clone" };
    const done = `data: ${JSON.stringify({ type: "done" })}\n\n`;
    const m = mock(
      page(1, [VOICE], false),
      envelope(VOICE, 201),
      envelope(VOICE),
      envelope({ deleted: true }),
      envelope(result, 202),
      envelope(result, 202),
      envelope(job),
      new Response(new Uint8Array([1])),
      new Response(done),
    );
    const o = { headers: { "X-Trace": "t" } };
    for await (const _ of m.client.voices.list({}, o)) void _;
    await m.client.voices.create({ name: "n" }, o);
    await m.client.voices.update(VOICE.id, { name: "m" }, o);
    await m.client.voices.delete(VOICE.id, o);
    await m.client.voices.clone({ name: "a", file: new Uint8Array([1]) }, o);
    await m.client.voices.enroll(VOICE.id, { file: new Uint8Array([1]) }, o);
    await m.client.jobs.get("j", o);
    await m.client.speech.create({ voice_id: VOICE.id, text: "hi" }, o);
    await m.client.speech.stream({ voice_id: VOICE.id, text: "hi" }, o).readAll();
    expect(m.requests).toHaveLength(9);
    expect(m.requests.every((r) => r.headers.get("x-trace") === "t")).toBe(true);
  });
});

describe("voices.list()", () => {
  const a = { ...VOICE, id: "a".repeat(24) };
  const b = { ...VOICE, id: "b".repeat(24) };

  it("iterates every voice without awaiting first", async () => {
    const m = mock(page(1, [a], true), page(2, [b], false));
    const ids: string[] = [];
    for await (const v of m.client.voices.list({ page_size: 1 })) ids.push(v.id);
    expect(ids).toEqual([a.id, b.id]);
  });

  it("awaits to the first page and fetches it once", async () => {
    const m = mock(page(1, [a], true), page(2, [b], false));
    const list = m.client.voices.list({ page_size: 1 });
    expect(m.requests).toHaveLength(0); // lazy
    const first = await list;
    expect(first).toBeInstanceOf(ff.VoicePage);
    expect(first.voices.map((v) => v.id)).toEqual([a.id]);
    const ids: string[] = [];
    for await (const v of list) ids.push(v.id);
    expect(ids).toEqual([a.id, b.id]);
    expect(m.requests).toHaveLength(2); // page 1 once, then page 2
  });

  it("supports catch and finally", async () => {
    const m = mock(error(401, "bad key"));
    let finished = false;
    const caught = await m.client.voices
      .list()
      .finally(() => (finished = true))
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ff.AuthenticationError);
    expect(finished).toBe(true);
  });
});
