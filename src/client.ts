import { Core, type ClientOptions } from "./core.js";
import { rawClient, type RawClient } from "./raw.js";
import { Realtime } from "./realtime.js";
import { Jobs } from "./resources/jobs.js";
import { Speech } from "./resources/speech.js";
import { Voices } from "./resources/voices.js";

interface FinesseResources {
  voices: Voices;
  jobs: Jobs;
  speech: Speech;
}

function resources(core: Core): FinesseResources {
  const jobs = new Jobs(core);
  return { jobs, voices: new Voices(core, jobs), speech: new Speech(core) };
}

/**
 * Client for the Finesse API.
 *
 * ```ts
 * import { Finesse } from "@flam/finesse";
 *
 * const client = new Finesse(); // reads FINESSE_API_KEY
 * const audio = await client.speech.create({ voice_id: "665f1a2b3c4d5e6f7a8b9c0d", text: "Hello!" });
 * ```
 */
export class Finesse {
  readonly voices: Voices;
  readonly jobs: Jobs;
  readonly speech: Speech;
  readonly realtime: Realtime;
  /** @internal */
  readonly _core: Core;

  constructor(options: ClientOptions | { _core: Core } = {}) {
    this._core = "_core" in options ? options._core : new Core(options);
    const r = resources(this._core);
    this.jobs = r.jobs;
    this.voices = r.voices;
    this.speech = r.speech;
    this.realtime = new Realtime(this._core);
  }

  get baseURL(): string {
    return this._core.baseURL;
  }

  /** A copy of this client with different defaults. Cheap: it shares everything else. */
  withOptions(options: {
    timeout?: number;
    maxRetries?: number;
    defaultHeaders?: Record<string, string>;
  }): Finesse {
    return new Finesse({
      _core: this._core.withOptions({
        timeout: options.timeout,
        maxRetries: options.maxRetries,
        headers: options.defaultHeaders,
      }),
    });
  }

  /** The same calls, each resolving to `{ data, response, status, headers, requestId }`:
   *
   * ```ts
   * const { data: voice, requestId } = await client.withRawResponse.voices.get(id);
   * ```
   */
  get withRawResponse(): RawClient<FinesseResources> {
    return rawClient(this._core, resources);
  }
}
