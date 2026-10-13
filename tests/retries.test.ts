import { describe, expect, it } from "vitest";
import { retryDelay } from "../src/core.js";
import * as ff from "../src/index.js";
import { envelope, error, mock, netError, VOICE } from "./helpers.js";

const ok = () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });

describe("retries", () => {
  it("retries reads then succeeds", async () => {
    const m = mock(error(503, "busy"), error(429, "slow"), envelope(VOICE));
    expect((await m.client.voices.get(VOICE.id)).name).toBe("Narrator");
    expect(m.requests).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const m = mock(error(502, "a"), error(502, "b"), error(502, "c"));
    const e = await m.client.voices.get(VOICE.id).catch((x) => x);
    expect(e.message).toBe("502: c");
    expect(m.requests).toHaveLength(3);
  });

  it.each([400, 401, 402, 403, 404, 409])("does not retry %i", async (status) => {
    const m = mock(error(status, "no"));
    await expect(m.client.voices.get(VOICE.id)).rejects.toBeInstanceOf(ff.APIStatusError);
    expect(m.requests).toHaveLength(1);
  });

  it("retries network errors on reads", async () => {
    const m = mock(netError("ECONNRESET"), envelope(VOICE));
    await m.client.voices.get(VOICE.id);
    expect(m.requests).toHaveLength(2);
    const m2 = mock(netError("ECONNRESET"));
    await expect(m2.make({ maxRetries: 0 }).voices.get(VOICE.id)).rejects.toBeInstanceOf(
      ff.APIConnectionError,
    );
  });

  it("does not retry POSTs the server may have run", async () => {
    for (const step of [error(500, "boom"), error(504, "gw"), netError("ECONNRESET")]) {
      const m = mock(step);
      await expect(
        m.client.speech.create({ voice_id: VOICE.id, text: "hi" }),
      ).rejects.toBeInstanceOf(ff.FinesseError);
      expect(m.requests).toHaveLength(1);
    }
  });

  it("retries POSTs the server did not run", async () => {
    const m = mock(netError("ECONNREFUSED"), error(429, "slow"), ok());
    await m.client.speech.create({ voice_id: VOICE.id, text: "hi" });
    expect(m.requests).toHaveLength(3);
    const m2 = mock(error(502, "warming"), error(503, "busy"), ok());
    await m2.client.speech.create({ voice_id: VOICE.id, text: "hi" });
    expect(m2.requests).toHaveLength(3);
  });

  it("re-sends the same upload on retry", async () => {
    const m = mock(error(503, "busy"), envelope({ voice: VOICE, job_id: "j".repeat(24) }, 202));
    await m.client.voices.clone({ name: "a", file: new TextEncoder().encode("RIFFdata") });
    for (const r of m.requests) {
      const file = (r.body as FormData).get("file") as Blob;
      expect(await file.text()).toBe("RIFFdata");
    }
  });

  it("times out", async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const m = mock(hang);
    await expect(
      m.make({ timeout: 20, maxRetries: 0 }).voices.get(VOICE.id),
    ).rejects.toBeInstanceOf(ff.APITimeoutError);
  });

  it("does not retry a timed-out POST", async () => {
    const m = mock(() => new Promise<Response>(() => undefined));
    await expect(m.make({ timeout: 10 }).voices.create({ name: "x" })).rejects.toBeInstanceOf(
      ff.APITimeoutError,
    );
    expect(m.requests).toHaveLength(1);
  });

  it("computes backoff and honours Retry-After", () => {
    const r = (v: string) => new Response(null, { status: 429, headers: { "retry-after": v } });
    expect(retryDelay(0, r("3"))).toBe(3000);
    expect(retryDelay(0, r("999"))).toBeLessThanOrEqual(500);
    expect(retryDelay(10, null)).toBeLessThanOrEqual(8000);
    expect(retryDelay(10, null)).toBeGreaterThanOrEqual(6000);
  });
});

describe("caller abort", () => {
  it("does not send when the signal is already aborted", async () => {
    const m = mock(envelope(VOICE));
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(m.client._core.request("GET", "/voices", { signal: ac.signal })).rejects.toThrow(
      "stop",
    );
    expect(m.requests).toHaveLength(0);
  });

  it("stops retrying when aborted during backoff", async () => {
    const { _setSleep } = await import("../src/core.js");
    _setSleep((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))));
    const m = mock(
      new Response(null, { status: 503, headers: { "retry-after": "1" } }),
      envelope(VOICE),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("user cancelled")), 20);
    const started = Date.now();
    await expect(m.client._core.request("GET", "/voices", { signal: ac.signal })).rejects.toThrow(
      "user cancelled",
    );
    expect(Date.now() - started).toBeLessThan(150);
    expect(m.requests).toHaveLength(1);
  });

  it("rethrows the abort reason when aborted while reading the body", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        setTimeout(() => ac.abort(new Error("user cancelled")), 10);
      },
    });
    const m = mock(new Response(body));
    await expect(
      m.client.speech.create({ voice_id: VOICE.id, text: "hi" }, { signal: ac.signal }),
    ).rejects.toThrow("user cancelled");
  });

  it("retries a failed body read on reads but not on POSTs", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(c) {
            // Even an error that looks like "never connected" must not retry a POST once the
            // response headers arrived: the server already ran it.
            c.error(Object.assign(new TypeError("terminated"), { code: "ECONNREFUSED" }));
          },
        }),
      );
    const m = mock(broken(), envelope(VOICE));
    await m.client.voices.get(VOICE.id);
    expect(m.requests).toHaveLength(2);
    const m2 = mock(broken(), envelope(VOICE));
    await expect(
      m2.client.speech.create({ voice_id: VOICE.id, text: "hi" }),
    ).rejects.toBeInstanceOf(ff.APIConnectionError);
    expect(m2.requests).toHaveLength(1);
  });

  it("cancels a clone wait", async () => {
    const running = () =>
      envelope({
        id: "j",
        org_id: "o",
        job_type: "instant_clone",
        status: "running",
        progress: 0,
        attempts: 0,
      });
    const { _setSleep } = await import("../src/core.js");
    _setSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    const m = mock(running(), running(), running());
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("give up")), 20);
    const started = Date.now();
    await expect(
      m.client.jobs.wait("j", { pollInterval: 1000, signal: ac.signal }),
    ).rejects.toThrow("give up");
    expect(Date.now() - started).toBeLessThan(500);
    expect(m.requests).toHaveLength(1);
  });
});
