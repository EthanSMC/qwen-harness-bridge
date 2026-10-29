import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";
import { KEEPALIVE_FRAME } from "../wire/sse-codec.js";
import { InactivityWatchdog } from "./inactivity-watchdog.js";

export type RtcCloseReason =
  | "platform_close"
  | "user_exit"
  | "inactive"
  | "token_expired"
  | "provider_error"
  | "server_shutdown";

export type RtcActivityKind = "audio" | "control" | "output";

/** Extra detail for an activity event; output only counts when it succeeded. */
export type RtcActivityDetail = Readonly<{ succeeded?: boolean }>;

/** Injected clock so lifecycle boundaries are deterministic in tests. */
export type RtcClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export const createSystemClock = (): RtcClock => ({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Minimal SSE writer the lifecycle owns; the HTTP layer adapts a response. */
export type RtcSseWriter = {
  closed: boolean;
  write(frame: string): void;
  end(): void;
};

/** Provider-side resources disposed exactly once on close. */
export type RtcProviderResources = Readonly<{
  stopOutput: () => Promise<void> | void;
  closeProviderStreams: () => Promise<void> | void;
}>;

export type RtcSessionIdentity = Readonly<{
  ownerId: string;
  media: string;
  roomId: string;
  rtcUserId: string;
}>;

export type LiveRtcSession = Readonly<{
  id: string;
  ownerId: string;
  startedAt: Date;
  identity: RtcSessionIdentity;
  readonly closed: boolean;
  touch: (kind: RtcActivityKind, detail?: RtcActivityDetail) => void;
  /** Attaches a second SSE writer (duplicate identical start). */
  attach: (writer: RtcSseWriter) => () => void;
  close: (reason: RtcCloseReason) => Promise<void>;
}>;

export type CreateLiveRtcSessionOptions = Readonly<{
  start: NormalizedRtcStart;
  clock: RtcClock;
  writer: RtcSseWriter;
  resources: RtcProviderResources;
  onClose?: (reason: RtcCloseReason) => void;
  /** First real audio/output activity from the provider composition. */
  lifecycle?: Readonly<{
    firstAudio?: () => void;
    firstOutput?: () => void;
  }>;
  keepaliveMs?: number;
  inactivityMs?: number;
}>;

const dispose = async (
  resources: RtcProviderResources,
  writers: readonly RtcSseWriter[],
): Promise<unknown> => {
  let failure: unknown;
  for (const step of [
    () => resources.stopOutput(),
    () => resources.closeProviderStreams(),
  ]) {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  }
  for (const writer of writers) {
    try {
      writer.end();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
};

/**
 * One live RTC session. Close is exactly-once: a second call returns the same
 * promise, the keepalive and token-expiry timers stop, provider streams and
 * every attached SSE writer are disposed once and the close callback runs once.
 */
export const createLiveRtcSession = (
  options: CreateLiveRtcSessionOptions,
): LiveRtcSession => {
  const { start, clock, writer, resources } = options;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const attached = new Set<RtcSseWriter>();
  let firstAudioNotified = false;
  let firstOutputNotified = false;
  let expiryHandle: unknown;

  const writers = (): RtcSseWriter[] => [writer, ...attached];

  const broadcast = (frame: string): void => {
    if (closed) return;
    for (const target of writers()) {
      if (target.closed) continue;
      try {
        target.write(frame);
      } catch {
        // A broken subscriber must not stop keepalive for the others.
      }
    }
  };

  const watchdog = new InactivityWatchdog({
    clock,
    writeKeepalive: () => broadcast(KEEPALIVE_FRAME),
    onInactive: () => {
      void session.close("inactive");
    },
    ...(options.keepaliveMs === undefined
      ? {}
      : { keepaliveMs: options.keepaliveMs }),
    ...(options.inactivityMs === undefined
      ? {}
      : { inactivityMs: options.inactivityMs }),
  });

  const session: LiveRtcSession = {
    id: start.platformSessionId,
    ownerId: start.ownerSubject,
    startedAt: new Date(clock.now()),
    identity: {
      ownerId: start.ownerSubject,
      media: start.media,
      roomId: start.roomId,
      rtcUserId: start.rtcUserId,
    },
    get closed() {
      return closed;
    },
    touch(kind, detail) {
      if (closed) return;
      if (kind === "output" && detail?.succeeded !== true) return;
      if (kind === "audio" && !firstAudioNotified) {
        firstAudioNotified = true;
        options.lifecycle?.firstAudio?.();
      }
      if (kind === "output" && !firstOutputNotified) {
        firstOutputNotified = true;
        options.lifecycle?.firstOutput?.();
      }
      watchdog.touch(kind);
    },
    attach(target) {
      if (closed) {
        target.end();
        return () => undefined;
      }
      attached.add(target);
      return () => {
        attached.delete(target);
      };
    },
    close(reason) {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      watchdog.stop();
      if (expiryHandle !== undefined) {
        clock.clearTimeout(expiryHandle);
        expiryHandle = undefined;
      }
      const targets = writers();
      closePromise = (async () => {
        let failure = await dispose(resources, targets);
        try {
          options.onClose?.(reason);
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      })();
      return closePromise;
    },
  };

  const tokenExpiresAtMs = Date.parse(start.rtcTokenExpiresAt);
  if (Number.isFinite(tokenExpiresAtMs)) {
    const remaining = tokenExpiresAtMs - clock.now();
    expiryHandle = clock.setTimeout(
      () => {
        expiryHandle = undefined;
        void session.close("token_expired");
      },
      Math.max(1, remaining),
    );
  }

  watchdog.start();
  return session;
};
