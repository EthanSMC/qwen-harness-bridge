import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";
import {
  createLiveRtcSession,
  type LiveRtcSession,
  type RtcClock,
  type RtcCloseReason,
  type RtcProviderResources,
  type RtcSseWriter,
} from "./rtc-session.js";

/** The transport a start callback supplies for one new live session. */
export type RtcSessionTransport = Readonly<{
  writer: RtcSseWriter;
  resources: RtcProviderResources;
}>;

export type RtcSessionConflictReason =
  | "SESSION_ID_CONFLICT"
  | "OWNER_ALREADY_ACTIVE"
  | "REGISTRY_FULL";

export class RtcSessionConflictError extends Error {
  readonly code = "RTC_SESSION_CONFLICT" as const;
  readonly reason: RtcSessionConflictReason;

  constructor(reason: RtcSessionConflictReason) {
    super("RTC_SESSION_CONFLICT");
    this.name = "RtcSessionConflictError";
    this.reason = reason;
  }
}

export type RtcSessionRegistryOptions = Readonly<{
  clock: RtcClock;
  maxSessions?: number;
  keepaliveMs?: number;
  inactivityMs?: number;
  createTransport?: (input: {
    start: NormalizedRtcStart;
  }) => RtcSessionTransport;
  onDisconnect?: (reason: RtcCloseReason) => void;
  onSessionClosed?: (sessionId: string) => void;
}>;

export type RtcStartRequest = Readonly<{
  start: NormalizedRtcStart;
  createTransport?: () => RtcSessionTransport;
}>;

export type RtcStartOutcome = Readonly<{
  session: LiveRtcSession;
  created: boolean;
}>;

export type RtcSessionRegistry = Readonly<{
  readonly size: number;
  start: (request: RtcStartRequest) => Promise<RtcStartOutcome>;
  get: (sessionId: string) => LiveRtcSession | undefined;
  close: (sessionId: string, reason: RtcCloseReason) => Promise<boolean>;
  closeAll: (reason: RtcCloseReason) => Promise<void>;
}>;

const sameIdentity = (
  session: LiveRtcSession,
  start: NormalizedRtcStart,
): boolean =>
  session.identity.media === start.media &&
  session.identity.roomId === start.roomId &&
  session.identity.rtcUserId === start.rtcUserId;

const DEFAULT_MAX_SESSIONS = 2;

/**
 * In-memory bounded session registry. One active session per owner, at most two
 * total sessions for restart overlap, and no state that survives a process
 * restart. A duplicate identical start returns the existing live session; any
 * conflicting duplicate fails with RTC_SESSION_CONFLICT.
 */
export const createRtcSessionRegistry = (
  options: RtcSessionRegistryOptions,
): RtcSessionRegistry => {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, LiveRtcSession>();
  const ownerSessions = new Map<string, string>();

  const remove = (sessionId: string, ownerId: string): void => {
    sessions.delete(sessionId);
    if (ownerSessions.get(ownerId) === sessionId) {
      ownerSessions.delete(ownerId);
    }
  };

  const start = async (request: RtcStartRequest): Promise<RtcStartOutcome> => {
    const { start: startValue } = request;
    const existing = sessions.get(startValue.platformSessionId);
    if (existing !== undefined) {
      if (!sameIdentity(existing, startValue)) {
        throw new RtcSessionConflictError("SESSION_ID_CONFLICT");
      }
      return { session: existing, created: false };
    }
    if (ownerSessions.has(startValue.ownerSubject)) {
      throw new RtcSessionConflictError("OWNER_ALREADY_ACTIVE");
    }
    if (sessions.size >= maxSessions) {
      throw new RtcSessionConflictError("REGISTRY_FULL");
    }
    const transportFactory = request.createTransport ?? options.createTransport;
    if (transportFactory === undefined) {
      throw new Error("RTC session transport factory is required");
    }
    const transport = transportFactory({ start: startValue });
    const session = createLiveRtcSession({
      start: startValue,
      clock: options.clock,
      writer: transport.writer,
      resources: transport.resources,
      onClose: (reason) => {
        remove(startValue.platformSessionId, startValue.ownerSubject);
        options.onDisconnect?.(reason);
        options.onSessionClosed?.(startValue.platformSessionId);
      },
      ...(options.keepaliveMs === undefined
        ? {}
        : { keepaliveMs: options.keepaliveMs }),
      ...(options.inactivityMs === undefined
        ? {}
        : { inactivityMs: options.inactivityMs }),
    });
    sessions.set(startValue.platformSessionId, session);
    ownerSessions.set(startValue.ownerSubject, startValue.platformSessionId);
    return { session, created: true };
  };

  return {
    get size() {
      return sessions.size;
    },
    start,
    get(sessionId) {
      return sessions.get(sessionId);
    },
    async close(sessionId, reason) {
      const session = sessions.get(sessionId);
      if (session === undefined) return false;
      await session.close(reason);
      return true;
    },
    async closeAll(reason) {
      const active = [...sessions.values()];
      await Promise.all(active.map((session) => session.close(reason)));
    },
  };
};
