import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateAppOptions,
  createApp,
} from "../../apps/control-plane/src/http/app.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import type { McpCoordinator } from "../../apps/control-plane/src/mcp/tools.js";
import {
  createRtcPlugin,
  type RtcPlugin,
} from "../../apps/control-plane/src/rtc/plugin.js";
import type { RtcRouteSet } from "../../apps/control-plane/src/rtc/wire/routes.js";
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
