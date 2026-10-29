import type { FastifyInstance } from "fastify";
import type {
  RTC_TELEMETRY_COMMAND_TYPES,
  RtcTelemetrySnapshot,
} from "./observability.js";
import { RtcTelemetry } from "./observability.js";
import type { RtcCloseReason } from "./session/rtc-session.js";
import type { RtcRouteSet } from "./wire/routes.js";

export type RtcComponentStatus = "disabled" | "ok" | "degraded" | "closed";

export type RtcDegradedReason =
  | "credentials_missing"
  | "provider_startup_rejected"
  | "module_exception"
  | "audio_disconnect"
  | "sse_disconnect"
  | "asr_failure"
  | "token_expired"
  | "registry_saturated"
  | "concurrency_limit"
  | "circuit_open"
  | "drain_timeout";

export type RtcComponentHealth = Readonly<{
  status: RtcComponentStatus;
  reason?: RtcDegradedReason;
  telemetry: RtcTelemetrySnapshot;
}>;

export type RtcSessionDisconnectReason =
  | "provider_disconnect"
  | "provider_error"
  | "sse_disconnect"
  | "token_expired"
  | "user_exit"
  | "platform_close"
  | "inactive"
  | "server_shutdown";

export type RtcPluginOptions = Readonly<{
  enabled: boolean;
  build: () => Promise<RtcRouteSet | null>;
  metrics?: Readonly<{
    recordError: (code: string) => void;
    recordRtcDisconnect?: (reason: string) => void;
  }>;
  telemetry?: RtcTelemetry;
  now?: () => number;
  /** Maximum graceful drain before a forced close. */
  drainMs?: number;
  maxConcurrentSessions?: number;
  failureThreshold?: number;
}>;

export type RtcPlugin = Readonly<{
  enabled: boolean;
  component: () => RtcComponentHealth;
  mount: (app: FastifyInstance) => Promise<void>;
  canStart: () => boolean;
  startSession: () => boolean;
  endSession: () => void;
  observeSession: (reason: RtcSessionDisconnectReason) => void;
  observeRejected: (
    reason: "registry_full" | "concurrency_limit" | "circuit_open",
  ) => void;
  observeAudio: (msSinceStart?: number) => void;
  observeAsrFinal: (msSinceStart?: number) => void;
  observeOutput: (
    kind: (typeof RTC_TELEMETRY_COMMAND_TYPES)[number],
    msSinceStart?: number,
  ) => void;
  observeAsr: (outcome: "failure" | "final") => void;
  forceClose: (reason?: RtcCloseReason) => Promise<void>;
  drainAndClose: () => Promise<void>;
  readonly aborted: boolean;
}>;

const ERROR_REASONS: Readonly<Record<string, RtcDegradedReason>> = {
  RTC_CREDENTIALS_MISSING: "credentials_missing",
  RTC_PROVIDER_START_FAILED: "provider_startup_rejected",
};

const DEGRADED_BY_DISCONNECT: Partial<
  Readonly<Record<RtcSessionDisconnectReason, RtcDegradedReason>>
> = {
  provider_disconnect: "audio_disconnect",
  provider_error: "audio_disconnect",
  sse_disconnect: "sse_disconnect",
  token_expired: "token_expired",
};

const METRICS_DISCONNECT_REASON: Readonly<
  Record<RtcSessionDisconnectReason, string>
> = {
  provider_disconnect: "provider_error",
  provider_error: "provider_error",
  sse_disconnect: "platform_close",
  token_expired: "token_expired",
  user_exit: "user_exit",
  platform_close: "platform_close",
  inactive: "inactive",
  server_shutdown: "server_shutdown",
};

const DEFAULT_DRAIN_MS = 90_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Optional RTC module composition: mounted only when enabled, in a child scope,
 * with its own abort controller, bounded concurrency and an independent circuit
 * breaker. Real session/ASR/output call sites drive start, close and first
 * latency telemetry; RTC failures only degrade the RTC component and bounded
 * telemetry, never startup or core readiness, and force-close is a real path.
 */
export const createRtcPlugin = (options: RtcPluginOptions): RtcPlugin => {
  const telemetry = options.telemetry ?? new RtcTelemetry();
  telemetry.setEnabled(options.enabled);
  const now = options.now ?? (() => Date.now());
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const maxConcurrent = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
  const failureThreshold =
    options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

  let status: RtcComponentStatus = options.enabled ? "ok" : "disabled";
  let reason: RtcDegradedReason | undefined;
  let failures = 0;
  let active = 0;
  let aborted = false;
  let routeSet: RtcRouteSet | undefined;
  const startedAt: number[] = [];
  let firstAudioRecorded = false;
  let firstAsrFinalRecorded = false;
  let firstOutputRecorded = false;

  const component = (): RtcComponentHealth => ({
    status,
    ...(reason === undefined ? {} : { reason }),
    telemetry: telemetry.snapshot(),
  });

  const degrade = (next: RtcDegradedReason): void => {
    failures += 1;
    if (!options.enabled) return;
    reason = next;
    status = "degraded";
  };

  const mapError = (error: unknown): RtcDegradedReason => {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code in ERROR_REASONS
      ? (ERROR_REASONS[code] as RtcDegradedReason)
      : "module_exception";
  };

  const consumeActive = (): boolean => {
    if (active === 0) return false;
    active -= 1;
    telemetry.endSession();
    return true;
  };

  const elapsed = (override?: number): number => {
    if (override !== undefined) return Math.max(0, override);
    const started = startedAt.at(-1);
    return started === undefined ? 0 : Math.max(0, now() - started);
  };

  return {
    enabled: options.enabled,
    component,
    async mount(app) {
      if (!options.enabled) {
        status = "disabled";
        return;
      }
      if (aborted) {
        status = "closed";
        return;
      }
      let built: RtcRouteSet | null;
      try {
        built = await options.build();
      } catch (error) {
        telemetry.start("failed");
        degrade(mapError(error));
        return;
      }
      if (built === null) {
        telemetry.start("failed");
        degrade("credentials_missing");
        return;
      }
      routeSet = built;
      try {
        built.register(app);
      } catch (error) {
        telemetry.start("failed");
        degrade(mapError(error));
        return;
      }
      status = "ok";
    },
    canStart() {
      return (
        options.enabled &&
        !aborted &&
        failures < failureThreshold &&
        active < maxConcurrent
      );
    },
    startSession() {
      if (!options.enabled || aborted) return false;
      if (failures >= failureThreshold) {
        reason = "circuit_open";
        status = "degraded";
        telemetry.reject("circuit_open");
        return false;
      }
      if (active >= maxConcurrent) {
        telemetry.reject("concurrency_limit");
        degrade("concurrency_limit");
        return false;
      }
      active += 1;
      startedAt.push(now());
      firstAudioRecorded = false;
      firstAsrFinalRecorded = false;
      firstOutputRecorded = false;
      telemetry.start("started");
      return true;
    },
    endSession() {
      consumeActive();
    },
    observeSession(disconnectReason) {
      consumeActive();
      telemetry.disconnect(disconnectReason);
      try {
        options.metrics?.recordRtcDisconnect?.(
          METRICS_DISCONNECT_REASON[disconnectReason],
        );
      } catch {
        // Metrics are bounded and must never affect the session close path.
      }
      const degraded = DEGRADED_BY_DISCONNECT[disconnectReason];
      if (degraded !== undefined) degrade(degraded);
    },
    observeRejected(rejectReason) {
      telemetry.reject(rejectReason);
      degrade(
        rejectReason === "registry_full"
          ? "registry_saturated"
          : rejectReason === "concurrency_limit"
            ? "concurrency_limit"
            : "circuit_open",
      );
    },
    observeAudio(msSinceStart) {
      if (firstAudioRecorded) return;
      firstAudioRecorded = true;
      telemetry.firstAudio(elapsed(msSinceStart));
    },
    observeAsrFinal(msSinceStart) {
      if (firstAsrFinalRecorded) return;
      firstAsrFinalRecorded = true;
      telemetry.firstAsrFinal(elapsed(msSinceStart));
    },
    observeOutput(kind, msSinceStart) {
      telemetry.outputCommand(kind);
      if (firstOutputRecorded) return;
      firstOutputRecorded = true;
      telemetry.firstOutput(elapsed(msSinceStart));
    },
    observeAsr(outcome) {
      if (outcome === "failure") {
        telemetry.asrFailure();
        degrade("asr_failure");
        return;
      }
      this.observeAsrFinal();
    },
    async forceClose(closeReason = "server_shutdown") {
      aborted = true;
      active = 0;
      telemetry.resetActive();
      startedAt.length = 0;
      const current = routeSet;
      if (current !== undefined) {
        try {
          await current.closeAll(closeReason);
        } catch {
          // A failing provider close path must not escape the RTC boundary.
        }
      }
      status = options.enabled ? "closed" : "disabled";
    },
    async drainAndClose() {
      if (!options.enabled || aborted) return;
      const deadline = now() + drainMs;
      while (active > 0 && now() < deadline) {
        const remaining = deadline - now();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(250, Math.max(0, remaining)));
        });
      }
      if (active > 0) degrade("drain_timeout");
      await this.forceClose("server_shutdown");
    },
    get aborted() {
      return aborted;
    },
  };
};
