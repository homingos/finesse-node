import { pathId, sleep, type Core } from "../core.js";
import { CloneFailedError, CloneTimeoutError } from "../errors.js";
import type { CloneJob } from "../types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface WaitOptions {
  /** Give up after this many ms. Default 300 000 (the first clone after the cloner has been
   * idle can take a couple of minutes). */
  timeout?: number;
  /** Poll every this many ms. Default 2 000. */
  pollInterval?: number;
  /** Called with the job after every poll. */
  onUpdate?: (job: CloneJob) => void;
  /** Stop waiting (rejects with the signal's reason). The job itself keeps running. */
  signal?: AbortSignal;
}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** Clone jobs started by `voices.clone` and `voices.enroll`. */
export class Jobs {
  constructor(private readonly core: Core) {}

  get(jobId: string, options: { signal?: AbortSignal } = {}): Promise<CloneJob> {
    return this.core.json<CloneJob>("GET", `/jobs/${pathId(jobId)}`, { signal: options.signal });
  }

  /** Poll until the job finishes and return it. Throws {@link CloneFailedError} if it ends
   * `failed`, `cancelled` or `expired`, and {@link CloneTimeoutError} on timeout. */
  async wait(jobId: string, options: WaitOptions = {}): Promise<CloneJob> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const interval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      const job = await this.get(jobId, { signal: options.signal });
      options.onUpdate?.(job);
      if (FINISHED.has(job.status)) {
        if (job.status !== "succeeded") throw new CloneFailedError(job);
        return job;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CloneTimeoutError(jobId, timeout);
      await sleep(Math.min(interval, remaining), options.signal);
    }
  }
}
