import { createServer, type Server } from "node:net";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import * as ff from "../src/index.js";
import type { RealtimeSession } from "../src/index.js";

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
});
