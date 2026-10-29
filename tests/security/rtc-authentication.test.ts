import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RtcMedia } from "../../apps/control-plane/src/rtc/wire/qwen-rtc-schema.js";
import {
  createRtcAuthenticator,
  createRtcRouteSet,
  RTC_CALLBACK_PATH,
  RtcAuthenticationError,
  type RtcRejection,
} from "../../apps/control-plane/src/rtc/wire/routes.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contract",
  "fixtures",
  "qwen-rtc",
);
const read = (name: string): string =>
  readFileSync(join(fixtures, name), "utf8");

const OWNER = "owner-subject-1";
const SECRET = "rtc-adapter-signing-secret-value-0123456789";
const CALLBACK_URL = "https://control-plane.example.com/rtc/session";
const TOKEN = "<RtcRoom.thirdToken>";

const signatureFor = (
  rawBody: string,
  timestamp: string,
  nonce: string,
): string =>
  createHmac("sha256", SECRET)
    .update(
      [
        "POST",
        RTC_CALLBACK_PATH,
        timestamp,
        nonce,
        createHash("sha256").update(rawBody, "utf8").digest("hex"),
      ].join("\n"),
    )
    .digest("hex");

const requestFor = ({
  rawBody = read("start-request.json"),
  timestamp = "2026-08-06T02:00:30Z",
  nonce = "nonce-0001",
  owner = OWNER,
  signature = null as string | null,
}: {
  rawBody?: string;
  timestamp?: string;
  nonce?: string;
  owner?: string;
  signature?: string | null;
} = {}) => ({
  rawBody,
  method: "POST",
  path: RTC_CALLBACK_PATH,
  headers: {
    "x-qhb-signature": signature ?? signatureFor(rawBody, timestamp, nonce),
    "x-qhb-timestamp": timestamp,
    "x-qhb-nonce": nonce,
    "x-qhb-owner-subject": owner,
  },
});

const authenticatorFor = (
  now = "2026-08-06T02:01:00Z",
  rejections: RtcRejection[] = [],
) =>
  createRtcAuthenticator({
    ownerSubject: OWNER,
    signingSecret: SECRET,
    callbackUrl: CALLBACK_URL,
    allowedMedia: ["audio"] as readonly RtcMedia[],
    now: () => now,
    onReject: (rejection) => rejections.push(rejection),
  });

const expectRejection = (
  action: () => unknown,
  code: string,
): RtcAuthenticationError => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RtcAuthenticationError);
    expect((error as RtcAuthenticationError).code).toBe(code);
    return error as RtcAuthenticationError;
  }
  throw new Error(`expected ${code} rejection`);
};

describe("rtc callback authentication", () => {
  it("accepts a valid signed SESSION_START before any business field is used", () => {
    const callbacks = authenticatorFor();
    const verified = callbacks.verify(requestFor() as never);

    expect(verified.kind).toBe("start");
    if (verified.kind !== "start") return;
    expect(verified.start.platformSessionId).toBe("ses_001");
    expect(verified.start.ownerSubject).toBe(OWNER);
    expect(verified.start.media).toBe("audio");
    expect(verified.start.roomId).toBe("channel_001");
  });

  it("rejects a wrong signature and reports a bounded rejection", () => {
    const rejections: RtcRejection[] = [];
    const callbacks = authenticatorFor("2026-08-06T02:01:00Z", rejections);

    const error = expectRejection(
      () => callbacks.verify(requestFor({ signature: "0".repeat(64) })),
      "INVALID_SIGNATURE",
    );

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual({
      code: "INVALID_SIGNATURE",
      ownerSubject: null,
    });
    expect(error.message).not.toContain(TOKEN);
  });

  it("checks the signature before parsing the business body", () => {
    const callbacks = authenticatorFor();
    const rawBody = "{not valid json";

    expectRejection(
      () =>
        callbacks.verify(requestFor({ rawBody, signature: "f".repeat(64) })),
      "INVALID_SIGNATURE",
    );
  });

  it("rejects an unknown owner subject", () => {
    const callbacks = authenticatorFor();
    expectRejection(
      () => callbacks.verify(requestFor({ owner: "another-owner" })),
      "UNKNOWN_OWNER",
    );
  });

  it("rejects an expired RTC token", () => {
    const callbacks = authenticatorFor("2026-08-08T00:00:00Z");
    expectRejection(
      () =>
        callbacks.verify(
          requestFor({
            timestamp: "2026-08-08T00:00:00Z",
            nonce: "nonce-expired",
          }),
        ),
      "TOKEN_EXPIRED",
    );
  });

  it("rejects a stale timestamp outside the five minute window", () => {
    const callbacks = authenticatorFor("2026-08-06T02:06:01Z");
    expectRejection(
      () =>
        callbacks.verify(
          requestFor({
            timestamp: "2026-08-06T02:00:00Z",
            nonce: "nonce-stale",
          }),
        ),
      "STALE_TIMESTAMP",
    );
  });

  it("rejects a replayed nonce and accepts a fresh nonce", () => {
    const callbacks = authenticatorFor();
    const request = requestFor();

    expect(callbacks.verify(request as never).kind).toBe("start");
    expectRejection(
      () => callbacks.verify(request as never),
      "REPLAY_REJECTED",
    );
    expect(
      callbacks.verify(requestFor({ nonce: "nonce-0002" }) as never).kind,
    ).toBe("start");
  });

  it("never places the RTC token in an error or rejection", () => {
    const rejections: RtcRejection[] = [];
    const callbacks = authenticatorFor("2026-08-08T00:00:00Z", rejections);

    const error = expectRejection(
      () => callbacks.verify(requestFor({ timestamp: "2026-08-08T00:00:00Z" })),
      "TOKEN_EXPIRED",
    );
    const serialized = JSON.stringify({
      message: error.message,
      code: error.code,
    });
    expect(serialized).not.toContain(TOKEN);
    expect(JSON.stringify(rejections)).not.toContain(TOKEN);
  });

  it("accepts a valid signed SESSION_CLOSE", () => {
    const callbacks = authenticatorFor("2026-08-10T02:30:30Z");
    const verified = callbacks.verify(
      requestFor({
        rawBody: read("close-request.json"),
        timestamp: "2026-08-10T02:30:30Z",
        nonce: "nonce-close-001",
      }) as never,
    );

    expect(verified.kind).toBe("close");
    if (verified.kind !== "close") return;
    expect(verified.close.platformSessionId).toBe("ses_001");
    expect(verified.close.reason).toBe("USER_EXIT");
  });
});

describe("rtc route feature gate", () => {
  it("creates no RTC route set when the module is disabled", () => {
    expect(createRtcRouteSet({ module: null })).toBeNull();
  });

  it("creates the callback route set only for an enabled module", () => {
    const routes = createRtcRouteSet({
      module: {
        ownerSubject: OWNER,
        signingSecret: SECRET,
        callbackUrl: CALLBACK_URL,
        allowedMedia: ["audio"],
        provider: "ALIYUN_RTC",
      },
    });

    expect(routes).not.toBeNull();
    expect(routes?.path).toBe(RTC_CALLBACK_PATH);
    expect(routes?.registry.size).toBe(0);
  });
});
