import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ff from "../src/index.js";
import { envelope, mock, VOICE } from "./helpers.js";

const JOB_ID = "6660aa00bb11cc22dd33ee44";

const page = (n: number, voices: object[], has_more: boolean, total = 3) =>
  envelope({ voices, page: n, page_size: 2, total, has_more });

const job = (status: string, extra: object = {}) =>
  envelope({
    id: JOB_ID,
    org_id: VOICE.org_id,
    voice_id: VOICE.id,
    job_type: "instant_clone",
    status,
    progress: status === "succeeded" ? 100 : 0,
    attempts: 0,
    created_at: 1760000000000,
    ...extra,
  });

describe("voices", () => {
  it("converts labels and keeps unknown fields", async () => {
    const m = mock(envelope({ ...VOICE, brand_new: 1 }));
    const v = await m.client.voices.get(VOICE.id);
    expect(v.labels).toEqual({ gender: "female" });
    expect(v.brand_new).toBe(1);
    expect(ff.isReady(v)).toBe(true);
  });

  it("walks every page lazily", async () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => ({ ...VOICE, id: x.repeat(24) }));
    const m = mock(page(1, [a!, b!], true), page(2, [c!], false));
    const first = await m.client.voices.list({ page_size: 2 });
    expect([first.total, first.has_more, first.voices.length]).toEqual([3, true, 2]);
    expect(m.requests).toHaveLength(1);
    const ids: string[] = [];
    for await (const v of first) ids.push(v.id);
    expect(ids).toEqual(["a", "b", "c"].map((x) => x.repeat(24)));
    expect(m.requests.map((r) => Object.fromEntries(r.url.searchParams))).toEqual([
      { page: "1", page_size: "2" },
      { page: "2", page_size: "2" },
    ]);
  });

  it("stops on an empty page", async () => {
    const m = mock(page(1, [], true));
    const all = [];
    for await (const v of await m.client.voices.list()) all.push(v);
    expect(all).toEqual([]);
    expect(m.requests).toHaveLength(1);
  });

  it("creates, updates and deletes", async () => {
    const m = mock(envelope(VOICE, 201), envelope(VOICE), envelope({ deleted: true }));
    await m.client.voices.create({ name: "N", language: "en", labels: { gender: "female" } });
    expect(m.json(0)).toEqual({ name: "N", language: "en", labels: { gender: "female" } });
    await m.client.voices.update(VOICE.id, { description: "", labels: {} });
    expect(m.requests[1]!.method).toBe("PATCH");
    expect(m.json(1)).toEqual({ description: "", labels: {} });
    await expect(m.client.voices.delete(VOICE.id)).resolves.toBeUndefined();
    expect(m.last().method).toBe("DELETE");
  });

  it("clones with a multipart form", async () => {
    const m = mock(envelope({ voice: { ...VOICE, status: "processing" }, job_id: JOB_ID }, 202));
    const res = await m.client.voices.clone({
      consent: true,
      name: "Ana",
      file: { data: new TextEncoder().encode("RIFFbytes"), filename: "ref.wav" },
      labels: { accent: "british" },
      ref_text: "hello",
      remove_background_noise: true,
    });
    expect(res.job_id).toBe(JOB_ID);
    expect(res.voice.labels).toEqual({ gender: "female" });
    const fd = m.last().body as FormData;
    expect([fd.get("name"), fd.get("ref_text"), fd.get("remove_background_noise")]).toEqual([
      "Ana",
      "hello",
      "true",
    ]);
    expect(JSON.parse(String(fd.get("labels")))).toEqual({ accent: "british" });
    const file = fd.get("file") as File;
    expect([file.name, file.type, await file.text()]).toEqual([
      "ref.wav",
      "audio/wav",
      "RIFFbytes",
    ]);
    expect(fd.has("description")).toBe(false);
  });

  it("reads files from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finesse-"));
    const path = join(dir, "me.mp3");
    await writeFile(path, "ID3x");
    const m = mock(envelope({ voice: VOICE, job_id: JOB_ID }, 202));
    await m.client.voices.clone({ consent: true, name: "a", file: await ff.fileFromPath(path) });
    const file = (m.last().body as FormData).get("file") as File;
    expect([file.name, file.type, await file.text()]).toEqual(["me.mp3", "audio/mpeg", "ID3x"]);
  });

  it("enrolls", async () => {
    const m = mock(envelope({ voice: VOICE, job_id: JOB_ID }, 202));
    await m.client.voices.enroll(VOICE.id, {
      consent: true,
      file: new Blob(["x"]),
      language: "hi",
    });
    expect(m.last().url.pathname.endsWith(`/voices/${VOICE.id}/enroll`)).toBe(true);
    expect((m.last().body as FormData).get("language")).toBe("hi");
  });

  it("clones and waits", async () => {
    const seen: string[] = [];
    const m = mock(
      envelope({ voice: { ...VOICE, status: "processing" }, job_id: JOB_ID }, 202),
      job("running"),
      job("succeeded"),
      envelope(VOICE),
    );
    const v = await m.client.voices.cloneAndWait(
      { consent: true, name: "Ana", file: new Uint8Array([1]) },
      { pollInterval: 0, onUpdate: (j) => seen.push(j.status) },
    );
    expect(v.status).toBe("ready");
    expect(seen).toEqual(["running", "succeeded"]);
  });

  it("fails and times out waits", async () => {
    const m = mock(job("failed", { error: { message: "clip too short", status_code: 400 } }));
    const e = await m.client.jobs.wait(JOB_ID, { pollInterval: 0 }).catch((x) => x);
    expect(e).toBeInstanceOf(ff.CloneFailedError);
    expect(e.message).toMatch(/clip too short/);
    const m2 = mock(job("running"));
    await expect(
      m2.client.jobs.wait(JOB_ID, { timeout: 0, pollInterval: 0 }),
    ).rejects.toBeInstanceOf(ff.CloneTimeoutError);
  });
});

describe("files", () => {
  it("gives an untyped Blob the type guessed from its filename", async () => {
    const m = mock(envelope({ voice: VOICE, job_id: JOB_ID }, 202));
    await m.client.voices.clone({
      consent: true,
      name: "a",
      file: { data: new Blob(["x"]), filename: "a.mp3" },
    });
    expect(((m.last().body as FormData).get("file") as Blob).type).toBe("audio/mpeg");
  });
});
