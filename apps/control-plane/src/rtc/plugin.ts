import type { FastifyInstance } from "fastify";
import type { RtcProviderSettings } from "./config.js";
import type {
  RTC_TELEMETRY_COMMAND_TYPES,
  RtcTelemetrySnapshot,
} from "./observability.js";
import { RtcTelemetry } from "./observability.js";
import type { RtcCloseReason, RtcSseWriter } from "./session/rtc-session.js";
import type { NormalizedRtcStart } from "./wire/qwen-rtc-schema.js";
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

/** Output command kinds a real writer may occupy first-output with. */
export type RtcOutputKind = (typeof RTC_TELEMETRY_COMMAND_TYPES)[number];

/** Session-scoped input every provider factory receives. */
export type RtcCompositionInput = Readonly<{
  start: NormalizedRtcStart;
  settings?: RtcProviderSettings;
}>;

/** Provider handle disposed exactly once when its session closes. */
export type RtcCompositionHandle = Readonly<{
  close: () => Promise<void>;
}>;

type MaybeHandle =
  | RtcCompositionHandle
  | Promise<RtcCompositionHandle | undefined>
  | undefined;

/**
 * Real provider composition: per-session consumer, ASR and output factories
 * built from server configuration. Factories may be asynchronous; every
 * returned handle is closed exactly once on session close or force-close, and
 * a handle that resolves only after the session is gone is closed immediately
 * instead of leaking a provider stream.
 */
export type RtcProviderComposition = Readonly<{
  consumer?: (
    sessionId: string,
    input: RtcCompositionInput,
    callbacks: Readonly<{ onFirstAudio: () => void }>,
  ) => MaybeHandle;
  asr?: (
    sessionId: string,
    input: RtcCompositionInput,
    callbacks: Readonly<{ onFinal: () => void; onFailure: () => void }>,
  ) => MaybeHandle;
  output?: (
    sessionId: string,
    writer: RtcSseWriter,
    input: RtcCompositionInput,
    callbacks: Readonly<{ onFirstOutput: (kind: RtcOutputKind) => void }>,
  ) => MaybeHandle;
}>;

export type RtcPluginOptions = Readonly<{
  enabled: boolean;
  build: () => Promise<RtcRouteSet | null>;
  metrics?: Readonly<{
    recordError: (code: string) => void;
    recordRtcDisconnect?: (reason: string) => void;
  }>;
  telemetry?: RtcTelemetry;
  composition?: RtcProviderComposition;
  /** Provider credentials/model settings handed to the composition factories. */
  settings?: RtcProviderSettings;
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
    writer: RtcSseWriter,
    start: NormalizedRtcStart,
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
  const handles = new Map<string, RtcCompositionHandle[]>();

  /** Dispose a handle once; provider close failures never escape the boundary. */
  const closeHandle = (handle: RtcCompositionHandle): void => {
    try {
      void Promise.resolve(handle.close()).catch(() => undefined);
    } catch {
      // A provider close failure must not affect the session close path.
    }
  };

  /** Dispose every composed provider handle for one tracked session. */
  const closeSessionHandles = (sessionId: string): void => {
    const owned = handles.get(sessionId);
    if (owned === undefined) return;
    handles.delete(sessionId);
    for (const handle of owned) closeHandle(handle);
  };

  /** A composed handle whose session already closed must not leak. */
  const trackHandle = (
    sessionId: string,
    candidate: RtcCompositionHandle | undefined,
  ): void => {
    if (candidate === undefined) return;
    if (aborted || !sessions.has(sessionId)) {
      closeHandle(candidate);
      return;
    }
    const owned = handles.get(sessionId);
    if (owned === undefined) handles.set(sessionId, [candidate]);
    else owned.push(candidate);
  };

  const runFactory = (
    sessionId: string,
    factory: (() => MaybeHandle) | undefined,
  ): void => {
    if (factory === undefined) return;
    let result: MaybeHandle;
    try {
      result = factory();
    } catch {
      degrade("module_exception");
      return;
    }
    if (result === undefined) return;
    Promise.resolve(result)
      .then((handle) => trackHandle(sessionId, handle))
      .catch(() => degrade("module_exception"));
  };

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
      if (id !== undefined) {
        sessions.delete(id);
        closeSessionHandles(id);
      }
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
    composeSession(sessionId, writer, start) {
      const record = sessions.get(sessionId);
      const composition = options.composition;
      if (record === undefined || composition === undefined) return;
      const input: RtcCompositionInput = {
        start,
        ...(options.settings === undefined
          ? {}
          : { settings: options.settings }),
      };
      runFactory(
        sessionId,
        composition.consumer === undefined
          ? undefined
          : () =>
              composition.consumer?.(sessionId, input, {
                onFirstAudio: () => this.observeAudio(sessionId),
              }),
      );
      runFactory(
        sessionId,
        composition.asr === undefined
          ? undefined
          : () =>
              composition.asr?.(sessionId, input, {
                onFinal: () => this.observeAsrFinal(sessionId),
                onFailure: () => this.observeAsr("failure", sessionId),
              }),
      );
      runFactory(
        sessionId,
        composition.output === undefined
          ? undefined
          : () =>
              composition.output?.(sessionId, writer, input, {
                onFirstOutput: (kind) => this.observeOutput(kind, sessionId),
              }),
      );
    },
    async forceClose(closeReason = "server_shutdown") {
      aborted = true;
      for (const sessionId of [...handles.keys()]) {
        closeSessionHandles(sessionId);
      }
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
