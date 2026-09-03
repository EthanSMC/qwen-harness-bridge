import { sql } from "drizzle-orm";
import { jobStatusValues } from "../db/schema.js";

const MESSAGE_TYPES = [
  "connector.hello",
  "connector.heartbeat",
  "job.claim",
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
  "MESSAGE_EXPIRED",
  "INVALID_MESSAGE",
  "HELLO_REQUIRED",
  "HELLO_ALREADY_INITIALIZED",
] as const;

const HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const METRIC_HELP = [
  [
    "qhb_mcp_submit_duration_seconds",
    "MCP submit_task server-side duration in seconds.",
    "histogram",
  ],
  [
    "qhb_connector_online",
    "Whether at least one Connector is online.",
    "gauge",
  ],
  [
    "qhb_job_queue_age_seconds",
    "Age in seconds of the oldest queued job.",
    "gauge",
  ],
  ["qhb_jobs", "Jobs grouped by bounded status.", "gauge"],
  [
    "qhb_connector_messages_total",
    "Connector messages grouped by bounded message type.",
    "counter",
  ],
  ["qhb_errors_total", "Errors grouped by bounded error code.", "counter"],
] as const;

export type MetricsSnapshot = Readonly<{
  connectorOnline: boolean;
  queueAgeSeconds: number;
  jobsByStatus: Readonly<Record<string, number>>;
}>;

export type MetricsRegistry = Readonly<{
  startMcpSubmit(): () => void;
  observeMcpSubmit(durationSeconds: number): void;
  recordConnectorMessage(messageType: string): void;
  recordError(errorCode: string): void;
  render(): Promise<string>;
}>;

type MetricsRegistryOptions = Readonly<{
  readSnapshot(): Promise<MetricsSnapshot>;
  monotonicNow?: () => number;
}>;

const asFiniteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
};

const escapeLabelValue = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error("Metric value is not finite");
  return String(value);
};

const requireAllowed = (
  value: string,
  allowed: readonly string[],
  label: string,
): void => {
  if (!allowed.includes(value)) {
    throw new Error(`${label} is outside its allowlist`);
  }
};

export function createMetricsRegistry(
  options: MetricsRegistryOptions,
): MetricsRegistry {
  const monotonicNow =
    options.monotonicNow ??
    (() => Number(process.hrtime.bigint()) / 1_000_000_000);
  const messageCounts = new Map<string, number>(
    MESSAGE_TYPES.map((messageType) => [messageType, 0]),
  );
  const errorCounts = new Map<string, number>(
    ERROR_CODES.map((errorCode) => [errorCode, 0]),
  );
  const histogramCounts = HISTOGRAM_BUCKETS.map(() => 0);
  let histogramCount = 0;
  let histogramSum = 0;

  const observeMcpSubmit = (durationSeconds: number): void => {
    const duration = asFiniteNonNegative(durationSeconds, "Submit duration");
    histogramCount += 1;
    histogramSum += duration;
    for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
      if (duration <= (HISTOGRAM_BUCKETS[index] ?? Number.POSITIVE_INFINITY)) {
        histogramCounts[index] = (histogramCounts[index] ?? 0) + 1;
        break;
      }
    }
  };

  return {
    startMcpSubmit() {
      const startedAt = monotonicNow();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        observeMcpSubmit(monotonicNow() - startedAt);
      };
    },
    observeMcpSubmit,
    recordConnectorMessage(messageType) {
      requireAllowed(messageType, MESSAGE_TYPES, "Connector message type");
      messageCounts.set(messageType, (messageCounts.get(messageType) ?? 0) + 1);
    },
    recordError(errorCode) {
      requireAllowed(errorCode, ERROR_CODES, "Metric error code");
      errorCounts.set(errorCode, (errorCounts.get(errorCode) ?? 0) + 1);
    },
    async render() {
      const snapshot = await options.readSnapshot();
      const queueAgeSeconds = asFiniteNonNegative(
        snapshot.queueAgeSeconds,
        "Queue age",
      );
      const jobsByStatus = snapshot.jobsByStatus;
      for (const [status, count] of Object.entries(jobsByStatus)) {
        requireAllowed(status, jobStatusValues, "Job status");
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("Job count must be a non-negative integer");
        }
      }

      const lines: string[] = [];
      for (const [name, help, type] of METRIC_HELP) {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        if (name === "qhb_mcp_submit_duration_seconds") {
          let cumulative = 0;
          for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
            cumulative += histogramCounts[index] ?? 0;
            lines.push(
              `${name}_bucket{le="${formatNumber(HISTOGRAM_BUCKETS[index] ?? 0)}"} ${cumulative}`,
            );
          }
          lines.push(`${name}_bucket{le="+Inf"} ${histogramCount}`);
          lines.push(`${name}_sum ${formatNumber(histogramSum)}`);
          lines.push(`${name}_count ${histogramCount}`);
        } else if (name === "qhb_connector_online") {
          lines.push(`${name} ${snapshot.connectorOnline ? 1 : 0}`);
        } else if (name === "qhb_job_queue_age_seconds") {
          lines.push(`${name} ${formatNumber(queueAgeSeconds)}`);
        } else if (name === "qhb_jobs") {
          for (const status of jobStatusValues) {
            lines.push(
              `${name}{status="${escapeLabelValue(status)}"} ${jobsByStatus[status] ?? 0}`,
            );
          }
        } else if (name === "qhb_connector_messages_total") {
          for (const messageType of MESSAGE_TYPES) {
            lines.push(
              `${name}{message_type="${escapeLabelValue(messageType)}"} ${messageCounts.get(messageType) ?? 0}`,
            );
          }
        } else if (name === "qhb_errors_total") {
          for (const errorCode of ERROR_CODES) {
            lines.push(
              `${name}{error_code="${escapeLabelValue(errorCode)}"} ${errorCounts.get(errorCode) ?? 0}`,
            );
          }
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

type AggregateMetricsRow = Readonly<{
  connector_online?: unknown;
  queue_age_seconds?: unknown;
  status?: unknown;
  status_count?: unknown;
}>;

type AggregateMetricsQueryRunner = Readonly<{
  query(
    statement: string,
  ): Promise<Readonly<{ rows: readonly AggregateMetricsRow[] }>>;
}>;

type AggregateMetricsExecutor = Readonly<{
  execute(
    statement: ReturnType<typeof sql.raw>,
  ): Promise<readonly AggregateMetricsRow[]>;
}>;

const AGGREGATE_METRICS_SQL = `
  WITH job_status_counts AS (
    SELECT status::text AS status, count(*)::bigint AS status_count
    FROM jobs
    GROUP BY status
  ),
  connector_snapshot AS (
    SELECT coalesce(bool_or(health = 'fresh'), false) AS connector_online
    FROM connectors
  ),
  queue_snapshot AS (
    SELECT coalesce(
      max(extract(epoch FROM (clock_timestamp() - accepted_at))),
      0
    )::double precision AS queue_age_seconds
    FROM jobs
    WHERE status = 'queued'
  )
  SELECT connector_snapshot.connector_online,
         queue_snapshot.queue_age_seconds,
         job_status_counts.status,
         job_status_counts.status_count
  FROM connector_snapshot
  CROSS JOIN queue_snapshot
  LEFT JOIN job_status_counts ON true
`;

const isQueryRunner = (
  database: AggregateMetricsQueryRunner | AggregateMetricsExecutor,
): database is AggregateMetricsQueryRunner =>
  typeof (database as Partial<AggregateMetricsQueryRunner>).query ===
  "function";

const asNumber = (value: unknown, fallback: number): number => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function createPostgresMetricsAdapter(
  database: AggregateMetricsQueryRunner | AggregateMetricsExecutor,
): Readonly<{ readSnapshot(): Promise<MetricsSnapshot> }> {
  return {
    async readSnapshot() {
      const result = isQueryRunner(database)
        ? await database.query(AGGREGATE_METRICS_SQL)
        : {
            rows: await database.execute(sql.raw(AGGREGATE_METRICS_SQL)),
          };
      const rows = result.rows;
      const first = rows[0];
      const jobsByStatus: Record<string, number> = {};
      for (const row of rows) {
        if (typeof row.status !== "string") continue;
        jobsByStatus[row.status] = asNumber(row.status_count, 0);
      }
      return {
        connectorOnline:
          first?.connector_online === true || first?.connector_online === "t",
        queueAgeSeconds: Math.max(0, asNumber(first?.queue_age_seconds, 0)),
        jobsByStatus,
      };
    },
  };
}
