import { describe, expect, it, vi } from "vitest";
import * as ff from "../src/index.js";
import { envelope, mock, VOICE } from "./helpers.js";

const JOB_ID = "6660aa00bb11cc22dd33ee44";
const TOKEN = { token: "fin_tok_3f9c2a00112233", expires_at: 1760000060000, ttl_seconds: 60 };

describe("consent", () => {
  it.each([false, undefined, "yes", 1])(
    "refuses to clone or enroll without consent: true (%o), before any request",
    async (consent) => {
      const m = mock();
      const bad = { consent } as unknown as { consent: true };
      await expect(
        m.client.voices.clone({ ...bad, name: "a", file: new Uint8Array(1) }),
      ).rejects.toThrow(/consent: true/);
      await expect(
        m.client.voices.enroll(VOICE.id, { ...bad, file: new Uint8Array(1) }),
      ).rejects.toThrow(/consent: true/);
      expect(m.requests).toHaveLength(0);
    },
  );

  it("sends consent=true on clone and enroll", async () => {
    const ok = () => envelope({ voice: VOICE, job_id: JOB_ID }, 202);
    const m = mock(ok(), ok());
    await m.client.voices.clone({ consent: true, name: "a", file: new Uint8Array(1) });
    expect((m.requests[0]!.body as FormData).get("consent")).toBe("true");
    await m.client.voices.enroll(VOICE.id, { consent: true, file: new Uint8Array(1) });
    expect((m.requests[1]!.body as FormData).get("consent")).toBe("true");
  });
});

describe("tokens", () => {
  it("creates a token", async () => {
    const m = mock(envelope(TOKEN, 201));
    const tok = await m.client.tokens.create({ ttl_seconds: 60, voice_ids: [VOICE.id] });
    expect(m.last().method).toBe("POST");
    expect(m.last().url.pathname).toBe("/flam-voice-svc/api/v1/public/tokens");
    expect(m.json()).toEqual({ ttl_seconds: 60, voice_ids: [VOICE.id] });
    expect(tok).toEqual(TOKEN);
  });

  it("sends an empty body by default", async () => {
    const m = mock(envelope(TOKEN, 201));
    await m.client.tokens.create();
    expect(m.json()).toEqual({});
  });

  it("has a raw form", async () => {
    const m = mock(envelope(TOKEN, 201));
    const raw = await m.client.withRawResponse.tokens.create();
    expect([raw.status, raw.data.token]).toEqual([201, TOKEN.token]);
  });

  it("an access-token client sends Bearer, not the key", async () => {
    const m = mock(new Response("RIFF", { headers: { "content-type": "audio/wav" } }));
    const client = m.make({ apiKey: undefined, accessToken: "fin_tok_abc" });
    await client.speech.create({ voice_id: VOICE.id, text: "hi" });
    expect(m.last().headers.get("authorization")).toBe("Bearer fin_tok_abc");
    expect(m.last().headers.get("x-api-key")).toBeNull();
  });

  it("rejects a key and a token together", () => {
    expect(() => new ff.Finesse({ apiKey: "flv_x", accessToken: "fin_tok_y" })).toThrow(/not both/);
  });

  it("allows a token in a browser without dangerouslyAllowBrowser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    try {
      expect(() => new ff.Finesse({ accessToken: "fin_tok_y" })).not.toThrow();
      expect(() => new ff.Finesse({ apiKey: "flv_x" })).toThrow(/accessToken/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("new error codes", () => {
  it.each([
    [401, "key_expired", ff.AuthenticationError],
    [401, "token_invalid", ff.AuthenticationError],
    [403, "insufficient_scope", ff.PermissionDeniedError],
    [403, "voice_not_allowed", ff.PermissionDeniedError],
    [409, "conflict", ff.ConflictError],
    [413, "payload_too_large", ff.PayloadTooLargeError],
    [422, "invalid_input", ff.UnprocessableEntityError],
    [429, "concurrency_limited", ff.RateLimitError],
    [503, "upstream_busy", ff.InternalServerError],
  ])("%i %s", async (status, code, Cls) => {
    const body = { status, error: true, message: "m", code, request_id: "req_b" };
    const m = mock(new Response(JSON.stringify(body), { status, headers: { "Retry-After": "2" } }));
    const e = await m.client.voices.get(VOICE.id, { maxRetries: 0 }).catch((x) => x);
    expect(e).toBeInstanceOf(Cls);
    expect([e.code, e.retryAfter, e.requestId]).toEqual([code, 2, "req_b"]);
  });
});
