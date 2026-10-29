import { describe, expect, it } from "vitest";
import {
  createRtcProviderComposition,
  type RtcProviderClients,
} from "./composition.js";
import type { RtcConfig, RtcProviderSettings } from "./config.js";
import type { NormalizedRtcStart } from "./wire/qwen-rtc-schema.js";

const SETTINGS: RtcProviderSettings = {
  aliyunAppId: "app-id",
  aliyunAccessKeyId: "access-key-id",
  aliyunAccessKeySecret: "access-key-secret",
  dashscopeApiKey: "server-secret-api-key",
  dashscopeAsrModel: "paraformer-realtime-v2",
};

const enabledConfig: RtcConfig = {
  enabled: true,
  ownerSubject: "owner-subject-1",
  signingSecret: "rtc-adapter-signing-secret-value-0123456789",
  callbackUrl: "https://control-plane.example.com/rtc/session",
  allowedMedia: ["audio"],
  provider: "ALIYUN_RTC",
  providers: SETTINGS,
};

const start: NormalizedRtcStart = {
  platformSessionId: "ses_composed",
  ownerSubject: "owner-subject-1",
  media: "audio",
  roomId: "channel_composed",
  rtcUserId: "consumer_composed",
  rtcToken: "short-lived-rtc-token",
  rtcTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  callbackIssuedAt: "2026-08-06T10:00:00.000Z",
};

const waitFor = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("rtc provider composition", () => {
  it("stays bounded instead of throwing when it cannot compose", () => {
    expect(
      createRtcProviderComposition({ config: { enabled: false } }),
    ).toEqual({ available: false, reason: "disabled" });
    expect(
      createRtcProviderComposition({
        config: { ...enabledConfig, providers: undefined },
      }),
    ).toEqual({ available: false, reason: "credentials_missing" });
    expect(createRtcProviderComposition({ config: enabledConfig })).toEqual({
      available: false,
      reason: "provider_unavailable",
    });
  });

  it("builds real consumer, asr and output factories from server settings", async () => {
    const joined: Array<{
      channelId: string;
      userId: string;
      token: string;
      expiresAt: string;
    }> = [];
    const opened: Array<{ apiKey: string; model: string }> = [];
    let left = 0;
    const clients: RtcProviderClients = {
      consumer: () => ({
        async join(request) {
          joined.push(request);
          return {
            publisherUserId: request.userId,
            frames: (async function* frames() {
              yield {
                pcm16le: new Uint8Array(6_400),
                sampleRateHz: 16_000,
                channels: 1,
                sequence: 0,
              };
            })(),
            close: async () => {
              left += 1;
            },
          };
        },
      }),
      asr: () => ({
        async open(options) {
          opened.push({ apiKey: options.apiKey, model: options.model });
          return {
            async send() {},
            async finish() {},
            async abort() {},
            events: {
              async *[Symbol.asyncIterator]() {
                yield {
                  kind: "final" as const,
                  text: "已完成",
                  startedAtMs: 0,
                  endedAtMs: 10,
                  id: "final-1",
                };
              },
            },
          };
        },
      }),
    };

    const result = createRtcProviderComposition({
      config: enabledConfig,
      clients,
    });
    if (!result.available) throw new Error("composition unavailable");
    expect(result.settings).toEqual(SETTINGS);

    const first = { audio: 0, final: 0 };
    const input = { start, settings: SETTINGS };
    const consumerHandle = await result.composition.consumer?.(
      "ses_composed",
      input,
      { onFirstAudio: () => (first.audio += 1) },
    );
    await result.composition.asr?.("ses_composed", input, {
      onFinal: () => (first.final += 1),
      onFailure: () => undefined,
    });

    await waitFor(
      () => first.audio === 1 && first.final === 1,
      "composed provider events",
    );
    expect(joined).toEqual([
      {
        channelId: start.roomId,
        userId: start.rtcUserId,
        token: start.rtcToken,
        expiresAt: start.rtcTokenExpiresAt,
      },
    ]);
    expect(opened).toEqual([
      {
        apiKey: SETTINGS.dashscopeApiKey,
        model: SETTINGS.dashscopeAsrModel,
      },
    ]);

    await consumerHandle?.close();
    await consumerHandle?.close();
    expect(left).toBe(1);

    let writerEnded = 0;
    const writer = {
      closed: false,
      write: () => undefined,
      end: () => {
        writerEnded += 1;
      },
    };
    const outputHandle = await result.composition.output?.(
      "ses_composed",
      writer,
      input,
      { onFirstOutput: () => undefined },
    );
    await outputHandle?.close();
    await outputHandle?.close();
    expect(writerEnded).toBeLessThanOrEqual(2);
  });
});
