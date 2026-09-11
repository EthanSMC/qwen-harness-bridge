import type { ApprovalReservation } from "../approvals/approval-broker.js";
import type { ConnectorEpoch } from "../transport/connector-client.js";
import type { CoordinationClockSample } from "./coordination-deadlines.js";
import type { JobStateClient } from "./job-state-client.js";
import type { LiveStateRegistry } from "./live-state-registry.js";

export type ApprovalReservationRequest = Readonly<{
  jobId: string;
  repositoryId: string;
  attempt: number;
}>;

export type ApprovalReservationProviderOptions = Readonly<{
  registry: Pick<LiveStateRegistry, "capture" | "latest" | "revisionFor">;
  states: Pick<JobStateClient, "observe">;
  epoch: () => ConnectorEpoch | undefined;
  approvalTimeoutSeconds: (repositoryId: string) => number | undefined;
  clock?: () => CoordinationClockSample;
  signal?: AbortSignal;
}>;

const MAX_REVISION = 2_147_483_647;

/** ADR 0005 approval reservation. `refresh` obtains the observation (and stores
 * it deterministically); `reserve` is the synchronous trusted projection the
 * broker consumes. A reservation is bound to one epoch, one observed revision
 * and one conservative monotonic lifetime, and is revoked on release. */
export class ApprovalReservationProvider {
  readonly #options: ApprovalReservationProviderOptions;

  constructor(options: ApprovalReservationProviderOptions) {
    this.#options = options;
  }

  async refresh(request: ApprovalReservationRequest): Promise<boolean> {
    const epoch = this.#options.epoch();
    if (epoch === undefined || epoch.signal.aborted) return false;
    let exchange: Awaited<ReturnType<JobStateClient["observe"]>>;
    try {
      exchange = await this.#options.states.observe({
        jobId: request.jobId,
        repositoryId: request.repositoryId,
        attempt: request.attempt,
        signal: this.#options.signal,
      });
    } catch {
      return false;
    }
    if (
      exchange.epoch !== epoch ||
      epoch.signal.aborted ||
      this.#options.epoch() !== epoch
    )
      return false;
    const payload = exchange.state.payload;
    if (
      payload.job_id !== request.jobId ||
      payload.repository_id !== request.repositoryId ||
      payload.requested_attempt !== request.attempt
    )
      return false;
    return this.#options.registry.capture({
      payload,
      received: exchange.received,
    });
  }

  reserve(
    request: ApprovalReservationRequest,
  ): ApprovalReservation | undefined {
    const epoch = this.#options.epoch();
    if (epoch === undefined || epoch.signal.aborted) return undefined;
    const latest = this.#options.registry.latest(
      request.jobId,
      request.attempt,
    );
    const revision = this.#options.registry.revisionFor(
      request.jobId,
      request.attempt,
    );
    if (
      latest === undefined ||
      revision === undefined ||
      revision >= MAX_REVISION
    )
      return undefined;
    const payload = latest.payload;
    if (
      payload.job_id !== request.jobId ||
      payload.repository_id !== request.repositoryId ||
      payload.current_attempt !== request.attempt
    )
      return undefined;
    const approvalTimeoutSeconds = this.#options.approvalTimeoutSeconds(
      request.repositoryId,
    );
    if (
      approvalTimeoutSeconds === undefined ||
      !Number.isInteger(approvalTimeoutSeconds) ||
      approvalTimeoutSeconds < 60 ||
      approvalTimeoutSeconds > 1800
    )
      return undefined;
    const baseline = this.#sample();
    if (baseline === undefined) return undefined;
    const remoteExpiry = Date.parse(payload.expires_at);
    if (!Number.isFinite(remoteExpiry)) return undefined;
    const wireDeadlineMs = Math.min(
      remoteExpiry,
      baseline.wallTimeMs + approvalTimeoutSeconds * 1_000,
    );
    const monotonicDeadlineMs = Math.min(
      baseline.monotonicTimeMs + approvalTimeoutSeconds * 1_000,
      baseline.monotonicTimeMs +
        Math.max(0, remoteExpiry - baseline.wallTimeMs),
    );
    if (
      wireDeadlineMs <= baseline.wallTimeMs ||
      monotonicDeadlineMs <= baseline.monotonicTimeMs
    )
      return undefined;
    const controller = new AbortController();
    const sources: AbortSignal[] = [epoch.signal, controller.signal];
    if (this.#options.signal !== undefined) sources.push(this.#options.signal);
    const signal = AbortSignal.any(sources);
    const capturedEpoch = epoch;
    let released = false;
    return Object.freeze({
      requestedRevision: revision + 1,
      deadline: wireDeadlineMs,
      approvalTimeoutSeconds,
      signal,
      isCurrent: (): boolean => {
        if (released || signal.aborted) return false;
        if (
          this.#options.epoch() !== capturedEpoch ||
          capturedEpoch.signal.aborted
        )
          return false;
        const current = this.#sample();
        if (current === undefined) return false;
        if (
          current.monotonicTimeMs < baseline.monotonicTimeMs ||
          current.monotonicTimeMs >= monotonicDeadlineMs
        )
          return false;
        return (
          Math.abs(
            current.wallTimeMs -
              current.monotonicTimeMs -
              (baseline.wallTimeMs - baseline.monotonicTimeMs),
          ) <= 1000
        );
      },
      release: (): void => {
        released = true;
        try {
          controller.abort();
        } catch {
          // Revocation stays latched.
        }
      },
    });
  }

  #sample(): CoordinationClockSample | undefined {
    const clock =
      this.#options.clock ??
      (() => ({ wallTimeMs: Date.now(), monotonicTimeMs: performance.now() }));
    try {
      const value = clock();
      if (
        value === null ||
        typeof value !== "object" ||
        !Number.isFinite(value.wallTimeMs) ||
        !Number.isFinite(value.monotonicTimeMs)
      )
        return undefined;
      return {
        wallTimeMs: value.wallTimeMs,
        monotonicTimeMs: value.monotonicTimeMs,
      };
    } catch {
      return undefined;
    }
  }
}
