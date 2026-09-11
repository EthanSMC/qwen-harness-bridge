import {
  ConnectorServerMessageSchema,
  type JobStatePayload,
  JobStatePayloadSchema,
} from "@qhb/protocol";
import type { CoordinatingConnectorClient } from "../transport/connector-client.js";
import type { CoordinationClockSample } from "./coordination-deadlines.js";

export type LiveStateSnapshot = Readonly<{
  payload: JobStatePayload;
  received: CoordinationClockSample;
  snapshotDeadlineMonotonicMs: number;
}>;

const keyOf = (jobId: string, attempt: number): string =>
  `${jobId}\u0000${attempt}`;

const finite = (sample: CoordinationClockSample): boolean =>
  Number.isFinite(sample.wallTimeMs) && Number.isFinite(sample.monotonicTimeMs);

/** ADR 0005/0007 live state registry: the one cache of validated, non-recovered
 * `job.state` snapshots used to source an approval reservation's observed
 * revision. It grants no authority; every effect still rechecks the exact socket
 * epoch and conservative deadline. A snapshot expires one second before its
 * remote validity, so a reservation can never outlive its observation. */
export class LiveStateRegistry {
  readonly #connector: Pick<
    CoordinatingConnectorClient,
    "onState" | "currentEpoch"
  >;
  readonly #clock: () => CoordinationClockSample;
  readonly #entries = new Map<string, LiveStateSnapshot>();
  readonly #unsubscribe: () => void;
  #removeParent: (() => void) | undefined;
  #terminated = false;

  constructor(
    options: Readonly<{
      connector: Pick<CoordinatingConnectorClient, "onState" | "currentEpoch">;
      clock?: () => CoordinationClockSample;
      signal?: AbortSignal;
    }>,
  ) {
    this.#connector = options.connector;
    this.#clock =
      options.clock ??
      (() => ({ wallTimeMs: Date.now(), monotonicTimeMs: performance.now() }));
    this.#unsubscribe = this.#connector.onState((message, delivery) => {
      this.#receive(message, delivery);
      return undefined;
    });
    const signal = options.signal;
    if (signal !== undefined) {
      const abort = () => this.dispose();
      this.#removeParent = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  }

  latest(jobId: string, attempt: number): LiveStateSnapshot | undefined {
    if (this.#terminated) return undefined;
    return this.#entries.get(keyOf(jobId, attempt));
  }

  /** Observed server revision for a reservation, or undefined when the snapshot
   * is absent, expired or the clock moved discontinuously. */
  revisionFor(
    jobId: string,
    attempt: number,
    now?: CoordinationClockSample,
  ): number | undefined {
    const entry = this.latest(jobId, attempt);
    if (entry === undefined) return undefined;
    const sample = now ?? this.#sample();
    if (sample === undefined || !finite(sample)) return undefined;
    if (
      sample.monotonicTimeMs < entry.received.monotonicTimeMs ||
      sample.monotonicTimeMs >= entry.snapshotDeadlineMonotonicMs
    )
      return undefined;
    const drift = Math.abs(
      sample.wallTimeMs -
        sample.monotonicTimeMs -
        (entry.received.wallTimeMs - entry.received.monotonicTimeMs),
    );
    if (drift > 1000) return undefined;
    return entry.payload.job_revision;
  }

  /** Cache a directly observed live exchange. `JobStateClient.observe` resolves
   * before every `onState` listener has necessarily run, so a refresh must write
   * the exact validated payload it received instead of racing delivery order. */
  capture(
    input: Readonly<{
      payload: JobStatePayload;
      received: CoordinationClockSample;
    }>,
  ): boolean {
    if (this.#terminated) return false;
    try {
      const payload = JobStatePayloadSchema.parse(input.payload);
      if (!finite(input.received)) return false;
      return this.#cache(payload, {
        wallTimeMs: input.received.wallTimeMs,
        monotonicTimeMs: input.received.monotonicTimeMs,
      });
    } catch {
      return false;
    }
  }

  clear(jobId: string, attempt: number): void {
    this.#entries.delete(keyOf(jobId, attempt));
  }

  dispose(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#entries.clear();
    const removeParent = this.#removeParent;
    this.#removeParent = undefined;
    for (const cleanup of [this.#unsubscribe, removeParent]) {
      try {
        cleanup?.();
      } catch {
        // Termination stays latched.
      }
    }
  }

  #receive(
    message: unknown,
    delivery: Readonly<{ epoch: unknown; recovered: boolean }>,
  ): void {
    try {
      if (this.#terminated || delivery.recovered) return;
      const epoch = delivery.epoch;
      if (epoch === null || epoch !== this.#connector.currentEpoch()) return;
      const parsed = ConnectorServerMessageSchema.safeParse(message);
      if (!parsed.success || parsed.data.type !== "job.state") return;
      const payload = parsed.data.payload;
      const received = this.#sample();
      if (received === undefined) return;
      this.#cache(payload, received);
    } catch {
      // A malformed delivery never disturbs the transport receive pump.
    }
  }

  #cache(payload: JobStatePayload, received: CoordinationClockSample): boolean {
    const observedMs = Date.parse(payload.observed_at);
    const validUntilMs = Date.parse(payload.state_valid_until);
    if (!Number.isFinite(observedMs) || !Number.isFinite(validUntilMs))
      return false;
    const validity = validUntilMs - observedMs;
    if (validity <= 0) return false;
    if (!finite(received)) return false;
    if (Math.abs(received.wallTimeMs - observedMs) > 1000) return false;
    const snapshotDeadlineMonotonicMs =
      received.monotonicTimeMs + validity - 1000;
    if (snapshotDeadlineMonotonicMs <= received.monotonicTimeMs) return false;
    this.#entries.set(keyOf(payload.job_id, payload.current_attempt), {
      payload: Object.freeze({ ...payload }),
      received: Object.freeze({ ...received }),
      snapshotDeadlineMonotonicMs,
    });
    return true;
  }

  #sample(): CoordinationClockSample | undefined {
    try {
      const sample = this.#clock();
      if (sample === null || typeof sample !== "object" || !finite(sample))
        return undefined;
      return {
        wallTimeMs: sample.wallTimeMs,
        monotonicTimeMs: sample.monotonicTimeMs,
      };
    } catch {
      return undefined;
    }
  }
}
