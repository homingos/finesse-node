/**
 * Contract tests against a real Finesse API. Skipped unless FINESSE_LIVE=1.
 *
 *   FINESSE_LIVE=1 FINESSE_API_KEY=flv_... \
 *   FINESSE_BASE_URL=https://fi.development.flamapis.com pnpm vitest run tests/live
 *
 * They synthesize a few short sentences (billed per character) and open realtime sessions.
 * They refuse to run against production unless FINESSE_LIVE_ALLOW_PROD=1.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL } from "../../src/core.js";
import * as ff from "../../src/index.js";

const base = (process.env.FINESSE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const enabled =
  process.env.FINESSE_LIVE === "1" &&
  (base !== DEFAULT_BASE_URL || process.env.FINESSE_LIVE_ALLOW_PROD === "1");

describe.runIf(enabled)("live", { timeout: 180_000 }, () => {
  const client = enabled ? new ff.Finesse() : (undefined as unknown as ff.Finesse);
  let voice: ff.Voice;

  beforeAll(async () => {
    for await (const v of client.voices.list({ page_size: 100 })) {
      if (ff.isReady(v)) {
        voice = v;
        return;
      }
    }
    throw new Error("no ready voice visible to this key");
  });

  it("lists and gets voices", async () => {
    const page = await client.voices.list({ page_size: 1 });
    expect(page.page).toBe(1);
    expect((await client.voices.get(voice.id)).id).toBe(voice.id);
    await expect(client.voices.get("000000000000000000000000")).rejects.toBeInstanceOf(
      ff.NotFoundError,
    );
  });

  it("rejects a bad key", async () => {
    await expect(new ff.Finesse({ apiKey: "flv_invalid" }).voices.list()).rejects.toBeInstanceOf(
      ff.AuthenticationError,
    );
  });

  it("synthesizes", async () => {
    const audio = await client.speech.create({ voice_id: voice.id, text: "Live check." });
    expect(new TextDecoder().decode(audio.data.slice(0, 4))).toBe("RIFF");
    expect(audio.sampleRate).toBe(24000);
    const pcm = await client.speech.create({
      voice_id: voice.id,
      text: "Raw audio.",
      output_format: "s16le",
      sample_rate: 8000,
    });
    expect(pcm.sampleRate).toBe(24000);
  });

  it("streams", async () => {
    const stream = client.speech.stream({ voice_id: voice.id, text: "Streaming check." });
    expect((await stream.readAll()).length).toBeGreaterThan(0);
    expect(stream.done?.audio_duration_s).toBeGreaterThan(0);
  });

  it("speaks in realtime and cancels", async () => {
    const rt = await client.realtime.connect();
    try {
      const events = [];
      for await (const e of rt.say({ voice_id: voice.id, text: "Realtime check." })) events.push(e);
      expect(events[0]!.type).toBe("task_started");
      expect(events.at(-1)!.type).toBe("task_done");
      const ctx = rt.context({ voice_id: voice.id });
      await ctx.send("This is a long sentence that we will interrupt part of the way through.");
      let last = "";
      for await (const e of ctx) {
        last = e.type;
        if (e.type === "audio") await ctx.cancel();
      }
      expect(["task_cancelled", "task_done"]).toContain(last);
    } finally {
      await rt.close();
    }
  });

  // Each session holds one of the plan's concurrency slots (2 on free); the service also caps a
  // workspace at 4 sessions per pod. Whichever comes first refuses the next handshake.
  it("caps concurrent sessions", async () => {
    const sessions: ff.RealtimeSession[] = [];
    try {
      let e: unknown = null;
      for (let i = 0; i < 5 && !e; i++) {
        try {
          sessions.push(await client.realtime.connect());
        } catch (err) {
          e = err;
        }
      }
      expect(e).toBeInstanceOf(ff.RateLimitError);
      expect(["concurrency_limited", "too_many_sessions"]).toContain((e as ff.RateLimitError).code);
      expect(sessions.length).toBeGreaterThan(0);
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  });

  it("refuses to clone without consent, locally", async () => {
    const bad = { consent: false } as unknown as { consent: true };
    await expect(
      client.voices.clone({ ...bad, name: "never sent", file: new Uint8Array(1) }),
    ).rejects.toThrow(/consent: true/);
  });

  it("speaks once with a token, then refuses it", async () => {
    const { token } = await client.tokens.create({ ttl_seconds: 60, voice_ids: [voice.id] });
    const tc = new ff.Finesse({ accessToken: token });
    const audio = await tc.speech.create({ voice_id: voice.id, text: "Token check." });
    expect(audio.data.byteLength).toBeGreaterThan(44);
    const e = await tc.speech.create({ voice_id: voice.id, text: "Again." }).catch((x) => x);
    expect(e).toBeInstanceOf(ff.AuthenticationError);
    expect(e.code).toBe("token_invalid");
  });

  it("runs a realtime session on tokens", async () => {
    const fresh = async () => (await client.tokens.create({ voice_ids: [voice.id] })).token;
    const live = new ff.Finesse({ accessToken: await fresh() });
    const rt = await live.realtime.connect({ getAccessToken: fresh });
    try {
      const events = [];
      for await (const e of rt.say({ voice_id: voice.id, text: "Token realtime." })) events.push(e);
      expect(events.at(-1)?.type).toBe("task_done");
    } finally {
      await rt.close();
    }
  });
});
