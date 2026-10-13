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
