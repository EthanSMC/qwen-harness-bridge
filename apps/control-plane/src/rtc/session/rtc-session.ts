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
  touch: (kind: RtcActivityKind) => void;
  close: (reason: RtcCloseReason) => Promise<void>;
}>;

export type CreateLiveRtcSessionOptions = Readonly<{
  start: NormalizedRtcStart;
  clock: RtcClock;
  writer: RtcSseWriter;
  resources: RtcProviderResources;
  onClose?: (reason: RtcCloseReason) => void;
  keepaliveMs?: number;
  inactivityMs?: number;
}>;

const dispose = async (
  resources: RtcProviderResources,
  writer: RtcSseWriter,
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
  try {
    writer.end();
  } catch (error) {
    failure ??= error;
  }
  return failure;
};

/**
 * One live RTC session. Close is exactly-once: a second call returns the same
 * promise, the keepalive stops, provider streams and the SSE writer are disposed
 * once and the close callback runs once.
 */
export const createLiveRtcSession = (
  options: CreateLiveRtcSessionOptions,
): LiveRtcSession => {
  const { start, clock, writer, resources } = options;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const watchdog = new InactivityWatchdog({
    clock,
    writeKeepalive: () => {
      if (!closed) writer.write(KEEPALIVE_FRAME);
    },
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
      media: start.media,
      roomId: start.roomId,
      rtcUserId: start.rtcUserId,
    },
    get closed() {
      return closed;
    },
    touch(kind) {
      if (closed) return;
      watchdog.touch(kind);
    },
    close(reason) {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      watchdog.stop();
      closePromise = (async () => {
        let failure = await dispose(resources, writer);
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

  watchdog.start();
  return session;
};
