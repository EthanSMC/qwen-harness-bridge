import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";
import {
  type AliyunRtcClient,
  type AliyunRtcSubscription,
  createAliyunRtcConsumer,
} from "./aliyun-rtc-consumer.js";
import {
  type AsrProviderEvent,
  createDashScopeAsr,
  type DashScopeAsrClient,
} from "./dashscope-asr.js";
import {
  type AudioFrame,
  createProviderResources,
  RtcAudioError,
  type RtcAudioInputFrame,
  RtcProviderError,
} from "./types.js";

const providerRoot = dirname(fileURLToPath(import.meta.url));

const start = (
  overrides: Partial<NormalizedRtcStart> = {},
): NormalizedRtcStart => ({
  platformSessionId: "ses_001",
  ownerSubject: "owner-1",
  media: "audio",
  roomId: "channel_001",
  rtcUserId: "consumer_001",
  rtcToken: "short-lived-rtc-token-value",
  rtcTokenExpiresAt: "2026-08-07T10:00:00+08:00",
  callbackIssuedAt: "2026-08-06T10:00:00+08:00",
  ...overrides,
});

const pcm16 = (samples: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    bytes[index * 2] = sample & 0xff;
    bytes[index * 2 + 1] = (sample >> 8) & 0xff;
  });
  return bytes;
};

const inputFrame = (sequence: number): RtcAudioInputFrame => ({
  pcm16le: pcm16(new Array(3_200).fill(1_000)),
  sampleRateHz: 16_000,
  channels: 1,
  sequence,
});

const manualSource = () => {
  const queue: RtcAudioInputFrame[] = [];
  let waiting: (() => void) | undefined;
  let closed = false;
  return {
    push(frame: RtcAudioInputFrame) {
      queue.push(frame);
      waiting?.();
    },
    close() {
      closed = true;
      waiting?.();
    },
    async *iterate() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as RtcAudioInputFrame;
        if (closed) return;
        await new Promise<void>((resolve) => {
          waiting = () => {
            waiting = undefined;
            resolve();
          };
        });
      }
    },
  };
};

const subscription = (
  publisherUserId: string,
  source: ReturnType<typeof manualSource>,
): AliyunRtcSubscription & { closedCount: () => number } => {
  let closes = 0;
  return {
    publisherUserId,
    frames: source.iterate(),
    async close() {
      closes += 1;
      source.close();
    },
    closedCount: () => closes,
  };
};

describe("aliyun rtc consumer", () => {
  it("joins with the session token and normalizes owner audio frames", async () => {
    const source = manualSource();
    const sub = subscription("consumer_001", source);
    const joinRequests: unknown[] = [];
    const client: AliyunRtcClient = {
      async join(request) {
        joinRequests.push(request);
        return sub;
      },
    };
    const firstFrames: number[] = [];
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-06T10:00:00+08:00"),
      onFirstFrame: (frame: AudioFrame) => firstFrames.push(frame.sequence),
    });
    const controller = new AbortController();

    const stream = await consumer.join(start(), controller.signal);
    source.push(inputFrame(0));
    source.push(inputFrame(1));

    const collected: AudioFrame[] = [];
    for await (const frame of stream) {
      collected.push(frame);
      if (collected.length === 2) source.close();
    }

    expect(joinRequests).toHaveLength(1);
    expect(joinRequests[0]).toMatchObject({
      channelId: "channel_001",
      userId: "consumer_001",
      token: "short-lived-rtc-token-value",
    });
    expect(collected).toHaveLength(2);
    expect(collected.every((frame) => frame.sampleRateHz === 16_000)).toBe(
      true,
    );
    expect(collected.map((frame) => frame.sequence)).toEqual([0, 1]);
    expect(firstFrames).toEqual([0]);
  });

  it("rejects an expired provider token before joining", async () => {
    let joined = false;
    const client: AliyunRtcClient = {
      async join() {
        joined = true;
        return subscription("consumer_001", manualSource());
      },
    };
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-08T00:00:00+08:00"),
    });

    await expect(
      consumer.join(start(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "RTC_TOKEN_EXPIRED" });
    expect(joined).toBe(false);
  });

  it("rejects an unexpected publisher and closes the subscription once", async () => {
    const sub = subscription("intruder_002", manualSource());
    const client: AliyunRtcClient = {
      async join() {
        return sub;
      },
    };
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-06T10:00:00+08:00"),
    });

    await expect(
      consumer.join(start(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "RTC_PUBLISHER_REJECTED" });
    expect(sub.closedCount()).toBe(1);
    await consumer.leave();
    await consumer.leave();
    expect(sub.closedCount()).toBe(1);
  });

  it("stops immediately on abort and makes leave idempotent", async () => {
    const source = manualSource();
    const sub = subscription("consumer_001", source);
    const client: AliyunRtcClient = {
      async join() {
        return sub;
      },
    };
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-06T10:00:00+08:00"),
    });
    const controller = new AbortController();
    const stream = await consumer.join(start(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();

    source.push(inputFrame(0));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const pending = iterator.next();

    controller.abort();
    const ended = await pending;
    expect(ended.done).toBe(true);

    await consumer.leave();
    await consumer.leave();
    expect(sub.closedCount()).toBe(1);
  });

  it("surfaces a bounded disconnect reason without the provider token", async () => {
    const source = manualSource();
    const sub = subscription("consumer_001", source);
    const client: AliyunRtcClient = {
      async join() {
        return sub;
      },
    };
    const reasons: string[] = [];
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-06T10:00:00+08:00"),
      onDisconnect: (reason) => reasons.push(reason),
    });
    const stream = await consumer.join(start(), new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    source.push(inputFrame(0));
    await iterator.next();
    source.close();
    await iterator.next();

    expect(reasons).toEqual(["stream_closed"]);
    expect(JSON.stringify(reasons)).not.toContain(
      "short-lived-rtc-token-value",
    );
  });
});

type AsrEvent = {
  kind: "partial" | "final";
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  id?: string;
};

const asrStream = (events: readonly AsrEvent[]) => {
  const sends: number[] = [];
  let aborted = 0;
  let finished = 0;
  const stream = {
    async send(pcm: Uint8Array) {
      sends.push(pcm.length);
    },
    async finish() {
      finished += 1;
    },
    async abort() {
      aborted += 1;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    },
  };
  return {
    stream,
    sends: () => sends,
    aborted: () => aborted,
    finished: () => finished,
  };
};

const framesSource = (frames: readonly AudioFrame[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const frame of frames) yield frame;
  },
});

const audioFrame = (sequence: number): AudioFrame => ({
  pcm16le: pcm16(new Array(3_200).fill(1_000)),
  sampleRateHz: 16_000,
  channels: 1,
  sequence,
});

describe("dashscope streaming asr", () => {
  it("forwards partials and finals while dropping empty and duplicate finals", async () => {
    const events: AsrEvent[] = [
      { kind: "partial", text: "让 DeepSeek", startedAtMs: 0, endedAtMs: 200 },
      { kind: "final", text: "", startedAtMs: 0, endedAtMs: 300, id: "f1" },
      {
        kind: "final",
        text: "让 DeepSeek 跑测试",
        startedAtMs: 0,
        endedAtMs: 400,
        id: "f2",
      },
      {
        kind: "final",
        text: "让 DeepSeek 跑测试",
        startedAtMs: 0,
        endedAtMs: 500,
        id: "f2",
      },
      {
        kind: "final",
        text: "让 DeepSeek 跑测试",
        startedAtMs: 0,
        endedAtMs: 600,
      },
    ];
    const fake = asrStream(events);
    const client: DashScopeAsrClient = {
      async open() {
        return fake.stream;
      },
    };
    const asr = createDashScopeAsr({ client, apiKey: "server-secret-api-key" });
    const controller = new AbortController();
    const collected: AsrEvent[] = [];
    for await (const event of asr.recognize(
      framesSource([audioFrame(0)]),
      controller.signal,
    )) {
      collected.push(event as AsrEvent);
    }

    expect(collected.map((event) => event.text)).toEqual([
      "让 DeepSeek",
      "让 DeepSeek 跑测试",
    ]);
    expect(collected.filter((event) => event.kind === "final")).toHaveLength(1);
    expect(fake.sends()).toEqual([6_400]);
  });

  it("applies backpressure by awaiting each send before the next frame", async () => {
    let releaseSend: (() => void) | undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const sends: number[] = [];
    const client: DashScopeAsrClient = {
      async open() {
        return {
          async send(pcm: Uint8Array) {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            sends.push(pcm.length);
            await new Promise<void>((resolve) => {
              releaseSend = resolve;
            });
            inFlight -= 1;
          },
          async finish() {},
          async abort() {},
          events: {
            async *[Symbol.asyncIterator]() {
              yield* [];
            },
          },
        };
      },
    };
    const asr = createDashScopeAsr({ client, apiKey: "server-secret-api-key" });
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const _event of asr.recognize(
        framesSource([audioFrame(0), audioFrame(1), audioFrame(2)]),
        controller.signal,
      )) {
        // drain
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toHaveLength(1);
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toHaveLength(2);
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSend?.();
    await consuming;
    expect(maxInFlight).toBe(1);
  });

  it("aborts the provider stream immediately when the session closes", async () => {
    const fake = asrStream([
      { kind: "partial", text: "部分", startedAtMs: 0, endedAtMs: 200 },
    ]);
    const client: DashScopeAsrClient = {
      async open() {
        return fake.stream;
      },
    };
    const asr = createDashScopeAsr({ client, apiKey: "server-secret-api-key" });
    const controller = new AbortController();
    const consuming = (async () => {
      const events: AsrEvent[] = [];
      for await (const event of asr.recognize(
        framesSource([audioFrame(0)]),
        controller.signal,
      )) {
        events.push(event as AsrEvent);
        controller.abort();
      }
      return events;
    })();

    const events = await consuming;
    expect(events).toHaveLength(1);
    expect(fake.aborted()).toBe(1);
  });

  it("reconnects once after an ASR open failure and fails closed twice", async () => {
    let opens = 0;
    const fake = asrStream([
      { kind: "final", text: "好", startedAtMs: 0, endedAtMs: 10, id: "x" },
    ]);
    const client: DashScopeAsrClient = {
      async open() {
        opens += 1;
        if (opens === 1) throw new Error("reconnect required");
        return fake.stream;
      },
    };
    const asr = createDashScopeAsr({ client, apiKey: "server-secret-api-key" });
    const events: AsrEvent[] = [];
    for await (const event of asr.recognize(
      framesSource([audioFrame(0)]),
      new AbortController().signal,
    )) {
      events.push(event as AsrEvent);
      break;
    }
    expect(opens).toBe(2);
    expect(events[0]?.text).toBe("好");

    const failing: DashScopeAsrClient = {
      async open() {
        throw new Error("provider unavailable");
      },
    };
    const broken = createDashScopeAsr({
      client: failing,
      apiKey: "server-secret-api-key",
    });
    try {
      for await (const _event of broken.recognize(
        framesSource([audioFrame(0)]),
        new AbortController().signal,
      )) {
        // unreachable
      }
      throw new Error("expected RTC_ASR_FAILED");
    } catch (error) {
      expect(error).toBeInstanceOf(RtcProviderError);
      expect((error as RtcProviderError).code).toBe("RTC_ASR_FAILED");
      expect((error as Error).message).not.toContain("server-secret-api-key");
    }
  });
});

describe("provider resource integration", () => {
  it("maps provider shutdown onto Task 2 resources idempotently", async () => {
    let leaves = 0;
    let aborts = 0;
    const resources = createProviderResources({
      consumer: {
        async join() {
          return framesSource([]);
        },
        async leave() {
          leaves += 1;
        },
      },
      asr: {
        async abort() {
          aborts += 1;
        },
      },
    });

    await resources.stopOutput();
    await resources.stopOutput();
    await resources.closeProviderStreams();
    await resources.closeProviderStreams();

    expect(aborts).toBe(1);
    expect(leaves).toBe(1);
  });

  it("keeps provider sources free of filesystem, database and audio logging", () => {
    const files = readdirSync(providerRoot).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(providerRoot, file), "utf8");
      expect(text).not.toMatch(
        /node:fs|node:sqlite|drizzle|writeFile|appendFile|createWriteStream/u,
      );
      expect(text).not.toMatch(/console\.(?:log|debug|info)/u);
      expect(text).not.toMatch(/pcm16le\s*[:=]\s*Buffer/u);
    }
  });
});

describe("consumer audio error propagation", () => {
  it("preserves RTC_AUDIO_GAP instead of mapping it to a consumer failure", async () => {
    const source = manualSource();
    const sub = subscription("consumer_001", source);
    const client: AliyunRtcClient = {
      async join() {
        return sub;
      },
    };
    const consumer = createAliyunRtcConsumer({
      client,
      now: () => Date.parse("2026-08-06T10:00:00+08:00"),
    });
    const stream = await consumer.join(start(), new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();

    source.push(inputFrame(0));
    source.push(inputFrame(4));
    await iterator.next();
    try {
      await iterator.next();
      throw new Error("expected RTC_AUDIO_GAP");
    } catch (error) {
      expect(error).toBeInstanceOf(RtcAudioError);
      expect((error as RtcAudioError).code).toBe("RTC_AUDIO_GAP");
      expect((error as Error).message).not.toContain(
        "short-lived-rtc-token-value",
      );
    }
  });
});

const hangingEvents = {
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        new Promise<IteratorResult<AsrProviderEvent>>(() => undefined),
    };
  },
};

const failingClient = (failure: "send" | "finish" | "events") => {
  let aborts = 0;
  const client: DashScopeAsrClient = {
    async open() {
      return {
        async send() {
          if (failure === "send") throw new Error("send failed");
        },
        async finish() {
          if (failure === "finish") throw new Error("finish failed");
        },
        async abort() {
          aborts += 1;
        },
        events:
          failure === "events"
            ? {
                async *[Symbol.asyncIterator]() {
                  yield {
                    kind: "partial" as const,
                    text: "a",
                    startedAtMs: 0,
                    endedAtMs: 1,
                  };
                  throw new Error("event stream failed");
                },
              }
            : (hangingEvents as AsyncIterable<AsrProviderEvent>),
      };
    },
  };
  return { client, aborts: () => aborts };
};

describe("asr abort and failure boundaries", () => {
  it("aborts immediately while waiting for the next provider event", async () => {
    let aborts = 0;
    const client: DashScopeAsrClient = {
      async open() {
        return {
          async send() {},
          async finish() {},
          async abort() {
            aborts += 1;
          },
          events: hangingEvents as AsyncIterable<AsrProviderEvent>,
        };
      },
    };
    const asr = createDashScopeAsr({ client, apiKey: "server-secret-api-key" });
    const controller = new AbortController();
    const iterator = asr
      .recognize(framesSource([audioFrame(0)]), controller.signal)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 20));

    controller.abort();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(aborts).toBe(1);
  });

  it.each(["send", "finish"] as const)(
    "fails closed when %s fails",
    async (failure) => {
      const fake = failingClient(failure);
      const asr = createDashScopeAsr({
        client: fake.client,
        apiKey: "server-secret-api-key",
      });
      let rejection: unknown;
      try {
        for await (const _event of asr.recognize(
          framesSource([audioFrame(0)]),
          new AbortController().signal,
        )) {
          // drain
        }
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(RtcProviderError);
      expect((rejection as RtcProviderError).code).toBe("RTC_ASR_FAILED");
      expect((rejection as Error).message).not.toContain(
        "server-secret-api-key",
      );
      expect(fake.aborts()).toBe(1);
    },
  );

  it("fails closed when the provider event stream throws", async () => {
    const fake = failingClient("events");
    const asr = createDashScopeAsr({
      client: fake.client,
      apiKey: "server-secret-api-key",
    });
    let rejection: unknown;
    try {
      for await (const _event of asr.recognize(
        framesSource([audioFrame(0)]),
        new AbortController().signal,
      )) {
        // drain
      }
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(RtcProviderError);
    expect((rejection as RtcProviderError).code).toBe("RTC_ASR_FAILED");
    expect((rejection as Error).message).not.toContain("server-secret-api-key");
  });
});
