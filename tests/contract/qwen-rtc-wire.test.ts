import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMetricsRegistry } from "../../apps/control-plane/src/http/metrics.js";
import {
  createRtcRuntime,
  loadRtcConfig,
} from "../../apps/control-plane/src/rtc/config.js";
import { createRtcModule } from "../../apps/control-plane/src/rtc/module.js";
import {
  RtcWireError,
  verifyQwenRtcClose,
  verifyQwenRtcStart,
} from "../../apps/control-plane/src/rtc/wire/qwen-rtc-schema.js";
import {
  encodeOutputFrame,
  KEEPALIVE_FRAME,
  parseOutputFrame,
  toWireActions,
} from "../../apps/control-plane/src/rtc/wire/sse-codec.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "qwen-rtc",
);
const read = (name: string): string =>
  readFileSync(join(fixtures, name), "utf8");
const SECRET = "rtc-adapter-signing-secret-value-0123456789";
const OWNER = "owner-subject-1";
const CALLBACK_PATH = "/rtc/session";

const signatureFor = (
  rawBody: string,
  timestamp: string,
  nonce: string,
  path = CALLBACK_PATH,
): string =>
  createHmac("sha256", SECRET)
    .update(
      [
        "POST",
        path,
        timestamp,
        nonce,
        createHash("sha256").update(rawBody, "utf8").digest("hex"),
      ].join("\n"),
    )
    .digest("hex");

const headersFor = (rawBody: string, timestamp: string, nonce: string) => ({
  "x-qhb-signature": signatureFor(rawBody, timestamp, nonce),
  "x-qhb-timestamp": timestamp,
  "x-qhb-nonce": nonce,
  "x-qhb-owner-subject": OWNER,
});

const startInput = (overrides: Record<string, unknown> = {}) => {
  const rawBody = read("start-request.json");
  const timestamp = "2026-08-06T02:00:30Z";
  const nonce = "nonce-0001";
  return {
    rawBody,
    method: "POST",
    path: CALLBACK_PATH,
    headers: headersFor(rawBody, timestamp, nonce),
    ownerSubject: OWNER,
    signingSecret: SECRET,
    callbackUrl: "https://control-plane.example.com/rtc/session",
    media: "audio",
    allowedMedia: ["audio"],
    now: "2026-08-06T10:01:00+08:00",
    ...overrides,
  };
};

const expectCode = (action: () => unknown, code: string): void => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RtcWireError);
    expect((error as RtcWireError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} rejection`);
};

describe("qwen rtc start callback", () => {
  it("parses the official start fixture into the normalized contract", () => {
    const start = verifyQwenRtcStart(startInput() as never);

    expect(start).toEqual({
      platformSessionId: "ses_001",
      ownerSubject: OWNER,
      media: "audio",
      roomId: "channel_001",
      rtcUserId: "third_party_consumer_001",
      rtcToken: "<RtcRoom.thirdToken>",
      rtcTokenExpiresAt: "2026-08-07T10:00:00+08:00",
      callbackIssuedAt: "2026-08-06T10:00:00+08:00",
    });
  });

  it("rejects a wrong signature with a constant-time comparison", () => {
    const input = startInput();
    const headers = {
      ...(input.headers as Record<string, string>),
      "x-qhb-signature": "0".repeat(64),
    };
    expectCode(
      () => verifyQwenRtcStart({ ...input, headers } as never),
      "INVALID_SIGNATURE",
    );
  });

  it("rejects a missing or malformed signature header", () => {
    const input = startInput();
    expectCode(
      () =>
        verifyQwenRtcStart({
          ...input,
          headers: {
            ...(input.headers as Record<string, string>),
            "x-qhb-signature": undefined,
          },
        } as never),
      "INVALID_SIGNATURE",
    );
  });

  it("rejects an unknown owner subject", () => {
    const input = startInput();
    expectCode(
      () =>
        verifyQwenRtcStart({
          ...input,
          headers: {
            ...(input.headers as Record<string, string>),
            "x-qhb-owner-subject": "someone-else",
          },
        } as never),
      "UNKNOWN_OWNER",
    );
  });

  it("rejects a timestamp skew beyond five minutes", () => {
    const input = startInput({ now: "2026-08-06T02:06:01Z" });
    expectCode(() => verifyQwenRtcStart(input as never), "STALE_TIMESTAMP");
  });

  it("rejects an expired rtc token", () => {
    const timestamp = "2026-08-06T02:00:30Z";
    const nonce = "nonce-expired";
    const expired = JSON.parse(read("start-request.json"));
    expired.payload.rtc.expiresAt = "2026-08-06T01:59:59Z";
    const rawBody = JSON.stringify(expired);
    expectCode(
      () =>
        verifyQwenRtcStart({
          ...startInput(),
          rawBody,
          headers: headersFor(rawBody, timestamp, nonce),
        } as never),
      "TOKEN_EXPIRED",
    );
  });

  it("rejects unsupported media", () => {
    const input = startInput({ media: "video" });
    expectCode(() => verifyQwenRtcStart(input as never), "UNSUPPORTED_MEDIA");
  });

  it("rejects non-HTTPS callback metadata", () => {
    const input = startInput({
      callbackUrl: "http://control-plane.example.com/rtc/session",
    });
    expectCode(() => verifyQwenRtcStart(input as never), "NON_HTTPS_CALLBACK");
  });

  it("rejects a missing session id and an unknown event type", () => {
    const timestamp = "2026-08-06T02:00:30Z";
    const nonce = "nonce-0002";
    const withoutSession = JSON.stringify({
      ...JSON.parse(read("start-request.json")),
      sessionId: "",
    });
    expectCode(
      () =>
        verifyQwenRtcStart({
          ...startInput(),
          rawBody: withoutSession,
          headers: headersFor(withoutSession, timestamp, nonce),
        } as never),
      "MISSING_SESSION",
    );

    const unknownType = JSON.stringify({
      ...JSON.parse(read("start-request.json")),
      type: "SESSION_PAUSE",
    });
    expectCode(
      () =>
        verifyQwenRtcStart({
          ...startInput(),
          rawBody: unknownType,
          headers: headersFor(unknownType, timestamp, nonce),
        } as never),
      "UNKNOWN_EVENT_TYPE",
    );
  });

  it("parses the official close fixture", () => {
    const rawBody = read("close-request.json");
    const timestamp = "2026-08-10T02:30:30Z";
    const nonce = "nonce-0003";
    const close = verifyQwenRtcClose({
      ...startInput(),
      rawBody,
      headers: headersFor(rawBody, timestamp, nonce),
      now: "2026-08-10T10:30:30+08:00",
    } as never);

    expect(close).toEqual({
      platformSessionId: "ses_001",
      requestId: "req_close_001",
      reason: "USER_EXIT",
      closedAt: "2026-08-10T10:30:00+08:00",
    });
  });
});

describe("qwen sse output framing", () => {
  const framesOf = (text: string): string[] =>
    text.split(/\n\n/).filter((frame) => frame.trim() !== "");
  const frameEnding = (frame: string): string =>
    `${frame.replace(/\n+$/u, "")}\n\n`;

  it("re-encodes the official SPEAK frames byte for byte", () => {
    const official = framesOf(read("speak-event.txt"));
    expect(official).toHaveLength(2);
    for (const frame of official) {
      const parsed = parseOutputFrame(frameEnding(frame));
      expect(encodeOutputFrame(parsed)).toBe(frameEnding(frame));
    }
  });

  it("re-encodes the official STOP_OUTPUT plus SPEAK frame byte for byte", () => {
    const [frame] = framesOf(read("stop-output-event.txt"));
    expect(frame).toBeDefined();
    const parsed = parseOutputFrame(frameEnding(frame ?? ""));
    expect(parsed.actions.map((action) => action.type)).toEqual([
      "STOP_OUTPUT",
      "SPEAK",
    ]);
    expect(encodeOutputFrame(parsed)).toBe(frameEnding(frame ?? ""));
  });

  it("keeps the official highlight action example intact", () => {
    const action = JSON.parse(read("highlight-event.txt"));
    expect(action).toEqual({
      type: "SPEAK",
      payload: {
        speechId: "speech_001",
        index: 1,
        hasNext: true,
        text: "我先简单介绍一下，",
        textDisplayMode: "APPEND_HIGHLIGHT",
      },
    });
    expect(JSON.stringify(action, null, 2)).toBe(
      read("highlight-event.txt").trim(),
    );
  });

  it("emits the documented keep-alive frame", () => {
    expect(KEEPALIVE_FRAME).toBe(": keep-alive\n\n");
  });

  it("maps internal commands to official wire actions", () => {
    expect(
      toWireActions(
        [
          {
            type: "SPEAK",
            text: "我先简单介绍一下，",
            appendHighlight: "我先简单介绍一下，",
          },
          { type: "STOP_OUTPUT" },
        ],
        { speechId: "speech_001", startIndex: 1, hasNext: false },
      ),
    ).toEqual([
      {
        type: "SPEAK",
        payload: {
          speechId: "speech_001",
          index: 1,
          hasNext: false,
          text: "我先简单介绍一下，",
          textDisplayMode: "APPEND_HIGHLIGHT",
        },
      },
      { type: "STOP_OUTPUT", payload: { scope: "SPEAK" } },
    ]);
  });

  it("rejects unknown commands, actions and malformed frames", () => {
    expect(() =>
      toWireActions([{ type: "SHOUT", text: "x" } as never], {
        speechId: "speech_001",
        startIndex: 1,
        hasNext: true,
      }),
    ).toThrow(/UNKNOWN_COMMAND|unknown/i);
    expect(() =>
      encodeOutputFrame({
        sessionId: "ses_001",
        actions: [{ type: "REWIND", payload: {} } as never],
        final: false,
      }),
    ).toThrow(/UNKNOWN_ACTION|unknown/i);
    expect(() => parseOutputFrame("event: other\ndata: {}\n\n")).toThrow(
      /UNKNOWN_FRAME|unknown/i,
    );
  });
});

describe("rtc feature boundary", () => {
  it("stays disabled with no provider configuration", () => {
    const config = loadRtcConfig({
      DATABASE_URL: "postgres://user@127.0.0.1:5432/qhb",
      QHB_RTC_ENABLED: "false",
    });

    expect(config).toEqual({ enabled: false });
    expect(createRtcRuntime(config)).toBeNull();
  });

  it("requires provider credentials only when enabled", () => {
    expect(() =>
      loadRtcConfig({
        DATABASE_URL: "postgres://user@127.0.0.1:5432/qhb",
        QHB_RTC_ENABLED: "true",
      }),
    ).toThrow(/QHB_RTC_/);

    const enabled = loadRtcConfig({
      DATABASE_URL: "postgres://user@127.0.0.1:5432/qhb",
      QHB_RTC_ENABLED: "true",
      QHB_RTC_OWNER_SUBJECT: OWNER,
      QHB_RTC_SIGNING_SECRET: SECRET,
      QHB_RTC_CALLBACK_URL: "https://control-plane.example.com/rtc/session",
      QHB_RTC_ALLOWED_MEDIA: "audio",
      QHB_RTC_PROVIDER: "ALIYUN_RTC",
    });
    expect(enabled.enabled).toBe(true);
    expect(createRtcRuntime(enabled)).not.toBeNull();
  });
});

describe("rtc metric and route boundary", () => {
  const snapshot = async () => ({
    connectorOnline: false,
    queueAgeSeconds: 0,
    jobsByStatus: {},
  });
  const renderWith = async (rtcEnabled: boolean): Promise<string> =>
    createMetricsRegistry({ readSnapshot: snapshot, rtcEnabled }).render();

  it("exports qhb_rtc_enabled 0 when RTC is disabled", async () => {
    const text = await renderWith(false);
    expect(text).toContain("qhb_rtc_enabled 0");
    expect(text).not.toContain("qhb_rtc_enabled 1");
    expect(createRtcModule({ enabled: false })).toBeNull();
  });

  it("exports qhb_rtc_enabled 1 only when RTC is enabled", async () => {
    const text = await renderWith(true);
    expect(text).toContain("qhb_rtc_enabled 1");
  });
});
