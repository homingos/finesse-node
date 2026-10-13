import { beforeEach } from "vitest";
import { _setSleep } from "../src/core.js";
import { Finesse } from "../src/index.js";

export const PREFIX = "/flam-voice-svc/api/v1/public";
export const VOICE = {
  id: "665f1a2b3c4d5e6f7a8b9c0d",
  org_id: "665f00000000000000000001",
  name: "Narrator",
  clone_method: "instant",
  model: "finesse-v1",
  status: "ready",
  visibility: "private",
  primary_language: "en",
  labels: [{ key: "gender", value: "female" }],
  created_at: 1760000000000,
  updated_at: 1760000300000,
  language: "en",
  gender: "female",
};

beforeEach(() => _setSleep(async () => undefined));

export const envelope = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ status, error: false, data }), {
    status,
    headers: { "content-type": "application/json" },
  });

export const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ status, error: true, message }), { status, headers });

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

export const netError = (code = "ECONNREFUSED") =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Step = Response | Error | ((r: Recorded) => Response | Promise<Response>);

export function mock(...steps: Step[]) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const rec: Recorded = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      body: init.body,
    };
    requests.push(rec);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected request ${rec.method} ${rec.url}`);
    if (step instanceof Error) throw step;
    const signal = init.signal;
    const result = Promise.resolve(typeof step === "function" ? step(rec) : step).then((res) =>
      signal && res.body ? abortableBody(res, signal) : res,
    );
    if (!signal) return result;
    // Like a real fetch: an aborted signal rejects the request.
    return Promise.race([
      result,
      new Promise<never>((_, reject) => {
        const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) fail();
        signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
  };
  const client = new Finesse({ apiKey: "flv_test", baseURL: "https://api.test", fetch });
  return {
    client,
    requests,
    last: () => requests[requests.length - 1]!,
    json: (i = -1) => JSON.parse(String(requests.at(i)!.body)),
    make: (opts: Record<string, unknown>) =>
      new Finesse({ apiKey: "flv_test", baseURL: "https://api.test", fetch, ...opts }),
  };
}

/** Like a real fetch, aborting the request also errors a body that is still streaming. */
function abortableBody(res: Response, signal: AbortSignal): Response {
  const reader = res.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            /* already closed */
          }
          reader.cancel().catch(() => undefined);
        },
        { once: true },
      );
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
