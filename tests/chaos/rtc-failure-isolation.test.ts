import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateAppOptions,
  createApp,
} from "../../apps/control-plane/src/http/app.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import type { McpCoordinator } from "../../apps/control-plane/src/mcp/tools.js";
import { createSerializedSseOutput } from "../../apps/control-plane/src/rtc/output/serialized-sse-writer.js";
import {
  createRtcPlugin,
  type RtcPlugin,
} from "../../apps/control-plane/src/rtc/plugin.js";
import { createDashScopeAsr } from "../../apps/control-plane/src/rtc/providers/dashscope-asr.js";
import {
  createLiveRtcSession,
  createSystemClock,
} from "../../apps/control-plane/src/rtc/session/rtc-session.js";
import {
  createRtcRouteSet,
  type RtcRouteSet,
} from "../../apps/control-plane/src/rtc/wire/routes.js";
import { LOCALHOST_TLS } from "../integration/support/tls.js";

const OWNER = "chaos-owner";
const TOKEN = "chaos-bearer-token-value-032-characters";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const ACCEPTED_AT = "2026-09-01T00:00:00.000Z";
const SEVEN_TOOLS = [
  "cancel_task",
  "decide_approval",
  "get_task",
  "get_task_result",
  "list_pending_approvals",
  "list_tasks",
  "submit_task",
];

const coordinator: McpCoordinator = {
  async submit() {
    return {
      job_id: JOB_ID,
      short_id: "QH-CHA1",
      status: "queued",
      connector_status: "online",
      accepted_at: ACCEPTED_AT,
      expires_at: "2026-09-02T00:00:00.000Z",
    };
  },
  async list() {
    return [];
  },
  async get() {
    return {
      job_id: JOB_ID,
      title: "chaos",
      repository: "repo",
      status: "running",
      current_stage: "editing",
      freshness: "fresh",
      revision: 1,
      text: "editing",
      recent_events: [],
      pending_approval: null,
      terminal_summary: null,
    };
  },
  async cancel() {
    return { job_id: JOB_ID, status: "cancelling", short_id: "QH-CHA1" };
  },
  async listApprovals() {
    return [];
  },
  async decideApproval() {
    return { approval_id: JOB_ID, decision: "approve", revision: 1 };
  },
  async getResult() {
    return {
      job_id: JOB_ID,
      summary: "ok",
      changed_files: [],
      tests: { passed: 0, failed: 0, summary: "ok" },
      artifacts: [],
      acknowledged_at: ACCEPTED_AT,
    };
  },
};

const fakeMetrics = {
  startMcpSubmit: () => () => undefined,
  observeMcpSubmit: () => undefined,
  recordConnectorMessage: () => undefined,
  recordError: () => undefined,
  recordRtcDisconnect: vi.fn(),
  render: async () => "",
};

const activeApps: Awaited<ReturnType<typeof createApp>>[] = [];

const fakeRouteSet = (
  overrides: Partial<Pick<RtcRouteSet, "register" | "closeAll">> = {},
): RtcRouteSet => ({
  path: "/rtc/session",
  authenticator: {} as RtcRouteSet["authenticator"],
  registry: {} as RtcRouteSet["registry"],
  register: overrides.register ?? (() => undefined),
  closeAll: overrides.closeAll ?? (async () => undefined),
});

const createHarness = async (rtcPlugin: RtcPlugin) => {
  const options = {
    coordinator,
    ownerId: OWNER,
    mcpBearerToken: TOKEN,
    https: LOCALHOST_TLS,
    readinessProbe: { assertReady: async () => undefined },
    metrics: fakeMetrics,
    rtcPlugin,
  } satisfies CreateAppOptions;
  const app = await createApp(options);
  activeApps.push(app);
  return app;
};

const assertStableMcpHealthy = async (): Promise<void> => {
  const server = createMcpServer({ coordinator, ownerId: OWNER });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chaos-stable", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SEVEN_TOOLS);

    const tasks = await client.callTool({
      name: "list_tasks",
      arguments: { limit: 5 },
    });
    expect(tasks.isError).not.toBe(true);
    const approvals = await client.callTool({
      name: "list_pending_approvals",
      arguments: { limit: 5 },
    });
    expect(approvals.isError).not.toBe(true);
    const result = await client.callTool({
      name: "get_task_result",
      arguments: { job_id: JOB_ID },
    });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
};

const expectStableAppHealthy = async (
  app: Awaited<ReturnType<typeof createApp>>,
): Promise<void> => {
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  expect(ready.statusCode).toBe(200);
  expect(ready.json()).toEqual({ status: "ready" });
  const components = await app.inject({
    method: "GET",
    url: "/health/components",
  });
  expect(components.statusCode).toBe(200);
  expect(components.json().status).toBe("ok");
  expect(components.json().components.core).toEqual({ status: "ok" });
};

const BOUNDED_TELEMETRY_KEYS = [
  "active_sessions",
  "asr_failures",
  "disconnects",
  "enabled",
  "first_asr_final_bucket_ms",
  "first_audio_bucket_ms",
  "first_output_bucket_ms",
  "output_commands",
  "rejects",
  "starts",
].sort();

const boundedTelemetry = (plugin: RtcPlugin): void => {
  const snapshot = plugin.component().telemetry;
  const serialized = JSON.stringify(snapshot);
  expect(Object.keys(snapshot).sort()).toEqual(BOUNDED_TELEMETRY_KEYS);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(OWNER);
  expect(serialized).not.toContain(JOB_ID);
  expect(serialized).not.toMatch(/fingerprint|transcript|pcm/iu);
  expect(snapshot.starts).toEqual({
    started: expect.any(Number),
    rejected: expect.any(Number),
    failed: expect.any(Number),
  });
};

describe("rtc failure isolation", () => {
  afterEach(async () => {
    await Promise.allSettled(activeApps.splice(0).map((app) => app.close()));
    fakeMetrics.recordRtcDisconnect.mockClear();
  });

  const scenarios: ReadonlyArray<{
    name: string;
    build: () => Promise<RtcRouteSet | null>;
    drive?: (plugin: RtcPlugin) => void;
    expectedReason?: string;
  }> = [
    {
      name: "missing credentials",
      build: async () => {
        const error = new Error("missing QHB_RTC_OWNER_SUBJECT");
        Object.assign(error, { code: "RTC_CREDENTIALS_MISSING" });
        throw error;
      },
      expectedReason: "credentials_missing",
    },
    {
      name: "provider startup rejection",
      build: async () => {
        const error = new Error("provider start failed");
        Object.assign(error, { code: "RTC_PROVIDER_START_FAILED" });
        throw error;
      },
      expectedReason: "provider_startup_rejected",
    },
    {
      name: "mid-audio disconnect",
      build: async () => fakeRouteSet(),
      drive: (plugin) => plugin.observeSession("provider_disconnect"),
      expectedReason: "audio_disconnect",
    },
    {
      name: "asr failure",
      build: async () => fakeRouteSet(),
      drive: (plugin) => plugin.observeAsr("failure"),
      expectedReason: "asr_failure",
    },
    {
      name: "sse disconnect",
      build: async () => fakeRouteSet(),
      drive: (plugin) => plugin.observeSession("sse_disconnect"),
      expectedReason: "sse_disconnect",
    },
    {
      name: "token expiry",
      build: async () => fakeRouteSet(),
      drive: (plugin) => plugin.observeSession("token_expired"),
      expectedReason: "token_expired",
    },
    {
      name: "session registry saturation",
      build: async () => fakeRouteSet(),
      drive: (plugin) => plugin.observeRejected("registry_full"),
      expectedReason: "registry_saturated",
    },
    {
      name: "rtc module exception",
      build: async () =>
        fakeRouteSet({
          register() {
            throw new Error("module exploded");
          },
        }),
      expectedReason: "module_exception",
    },
  ];

  for (const scenario of scenarios) {
    it(`keeps stable health and MCP healthy under ${scenario.name}`, async () => {
      const plugin = createRtcPlugin({
        enabled: true,
        build: scenario.build,
        metrics: fakeMetrics,
        drainMs: 5,
        maxConcurrentSessions: 1,
      });
      const app = await createHarness(plugin);

      await expectStableAppHealthy(app);
      scenario.drive?.(plugin);
      await assertStableMcpHealthy();
      await expectStableAppHealthy(app);

      const components = await app.inject({
        method: "GET",
        url: "/health/components",
      });
      const rtc = components.json().components.rtc as {
        status: string;
        reason?: string;
      };
      expect(rtc.status).toBe("degraded");
      if (scenario.expectedReason !== undefined) {
        expect(rtc.reason).toBe(scenario.expectedReason);
      }
      boundedTelemetry(plugin);
    });
  }

  it("force-closes real RTC resources without touching stable readiness", async () => {
    const closeAll = vi.fn(async () => undefined);
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet({ closeAll }),
      metrics: fakeMetrics,
      drainMs: 5,
    });
    const app = await createHarness(plugin);
    await expectStableAppHealthy(app);

    await plugin.forceClose();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(plugin.component().status).toBe("closed");
    expect(plugin.aborted).toBe(true);
    await expectStableAppHealthy(app);
    await assertStableMcpHealthy();
  });

  it("drains for up to the deadline and then force-closes a stuck session", async () => {
    const closeAll = vi.fn(async () => undefined);
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet({ closeAll }),
      metrics: fakeMetrics,
      drainMs: 5,
    });
    await createHarness(plugin);
    expect(plugin.startSession()).toBe(true);

    await plugin.drainAndClose();

    expect(plugin.component().reason).toBe("drain_timeout");
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(plugin.aborted).toBe(true);
  });

  it("mounts zero RTC resources when the flag is disabled and still starts", async () => {
    let built = 0;
    const plugin = createRtcPlugin({
      enabled: false,
      build: async () => {
        built += 1;
        return fakeRouteSet();
      },
      metrics: fakeMetrics,
    });
    const app = await createHarness(plugin);

    expect(built).toBe(0);
    const components = await app.inject({
      method: "GET",
      url: "/health/components",
    });
    expect(components.json().components.rtc.status).toBe("disabled");
    const rtcRoute = await app.inject({
      method: "POST",
      url: "/rtc/session",
      payload: {},
    });
    expect(rtcRoute.statusCode).toBe(404);
    await expectStableAppHealthy(app);
    await assertStableMcpHealthy();
  });
});

const SIGNING_SECRET = "rtc-adapter-signing-secret-value-0123456789";
const OWNER_SUBJECT = "owner-subject-1";
const CALLBACK_URL = "https://control-plane.example.com/rtc/session";

const rtcModule = {
  ownerSubject: OWNER_SUBJECT,
  signingSecret: SIGNING_SECRET,
  callbackUrl: CALLBACK_URL,
  allowedMedia: ["audio"] as const,
  provider: "ALIYUN_RTC" as const,
};

const FIXED_NOW = Date.parse("2026-08-06T10:00:00+08:00");
const sessionStart = {
  platformSessionId: "ses_rtc_lifecycle",
  ownerSubject: OWNER_SUBJECT,
  media: "audio" as const,
  roomId: "channel_lifecycle",
  rtcUserId: "consumer_lifecycle",
  rtcToken: "short-lived-token-value",
  rtcTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  callbackIssuedAt: "2026-08-06T10:00:00.000Z",
};

describe("real rtc lifecycle telemetry", () => {
  afterEach(async () => {
    await Promise.allSettled(activeApps.splice(0).map((app) => app.close()));
  });

  it("drives start, close and latency telemetry from real session call sites", async () => {
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet(),
      now: () => 1_000,
      drainMs: 5,
    });
    expect(plugin.startSession()).toBe(true);
    const writer = {
      closed: false,
      write: () => undefined,
      end: () => undefined,
    };
    const session = createLiveRtcSession({
      start: sessionStart,
      clock: createSystemClock(),
      writer,
      resources: {
        stopOutput: async () => undefined,
        closeProviderStreams: async () => undefined,
      },
      lifecycle: {
        firstAudio: () => plugin.observeAudio(250),
        firstOutput: () => plugin.observeOutput("speak", 400),
      },
      onClose: (reason) => plugin.observeSession(reason),
    });

    session.touch("audio");
    session.touch("output", { succeeded: true });
    await session.close("user_exit");

    const snapshot = plugin.component().telemetry;
    expect(snapshot.first_audio_bucket_ms["250"]).toBe(1);
    expect(snapshot.first_output_bucket_ms["500"]).toBe(1);
    expect(snapshot.output_commands.speak).toBe(1);
    expect(snapshot.active_sessions).toBe(0);
    expect(snapshot.disconnects.user_exit).toBe(1);
  });

  it("records ASR first-final latency and failure from the real adapter", async () => {
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet(),
      drainMs: 5,
    });
    expect(plugin.startSession()).toBe(true);
    const asr = createDashScopeAsr({
      apiKey: "server-secret-api-key",
      onFinal: () => plugin.observeAsrFinal(1_500),
      onFailure: () => plugin.observeAsr("failure"),
      client: {
        async open() {
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
                  endedAtMs: 1_500,
                  id: "final-1",
                };
              },
            },
          };
        },
      },
    });
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield {
          pcm16le: new Uint8Array(6_400),
          sampleRateHz: 16_000 as const,
          channels: 1 as const,
          sequence: 0,
        };
      },
    };
    for await (const _event of asr.recognize(
      frames,
      new AbortController().signal,
    )) {
      // drain the final
    }
    expect(plugin.component().telemetry.first_asr_final_bucket_ms["2000"]).toBe(
      1,
    );

    const failingAsr = createDashScopeAsr({
      apiKey: "server-secret-api-key",
      onFailure: () => plugin.observeAsr("failure"),
      client: {
        async open() {
          throw new Error("provider unavailable");
        },
      },
    });
    try {
      for await (const _event of failingAsr.recognize(
        frames,
        new AbortController().signal,
      )) {
        // unreachable
      }
    } catch {
      // expected RTC_ASR_FAILED
    }
    expect(plugin.component().telemetry.asr_failures).toBe(1);
  });

  it("records output first-frame telemetry from the real serialized writer", async () => {
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet(),
      drainMs: 5,
    });
    expect(plugin.startSession()).toBe(true);
    const frames: string[] = [];
    const output = createSerializedSseOutput({
      writer: {
        closed: false,
        write: (frame: string) => frames.push(frame),
        end: () => undefined,
      },
      onFirstOutput: (kind) => plugin.observeOutput(kind as "speak", 1_200),
    });
    await output.speak("你好。");
    expect(frames.length).toBeGreaterThan(0);
    expect(plugin.component().telemetry.output_commands.speak).toBe(1);
    expect(plugin.component().telemetry.first_output_bucket_ms["2000"]).toBe(1);
  });

  it("keeps active sessions consistent across start, close and force-close", async () => {
    const closeAll = vi.fn(async () => undefined);
    const plugin = createRtcPlugin({
      enabled: true,
      build: async () => fakeRouteSet({ closeAll }),
      drainMs: 5,
      maxConcurrentSessions: 1,
    });
    expect(plugin.startSession()).toBe(true);
    expect(plugin.startSession()).toBe(false);
    expect(plugin.component().telemetry.rejects.concurrency_limit).toBe(1);
    plugin.observeSession("user_exit");
    expect(plugin.component().telemetry.active_sessions).toBe(0);
    plugin.observeSession("user_exit");
    expect(plugin.component().telemetry.active_sessions).toBe(0);
    expect(plugin.component().telemetry.disconnects.user_exit).toBe(2);

    expect(plugin.startSession()).toBe(true);
    await plugin.forceClose();
    expect(plugin.component().telemetry.active_sessions).toBe(0);
    expect(plugin.component().status).toBe("closed");
  });

  it("drives plugin counters from the real RTC route lifecycle wiring", async () => {
    const plugin = createRtcPlugin({
      enabled: true,
      drainMs: 5,
      maxConcurrentSessions: 1,
      build: async () => null,
    });
    const routeSet = createRtcRouteSet({
      module: rtcModule,
      clock: {
        now: () => FIXED_NOW,
        setTimeout: (callback: () => void, ms: number) =>
          setTimeout(callback, ms),
        clearTimeout: (handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      lifecycle: {
        canStart: () => plugin.canStart(),
        rejectionReason: () => plugin.rejectionReason(),
        sessionStart: () => plugin.startSession(),
        sessionRelease: () => plugin.endSession(),
        sessionClose: (reason) => plugin.observeSession(reason),
        sessionRejected: (reason) => plugin.observeRejected(reason),
        firstAudio: () => plugin.observeAudio(),
        firstOutput: () => plugin.observeOutput("speak"),
      },
    });
    if (routeSet === null) throw new Error("route set is disabled");
    expect(routeSet.lifecycle?.canStart?.()).toBe(true);
    const outcome = await routeSet.registry.start({
      start: sessionStart,
      createTransport: () => ({
        writer: {
          closed: false,
          write: () => undefined,
          end: () => undefined,
        },
        resources: {
          stopOutput: async () => undefined,
          closeProviderStreams: async () => undefined,
        },
      }),
    });
    expect(outcome.created).toBe(true);
    expect(routeSet.lifecycle?.sessionStart?.()).toBe(true);
    expect(plugin.component().telemetry.active_sessions).toBe(1);

    outcome.session.touch("audio");
    outcome.session.touch("output", { succeeded: true });
    expect(
      Object.values(plugin.component().telemetry.first_audio_bucket_ms),
    ).toContain(1);
    expect(
      Object.values(plugin.component().telemetry.first_output_bucket_ms),
    ).toContain(1);

    expect(routeSet.lifecycle?.canStart?.()).toBe(false);
    routeSet.lifecycle?.sessionRejected?.(
      routeSet.lifecycle.rejectionReason?.() ?? "concurrency_limit",
    );
    expect(plugin.component().telemetry.rejects.concurrency_limit).toBe(1);
    expect(plugin.component().telemetry.active_sessions).toBe(1);

    const duplicate = await routeSet.registry.start({
      start: sessionStart,
      createTransport: () => ({
        writer: {
          closed: false,
          write: () => undefined,
          end: () => undefined,
        },
        resources: {
          stopOutput: async () => undefined,
          closeProviderStreams: async () => undefined,
        },
      }),
    });
    expect(duplicate.created).toBe(false);
    expect(plugin.component().telemetry.active_sessions).toBe(1);

    await routeSet.registry.close(outcome.session.id, "user_exit");
    expect(plugin.component().telemetry.active_sessions).toBe(0);
    expect(plugin.component().telemetry.disconnects.user_exit).toBe(1);
  });
});
