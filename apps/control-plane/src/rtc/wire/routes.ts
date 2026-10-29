import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MetricsRegistry } from "../../http/metrics.js";
import type { RtcModule } from "../module.js";
import {
  createSystemClock,
  type RtcClock,
  type RtcCloseReason,
  type RtcSseWriter,
} from "../session/rtc-session.js";
import {
  createRtcSessionRegistry,
  RtcSessionConflictError,
  type RtcSessionRegistry,
  type RtcSessionTransport,
} from "../session/session-registry.js";
import {
  type NormalizedRtcClose,
  type NormalizedRtcStart,
  RTC_CLOCK_SKEW_MS,
  type RtcMedia,
  RtcWireError,
  type RtcWireErrorCode,
  verifyQwenRtcClose,
  verifyQwenRtcSignature,
  verifyQwenRtcStart,
} from "./qwen-rtc-schema.js";

export const RTC_CALLBACK_PATH = "/rtc/session";

const NONCE_STORE_MAX_ENTRIES = 1_024;

export type RtcAuthErrorCode = RtcWireErrorCode | "REPLAY_REJECTED";

const SAFE_MESSAGES: Record<RtcAuthErrorCode, string> = {
  INVALID_ENVELOPE: "RTC callback envelope is invalid.",
  INVALID_SIGNATURE: "RTC callback signature is invalid.",
  UNKNOWN_OWNER: "RTC callback owner is not authorized.",
  STALE_TIMESTAMP: "RTC callback timestamp is outside the accepted window.",
  TOKEN_EXPIRED: "RTC callback token is expired.",
  UNSUPPORTED_MEDIA: "RTC callback media is not enabled.",
  MISSING_SESSION: "RTC callback session is missing.",
  NON_HTTPS_CALLBACK: "RTC callback metadata must use HTTPS.",
  UNKNOWN_EVENT_TYPE: "RTC callback event type is not supported.",
  UNKNOWN_ACTION: "RTC output action is not supported.",
  UNKNOWN_FRAME: "RTC output frame is not supported.",
  UNKNOWN_COMMAND: "RTC output command is not supported.",
  REPLAY_REJECTED: "RTC callback was already processed.",
};

export class RtcAuthenticationError extends Error {
  readonly code: RtcAuthErrorCode;

  constructor(code: RtcAuthErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "RtcAuthenticationError";
    this.code = code;
  }
}

export type RtcRejection = Readonly<{
  code: RtcAuthErrorCode;
  ownerSubject: string | null;
}>;

export type RtcVerifiedCallback =
  | Readonly<{ kind: "start"; start: NormalizedRtcStart }>
  | Readonly<{ kind: "close"; close: NormalizedRtcClose }>;

export type RtcCallbackRequest = Readonly<{
  rawBody: string;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
}>;

export type RtcAuthenticator = Readonly<{
  verify: (request: RtcCallbackRequest) => RtcVerifiedCallback;
}>;

export type RtcAuthenticatorOptions = Readonly<{
  ownerSubject: string;
  signingSecret: string;
  callbackUrl: string;
  allowedMedia: readonly RtcMedia[];
  now: () => string;
  onReject?: (rejection: RtcRejection) => void;
}>;

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

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const createNonceStore = (maxEntries = NONCE_STORE_MAX_ENTRIES) => {
  const entries = new Map<string, number>();
  const prune = (nowMs: number): void => {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= nowMs) entries.delete(key);
    }
  };
  return {
    accept(digest: string, expiresAtMs: number, nowMs: number): boolean {
      prune(nowMs);
      if (entries.has(digest)) return false;
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(digest, expiresAtMs);
      return true;
    },
  };
};

const reject = (
  options: RtcAuthenticatorOptions,
  code: RtcAuthErrorCode,
  ownerSubject: string | null,
): never => {
  options.onReject?.({ code, ownerSubject });
  throw new RtcAuthenticationError(code);
};

/**
 * Authenticates one Qwen RTC callback: signature over the exact raw bytes,
 * timestamp window, single owner subject, short-lived nonce digest and token
 * expiry. Business fields are parsed only after the signature and owner pass.
 * Errors and logs carry a bounded code and never the RTC token or raw body.
 */
export const createRtcAuthenticator = (
  options: RtcAuthenticatorOptions,
): RtcAuthenticator => {
  const nonceStore = createNonceStore();
  const media: RtcMedia = options.allowedMedia[0] ?? "audio";

  return {
    verify(request) {
      const now = options.now();
      const wireRequest = {
        rawBody: request.rawBody,
        method: request.method,
        path: request.path,
        headers: request.headers,
        ownerSubject: options.ownerSubject,
        signingSecret: options.signingSecret,
        callbackUrl: options.callbackUrl,
        media,
        allowedMedia: options.allowedMedia,
        now,
      };
      try {
        verifyQwenRtcSignature(wireRequest);
      } catch (error) {
        return reject(
          options,
          error instanceof RtcWireError ? error.code : "INVALID_SIGNATURE",
          null,
        );
      }

      const owner = headerValue(request.headers, "x-qhb-owner-subject");
      if (owner === undefined || owner !== options.ownerSubject) {
        return reject(options, "UNKNOWN_OWNER", owner ?? null);
      }

      const timestamp = headerValue(request.headers, "x-qhb-timestamp");
      const nonce = headerValue(request.headers, "x-qhb-nonce");
      if (timestamp === undefined || nonce === undefined) {
        return reject(options, "INVALID_SIGNATURE", owner);
      }
      const digest = sha256Hex(
        [owner, timestamp, nonce, sha256Hex(request.rawBody)].join("\n"),
      );
      const expiresAtMs = Date.parse(timestamp) + RTC_CLOCK_SKEW_MS;
      if (!nonceStore.accept(digest, expiresAtMs, Date.parse(now))) {
        return reject(options, "REPLAY_REJECTED", owner);
      }

      let type: unknown;
      try {
        type = (JSON.parse(request.rawBody) as { type?: unknown }).type;
      } catch {
        return reject(options, "INVALID_ENVELOPE", owner);
      }
      try {
        if (type === "SESSION_START") {
          return { kind: "start", start: verifyQwenRtcStart(wireRequest) };
        }
        if (type === "SESSION_CLOSE") {
          return { kind: "close", close: verifyQwenRtcClose(wireRequest) };
        }
        return reject(options, "UNKNOWN_EVENT_TYPE", owner);
      } catch (error) {
        if (error instanceof RtcAuthenticationError) throw error;
        return reject(
          options,
          error instanceof RtcWireError ? error.code : "INVALID_ENVELOPE",
          owner,
        );
      }
    },
  };
};

export type RtcRouteOptions = Readonly<{
  module: RtcModule | null;
  clock?: RtcClock;
  metrics?: Pick<MetricsRegistry, "recordError"> & {
    recordRtcDisconnect?: (reason: string) => void;
  };
}>;

export type RtcRouteSet = Readonly<{
  path: typeof RTC_CALLBACK_PATH;
  authenticator: RtcAuthenticator;
  registry: RtcSessionRegistry;
  register: (app: FastifyInstance) => void;
  closeAll: (reason?: RtcCloseReason) => Promise<void>;
}>;

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

const createHttpTransport = (reply: FastifyReply): RtcSessionTransport => {
  reply.hijack();
  reply.raw.writeHead(200, sseHeaders);
  const writer: RtcSseWriter = {
    closed: false,
    write(frame) {
      if (writer.closed || reply.raw.writableEnded) return;
      reply.raw.write(frame);
    },
    end() {
      writer.closed = true;
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
  return {
    writer,
    resources: {
      stopOutput: () => undefined,
      closeProviderStreams: () => undefined,
    },
  };
};

const rawBodyKey = new WeakMap<object, string>();

/**
 * Creates the signed RTC callback route set, or null when the experimental
 * module is disabled. With RTC disabled nothing is mounted and the stable MCP
 * path, liveness and readiness are untouched.
 */
export const createRtcRouteSet = (
  options: RtcRouteOptions,
): RtcRouteSet | null => {
  if (options.module === null) return null;
  const module = options.module;
  const clock = options.clock ?? createSystemClock();
  const authenticator = createRtcAuthenticator({
    ownerSubject: module.ownerSubject,
    signingSecret: module.signingSecret,
    callbackUrl: module.callbackUrl,
    allowedMedia: module.allowedMedia,
    now: () => new Date(clock.now()).toISOString(),
  });
  const registry = createRtcSessionRegistry({
    clock,
    onDisconnect: (reason) => options.metrics?.recordRtcDisconnect?.(reason),
  });

  const register = (app: FastifyInstance): void => {
    void app.register(async (instance) => {
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (request, body, done) => {
          rawBodyKey.set(request, body as string);
          done(null, undefined);
        },
      );
      instance.post(RTC_CALLBACK_PATH, async (request, reply) => {
        const rawBody = rawBodyKey.get(request) ?? "";
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          headers[name] = Array.isArray(value) ? value[0] : value;
        }
        const path = (request.url.split("?")[0] ?? RTC_CALLBACK_PATH) as string;
        let verified: RtcVerifiedCallback;
        try {
          verified = authenticator.verify({
            rawBody,
            method: request.method,
            path,
            headers,
          });
        } catch (error) {
          options.metrics?.recordError("UNAUTHENTICATED");
          const code =
            error instanceof RtcAuthenticationError
              ? error.code
              : "INVALID_SIGNATURE";
          return reply
            .code(401)
            .type("application/json")
            .send({
              error: { code, message: "RTC callback rejected." },
            });
        }
        if (verified.kind === "close") {
          const closed = await registry.close(
            verified.close.platformSessionId,
            "platform_close",
          );
          if (!closed) {
            return reply
              .code(404)
              .type("application/json")
              .send({ error: { code: "RTC_SESSION_NOT_FOUND" } });
          }
          return reply.code(204).send();
        }
        try {
          const outcome = await registry.start({
            start: verified.start,
            createTransport: () => createHttpTransport(reply),
          });
          if (!outcome.created) {
            return reply.code(200).type("application/json").send({
              status: "already_active",
              session_id: outcome.session.id,
            });
          }
          reply.raw.once("close", () => {
            void registry.close(outcome.session.id, "user_exit");
          });
          return reply;
        } catch (error) {
          if (error instanceof RtcSessionConflictError) {
            return reply
              .code(409)
              .type("application/json")
              .send({ error: { code: error.code } });
          }
          options.metrics?.recordError("INTERNAL");
          return reply
            .code(500)
            .type("application/json")
            .send({ error: { code: "INTERNAL" } });
        }
      });
    });
  };

  return {
    path: RTC_CALLBACK_PATH,
    authenticator,
    registry,
    register,
    closeAll: (reason = "server_shutdown") => registry.closeAll(reason),
  };
};
