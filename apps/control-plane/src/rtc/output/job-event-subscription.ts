import type { RtcJobEvent } from "./progress-scheduler.js";

export type RtcJobEventSource = Readonly<{
  subscribe: (
    jobIds: readonly string[],
    listener: (event: RtcJobEvent) => void,
  ) => () => void;
}>;

/**
 * Tracks only the jobs touched by this RTC session and re-subscribes whenever a
 * new job is touched. Unsubscribing never affects the job itself.
 */
export class JobEventSubscription {
  readonly #source: RtcJobEventSource;
  readonly #listener: (event: RtcJobEvent) => void;
  readonly #jobs = new Set<string>();
  #unsubscribe: (() => void) | undefined;

  constructor(
    source: RtcJobEventSource,
    listener: (event: RtcJobEvent) => void,
  ) {
    this.#source = source;
    this.#listener = listener;
  }

  track(jobIds: readonly string[]): void {
    let added = false;
    for (const jobId of jobIds) {
      if (jobId.length === 0 || this.#jobs.has(jobId)) continue;
      this.#jobs.add(jobId);
      added = true;
    }
    if (!added) return;
    this.#unsubscribe?.();
    this.#unsubscribe = this.#source.subscribe([...this.#jobs], this.#listener);
  }

  jobIds(): readonly string[] {
    return [...this.#jobs];
  }

  unsubscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}
