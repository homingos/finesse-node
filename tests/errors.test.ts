import { describe, expect, it } from "vitest";
import * as ff from "../src/index.js";
import { error, jsonResponse, mock, VOICE } from "./helpers.js";

describe("errors", () => {
  it.each([
    [400, ff.BadRequestError],
    [401, ff.AuthenticationError],
    [402, ff.PaymentRequiredError],
    [403, ff.PermissionDeniedError],
    [404, ff.NotFoundError],
    [422, ff.APIStatusError],
  ])("maps %i", async (status, cls) => {
    const m = mock(error(status, "nope"));
    const e = await m.client.voices.get(VOICE.id).catch((x) => x);
    expect(e).toBeInstanceOf(cls);
    expect(e.status).toBe(status);
    expect(e.code).toBeNull();
    expect(e.message).toBe(`${status}: nope`);
  });

  it("reads entitlement denials", async () => {
    const m = mock(
      jsonResponse(
        402,
        { error: "insufficient_credits", unit: "character", limit: 100, used: 99 },
        { "x-billing-remaining": "1" },
      ),
    );
    const e = await m.client.speech.create({ voice_id: VOICE.id, text: "hi" }).catch((x) => x);
    expect(e).toBeInstanceOf(ff.PaymentRequiredError);
    expect([e.code, e.limit, e.used, e.billingRemaining]).toEqual([
      "insufficient_credits",
      100,
      99,
      1,
    ]);
  });

  it("takes the code from an envelope message", async () => {
    const m = mock(error(402, "insufficient_credits"));
    const e = await m.client.speech.create({ voice_id: VOICE.id, text: "hi" }).catch((x) => x);
    expect(e.code).toBe("insufficient_credits");
    const m2 = mock(error(400, "text too long (max 10000 chars)"));
    const e2 = await m2.client.speech.create({ voice_id: VOICE.id, text: "hi" }).catch((x) => x);
    expect(e2.code).toBeNull();
  });

  it("reads plan limits", async () => {
    const m = mock(
      jsonResponse(403, { error: "plan limit reached", feature: "max_voices", limit: 3 }),
    );
    const e = await m.client.voices.create({ name: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(ff.PermissionDeniedError);
    expect([e.code, e.feature, e.limit]).toEqual(["plan_limit_reached", "max_voices", 3]);
  });

  it("handles non-JSON and empty bodies", async () => {
    const page = "<html>" + "Bad gateway ".repeat(200) + "</html>";
    const m = mock(
      new Response(page, { status: 418 }),
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    const e = await m.client.voices.get(VOICE.id).catch((x) => x);
    expect(e.body).toBe(page);
    expect(e.message.length).toBeLessThan(320);
    const e2 = await m.client.voices.get(VOICE.id).catch((x) => x);
    expect(e2).toBeInstanceOf(ff.AuthenticationError);
    expect(e2.message).toBe("401: Unauthorized");
  });

  it("maps 5xx to InternalServerError", async () => {
    const m = mock(error(500, "boom"));
    const c = m.make({ maxRetries: 0 });
    await expect(c.voices.get(VOICE.id)).rejects.toBeInstanceOf(ff.InternalServerError);
  });
});
