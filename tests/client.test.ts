import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL } from "../src/core.js";
import { Finesse, FinesseError, VERSION } from "../src/index.js";
import { envelope, mock, PREFIX, VOICE } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());

describe("client", () => {
  it("requires an API key", () => {
    vi.stubEnv("FINESSE_API_KEY", "");
    expect(() => new Finesse()).toThrow(/FINESSE_API_KEY/);
  });

  it("reads env defaults", () => {
    vi.stubEnv("FINESSE_API_KEY", "flv_env");
    vi.stubEnv("FINESSE_BASE_URL", "");
    expect(new Finesse().baseURL).toBe(DEFAULT_BASE_URL);
    vi.stubEnv("FINESSE_BASE_URL", "https://finesse.example.com/");
    expect(new Finesse().baseURL).toBe("https://finesse.example.com");
  });

  it("sends auth and attribution headers to the right URL", async () => {
    const m = mock(envelope(VOICE));
    await m.client.voices.get(VOICE.id);
    const r = m.last();
    expect(r.url.toString()).toBe(`https://api.test${PREFIX}/voices/${VOICE.id}`);
    expect(r.headers.get("x-api-key")).toBe("flv_test");
    expect(r.headers.get("x-finesse-client")).toBe(`flam-finesse-node/${VERSION}`);
  });

  it("lets default headers override attribution", async () => {
    const m = mock(envelope(VOICE));
    const c = m.make({ defaultHeaders: { "X-Finesse-Client": "my-plugin/1.0" } });
    await c.voices.get(VOICE.id);
    expect(m.last().headers.get("x-finesse-client")).toBe("my-plugin/1.0");
  });

  it("escapes ids", async () => {
    const m = mock(envelope(VOICE));
    await m.client.voices.get("a/../b");
    expect(m.last().url.pathname.endsWith("/voices/a%2F..%2Fb")).toBe(true);
    await expect(m.client.voices.get("..")).rejects.toBeInstanceOf(FinesseError);
  });

  it("refuses to run in a browser unless allowed", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    try {
      expect(() => new Finesse({ apiKey: "k" })).toThrow(/browser/);
      expect(() => new Finesse({ apiKey: "k", dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
