import { Core, type ClientOptions } from "./core.js";
import { Realtime } from "./realtime.js";
import { Jobs } from "./resources/jobs.js";
import { Speech } from "./resources/speech.js";
import { Voices } from "./resources/voices.js";

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

  constructor(options: ClientOptions = {}) {
    this._core = new Core(options);
    this.jobs = new Jobs(this._core);
    this.voices = new Voices(this._core, this.jobs);
    this.speech = new Speech(this._core);
    this.realtime = new Realtime(this._core);
  }

  get baseURL(): string {
    return this._core.baseURL;
  }
}
