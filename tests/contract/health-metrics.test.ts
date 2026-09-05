import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateAppOptions,
  createApp,
} from "../../apps/control-plane/src/http/app.js";
import {
  createMcpServer,
  type McpServerOptions,
} from "../../apps/control-plane/src/mcp/server.js";
import type { McpCoordinator } from "../../apps/control-plane/src/mcp/tools.js";
import { LOCALHOST_TLS } from "../integration/support/tls.js";

type ReadinessProbe = Readonly<{
  assertReady(): Promise<void>;
}>;

type MetricsSnapshot = Readonly<{
  connectorOnline: boolean;
  queueAgeSeconds: number;
  jobsByStatus: Readonly<Record<string, number>>;
}>;

type AggregateMetricsRow = Readonly<{
  connector_online: boolean;
  queue_age_seconds: number;
  status: string;
  status_count: number;
}>;

type AggregateMetricsQueryRunner = Readonly<{
  query(
    statement: string,
  ): Promise<Readonly<{ rows: readonly AggregateMetricsRow[] }>>;
}>;

type MetricsSnapshotReader = Readonly<{
  readSnapshot(): Promise<MetricsSnapshot>;
}>;

type MetricsRegistry = Readonly<{
  startMcpSubmit(): () => void;
  observeMcpSubmit(durationSeconds: number): void;
  recordConnectorMessage(messageType: string): void;
  recordError(errorCode: string): void;
  render(): Promise<string>;
}>;

type RuntimeOptions = Readonly<{
  readinessProbe?: ReadinessProbe;
  isDraining?: () => boolean;
  metrics?: MetricsRegistry;
}>;

type MetricsModule = Readonly<{
  createMetricsRegistry(options: {
    readSnapshot(): Promise<MetricsSnapshot>;
    monotonicNow?: () => number;
  }): MetricsRegistry;
  createPostgresMetricsAdapter(
    database: AggregateMetricsQueryRunner,
  ): MetricsSnapshotReader;
}>;

type RequiredRuntimeKeys = keyof RuntimeOptions;
type RuntimeContractDeclared =
  RequiredRuntimeKeys extends keyof CreateAppOptions ? true : false;
const runtimeContractDeclared: RuntimeContractDeclared = true;
void runtimeContractDeclared;
type ServerMetricsContractDeclared = "metrics" extends keyof McpServerOptions
  ? true
  : false;
const serverMetricsContractDeclared: ServerMetricsContractDeclared = true;
void serverMetricsContractDeclared;

const coordinator: McpCoordinator = {
  async submit() {
    return {};
  },
  async list() {
    return [];
  },
  async get() {
    return {};
  },
  async cancel() {
    return {};
  },
  async listApprovals() {
    return [];
  },
  async decideApproval() {
    return {};
  },
  async getResult() {
    return {};
  },
};

const activeApps: Awaited<ReturnType<typeof createApp>>[] = [];

const createTestApp = async (runtime: RuntimeOptions = {}) => {
  const options = {
    coordinator,
    ownerId: "health-owner",
    mcpBearerToken: "health-metrics-contract-bearer-token",
    https: LOCALHOST_TLS,
    readinessProbe: runtime.readinessProbe,
    isDraining: runtime.isDraining,
    metrics: runtime.metrics,
  } satisfies CreateAppOptions;
  const app = await createApp(options);
  activeApps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.allSettled(activeApps.splice(0).map((app) => app.close()));
});

describe("health endpoint separation", () => {
  it("keeps liveness independent from failed readiness", async () => {
    const assertReady = vi
      .fn<ReadinessProbe["assertReady"]>()
      .mockRejectedValue(new Error("postgresql://secret@private/db"));
    const app = await createTestApp({ readinessProbe: { assertReady } });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(assertReady).not.toHaveBeenCalled();
  });

  it("keeps the legacy healthz route as a liveness alias", async () => {
    const app = await createTestApp();

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports ready only after the injected probe succeeds", async () => {
    const assertReady = vi
      .fn<ReadinessProbe["assertReady"]>()
      .mockResolvedValue();
    const app = await createTestApp({ readinessProbe: { assertReady } });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(assertReady).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing probe", undefined],
    [
      "failed probe",
      {
        assertReady: vi
          .fn<ReadinessProbe["assertReady"]>()
          .mockRejectedValue(new Error("SELECT secret FROM private_table")),
      },
    ],
  ])(
    "fails readiness closed for a %s without leaking details",
    async (_name, readinessProbe) => {
      const app = await createTestApp({ readinessProbe });

      const response = await app.inject({
        method: "GET",
        url: "/health/ready",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(response.body).not.toContain("SELECT");
      expect(response.body).not.toContain("private_table");
    },
  );

  it("fails readiness closed while shutdown is draining", async () => {
    const assertReady = vi
      .fn<ReadinessProbe["assertReady"]>()
      .mockResolvedValue();
    const app = await createTestApp({
      readinessProbe: { assertReady },
      isDraining: () => true,
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(assertReady).not.toHaveBeenCalled();
  });
});

const ALL_JOB_COUNTS = {
  queued: 2,
  dispatched: 1,
  running: 3,
  waiting_approval: 1,
  cancelling: 0,
  succeeded: 4,
  failed: 1,
  cancelled: 1,
  expired: 0,
} as const;

const loadMetricsModule = async (): Promise<MetricsModule> =>
  (await import(
    "../../apps/control-plane/src/http/metrics.js"
  )) as MetricsModule;

const loadRegistry = async () =>
  (await loadMetricsModule()).createMetricsRegistry;

const sampleLines = (body: string, metric: string): string[] =>
  body
    .split("\n")
    .filter(
      (line) => line.startsWith(metric) && !line.startsWith(`${metric}_`),
    );

type ParsedMetricSample = Readonly<{
  metricName: string;
  labels: ReadonlyArray<Readonly<{ key: string; value: string }>>;
  labelKeys: string[];
  value: string;
}>;

const parseSampleLines = (body: string): ParsedMetricSample[] =>
  body
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(
        line,
      );
      if (match === null) {
        throw new Error(`Invalid Prometheus sample: ${line}`);
      }

      const labels =
        match[2] === undefined || match[2].length === 0
          ? []
          : match[2].split(",").map((label) => {
              const labelMatch =
                /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"$/.exec(label);
              if (labelMatch === null) {
                throw new Error(`Invalid Prometheus label: ${label}`);
              }
              return { key: labelMatch[1], value: labelMatch[2] };
            });
      if (new Set(labels.map((label) => label.key)).size !== labels.length) {
        throw new Error(`Duplicate Prometheus label in sample: ${line}`);
      }

      const sortedLabels = labels.sort((left, right) =>
        left.key.localeCompare(right.key),
      );

      return {
        metricName: match[1],
        labels: sortedLabels,
        labelKeys: sortedLabels.map((label) => label.key),
        value: match[3],
      };
    });

const HISTOGRAM_FAMILY = "qhb_mcp_submit_duration_seconds";

const normalizeMetricFamily = (metricName: string): string => {
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (metricName === `${HISTOGRAM_FAMILY}${suffix}`) {
      return HISTOGRAM_FAMILY;
    }
  }
  return metricName;
};

const MESSAGE_TYPES = [
  "connector.hello",
  "connector.heartbeat",
  "job.claim",
  "job.sync",
  "job.state",
  "job.event",
  "approval.requested",
  "job.cancelled",
  "connector.welcome",
  "job.offer",
  "job.cancel",
  "approval.decision",
  "ack",
  "protocol.error",
] as const;

const ERROR_CODES = [
  "CONNECTOR_OFFLINE",
  "REPOSITORY_NOT_ALLOWED",
  "JOB_NOT_FOUND",
  "JOB_NOT_MUTABLE",
  "IDEMPOTENCY_CONFLICT",
  "APPROVAL_EXPIRED",
  "APPROVAL_MISMATCH",
  "POLICY_DENIED",
  "HARNESS_FAILED",
  "TASK_TIMEOUT",
  "CONNECTOR_LOST",
  "RATE_LIMITED",
  "INTERNAL",
  "REVISION_CONFLICT",
  "UNAUTHENTICATED",
  "AUTHORIZATION_FAILED",
  "CLIENT_SEQUENCE_GAP",
  "CLIENT_REPLAY_MISMATCH",
  "CLAIM_REJECTED",
  "EVENT_REJECTED",
  "JOB_AUTHORITY_UNAVAILABLE",
  "MESSAGE_EXPIRED",
  "INVALID_MESSAGE",
  "HELLO_REQUIRED",
  "HELLO_ALREADY_INITIALIZED",
] as const;

const METRIC_TYPES = {
  qhb_mcp_submit_duration_seconds: "histogram",
  qhb_connector_online: "gauge",
  qhb_job_queue_age_seconds: "gauge",
  qhb_jobs: "gauge",
  qhb_connector_messages_total: "counter",
  qhb_errors_total: "counter",
} as const;

describe("bounded Prometheus metrics", () => {
  it("counts only fixed coordination message and error labels", async () => {
    const registry = (await loadRegistry())({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: ALL_JOB_COUNTS,
        };
      },
    });
    registry.recordConnectorMessage("job.sync");
    registry.recordConnectorMessage("job.sync");
    registry.recordConnectorMessage("job.state");
    registry.recordError("JOB_AUTHORITY_UNAVAILABLE");
    const body = await registry.render();
    expect(sampleLines(body, "qhb_connector_messages_total")).toHaveLength(14);
    expect(sampleLines(body, "qhb_errors_total")).toHaveLength(25);
    expect(body).toContain(
      'qhb_connector_messages_total{message_type="job.sync"} 2',
    );
    expect(body).toContain(
      'qhb_connector_messages_total{message_type="job.state"} 1',
    );
    expect(body).toContain(
      'qhb_errors_total{error_code="JOB_AUTHORITY_UNAVAILABLE"} 1',
    );
  });
  it("exports correct stable gauges, bounded families, and histogram samples", async () => {
    const createMetricsRegistry = await loadRegistry();
    const terminalSummaryFixture =
      "terminal summary: customer-payments completed with secret material";
    const sensitiveValues = [
      "00000000-0000-4000-8000-000000000099",
      "owner-private-123",
      "connector-private-456",
      "repo-customer-payments",
      "delete the production database",
      "/Users/private/customer/repository",
      "C:\\Users\\private\\repository",
      "https://token:secret@example.test/artifact?access_token=secret",
      "sk-proj-secret-material",
      "SELECT password FROM users",
      terminalSummaryFixture,
    ];
    const registry = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: true,
          queueAgeSeconds: 12.5,
          jobsByStatus: ALL_JOB_COUNTS,
          ignoredSensitiveFixture: sensitiveValues,
          terminalSummary: terminalSummaryFixture,
        } as MetricsSnapshot;
      },
    });
    registry.observeMcpSubmit(0.125);
    registry.recordConnectorMessage("connector.heartbeat");
    registry.recordError("INTERNAL");
    const app = await createTestApp({ metrics: registry });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    for (const [family, type] of Object.entries(METRIC_TYPES)) {
      expect(response.body).toMatch(new RegExp(`^# HELP ${family} `, "m"));
      expect(response.body).toContain(`# TYPE ${family} ${type}\n`);
    }
    expect(
      response.body
        .split("\n")
        .flatMap((line) => /^# HELP (\S+) /.exec(line)?.[1] ?? []),
    ).toEqual(Object.keys(METRIC_TYPES));
    const emittedTypes = Object.fromEntries(
      response.body.split("\n").flatMap((line) => {
        const match = /^# TYPE (\S+) (\S+)$/.exec(line);
        return match === null ? [] : [[match[1], match[2]]];
      }),
    );
    expect(emittedTypes).toEqual(METRIC_TYPES);
    const samples = parseSampleLines(response.body);
    const sampleKeys = samples.map(
      (sample) =>
        `${sample.metricName}|${sample.labels
          .map((label) => `${label.key}=${label.value}`)
          .join(",")}`,
    );
    expect(new Set(sampleKeys).size).toBe(sampleKeys.length);
    expect(
      [
        ...new Set(
          samples.map((sample) => normalizeMetricFamily(sample.metricName)),
        ),
      ].sort(),
    ).toEqual(Object.keys(METRIC_TYPES).sort());
    const expectedLabelKeys: Readonly<Record<string, readonly string[]>> = {
      qhb_mcp_submit_duration_seconds: [],
      qhb_connector_online: [],
      qhb_job_queue_age_seconds: [],
      qhb_jobs: ["status"],
      qhb_connector_messages_total: ["message_type"],
      qhb_errors_total: ["error_code"],
    };
    for (const sample of samples) {
      const expected =
        sample.metricName === `${HISTOGRAM_FAMILY}_bucket`
          ? ["le"]
          : expectedLabelKeys[normalizeMetricFamily(sample.metricName)];
      expect(expected).toBeDefined();
      expect(sample.labelKeys).toEqual(expected);
    }
    expect(response.body).toContain("qhb_connector_online 1");
    expect(response.body).toContain("qhb_job_queue_age_seconds 12.5");
    for (const [status, count] of Object.entries(ALL_JOB_COUNTS)) {
      expect(response.body).toContain(`qhb_jobs{status="${status}"} ${count}`);
    }
    expect(response.body).toContain(
      'qhb_connector_messages_total{message_type="connector.heartbeat"} 1',
    );
    expect(response.body).toContain(
      'qhb_errors_total{error_code="INTERNAL"} 1',
    );
    const bucketLines = response.body
      .split("\n")
      .filter((line) =>
        line.startsWith("qhb_mcp_submit_duration_seconds_bucket"),
      );
    const buckets = bucketLines.map((line) =>
      Number(line.slice(line.lastIndexOf(" ") + 1)),
    );
    expect(bucketLines.length).toBeGreaterThan(1);
    expect(bucketLines.at(-1)).toMatch(
      /qhb_mcp_submit_duration_seconds_bucket\{le="\+Inf"\} \S+$/,
    );
    expect(buckets.every((value) => Number.isFinite(value))).toBe(true);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]).toBeGreaterThanOrEqual(buckets[index - 1] ?? 0);
    }
    const count = Number(
      /^qhb_mcp_submit_duration_seconds_count (\S+)$/m.exec(response.body)?.[1],
    );
    const sum = Number(
      /^qhb_mcp_submit_duration_seconds_sum (\S+)$/m.exec(response.body)?.[1],
    );
    expect(Number.isFinite(count)).toBe(true);
    expect(Number.isFinite(sum)).toBe(true);
    expect(count).toBe(1);
    expect(sum).toBe(0.125);
    expect(response.body.endsWith("\n")).toBe(true);
    for (const value of sensitiveValues) {
      expect(response.body).not.toContain(value);
    }

    for (const line of sampleLines(response.body, "qhb_jobs")) {
      expect(line).toMatch(/^qhb_jobs\{status="[a-z_]+"\} \d+$/);
    }
    for (const line of sampleLines(
      response.body,
      "qhb_connector_messages_total",
    )) {
      expect(line).toMatch(
        /^qhb_connector_messages_total\{message_type="[a-z.]+"\} \d+$/,
      );
    }
    for (const line of sampleLines(response.body, "qhb_errors_total")) {
      expect(line).toMatch(/^qhb_errors_total\{error_code="[A-Z_]+"\} \d+$/);
    }
  });

  it("measures submit_task inside the server with an injected monotonic clock", async () => {
    const createMetricsRegistry = await loadRegistry();
    const clockValues = [100, 100.125];
    const trace: string[] = [];
    const registry = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: ALL_JOB_COUNTS,
        };
      },
      monotonicNow: () => {
        trace.push(trace.length === 0 ? "clock:start" : "clock:stop");
        const value = clockValues.shift();
        if (value === undefined) throw new Error("monotonic clock over-read");
        return value;
      },
    });
    let submittedInput: unknown;
    const timingCoordinator: McpCoordinator = {
      ...coordinator,
      async submit(_owner, input) {
        trace.push("submit:start");
        submittedInput = input;
        await Promise.resolve();
        trace.push("submit:end");
        return {
          job_id: "00000000-0000-4000-8000-000000000001",
          short_id: "QH-7M2P",
          status: "queued",
          connector_status: "offline",
          accepted_at: "2026-09-01T00:00:00.000Z",
          expires_at: "2026-09-02T00:00:00.000Z",
        };
      },
    };
    const serverOptions = {
      coordinator: timingCoordinator,
      ownerId: "metrics-owner",
      metrics: registry,
    };
    const server = createMcpServer(serverOptions);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "metrics-contract", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const submitTool = (await client.listTools()).tools.find(
        (tool) => tool.name === "submit_task",
      );
      expect(submitTool?.inputSchema.properties).not.toHaveProperty(
        "duration_seconds",
      );

      const response = await client.callTool({
        name: "submit_task",
        arguments: {
          client_request_id: "00000000-0000-4000-8000-000000000010",
          repository_id: "metrics-repository",
          request: "Run the metrics contract",
          mode: "normal",
        },
      });
      expect(response.isError).not.toBe(true);
      expect(submittedInput).not.toHaveProperty("duration_seconds");
      const body = await registry.render();
      expect(body).toContain("qhb_mcp_submit_duration_seconds_count 1");
      const sum = Number(
        /^qhb_mcp_submit_duration_seconds_sum (\S+)$/m.exec(body)?.[1],
      );
      expect(sum).toBe(0.125);
      expect(clockValues).toHaveLength(0);
      expect(trace).toEqual([
        "clock:start",
        "submit:start",
        "submit:end",
        "clock:stop",
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps liveness healthy and hides a metric snapshot failure", async () => {
    const createMetricsRegistry = await loadRegistry();
    const secretError = "postgresql://user:secret@private/db SELECT password";
    const readSnapshot = vi
      .fn<MetricsSnapshotReader["readSnapshot"]>()
      .mockRejectedValue(new Error(secretError));
    const registry = createMetricsRegistry({
      readSnapshot,
    });
    const app = await createTestApp({ metrics: registry });

    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(readSnapshot).not.toHaveBeenCalled();
    const metrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(metrics.statusCode).toBe(503);
    expect(metrics.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(metrics.json()).toEqual({ status: "unavailable" });
  });

  it("renders independent registries deterministically across insertion order", async () => {
    const createMetricsRegistry = await loadRegistry();
    const firstCounts = Object.fromEntries(Object.entries(ALL_JOB_COUNTS));
    const secondCounts = Object.fromEntries(
      Object.entries(ALL_JOB_COUNTS).reverse(),
    );
    const first = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: firstCounts,
        };
      },
    });
    const second = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: secondCounts,
        };
      },
    });
    first.recordConnectorMessage("connector.heartbeat");
    first.recordConnectorMessage("job.claim");
    first.recordError("INTERNAL");
    first.recordError("TASK_TIMEOUT");
    first.observeMcpSubmit(0.125);
    second.observeMcpSubmit(0.125);
    second.recordError("TASK_TIMEOUT");
    second.recordError("INTERNAL");
    second.recordConnectorMessage("job.claim");
    second.recordConnectorMessage("connector.heartbeat");

    const firstBody = await first.render();
    const secondBody = await second.render();

    expect(firstBody).toBe(secondBody);
    expect(firstBody).toContain("qhb_connector_online 0\n");

    const isolated = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: ALL_JOB_COUNTS,
        };
      },
    });
    const isolatedBody = await isolated.render();
    expect(isolatedBody).not.toContain(
      'qhb_connector_messages_total{message_type="connector.heartbeat"} 1',
    );
    expect(isolatedBody).not.toContain(
      'qhb_errors_total{error_code="INTERNAL"} 1',
    );
    const isolatedSamples = parseSampleLines(isolatedBody);
    const freshProcessLocalSamples = isolatedSamples.filter((sample) =>
      [
        HISTOGRAM_FAMILY,
        "qhb_connector_messages_total",
        "qhb_errors_total",
      ].includes(normalizeMetricFamily(sample.metricName)),
    );
    expect(
      freshProcessLocalSamples.every((sample) => sample.value === "0"),
    ).toBe(true);
  });

  it("uses aggregate-only PostgreSQL metrics queries without raw projections", async () => {
    const metrics = await loadMetricsModule();
    const aggregateRows = [
      {
        connector_online: true,
        queue_age_seconds: 12.5,
        status: "queued",
        status_count: 2,
      },
      {
        connector_online: true,
        queue_age_seconds: 12.5,
        status: "succeeded",
        status_count: 4,
      },
    ] as const;
    const statements: string[] = [];
    const query = vi.fn(
      async (
        statement: string,
      ): Promise<{ rows: readonly AggregateMetricsRow[] }> => {
        statements.push(statement);
        expect(statement).toMatch(/\bselect\b/i);
        expect(statement).not.toMatch(/\bselect\s+\*/i);
        expect(statement).not.toMatch(
          /\b(?:owner_id|connector_id|job_id|repository_id|prompt|summary|path|url|secret|raw_error|error_text)\b/i,
        );
        return { rows: aggregateRows };
      },
    );

    const adapter = metrics.createPostgresMetricsAdapter({ query });
    const snapshot = await adapter.readSnapshot();

    expect(query).toHaveBeenCalled();
    expect(statements.length).toBeGreaterThan(0);
    expect(Object.keys(snapshot).sort()).toEqual([
      "connectorOnline",
      "jobsByStatus",
      "queueAgeSeconds",
    ]);
    expect(snapshot).toEqual({
      connectorOnline: true,
      queueAgeSeconds: 12.5,
      jobsByStatus: {
        queued: 2,
        succeeded: 4,
      },
    });
  });

  it("uses execute for a schema-bound Drizzle database with a non-callable query object", async () => {
    const metrics = await loadMetricsModule();
    const execute = vi.fn(
      async () =>
        [
          {
            connector_online: true,
            queue_age_seconds: "2.5",
            status: "queued",
            status_count: "3",
          },
        ] as const,
    );
    const schemaBoundDatabase = {
      query: {
        connectors: {},
        jobs: {},
      },
      execute,
    };

    const adapter = metrics.createPostgresMetricsAdapter(
      schemaBoundDatabase as never,
    );

    await expect(adapter.readSnapshot()).resolves.toEqual({
      connectorOnline: true,
      queueAgeSeconds: 2.5,
      jobsByStatus: { queued: 3 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects every value outside the bounded status/message/error allowlists", async () => {
    const createMetricsRegistry = await loadRegistry();
    const registry = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: ALL_JOB_COUNTS,
        };
      },
    });

    for (const value of MESSAGE_TYPES) {
      expect(() => registry.recordConnectorMessage(value)).not.toThrow();
    }
    for (const value of ERROR_CODES) {
      expect(() => registry.recordError(value)).not.toThrow();
    }
    const body = await registry.render();
    const emittedStatuses = sampleLines(body, "qhb_jobs")
      .map((line) => /status="([^"]+)"/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    const emittedMessages = sampleLines(body, "qhb_connector_messages_total")
      .map((line) => /message_type="([^"]+)"/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    const emittedErrors = sampleLines(body, "qhb_errors_total")
      .map((line) => /error_code="([^"]+)"/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    expect(emittedStatuses).toEqual(Object.keys(ALL_JOB_COUNTS).sort());
    expect(emittedMessages).toEqual([...MESSAGE_TYPES].sort());
    expect(emittedErrors).toEqual([...ERROR_CODES].sort());

    for (const value of [
      "connector.foo",
      "job.progress",
      "bogus",
      "NOT_A_CODE",
      "00000000-0000-4000-8000-000000000099",
      "owner-private-123",
      "repo-customer-payments",
      "delete the production database",
      "/Users/private/customer/repository",
      "C:\\Users\\private\\repository",
      "https://token:secret@example.test/artifact?access_token=secret",
      "sk-proj-secret-material",
      "SELECT password FROM users",
    ]) {
      expect(() => registry.recordConnectorMessage(value)).toThrow();
      expect(() => registry.recordError(value)).toThrow();
    }
    expect(registry).not.toHaveProperty("labels");
    expect(registry).not.toHaveProperty("setLabel");

    const invalidStatusRegistry = createMetricsRegistry({
      async readSnapshot() {
        return {
          connectorOnline: false,
          queueAgeSeconds: 0,
          jobsByStatus: {
            ...ALL_JOB_COUNTS,
            bogus: 1,
          },
        };
      },
    });
    await expect(invalidStatusRegistry.render()).rejects.toThrow();
  });
});
