import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import type { McpCoordinator } from "../../apps/control-plane/src/mcp/tools.js";
import type { RtcProviderSettings } from "../../apps/control-plane/src/rtc/config.js";
import {
  createRtcPlugin,
  type RtcCompositionHandle,
  type RtcProviderComposition,
} from "../../apps/control-plane/src/rtc/plugin.js";
import {
  createRtcRouteSet,
  RTC_CALLBACK_PATH,
  type RtcRouteSet,
} from "../../apps/control-plane/src/rtc/wire/routes.js";
import { LOCALHOST_TLS } from "./support/tls.js";

const OWNER = "owner-subject-1";
const TOKEN = "composition-test-bearer-token-032-characters";
const SIGNING_SECRET = "rtc-adapter-signing-secret-value-0123456789";
const CALLBACK_URL = "https://control-plane.example.com/rtc/session";
const SESSION_ID = "ses_composed";
const SETTINGS: RtcProviderSettings = {
  aliyunAppId: "app-id",
  aliyunAccessKeyId: "access-key-id",
  aliyunAccessKeySecret: "access-key-secret",
  dashscopeApiKey: "server-secret-api-key",
  dashscopeAsrModel: "paraformer-realtime-v2",
};

const rtcModule = {
  ownerSubject: OWNER,
  signingSecret: SIGNING_SECRET,
  callbackUrl: CALLBACK_URL,
  allowedMedia: ["audio"] as const,
  provider: "ALIYUN_RTC" as const,
};

// The MCP routes are registered but never called by this RTC composition test.
const coordinator = {} as McpCoordinator;

const signedStart = (sessionId: string) => {
  const timestamp = new Date().toISOString();
  const rawBody = JSON.stringify({
    specVersion: "1.0",
    requestId: `req_${sessionId}`,
    sessionId,
    type: "SESSION_START",
    occurredAt: timestamp,
    payload: {
      rtc: {
        provider: "ALIYUN_RTC",
        channelId: "channel_composed",
        consumerUserId: "consumer_composed",
        consumerToken: "short-lived-rtc-token",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    },
  });
  const nonce = `nonce-${sessionId}`;
  const signature = createHmac("sha256", SIGNING_SECRET)
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
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-qhb-signature": signature,
      "x-qhb-timestamp": timestamp,
      "x-qhb-nonce": nonce,
      "x-qhb-owner-subject": OWNER,
    },
  };
};

type Harness = Readonly<{
  plugin: ReturnType<typeof createRtcPlugin>;
  routeSet: RtcRouteSet;
  port: number;
}>;

type OpenStream = Readonly<{
  closed: Promise<void>;
  firstChunk: Promise<string>;
  status: number;
}>;

const createHarness = async (
  composition: RtcProviderComposition,
): Promise<Harness> => {
  let routeSet: RtcRouteSet | null = null;
  const plugin = createRtcPlugin({
    enabled: true,
    settings: SETTINGS,
    composition,
    drainMs: 5,
    build: async () => {
      routeSet = createRtcRouteSet({
        module: rtcModule,
        lifecycle: {
          canStart: () => plugin.canStart(),
          rejectionReason: () => plugin.rejectionReason(),
          sessionStart: (sessionId) => plugin.startSession(sessionId),
          sessionRelease: (sessionId) => plugin.endSession(sessionId),
          sessionClose: (reason, sessionId) =>
            plugin.observeSession(reason, sessionId),
          sessionRejected: (reason) => plugin.observeRejected(reason),
          firstAudio: (sessionId) => plugin.observeAudio(sessionId),
          sessionCreated: (sessionId, writer, start) =>
            plugin.composeSession(sessionId, writer, start),
        },
      });
      return routeSet;
    },
  });
  const app = await createApp({
    coordinator,
    ownerId: OWNER,
    mcpBearerToken: TOKEN,
    https: LOCALHOST_TLS,
    readinessProbe: { assertReady: async () => undefined },
    rtcPlugin: plugin,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  activeApps.push(app);
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("RTC composition test server did not bind a port");
  }
  if (routeSet === null) throw new Error("RTC route set was not built");
  return { plugin, routeSet, port: address.port };
};

const activeApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

const waitFor = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const bucketTotal = (buckets: Readonly<Record<string, number>>): number =>
  Object.values(buckets).reduce((total, value) => total + value, 0);

const openSession = async (
  harness: Harness,
  sessionId = SESSION_ID,
): Promise<OpenStream> => {
  const signed = signedStart(sessionId);
  return new Promise<OpenStream>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port: harness.port,
        path: RTC_CALLBACK_PATH,
        method: "POST",
        headers: signed.headers,
        rejectUnauthorized: false,
      },
      (response: IncomingMessage) => {
        const firstChunk = new Promise<string>((resolveFirst) => {
          response.once("data", (chunk: Buffer) => {
            resolveFirst(chunk.toString("utf8"));
          });
        });
        const closed = new Promise<void>((resolveClosed) => {
          response.once("end", resolveClosed);
          response.once("close", resolveClosed);
        });
        resolve({
          status: response.statusCode ?? 0,
          firstChunk,
          closed,
        });
      },
    );
    request.once("error", reject);
    request.write(signed.rawBody);
    request.end();
  });
};

afterEach(async () => {
  await Promise.all(
    activeApps.splice(0).map(async (app) => {
      try {
        await app.close();
      } catch {
        // A hijacked SSE connection may already be closed by session teardown.
      }
    }),
  );
});

describe("rtc session composition over the real callback route", () => {
  it("records first-audio, first-asr-final and progress first-output from a live POST", async () => {
    const seen = {
      tokens: [] as string[],
      settings: [] as Array<RtcProviderSettings | undefined>,
    };
    const composition: RtcProviderComposition = {
      consumer: async (_sessionId, input, callbacks) => {
        seen.tokens.push(input.start.rtcToken);
        seen.settings.push(input.settings);
        callbacks.onFirstAudio();
        return { close: async () => undefined };
      },
      asr: (_sessionId, input, callbacks) => {
        seen.tokens.push(input.start.roomId);
        callbacks.onFinal();
        return { close: async () => undefined };
      },
      output: (_sessionId, writer, input, callbacks) => {
        seen.tokens.push(input.start.rtcUserId);
        writer.write('event: progress\ndata: {"stage":"running"}\n\n');
        callbacks.onFirstOutput("progress");
        return { close: async () => undefined };
      },
    };
    const harness = await createHarness(composition);

    const stream = await openSession(harness);
    expect(stream.status).toBe(200);
    expect(await stream.firstChunk).toContain("connected");

    await waitFor(
      () =>
        bucketTotal(
          harness.plugin.component().telemetry.first_audio_bucket_ms,
        ) > 0 &&
        bucketTotal(
          harness.plugin.component().telemetry.first_asr_final_bucket_ms,
        ) > 0 &&
        bucketTotal(
          harness.plugin.component().telemetry.first_output_bucket_ms,
        ) > 0,
      "first-event telemetry",
    );

    const telemetry = harness.plugin.component().telemetry;
    expect(bucketTotal(telemetry.first_audio_bucket_ms)).toBe(1);
    expect(bucketTotal(telemetry.first_asr_final_bucket_ms)).toBe(1);
    expect(bucketTotal(telemetry.first_output_bucket_ms)).toBe(1);
    expect(telemetry.output_commands.progress).toBe(1);
    expect(telemetry.output_commands.speak).toBe(0);
    expect(telemetry.active_sessions).toBe(1);
    expect(seen.tokens).toEqual([
      "short-lived-rtc-token",
      "channel_composed",
      "consumer_composed",
    ]);
    expect(seen.settings[0]).toEqual(SETTINGS);

    await harness.routeSet.registry.close(SESSION_ID, "user_exit");
    await stream.closed;
    await waitFor(
      () => harness.plugin.component().telemetry.active_sessions === 0,
      "session close",
    );
    expect(harness.plugin.component().telemetry.disconnects.user_exit).toBe(1);
  });

  it("force-closes composed provider handles exactly once", async () => {
    const closes: string[] = [];
    const handle = (name: string): RtcCompositionHandle => ({
      close: async () => {
        closes.push(name);
      },
    });
    const composition: RtcProviderComposition = {
      consumer: () => handle("consumer"),
      asr: () => handle("asr"),
      output: () => handle("output"),
    };
    const harness = await createHarness(composition);

    const stream = await openSession(harness, "ses_force_close");
    await waitFor(
      () => harness.plugin.component().telemetry.active_sessions === 1,
      "session start",
    );
    await waitFor(
      () => closes.length === 0 && harness.routeSet.registry.size === 1,
      "composed session",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.plugin.forceClose();
    await stream.closed;

    expect(closes.sort()).toEqual(["asr", "consumer", "output"]);
    expect(harness.plugin.component().telemetry.active_sessions).toBe(0);
    await harness.plugin.forceClose();
    expect(closes.sort()).toEqual(["asr", "consumer", "output"]);
  });

  it("closes a provider handle that resolves after its session is gone", async () => {
    let closed = 0;
    const composition: RtcProviderComposition = {
      consumer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          close: async () => {
            closed += 1;
          },
        };
      },
    };
    const harness = await createHarness(composition);

    const stream = await openSession(harness, "ses_late_handle");
    await waitFor(
      () => harness.plugin.component().telemetry.active_sessions === 1,
      "session start",
    );
    await harness.routeSet.registry.close("ses_late_handle", "user_exit");
    await waitFor(() => closed === 1, "late handle close");
    expect(closed).toBe(1);
    await stream.closed;
  });
});
