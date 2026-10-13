import type { Core } from "./core.js";
import { FinesseError } from "./errors.js";

/** The parsed result of a call plus the HTTP response it came from. For calls that make several
 * requests (`voices.list` walking pages, `cloneAndWait` polling), `response` is the first one. */
export interface RawResponse<T> {
  data: T;
  response: Response;
  status: number;
  headers: Headers;
  /** The service's `X-Request-Id` for this request, when sent. */
  requestId: string | null;
}

type Fn = (...args: never[]) => unknown;
type RawMethods<R> = {
  [M in keyof R as R[M] extends Fn ? (M extends "stream" ? never : M) : never]: R[M] extends (
    ...args: infer A
  ) => infer Ret
    ? (...args: A) => Promise<RawResponse<Awaited<Ret>>>
    : never;
};

export interface Resources {
  voices: object;
  jobs: object;
  speech: object;
}

/** `client.withRawResponse`: the same methods, each resolving to a {@link RawResponse}. */
export type RawClient<R extends Resources> = { [K in keyof R]: RawMethods<R[K]> };

export function rawClient<R extends Resources>(core: Core, build: (core: Core) => R): RawClient<R> {
  const namespace = (name: keyof R) =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          if (method === "stream") {
            throw new FinesseError(
              "speech.stream has no raw form: read headers from the stream itself " +
                "(stream.billingRemaining, stream.done) instead.",
            );
          }
          return async (...args: unknown[]) => {
            const seen: Response[] = [];
            const view = core.withOptions({});
            view.onResponse = (r) => seen.push(r);
            const resource = build(view)[name] as Record<string, (...a: unknown[]) => unknown>;
            const fn = resource[method];
            if (typeof fn !== "function")
              throw new FinesseError(`No method ${String(name)}.${method}`);
            const data = await fn.apply(resource, args);
            const response = seen[0];
            if (!response) throw new FinesseError("This call made no HTTP request.");
            return {
              data,
              response,
              status: response.status,
              headers: response.headers,
              requestId: response.headers.get("x-request-id"),
            };
          };
        },
      },
    );
  return {
    voices: namespace("voices"),
    jobs: namespace("jobs"),
    speech: namespace("speech"),
  } as RawClient<R>;
}
