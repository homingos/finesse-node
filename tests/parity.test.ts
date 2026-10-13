import { afterEach, describe, expect, it, vi } from "vitest";
import * as ff from "../src/index.js";
import { envelope, error, mock, VOICE } from "./helpers.js";

const withId = (res: Response, id: string): Response => {
  res.headers.set("x-request-id", id);
  return res;
};

describe("withOptions", () => {
  it("copies the client with other defaults", async () => {
    const m = mock(error(503, "busy"), envelope(VOICE), envelope(VOICE));
    const quick = m.client.withOptions({ maxRetries: 0, defaultHeaders: { "X-Team": "voice" } });
    await expect(quick.voices.get(VOICE.id)).rejects.toBeInstanceOf(ff.InternalServerError);
    await quick.voices.get(VOICE.id);
    await m.client.voices.get(VOICE.id);
    expect(m.requests).toHaveLength(3); // the copy did not retry
    expect(m.requests[1]!.headers.get("x-team")).toBe("voice");
    expect(m.requests[2]!.headers.get("x-team")).toBeNull(); // original unchanged
    expect(quick.baseURL).toBe(m.client.baseURL);
  });

  it("applies the timeout", async () => {
    const m = mock(() => new Promise<Response>(() => undefined));
    const quick = m.client.withOptions({ timeout: 20, maxRetries: 0 });
    await expect(quick.voices.get(VOICE.id)).rejects.toBeInstanceOf(ff.APITimeoutError);
  });
});

describe("withRawResponse", () => {
  it("returns the response with the data", async () => {
    const m = mock(withId(envelope(VOICE), "req_123"));
    const raw = await m.client.withRawResponse.voices.get(VOICE.id);
    expect([raw.status, raw.requestId, raw.headers.get("content-type")]).toEqual([
      200,
      "req_123",
      "application/json",
    ]);
    const voice: ff.Voice = raw.data; // typed
    expect(voice.labels).toEqual({ gender: "female" });
  });

  it("works for speech and passes options through", async () => {
    const m = mock(
      new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "x-sample-rate": "24000" } }),
    );
    const raw = await m.client.withRawResponse.speech.create(
      { voice_id: VOICE.id, text: "hi" },
      { headers: { "X-Trace": "t" } },
    );
    expect(raw.headers.get("x-sample-rate")).toBe("24000");
    expect(raw.data.data).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(m.last().headers.get("x-trace")).toBe("t");
  });

  it("reports the first request of a multi-request call", async () => {
    const job = { id: "j", org_id: "o", status: "succeeded", job_type: "instant_clone" };
    const m = mock(
      withId(envelope({ voice: VOICE, job_id: "j" }, 202), "clone"),
      withId(envelope(job), "poll"),
      withId(envelope(VOICE), "get"),
    );
    const raw = await m.client.withRawResponse.voices.cloneAndWait(
      { name: "a", file: new Uint8Array([1]) },
      { pollInterval: 0 },
    );
    expect([raw.status, raw.requestId, raw.data.status]).toEqual([202, "clone", "ready"]);
  });

  it("returns the first page for list", async () => {
    const m = mock(envelope({ voices: [VOICE], page: 1, page_size: 1, total: 1, has_more: false }));
    const raw = await m.client.withRawResponse.voices.list();
    expect(raw.data).toBeInstanceOf(ff.VoicePage);
    expect(raw.status).toBe(200);
  });

  it("keeps concurrent calls apart", async () => {
    const respond = async (r: { url: URL }) => {
      const id = r.url.pathname.slice(-24);
      if (id.startsWith("a")) await new Promise((x) => setTimeout(x, 10));
      return withId(envelope({ ...VOICE, id }), id.slice(0, 4));
    };
    const m = mock(respond, respond);
    const [a, b] = await Promise.all([
      m.client.withRawResponse.voices.get("a".repeat(24)),
      m.client.withRawResponse.voices.get("b".repeat(24)),
    ]);
    expect([a.requestId, a.data.id]).toEqual(["aaaa", "a".repeat(24)]);
    expect([b.requestId, b.data.id]).toEqual(["bbbb", "b".repeat(24)]);
  });

  it("still throws API errors, and has no stream", async () => {
    const m = mock(error(404, "Voice not found"));
    await expect(m.client.withRawResponse.voices.get(VOICE.id)).rejects.toBeInstanceOf(
      ff.NotFoundError,
    );
    // @ts-expect-error stream is not part of the raw client
    expect(() => m.client.withRawResponse.speech.stream).toThrow(/stream/);
  });
});

describe("logging", () => {
  afterEach(() => vi.unstubAllEnvs());

  const capture = () => {
    const lines: string[] = [];
    return {
      lines,
      logger: {
        debug: (m: string) => lines.push(`D ${m}`),
        info: (m: string) => lines.push(`I ${m}`),
      },
    };
  };

  it("logs requests and retries without secrets", async () => {
    const { lines, logger } = capture();
    const m = mock(error(503, "busy"), withId(envelope(VOICE), "req_9"));
    const c = m.make({ logLevel: "debug", logger });
    await c.voices.get(VOICE.id);
    const text = lines.join("\n");
    expect(text).toContain("GET https://api.test/flam-voice-svc/api/v1/public/voices/");
    expect(text).toMatch(/-> 503/);
    expect(text).toMatch(/-> 200 .*req_9/);
    expect(text).toMatch(/^I \[finesse\] retrying GET .*HTTP 503/m);
    expect(text).not.toContain("flv_test");
  });

  it("is off by default, info hides per-request lines, and FINESSE_LOG turns it on", async () => {
    const off = capture();
    await mock(envelope(VOICE)).make({ logger: off.logger }).voices.get(VOICE.id);
    expect(off.lines).toEqual([]);
    const info = capture();
    await mock(error(503, "x"), envelope(VOICE))
      .make({ logLevel: "info", logger: info.logger })
      .voices.get(VOICE.id);
    expect(info.lines).toHaveLength(1);
    expect(info.lines[0]).toMatch(/^I .*retrying/);
    vi.stubEnv("FINESSE_LOG", "DEBUG");
    const env = capture();
    await mock(envelope(VOICE)).make({ logger: env.logger }).voices.get(VOICE.id);
    expect(env.lines[0]).toMatch(/^D .*-> 200/);
  });
});
