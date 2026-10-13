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
    for await (const v of await client.voices.list({ page_size: 100 })) {
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

  // The cap is 4 sessions per workspace per pod; this assumes one pod (true on dev today).
  it("caps concurrent sessions", async () => {
    const sessions = await Promise.all([1, 2, 3, 4].map(() => client.realtime.connect()));
    try {
      const e = await client.realtime.connect().catch((x) => x);
      expect(e).toBeInstanceOf(ff.RateLimitError);
      expect(e.code).toBe("too_many_sessions");
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  });
});
