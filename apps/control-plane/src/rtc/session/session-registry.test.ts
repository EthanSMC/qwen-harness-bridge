import { describe, expect, it } from "vitest";
import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";
import { KEEPALIVE_FRAME } from "../wire/sse-codec.js";
import {
  InactivityWatchdog,
  RTC_INACTIVITY_MS,
  RTC_KEEPALIVE_MS,
} from "./inactivity-watchdog.js";
import {
  createLiveRtcSession,
  createSystemClock,
  type RtcClock,
  type RtcCloseReason,
  type RtcSseWriter,
} from "./rtc-session.js";
import {
  createRtcSessionRegistry,
  RtcSessionConflictError,
  type RtcSessionTransport,
} from "./session-registry.js";

type Timer = { at: number; callback: () => void };

const createFakeClock = () => {
  let now = 0;
  let sequence = 1;
  const timers = new Map<number, Timer>();
  const clock: RtcClock = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = sequence;
      sequence += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size };
};

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

const start = (
  overrides: Partial<NormalizedRtcStart> = {},
): NormalizedRtcStart => ({
  platformSessionId: "ses_001",
  ownerSubject: "owner-1",
  media: "audio",
  roomId: "channel_001",
  rtcUserId: "consumer_001",
  rtcToken: "<RtcRoom.thirdToken>",
  rtcTokenExpiresAt: "2026-08-07T10:00:00+08:00",
  callbackIssuedAt: "2026-08-06T10:00:00+08:00",
  ...overrides,
});

const createTransport = () => {
  const writes: string[] = [];
  const events: string[] = [];
  const writer: RtcSseWriter = {
    closed: false,
    write: (frame) => {
      if (!writer.closed) writes.push(frame);
    },
    end: () => {
      writer.closed = true;
      events.push("writer.end");
    },
  };
  const resources = {
    stopOutput: () => {
      events.push("stopOutput");
    },
    closeProviderStreams: () => {
      events.push("closeProviderStreams");
    },
  };
  return { writer, resources, writes, events };
};

describe("live RTC session keepalive and inactivity", () => {
  it("writes an SSE comment keepalive every 30 seconds", () => {
    const { clock, advance } = createFakeClock();
    const transport = createTransport();
    const session = createLiveRtcSession({
      start: start(),
      clock,
      writer: transport.writer,
      resources: transport.resources,
    });
    session.touch("audio");

    advance(RTC_KEEPALIVE_MS - 1);
    expect(transport.writes).toEqual([]);
    advance(1);
    expect(transport.writes).toEqual([KEEPALIVE_FRAME]);
    advance(RTC_KEEPALIVE_MS);
    expect(transport.writes).toEqual([KEEPALIVE_FRAME, KEEPALIVE_FRAME]);
  });

  it("keeps the session open at 89 seconds and closes it at exactly 90 seconds", async () => {
    const { clock, advance } = createFakeClock();
    const transport = createTransport();
    const closed: RtcCloseReason[] = [];
    const session = createLiveRtcSession({
      start: start(),
      clock,
      writer: transport.writer,
      resources: transport.resources,
      onClose: (reason) => closed.push(reason),
    });

    advance(RTC_INACTIVITY_MS - 1);
    expect(session.closed).toBe(false);
    expect(closed).toEqual([]);

    advance(1);
    expect(session.closed).toBe(true);
    await settle();
    expect(closed).toEqual(["inactive"]);
    expect(transport.events).toEqual([
      "stopOutput",
      "closeProviderStreams",
      "writer.end",
    ]);
  });

  it("resets inactivity only for audio, control or successful output activity", async () => {
    const { clock, advance } = createFakeClock();
    const transport = createTransport();
    const session = createLiveRtcSession({
      start: start(),
      clock,
      writer: transport.writer,
      resources: transport.resources,
    });

    advance(80_000);
    session.touch("audio");
    advance(89_999);
    expect(session.closed).toBe(false);
    session.touch("control");
    advance(60_000);
    expect(session.closed).toBe(false);
    session.touch("output");
    advance(RTC_INACTIVITY_MS - 1);
    expect(session.closed).toBe(false);
    advance(1);
    expect(session.closed).toBe(true);
  });

  it("stops keepalive and disposal after close and closes exactly once", async () => {
    const { clock, advance } = createFakeClock();
    const transport = createTransport();
    const closed: RtcCloseReason[] = [];
    const session = createLiveRtcSession({
      start: start(),
      clock,
      writer: transport.writer,
      resources: transport.resources,
      onClose: (reason) => closed.push(reason),
    });

    await Promise.all([
      session.close("platform_close"),
      session.close("user_exit"),
    ]);
    await session.close("inactive");

    expect(closed).toEqual(["platform_close"]);
    expect(transport.events).toEqual([
      "stopOutput",
      "closeProviderStreams",
      "writer.end",
    ]);
    advance(RTC_KEEPALIVE_MS * 3);
    expect(transport.writes).toEqual([]);
  });
});

describe("bounded RTC session registry", () => {
  const optionsFor = (transports: ReturnType<typeof createTransport>[]) => {
    const { clock, advance } = createFakeClock();
    const disconnects: RtcCloseReason[] = [];
    let created = 0;
    const registry = createRtcSessionRegistry({
      clock,
      maxSessions: 2,
      onDisconnect: (reason) => disconnects.push(reason),
      createTransport: () => {
        const transport = createTransport();
        transports.push(transport);
        created += 1;
        return transport satisfies RtcSessionTransport;
      },
    });
    return {
      registry,
      clock,
      advance,
      disconnects,
      createdCount: () => created,
    };
  };

  it("registers one active session per owner", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry } = optionsFor(transports);

    const outcome = await registry.start({ start: start() });

    expect(outcome.created).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get("ses_001")?.ownerId).toBe("owner-1");
    expect(outcome.session.startedAt).toBeInstanceOf(Date);
  });

  it("returns the existing stream for a duplicate identical start", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry, createdCount } = optionsFor(transports);

    const first = await registry.start({ start: start() });
    const second = await registry.start({ start: start() });

    expect(second.created).toBe(false);
    expect(second.session).toBe(first.session);
    expect(createdCount()).toBe(1);
    expect(registry.size).toBe(1);
  });

  it("rejects a conflicting duplicate that changes the room or user", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry } = optionsFor(transports);
    await registry.start({ start: start() });

    for (const conflicting of [
      start({ roomId: "channel_002" }),
      start({ rtcUserId: "consumer_002" }),
    ]) {
      await expect(
        registry.start({ start: conflicting }),
      ).rejects.toBeInstanceOf(RtcSessionConflictError);
    }
    await expect(
      registry.start({ start: start({ roomId: "channel_002" }) }),
    ).rejects.toMatchObject({
      code: "RTC_SESSION_CONFLICT",
    });
    expect(registry.size).toBe(1);
  });

  it("rejects a second session for the same owner and allows at most two total sessions", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry } = optionsFor(transports);

    await registry.start({ start: start() });
    await expect(
      registry.start({ start: start({ platformSessionId: "ses_002" }) }),
    ).rejects.toMatchObject({ code: "RTC_SESSION_CONFLICT" });

    await registry.start({
      start: start({ platformSessionId: "ses_003", ownerSubject: "owner-2" }),
    });
    expect(registry.size).toBe(2);
    await expect(
      registry.start({
        start: start({ platformSessionId: "ses_004", ownerSubject: "owner-3" }),
      }),
    ).rejects.toMatchObject({ code: "RTC_SESSION_CONFLICT" });
    expect(registry.size).toBe(2);
  });

  it("closes on platform close exactly once and disposes the transport", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry, disconnects } = optionsFor(transports);
    await registry.start({ start: start() });

    expect(await registry.close("ses_001", "platform_close")).toBe(true);
    expect(await registry.close("ses_001", "platform_close")).toBe(false);

    expect(registry.size).toBe(0);
    expect(disconnects).toEqual(["platform_close"]);
    expect(transports[0]?.events).toEqual([
      "stopOutput",
      "closeProviderStreams",
      "writer.end",
    ]);
  });

  it("closes every session once on server shutdown", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry, disconnects } = optionsFor(transports);
    await registry.start({ start: start() });
    await registry.start({
      start: start({ platformSessionId: "ses_003", ownerSubject: "owner-2" }),
    });

    await registry.closeAll("server_shutdown");
    await registry.closeAll("server_shutdown");

    expect(registry.size).toBe(0);
    expect(disconnects).toEqual(["server_shutdown", "server_shutdown"]);
    for (const transport of transports) {
      expect(
        transport.events.filter((event) => event === "writer.end"),
      ).toHaveLength(1);
    }
  });

  it("does not persist session state across a new registry instance", async () => {
    const transports: ReturnType<typeof createTransport>[] = [];
    const { registry } = optionsFor(transports);
    await registry.start({ start: start() });

    const restarted = createRtcSessionRegistry({
      clock: createSystemClock(),
      createTransport: () => createTransport(),
    });
    expect(restarted.size).toBe(0);
    expect(restarted.get("ses_001")).toBeUndefined();
  });
});

describe("inactivity watchdog", () => {
  it("is a bounded timer pair with the documented defaults", () => {
    expect(RTC_KEEPALIVE_MS).toBe(30_000);
    expect(RTC_INACTIVITY_MS).toBe(90_000);
    const { clock } = createFakeClock();
    const watchdog = new InactivityWatchdog({
      clock,
      writeKeepalive: () => undefined,
      onInactive: () => undefined,
    });
    watchdog.start();
    watchdog.touch("output");
    watchdog.stop();
  });
});
