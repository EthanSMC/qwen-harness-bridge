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
  /** Injectable composition entry points (fake providers in tests; real
   * Task 3/5 adapters are constructed here when configured). */
  composition?: Readonly<{
    consumer?: (
      sessionId: string,
      callbacks: { onFirstAudio: () => void; close: () => Promise<void> },
    ) => { close: () => Promise<void> };
    asr?: (
      sessionId: string,
      callbacks: { onFinal: () => void; onFailure: () => void },
    ) => { close?: () => Promise<void> };
    output?: (
      sessionId: string,
      writer: import("./session/rtc-session.js").RtcSseWriter,
      callbacks: { onFirstOutput: (kind: string) => void },
    ) => { close?: () => Promise<void> };
  }>;
  now?: () => number;
  drainMs?: number;
  maxConcurrentSessions?: number;
  failureThreshold?: number;
}>;

export type RtcPlugin = Readonly<{
  enabled: boolean;
  component: () => RtcComponentHealth;
  mount: (app: FastifyInstance) => Promise<void>;
  canStart: () => boolean;
  rejectionReason: () => "concurrency_limit" | "circuit_open" | undefined;
  startSession: (sessionId?: string) => boolean;
  endSession: (sessionId?: string) => void;
  observeSession: (
    reason: RtcSessionDisconnectReason,
    sessionId?: string,
  ) => void;
  observeRejected: (
    reason: "registry_full" | "concurrency_limit" | "circuit_open",
  ) => void;
  observeAudio: (sessionId?: string, msSinceStart?: number) => void;
  observeAsrFinal: (sessionId?: string, msSinceStart?: number) => void;
  observeOutput: (
    kind: (typeof RTC_TELEMETRY_COMMAND_TYPES)[number],
    sessionId?: string,
    msSinceStart?: number,
  ) => void;
  observeAsr: (outcome: "failure" | "final", sessionId?: string) => void;
  composeSession: (
    sessionId: string,
    writer: import("./session/rtc-session.js").RtcSseWriter,
  ) => void;
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

type SessionRecord = {
  startedAt: number;
  firstAudio: boolean;
  firstAsrFinal: boolean;
  firstOutput: boolean;
};

/**
 * Optional RTC module composition. Sessions are tracked by id so active counts,
 * first-latency buckets and start timestamps cannot leak between concurrent
 * sessions; a close only decrements the session that is actually tracked.
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
  let aborted = false;
  let routeSet: RtcRouteSet | undefined;
  let anonymous = 0;
  const sessions = new Map<string, SessionRecord>();

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

  const recordFor = (sessionId?: string): SessionRecord | undefined => {
    if (sessionId !== undefined) return sessions.get(sessionId);
    if (sessions.size === 0) return undefined;
    return sessions.values().next().value;
  };

  const elapsed = (
    record: SessionRecord | undefined,
    override?: number,
  ): number => {
    if (override !== undefined) return Math.max(0, override);
    return record === undefined ? 0 : Math.max(0, now() - record.startedAt);
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
        sessions.size < maxConcurrent
      );
    },
    rejectionReason() {
      if (failures >= failureThreshold) return "circuit_open";
      if (sessions.size >= maxConcurrent) return "concurrency_limit";
      return undefined;
    },
    startSession(sessionId) {
      if (!this.canStart()) return false;
      anonymous += 1;
      const id = sessionId ?? `anonymous-${anonymous}`;
      if (sessions.has(id)) return true;
      sessions.set(id, {
        startedAt: now(),
        firstAudio: false,
        firstAsrFinal: false,
        firstOutput: false,
      });
      telemetry.start("started");
      return true;
    },
    endSession(sessionId) {
      const record = recordFor(sessionId);
      if (record === undefined) return;
      const [id] =
        [...sessions.entries()].find(([, value]) => value === record) ?? [];
      if (id !== undefined) sessions.delete(id);
      telemetry.endSession();
    },
    observeSession(disconnectReason, sessionId) {
      this.endSession(sessionId);
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
    observeAudio(sessionId, msSinceStart) {
      const record = recordFor(sessionId);
      if (record === undefined || record.firstAudio) return;
      record.firstAudio = true;
      telemetry.firstAudio(elapsed(record, msSinceStart));
    },
    observeAsrFinal(sessionId, msSinceStart) {
      const record = recordFor(sessionId);
      if (record === undefined || record.firstAsrFinal) return;
      record.firstAsrFinal = true;
      telemetry.firstAsrFinal(elapsed(record, msSinceStart));
    },
    observeOutput(kind, sessionId, msSinceStart) {
      telemetry.outputCommand(kind);
      const record = recordFor(sessionId);
      if (record === undefined || record.firstOutput) return;
      record.firstOutput = true;
      telemetry.firstOutput(elapsed(record, msSinceStart));
    },
    observeAsr(outcome, sessionId) {
      if (outcome === "failure") {
        telemetry.asrFailure();
        degrade("asr_failure");
        return;
      }
      this.observeAsrFinal(sessionId);
    },
    composeSession(sessionId, writer) {
      const record = sessions.get(sessionId);
      if (record === undefined) return;
      try {
        options.composition?.consumer?.(sessionId, {
          onFirstAudio: () => this.observeAudio(sessionId),
          close: async () => undefined,
        });
        options.composition?.asr?.(sessionId, {
          onFinal: () => this.observeAsrFinal(sessionId),
          onFailure: () => this.observeAsr("failure", sessionId),
        });
        options.composition?.output?.(sessionId, writer, {
          onFirstOutput: (kind) =>
            this.observeOutput(
              kind as (typeof RTC_TELEMETRY_COMMAND_TYPES)[number],
              sessionId,
            ),
        });
      } catch {
        degrade("module_exception");
      }
    },
    async forceClose(closeReason = "server_shutdown") {
      aborted = true;
      sessions.clear();
      telemetry.resetActive();
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
      while (sessions.size > 0 && now() < deadline) {
        const remaining = deadline - now();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(250, Math.max(0, remaining)));
        });
      }
      if (sessions.size > 0) degrade("drain_timeout");
      await this.forceClose("server_shutdown");
    },
    get aborted() {
      return aborted;
    },
  };
};
