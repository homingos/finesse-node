import { createServer, type Server } from "node:net";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import * as ff from "../src/index.js";
import type { RealtimeSession } from "../src/index.js";
import { MAX_FRAME_BYTES, splitText } from "../src/realtime.js";

const VID = "665f1a2b3c4d5e6f7a8b9c0d";
const PATH = "/flam-voice-svc/api/v1/public/stream";
type Msg = Record<string, any>;
type Handler = (ws: WebSocket, msg: Msg, engine: Engine) => Promise<void> | void;

class Engine {
  received: Msg[] = [];
  requests: IncomingMessage[] = [];
  connections = 0;
  cancelled = new Set<string>();
  onMessage: Handler = defaultHandler;

  audio(ws: WebSocket, cid: string, pcm: string, i = 0) {
    ws.send(
      JSON.stringify({
        type: "audio_chunk",
        context_id: cid,
        sentence_index: 0,
        chunk_index: i,
        byte_length: pcm.length,
      }),
    );
    ws.send(Buffer.from(pcm));
  }
}

function defaultHandler(ws: WebSocket, msg: Msg, e: Engine) {
  const cid = msg.context_id;
  if (msg.type === "task_start") {
    ws.send(
      JSON.stringify({
        type: "task_started",
        context_id: cid,
        sample_rate: 24000,
        audio_format: msg.output_format,
      }),
    );
  }
  if (msg.type === "task_start" || msg.type === "task_continue") {
    if (msg.text) e.audio(ws, cid, msg.text);
    if (msg.finalize) {
      ws.send(
        JSON.stringify({
          type: "sentence_done",
          context_id: cid,
          sentence_index: 0,
          text: "x",
          audio_duration_s: 0.5,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "task_done",
          context_id: cid,
          num_sentences: 1,
          total_audio_duration_s: 0.5,
        }),
      );
    }
  } else if (msg.type === "task_cancel") {
    e.cancelled.add(cid);
    e.audio(ws, cid, "late");
    ws.send(
      JSON.stringify({
        type: "task_cancelled",
        context_id: cid,
        sentences_completed: 0,
        sentences_dropped: 1,
      }),
    );
  } else if (msg.type === "session_end") {
    ws.send(JSON.stringify({ type: "session_ended", reason: "client_request" }));
    ws.close(1000);
  }
}

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(
  engine: Engine,
  reject?: { status: number; body: unknown },
  delayHandshakeMs = 0,
): Promise<ff.Finesse> {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (info, cb) => {
      setTimeout(() => {
        if (reject) cb(false, reject.status, "x", { "Content-Type": "application/json" });
        else cb(true);
      }, delayHandshakeMs);
    },
  });
  if (reject) {
    // ws writes the reason as the body; send our JSON instead.
    wss.options.verifyClient = (_info: unknown, cb: (...a: any[]) => void) =>
      cb(false, reject.status, JSON.stringify(reject.body), { "Content-Type": "application/json" });
  }
  wss.on("connection", (ws, req) => {
    engine.connections++;
    engine.requests.push(req);
    ws.on("message", async (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      engine.received.push(msg);
      await engine.onMessage(ws, msg, engine);
    });
  });
  servers.push(wss);
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const { port } = wss.address() as { port: number };
  return new ff.Finesse({ apiKey: "flv_test", baseURL: `http://127.0.0.1:${port}` });
}

async function collect(it: AsyncIterable<{ type: string }>) {
  const out: any[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const text = (u: Uint8Array) => Buffer.from(u).toString();

async function session(client: ff.Finesse, fn: (rt: RealtimeSession) => Promise<void>) {
  const rt = await client.realtime.connect();
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

describe("realtime", () => {
  it("says a turn", async () => {
    const engine = new Engine();
    const client = await start(engine);
    let events: any[] = [];
    await session(client, async (rt) => {
      events = await collect(rt.say({ voice_id: VID, text: "Hello.", length_scale: 1.1 }));
    });
    expect(events.map((e) => e.type)).toEqual([
      "task_started",
      "audio",
      "sentence_done",
      "task_done",
    ]);
    expect([text(events[1].pcm), events[1].sample_rate, events[1].audio_format]).toEqual([
      "Hello.",
      24000,
      "s16le",
    ]);
    const startMsg = engine.received[0]!;
    expect([
      startMsg.type,
      startMsg.voice_id,
      startMsg.text,
      startMsg.finalize,
      startMsg.output_format,
      startMsg.length_scale,
    ]).toEqual(["task_start", VID, "Hello.", true, "s16le", 1.1]);
    expect(engine.received.at(-1)).toEqual({ type: "session_end" });
    const req = engine.requests[0]!;
    expect(req.headers["x-api-key"]).toBe("flv_test");
    expect(String(req.headers["x-finesse-client"])).toMatch(/^flam-finesse-node\//);
    expect(req.url).toBe(PATH);
  });

  it("streams text into a context", async () => {
    const engine = new Engine();
    const client = await start(engine);
    await session(client, async (rt) => {
      const ctx = rt.context({ voice_id: VID, idle_flush_ms: 300 });
      await ctx.send("Hello ");
      await ctx.send("world.");
      await ctx.finish();
      const pcm: string[] = [];
      for await (const p of ctx.audio()) pcm.push(text(p));
      expect(pcm).toEqual(["Hello ", "world."]);
      expect(ctx.sampleRate).toBe(24000);
    });
    expect(engine.received.slice(0, 3).map((m) => [m.type, m.text, m.finalize])).toEqual([
      ["task_start", "Hello ", false],
      ["task_continue", "world.", false],
      ["task_continue", undefined, true],
    ]);
    expect(engine.received[0]!.idle_flush_ms).toBe(300);
  });

  it("splits text over the 1 MiB frame cap across task_continue frames", async () => {
    const engine = new Engine();
    engine.onMessage = () => undefined;
    const client = await start(engine);
    // Multi-byte text with quotes (escaped) and emoji (surrogate pairs) near every boundary.
    const unit = 'a"é€😀';
    const long = unit.repeat(Math.ceil((2.5 * MAX_FRAME_BYTES) / 12));
    await session(client, async (rt) => {
      const ctx = rt.context({ voice_id: VID, context_id: "big" });
      await ctx.send(long, { finalize: true });
      await vi.waitFor(() => expect(engine.received.length).toBeGreaterThanOrEqual(3));
      await ctx.cancel();
    });
    const frames = engine.received.filter((m) => m.context_id === "big" && "text" in m);
    expect(frames.map((m) => m.type)).toEqual([
      "task_start",
      ...Array(frames.length - 1).fill("task_continue"),
    ]);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.map((m) => m.finalize)).toEqual([...Array(frames.length - 1).fill(false), true]);
    expect(frames.map((m) => m.text).join("")).toBe(long);
    for (const m of frames) {
      expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      expect(m.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(frames[0]!.voice_id).toBe(VID);
  });

  it("splits text without breaking code points", () => {
    expect(splitText("ab", 1)).toEqual(["a", "b"]);
    expect(splitText("😀😀", 5)).toEqual(["😀", "😀"]);
    expect(splitText('"\\', 3)).toEqual(['"', "\\"]);
    expect(splitText("\ud800x", 6)).toEqual(["\ud800", "x"]); // a lone surrogate is escaped
    expect(splitText("😀", 1)).toEqual(["😀"]); // at least one code point per piece
    expect(splitText("", 10)).toEqual([""]);
  });

  it("demultiplexes concurrent contexts", async () => {
    const engine = new Engine();
    const client = await start(engine);
    await session(client, async (rt) => {
      const a = rt.context({ voice_id: VID, context_id: "a" });
      const b = rt.context({ voice_id: VID, context_id: "b" });
      await a.send("A1");
      await b.send("B1");
      await a.send("A2", { finalize: true });
      await b.send("B2", { finalize: true });
      const all = async (c: ff.RealtimeContext) => {
        const out: string[] = [];
        for await (const p of c.audio()) out.push(text(p));
        return out;
      };
      expect(await Promise.all([all(a), all(b)])).toEqual([
        ["A1", "A2"],
        ["B1", "B2"],
      ]);
    });
  });

  it("cancels and drops late audio", async () => {
    const engine = new Engine();
    const client = await start(engine);
    await session(client, async (rt) => {
      const ctx = rt.context({ voice_id: VID });
      await ctx.send("first ");
      const events: any[] = [];
      for await (const e of ctx) {
        events.push(e);
        if (e.type === "audio") await ctx.cancel();
      }
      expect(events.map((e) => e.type)).toEqual(["task_started", "audio", "task_cancelled"]);
      expect(events[2].sentences_dropped).toBe(1);
      expect(engine.cancelled.has(ctx.id)).toBe(true);
      await ctx.cancel();
    });
  });

  it("cancels a say() the caller breaks out of", async () => {
    const engine = new Engine();
    engine.onMessage = (ws, msg, e) => {
      if (msg.type === "task_start") e.audio(ws, msg.context_id, "one");
      else return defaultHandler(ws, msg, e);
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      for await (const _ of rt.say({ voice_id: VID, text: "long" })) break;
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(engine.received.slice(0, 2).map((m) => m.type)).toEqual(["task_start", "task_cancel"]);
  });

  it("fails one context on a non-fatal error and keeps the session", async () => {
    const engine = new Engine();
    engine.onMessage = (ws, msg, e) => {
      if (msg.type === "task_start" && msg.context_id === "bad") {
        ws.send(
          JSON.stringify({
            type: "error",
            context_id: "bad",
            code: "voice_not_found",
            message: "Voice not found",
          }),
        );
        return;
      }
      return defaultHandler(ws, msg, e);
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      const bad = rt.context({ voice_id: "nope", context_id: "bad" });
      await bad.send("x", { finalize: true });
      const e = await collect(bad).catch((x) => x);
      expect(e).toBeInstanceOf(ff.RealtimeError);
      expect([e.code, e.contextId, e.retryable]).toEqual(["voice_not_found", "bad", false]);
      expect((await collect(rt.say({ voice_id: VID, text: "ok" }))).at(-1).type).toBe("task_done");
    });
  });

  it("raises task_failed", async () => {
    const engine = new Engine();
    engine.onMessage = (ws, msg, e) => {
      if (msg.type === "task_start")
        ws.send(
          JSON.stringify({
            type: "task_failed",
            context_id: msg.context_id,
            code: "text_too_long",
            message: "too long",
          }),
        );
      else return defaultHandler(ws, msg, e);
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      const e = await collect(rt.say({ voice_id: VID, text: "x" })).catch((x) => x);
      expect(e.code).toBe("text_too_long");
    });
  });

  const closing =
    (error: Msg | null, code: number, reason: string): Handler =>
    (ws, msg) => {
      if (msg.type === "task_start") {
        if (error) ws.send(JSON.stringify({ type: "error", ...error }));
        ws.close(code, reason);
      }
    };

  it.each([
    [
      { code: "insufficient_credits", message: "Out", fatal: true },
      1008,
      "insufficient_credits",
      "insufficient_credits",
      false,
    ],
    [
      { code: "upstream_closed", message: "dropped", fatal: true },
      1011,
      "upstream_closed",
      "upstream_closed",
      true,
    ],
    [
      { code: "upstream_unavailable", message: "unreachable", fatal: true },
      1013,
      "upstream_unavailable",
      "upstream_unavailable",
      true,
    ],
    [null, 1013, "upstream_busy", "upstream_busy", true],
    [null, 1011, "upstream_error", "upstream_error", true],
    [null, 4429, "too many", "service_busy", true],
    [null, 4401, "bad key", "service_auth_failed", false],
    [null, 1011, "", "upstream_closed", true],
    [null, 1012, "", "connection_lost", true],
    [null, 1001, "", "connection_lost", true],
  ])("maps closes (%o, %i)", async (error, close, reason, code, retryable) => {
    const engine = new Engine();
    engine.onMessage = closing(error, close, reason);
    const client = await start(engine);
    const rt = await client.realtime.connect();
    const e = await collect(rt.say({ voice_id: VID, text: "x" })).catch((x) => x);
    expect([e.code, e.closeCode, e.retryable]).toEqual([code, close, retryable]);
    await rt.close();
  });

  it("reconnects after a dropped connection", async () => {
    const engine = new Engine();
    let first = true;
    engine.onMessage = (ws, msg, e) => {
      if (first && msg.type === "task_start") {
        first = false;
        ws.terminate(); // no close frame: the client sees 1006
        return;
      }
      return defaultHandler(ws, msg, e);
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      const e = await collect(rt.say({ voice_id: VID, text: "x" })).catch((x) => x);
      expect([e.code, e.closeCode, e.retryable]).toEqual(["connection_lost", 1006, true]);
      expect((await collect(rt.say({ voice_id: VID, text: "again" }))).at(-1).type).toBe(
        "task_done",
      );
    });
    expect(engine.connections).toBe(2);
  });

  it("sends a token in the subprotocol list, not a header or the URL", async () => {
    const engine = new Engine();
    const keyed = await start(engine);
    const client = new ff.Finesse({ accessToken: "fin_tok_abc", baseURL: keyed.baseURL });
    await session(client, async (rt) => {
      await collect(rt.say({ voice_id: VID, text: "hi" }));
    });
    const req = engine.requests[0]!;
    expect(protocols(req)).toEqual(["finesse.v1", "fin_tok_abc"]);
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(String(req.url)).not.toContain("fin_tok_abc");
  });

  it("offers no subprotocol on a key session", async () => {
    const engine = new Engine();
    const client = await start(engine);
    await session(client, async (rt) => {
      await collect(rt.say({ voice_id: VID, text: "hi" }));
    });
    expect(engine.requests[0]!.headers["sec-websocket-protocol"]).toBeUndefined();
  });

  const protocols = (req: { headers: Record<string, unknown> }) =>
    String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim());

  function dropFirstTask(engine: Engine) {
    let first = true;
    engine.onMessage = (ws, msg, e) => {
      if (first && msg.type === "task_start") {
        first = false;
        ws.terminate();
        return;
      }
      return defaultHandler(ws, msg, e);
    };
  }

  it("refuses to reconnect with a spent token", async () => {
    const engine = new Engine();
    dropFirstTask(engine);
    const keyed = await start(engine);
    const client = new ff.Finesse({ accessToken: "fin_tok_1", baseURL: keyed.baseURL });
    const rt = await client.realtime.connect();
    await collect(rt.say({ voice_id: VID, text: "x" })).catch(() => undefined);
    const e = await collect(rt.say({ voice_id: VID, text: "again" })).catch((x) => x);
    expect(e.code).toBe("token_spent");
    expect(engine.connections).toBe(1);
    await rt.close();
  });

  it("uses the static token first, then getAccessToken for each reconnect", async () => {
    const engine = new Engine();
    dropFirstTask(engine);
    const keyed = await start(engine);
    const client = new ff.Finesse({ accessToken: "fin_tok_first", baseURL: keyed.baseURL });
    let n = 0;
    const rt = await client.realtime.connect({ getAccessToken: async () => `fin_tok_fresh${n++}` });
    await collect(rt.say({ voice_id: VID, text: "x" })).catch(() => undefined);
    expect((await collect(rt.say({ voice_id: VID, text: "again" }))).at(-1).type).toBe("task_done");
    await rt.close();
    expect(engine.requests.map(protocols)).toEqual([
      ["finesse.v1", "fin_tok_first"],
      ["finesse.v1", "fin_tok_fresh0"],
    ]);
  });

  it("does not reconnect when disabled", async () => {
    const engine = new Engine();
    engine.onMessage = closing(null, 1011, "upstream_closed");
    const client = await start(engine);
    const rt = await client.realtime.connect({ autoReconnect: false });
    await collect(rt.say({ voice_id: VID, text: "x" })).catch(() => undefined);
    const e = await rt
      .context({ voice_id: VID })
      .send("y")
      .catch((x) => x);
    expect(e.code).toBe("upstream_closed");
    expect(engine.connections).toBe(1);
    await rt.close();
  });

  it("drops a binary frame without a header and survives odd frames", async () => {
    const engine = new Engine();
    engine.onMessage = (ws, msg, e) => {
      if (msg.type !== "task_start") return defaultHandler(ws, msg, e);
      const cid = msg.context_id;
      ws.send(JSON.stringify({ type: "task_started", context_id: cid, sample_rate: "fast" }));
      ws.send("not json");
      ws.send(JSON.stringify([1, 2]));
      e.audio(ws, cid, "paired");
      ws.send(Buffer.from("stray"));
      ws.send(JSON.stringify({ type: "task_done", context_id: cid, num_sentences: "many" }));
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      const events = await collect(rt.say({ voice_id: VID, text: "x" }));
      expect(events.map((e) => e.type)).toEqual(["task_started", "audio", "task_done"]);
      expect(text(events[1].pcm)).toBe("paired");
    });
  });

  it("ignores stale non-fatal errors", async () => {
    const engine = new Engine();
    engine.onMessage = async (ws, msg, e) => {
      await defaultHandler(ws, msg, e);
      if (msg.type === "task_start") {
        ws.send(
          JSON.stringify({
            type: "error",
            context_id: msg.context_id,
            code: "late",
            message: "x",
            fatal: false,
          }),
        );
        ws.send(JSON.stringify({ type: "error", code: "no_context", message: "?" }));
      }
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      await collect(rt.say({ voice_id: VID, text: "Done." }));
      engine.onMessage = closing(null, 1012, "");
      const e = await collect(rt.say({ voice_id: VID, text: "x" })).catch((x) => x);
      expect([e.code, e.closeCode]).toEqual(["connection_lost", 1012]);
    });
  });

  it("rejects duplicate context ids and keeps send order", async () => {
    const engine = new Engine();
    const client = await start(engine);
    const rt = client.realtime.session(); // opens on first send, while the others queue
    const ctx = rt.context({ voice_id: VID, context_id: "same" });
    await Promise.all([ctx.send("a"), ctx.send("b"), ctx.send("c")]);
    const e = await rt
      .context({ voice_id: VID, context_id: "same" })
      .send("dup")
      .catch((x) => x);
    expect(e.code).toBe("context_already_exists");
    await ctx.finish();
    await collect(ctx);
    await rt.close();
    expect(engine.received.filter((m) => m.context_id === "same").map((m) => m.type)).toEqual([
      "task_start",
      "task_continue",
      "task_continue",
      "task_continue",
    ]);
  });

  it.each([
    [429, { error: "too_many_sessions", limit: 4 }, ff.RateLimitError, "too_many_sessions"],
    [
      401,
      { status: 401, error: true, message: "Invalid or missing API key" },
      ff.AuthenticationError,
      null,
    ],
    [
      402,
      { error: "insufficient_credits", unit: "character", limit: 1, used: 1 },
      ff.PaymentRequiredError,
      "insufficient_credits",
    ],
    [
      403,
      { error: "feature_disabled", unit: "", limit: 0, used: 0 },
      ff.PermissionDeniedError,
      "feature_disabled",
    ],
  ])("maps a refused handshake (%i)", async (status, body, cls, code) => {
    const client = await start(new Engine(), { status, body });
    const e = await client.realtime.connect().catch((x) => x);
    expect(e).toBeInstanceOf(cls);
    expect(e.code).toBe(code);
    if (status === 429) expect(e.limit).toBe(4);
  });

  it("closes cleanly while opening", async () => {
    const client = await start(new Engine(), undefined, 150);
    const rt = client.realtime.session();
    const opening = rt.open();
    await new Promise((r) => setTimeout(r, 30));
    await rt.close();
    const e = await opening.catch((x) => x);
    expect(e.code).toBe("session_closed");
    expect(rt.isOpen).toBe(false);
  });

  it("reports connection errors", async () => {
    const garbage: Server = createServer((sock) => {
      sock.once("data", () => sock.end("definitely not http\r\n\r\n"));
    });
    await new Promise<void>((r) => garbage.listen(0, "127.0.0.1", () => r()));
    servers.push(garbage);
    const { port } = garbage.address() as { port: number };
    const c1 = new ff.Finesse({ apiKey: "k", baseURL: `http://127.0.0.1:${port}` });
    await expect(c1.realtime.connect()).rejects.toBeInstanceOf(ff.APIConnectionError);
    const c2 = new ff.Finesse({ apiKey: "k", baseURL: "http://127.0.0.1:9" });
    await expect(c2.realtime.connect()).rejects.toBeInstanceOf(ff.APIConnectionError);
  });

  it("times out a slow handshake without an uncaught error", async () => {
    const client = await start(new Engine(), undefined, 300);
    const e = await client.realtime.connect({ openTimeout: 30 }).catch((x) => x);
    expect(e).toBeInstanceOf(ff.APITimeoutError);
    await new Promise((r) => setTimeout(r, 50)); // let any late socket error surface
  });

  it("refuses to reopen a closed session", async () => {
    const engine = new Engine();
    const client = await start(engine);
    const rt = await client.realtime.connect();
    await rt.close();
    const e = await collect(rt.say({ voice_id: VID, text: "x" })).catch((x) => x);
    expect(e.code).toBe("session_closed");
  });

  it("narrows events on type and passes unknown events through", async () => {
    const engine = new Engine();
    engine.onMessage = async (ws, msg, e) => {
      if (msg.type === "task_start") {
        ws.send(
          JSON.stringify({ type: "word_timestamps", context_id: msg.context_id, words: ["hi"] }),
        );
      }
      await defaultHandler(ws, msg, e);
    };
    const client = await start(engine);
    await session(client, async (rt) => {
      let total = 0;
      let pcm: Uint8Array | null = null;
      let unknown: ff.UnknownEvent | null = null;
      for await (const e of rt.say({ voice_id: VID, text: "hi" })) {
        switch (e.type) {
          case "audio":
            pcm = e.pcm; // typed as Uint8Array without a cast
            break;
          case "task_done":
            total = e.total_audio_duration_s ?? 0;
            break;
          case "unknown":
            unknown = e;
            break;
        }
      }
      expect(text(pcm!)).toBe("hi");
      expect(total).toBe(0.5);
      expect(unknown).toEqual({
        type: "unknown",
        context_id: expect.any(String),
        event_type: "word_timestamps",
        data: expect.objectContaining({ words: ["hi"] }),
      });
    });
  });

  it("cancel before the first send reaches the server sends nothing", async () => {
    const engine = new Engine();
    const client = await start(engine);
    await session(client, async (rt) => {
      const ctx = rt.context({ voice_id: VID });
      const p = ctx.send("hi");
      await ctx.cancel();
      const e = await p.catch((x) => x);
      expect(e.code).toBe("context_cancelled");
      expect(await collect(ctx)).toEqual([]);
    });
    expect(engine.received.filter((m) => m.type !== "session_end")).toEqual([]);
  });

  it("cancel during an in-flight start cancels it on the server", async () => {
    const engine = new Engine();
    const client = await start(engine, undefined, 50);
    const rt = client.realtime.session(); // the first send has to open the socket
    const ctx = rt.context({ voice_id: VID });
    const p = ctx.send("hi");
    await new Promise((r) => setTimeout(r, 10)); // the start is now waiting on the handshake
    await ctx.cancel();
    await p;
    const events = await collect(ctx);
    await rt.close();
    expect(engine.received.slice(0, 2).map((m) => m.type)).toEqual(["task_start", "task_cancel"]);
    expect(events.at(-1).type).toBe("task_cancelled");
  });

  it("close() waits for an in-flight open", async () => {
    const client = await start(new Engine(), undefined, 100);
    const rt = client.realtime.session();
    let settled = false;
    const opening = rt.open().finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    await rt.close();
    expect(settled).toBe(true);
    await opening.catch(() => undefined);
  });

  it("names the network error", async () => {
    const client = new ff.Finesse({ apiKey: "k", baseURL: "http://127.0.0.1:9" });
    const e = await client.realtime.connect().catch((x) => x);
    expect(e).toBeInstanceOf(ff.APIConnectionError);
    expect(e.message).toMatch(/ECONNREFUSED/);
  });

  describe("runtime WebSocket choice", () => {
    afterEach(() => vi.unstubAllGlobals());

    function fakeWebSocket() {
      const calls: unknown[][] = [];
      class Fake {
        constructor(...args: unknown[]) {
          calls.push(args);
          throw new Error("fake socket");
        }
      }
      return { calls, Fake };
    }

    it("Bun: the global WebSocket with headers", async () => {
      const { calls, Fake } = fakeWebSocket();
      vi.stubGlobal("WebSocket", Fake);
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.1.0" } });
      const client = new ff.Finesse({ apiKey: "flv_k", baseURL: "https://x.test" });
      await expect(client.realtime.connect()).rejects.toThrow("fake socket");
      expect(String(calls[0]![0])).toBe("wss://x.test/flam-voice-svc/api/v1/public/stream");
      expect((calls[0]![1] as { headers: Record<string, string> }).headers["X-API-Key"]).toBe(
        "flv_k",
      );
    });

    it("Deno: the global WebSocket with the key in the URL", async () => {
      const { calls, Fake } = fakeWebSocket();
      vi.stubGlobal("WebSocket", Fake);
      vi.stubGlobal("Deno", {});
      const client = new ff.Finesse({ apiKey: "flv_k", baseURL: "https://x.test" });
      await expect(client.realtime.connect()).rejects.toThrow("fake socket");
      const url = new URL(String(calls[0]![0]));
      expect(url.searchParams.get("api_key")).toBe("flv_k");
      expect(url.searchParams.get("client")).toMatch(/^flam-finesse-node\//);
      expect(calls[0]).toHaveLength(1);
    });

    it("Deno 2.5+: the global WebSocket with headers", async () => {
      const { calls, Fake } = fakeWebSocket();
      vi.stubGlobal("WebSocket", Fake);
      vi.stubGlobal("Deno", { version: { deno: "2.5.0" } });
      const client = new ff.Finesse({ apiKey: "flv_k", baseURL: "https://x.test" });
      await expect(client.realtime.connect()).rejects.toThrow("fake socket");
      expect(String(calls[0]![0])).toBe("wss://x.test/flam-voice-svc/api/v1/public/stream");
      expect((calls[0]![1] as { headers: Record<string, string> }).headers["X-API-Key"]).toBe(
        "flv_k",
      );
    });

    it("warns once about a key in the URL when logging is on", async () => {
      const { Fake } = fakeWebSocket();
      vi.stubGlobal("WebSocket", Fake);
      vi.stubGlobal("Deno", { version: { deno: "2.4.5" } });
      const quiet = { debug: vi.fn(), info: vi.fn() };
      const off = new ff.Finesse({ apiKey: "flv_k", baseURL: "https://x.test", logger: quiet });
      await expect(off.realtime.connect()).rejects.toThrow("fake socket");
      expect(quiet.info).not.toHaveBeenCalled();
      const logger = { debug: vi.fn(), info: vi.fn() };
      const client = new ff.Finesse({
        apiKey: "flv_k",
        baseURL: "https://x.test",
        logger,
        logLevel: "info",
      });
      await expect(client.realtime.connect()).rejects.toThrow("fake socket");
      await expect(client.realtime.connect()).rejects.toThrow("fake socket");
      expect(logger.info).toHaveBeenCalledTimes(1);
      const line = String(logger.info.mock.calls[0]![0]);
      expect(line).toMatch(/deprecated.*accessToken/s);
      expect(line).not.toContain("flv_k");
      const token = new ff.Finesse({
        accessToken: "fin_tok_x",
        baseURL: "https://x.test",
        logger: { debug: vi.fn(), info: vi.fn() },
      });
      await expect(token.realtime.connect()).rejects.toThrow("fake socket");
      expect(token._core.logger.info).not.toHaveBeenCalled();
    });
  });
});
