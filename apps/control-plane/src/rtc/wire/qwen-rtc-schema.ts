import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RTC_SPEC_VERSION = "1.0";
export const RTC_MEDIA = ["audio", "video"] as const;
export const RTC_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type RtcMedia = (typeof RTC_MEDIA)[number];

export type RtcWireErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_SIGNATURE"
  | "UNKNOWN_OWNER"
  | "STALE_TIMESTAMP"
  | "TOKEN_EXPIRED"
  | "UNSUPPORTED_MEDIA"
  | "MISSING_SESSION"
  | "NON_HTTPS_CALLBACK"
  | "UNKNOWN_EVENT_TYPE"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_FRAME"
  | "UNKNOWN_COMMAND";

export class RtcWireError extends Error {
  readonly code: RtcWireErrorCode;

  constructor(code: RtcWireErrorCode, message: string) {
    super(message);
    this.name = "RtcWireError";
    this.code = code;
  }
}

export type NormalizedRtcStart = Readonly<{
  platformSessionId: string;
  ownerSubject: string;
  media: RtcMedia;
  roomId: string;
  rtcUserId: string;
  rtcToken: string;
  rtcTokenExpiresAt: string;
  callbackIssuedAt: string;
}>;

export type NormalizedRtcClose = Readonly<{
  platformSessionId: string;
  requestId: string;
  reason: string;
  closedAt: string;
}>;

export type RtcWireRequest = Readonly<{
  rawBody: string;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  ownerSubject: string;
  signingSecret: string;
  callbackUrl: string;
  media: string;
  allowedMedia?: readonly RtcMedia[];
  now: string;
}>;

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const fail = (code: RtcWireErrorCode, message: string): never => {
  throw new RtcWireError(code, message);
};

const headerValue = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.toLowerCase() === name &&
      typeof value === "string" &&
      value !== ""
    ) {
      return value;
    }
  }
  return undefined;
};

const requireTimestamp = (
  value: string | undefined,
  code: RtcWireErrorCode,
) => {
  if (
    value === undefined ||
    !RFC3339.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(code, "timestamp must be an RFC 3339 instant");
  }
  return value as string;
};

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const expectedSignature = (
  request: RtcWireRequest,
  timestamp: string,
  nonce: string,
): string =>
  createHmac("sha256", request.signingSecret)
    .update(
      [
        request.method.toUpperCase(),
        request.path,
        timestamp,
        nonce,
        sha256Hex(request.rawBody),
      ].join("\n"),
    )
    .digest("hex");

const verifySignature = (request: RtcWireRequest): void => {
  const timestamp = requireTimestamp(
    headerValue(request.headers, "x-qhb-timestamp"),
    "INVALID_SIGNATURE",
  );
  const nonce = headerValue(request.headers, "x-qhb-nonce");
  if (nonce === undefined || nonce.length < 8) {
    fail("INVALID_SIGNATURE", "nonce header is required");
  }
  const presented = headerValue(request.headers, "x-qhb-signature");
  if (presented === undefined || !/^[a-f0-9]{64}$/u.test(presented)) {
    fail("INVALID_SIGNATURE", "signature header is malformed");
  }
  const expected = expectedSignature(request, timestamp, nonce as string);
  const presentedBytes = Buffer.from(presented as string, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    presentedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    fail(
      "INVALID_SIGNATURE",
      "signature does not match the exact request bytes",
    );
  }
  if (
    Math.abs(Date.parse(timestamp) - Date.parse(request.now)) >
    RTC_CLOCK_SKEW_MS
  ) {
    fail(
      "STALE_TIMESTAMP",
      "request timestamp is outside the five minute window",
    );
  }
};

/**
 * Verifies the adapter envelope on the exact raw request bytes before any
 * business field is parsed. Exported so the session layer can authenticate a
 * callback once and then dispatch on its envelope type.
 */
export const verifyQwenRtcSignature = (request: RtcWireRequest): void => {
  verifySignature(request);
};

type Envelope = Readonly<{
  specVersion: string;
  requestId: string;
  sessionId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
  value: unknown,
  code: RtcWireErrorCode,
  label: string,
): string => {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${label} is required`);
  }
  return value as string;
};

const parseEnvelope = (rawBody: string): Envelope => {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    fail("INVALID_ENVELOPE", "request body must be valid JSON");
  }
  if (!isRecord(value)) {
    fail("INVALID_ENVELOPE", "request body must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.specVersion !== RTC_SPEC_VERSION) {
    fail("INVALID_ENVELOPE", "specVersion must be 1.0");
  }
  const requestId = requireString(
    record.requestId,
    "INVALID_ENVELOPE",
    "requestId",
  );
  const sessionId = requireString(
    record.sessionId,
    "MISSING_SESSION",
    "sessionId",
  );
  const type = requireString(record.type, "INVALID_ENVELOPE", "type");
  const occurredAt = requireTimestamp(
    typeof record.occurredAt === "string" ? record.occurredAt : undefined,
    "INVALID_ENVELOPE",
  );
  const payload = record.payload;
  if (!isRecord(payload)) {
    fail("INVALID_ENVELOPE", "payload must be an object");
  }
  return {
    specVersion: RTC_SPEC_VERSION,
    requestId,
    sessionId,
    type,
    occurredAt,
    payload: payload as Record<string, unknown>,
  };
};

const verifyEnvelope = (
  request: RtcWireRequest,
  expectedType: string,
): Envelope => {
  verifySignature(request);
  const owner = headerValue(request.headers, "x-qhb-owner-subject");
  if (owner === undefined || owner !== request.ownerSubject) {
    fail("UNKNOWN_OWNER", "owner subject is unknown");
  }
  const envelope = parseEnvelope(request.rawBody);
  if (envelope.type !== expectedType) {
    fail("UNKNOWN_EVENT_TYPE", `event type ${envelope.type} is not supported`);
  }
  const callback = ((): URL => {
    try {
      return new URL(request.callbackUrl);
    } catch {
      return fail(
        "NON_HTTPS_CALLBACK",
        "callback metadata must be an absolute HTTPS URL",
      );
    }
  })();
  if (callback.protocol !== "https:") {
    fail("NON_HTTPS_CALLBACK", "callback metadata must use HTTPS");
  }
  return envelope;
};

const requireMedia = (request: RtcWireRequest): RtcMedia => {
  const allowed = request.allowedMedia ?? RTC_MEDIA;
  if (
    !RTC_MEDIA.includes(request.media as RtcMedia) ||
    !allowed.includes(request.media as RtcMedia)
  ) {
    fail("UNSUPPORTED_MEDIA", "media is not supported by this deployment");
  }
  return request.media as RtcMedia;
};

export const verifyQwenRtcStart = (
  request: RtcWireRequest,
): NormalizedRtcStart => {
  const envelope = verifyEnvelope(request, "SESSION_START");
  const media = requireMedia(request);
  const rtcValue = envelope.payload.rtc;
  if (!isRecord(rtcValue)) {
    fail("INVALID_ENVELOPE", "payload.rtc is required");
  }
  const rtc = rtcValue as Record<string, unknown>;
  const provider = requireString(
    rtc.provider,
    "INVALID_ENVELOPE",
    "payload.rtc.provider",
  );
  if (provider !== "ALIYUN_RTC") {
    fail("INVALID_ENVELOPE", "payload.rtc.provider is not supported");
  }
  const roomId = requireString(
    rtc.channelId,
    "INVALID_ENVELOPE",
    "payload.rtc.channelId",
  );
  const rtcUserId = requireString(
    rtc.consumerUserId,
    "INVALID_ENVELOPE",
    "payload.rtc.consumerUserId",
  );
  const rtcToken = requireString(
    rtc.consumerToken,
    "INVALID_ENVELOPE",
    "payload.rtc.consumerToken",
  );
  const expiresAt = requireTimestamp(
    typeof rtc.expiresAt === "string" ? rtc.expiresAt : undefined,
    "INVALID_ENVELOPE",
  );
  if (Date.parse(expiresAt) <= Date.parse(request.now)) {
    fail("TOKEN_EXPIRED", "rtc token is already expired");
  }
  return {
    platformSessionId: envelope.sessionId,
    ownerSubject: request.ownerSubject,
    media,
    roomId,
    rtcUserId,
    rtcToken,
    rtcTokenExpiresAt: expiresAt,
    callbackIssuedAt: envelope.occurredAt,
  };
};

export const verifyQwenRtcClose = (
  request: RtcWireRequest,
): NormalizedRtcClose => {
  const envelope = verifyEnvelope(request, "SESSION_CLOSE");
  const reason = requireString(
    envelope.payload.reason,
    "INVALID_ENVELOPE",
    "payload.reason",
  );
  return {
    platformSessionId: envelope.sessionId,
    requestId: envelope.requestId,
    reason,
    closedAt: envelope.occurredAt,
  };
};
