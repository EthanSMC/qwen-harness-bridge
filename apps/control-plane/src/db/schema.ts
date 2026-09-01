import type { JobStatus } from "@qhb/protocol";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const jobStatusValues = [
  "queued",
  "dispatched",
  "running",
  "waiting_approval",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly JobStatus[];

export const jobStatusEnum = pgEnum("job_status", jobStatusValues);

export const connectorHealthValues = ["fresh", "stale", "offline"] as const;
export const connectorHealthEnum = pgEnum(
  "connector_health",
  connectorHealthValues,
);

export const jobModeValues = ["normal", "read_only"] as const;
export const jobModeEnum = pgEnum("job_mode", jobModeValues);

export const approvalDecisionValues = ["approve", "reject"] as const;
export const approvalDecisionEnum = pgEnum(
  "approval_decision",
  approvalDecisionValues,
);

export const connectorMessageDirectionValues = ["server", "client"] as const;
export const connectorMessageDirectionEnum = pgEnum(
  "connector_message_direction",
  connectorMessageDirectionValues,
);

const dateTimestamp = { withTimezone: true, mode: "date" } as const;

export const owners = pgTable("owners", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", dateTimestamp).notNull().defaultNow(),
});

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    credentialHash: text("credential_hash").notNull(),
    publicKey: text("public_key"),
    capabilities: jsonb("capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    protocolVersion: varchar("protocol_version", { length: 32 })
      .notNull()
      .default("1.0"),
    health: connectorHealthEnum("health").notNull().default("offline"),
    lastServerSequence: bigint("last_server_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastClientSequence: bigint("last_client_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastHeartbeatAt: timestamp("last_heartbeat_at", dateTimestamp),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    index("connectors_owner_health_idx").on(table.ownerId, table.health),
    check(
      "connectors_server_sequence_nonnegative_check",
      sql`${table.lastServerSequence} >= 0`,
    ),
    check(
      "connectors_client_sequence_nonnegative_check",
      sql`${table.lastClientSequence} >= 0`,
    ),
  ],
);

export const repositoryPolicies = pgTable(
  "repository_policies",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    allowedActionClasses: jsonb("allowed_action_classes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvalTimeoutMinutes: integer("approval_timeout_minutes")
      .notNull()
      .default(5),
    runtimeTimeoutSeconds: integer("runtime_timeout_seconds")
      .notNull()
      .default(3_600),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    index("repository_policies_owner_enabled_idx").on(
      table.ownerId,
      table.enabled,
    ),
    unique("repository_policies_owner_id_key").on(table.ownerId, table.id),
    check(
      "repository_policies_approval_timeout_check",
      sql`${table.approvalTimeoutMinutes} between 1 and 30`,
    ),
    check(
      "repository_policies_runtime_timeout_positive_check",
      sql`${table.runtimeTimeoutSeconds} > 0`,
    ),
    check(
      "repository_policies_concurrency_positive_check",
      sql`${table.maxConcurrency} > 0`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shortId: varchar("short_id", { length: 7 }).notNull().unique(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id").references(() => connectors.id, {
      onDelete: "set null",
    }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositoryPolicies.id, { onDelete: "restrict" }),
    requestCiphertext: text("request_ciphertext"),
    requestDigest: text("request_digest").notNull(),
    mode: jobModeEnum("mode").notNull().default("normal"),
    status: jobStatusEnum("status").notNull().default("queued"),
    currentStage: varchar("current_stage", { length: 128 })
      .notNull()
      .default("queued"),
    revision: integer("revision").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", dateTimestamp),
    harnessAgentId: text("harness_agent_id"),
    harnessSessionId: text("harness_session_id"),
    title: varchar("title", { length: 40 }),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    unreadTerminal: boolean("unread_terminal").notNull().default(false),
    acceptedAt: timestamp("accepted_at", dateTimestamp).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", dateTimestamp)
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    requestDeleteAt: timestamp("request_delete_at", dateTimestamp),
    retentionDeleteAt: timestamp("retention_delete_at", dateTimestamp)
      .notNull()
      .default(sql`now() + interval '30 days'`),
    terminalAt: timestamp("terminal_at", dateTimestamp),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt,
      table.id,
    ),
    index("jobs_owner_status_updated_idx").on(
      table.ownerId,
      table.status,
      table.updatedAt,
    ),
    index("jobs_expiry_idx").on(table.status, table.expiresAt),
    check("jobs_revision_nonnegative_check", sql`${table.revision} >= 0`),
    check("jobs_attempt_nonnegative_check", sql`${table.attempt} >= 0`),
    check(
      "jobs_request_delete_after_terminal_check",
      sql`${table.requestDeleteAt} is null or ${table.terminalAt} is not null`,
    ),
    foreignKey({
      name: "jobs_owner_repository_id_fkey",
      columns: [table.ownerId, table.repositoryId],
      foreignColumns: [repositoryPolicies.ownerId, repositoryPolicies.id],
    }).onDelete("restrict"),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    messageId: uuid("message_id").notNull().defaultRandom(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    source: varchar("source", { length: 32 })
      .notNull()
      .default("control-plane"),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    unique("job_events_job_sequence_key").on(table.jobId, table.sequence),
    unique("job_events_job_message_id_key").on(table.jobId, table.messageId),
    index("job_events_job_created_idx").on(table.jobId, table.createdAt),
    check("job_events_sequence_positive_check", sql`${table.sequence} > 0`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    jobRevision: integer("job_revision").notNull(),
    actionSummary: varchar("action_summary", { length: 400 }).notNull(),
    impactSummary: varchar("impact_summary", { length: 800 }).notNull(),
    actionFingerprint: varchar("action_fingerprint", { length: 71 }).notNull(),
    riskClass: varchar("risk_class", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", dateTimestamp).notNull(),
    decision: approvalDecisionEnum("decision"),
    decidedAt: timestamp("decided_at", dateTimestamp),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    index("approvals_pending_idx").on(
      table.expiresAt,
      table.jobId,
      table.decision,
    ),
    index("approvals_job_idx").on(table.jobId, table.createdAt),
    check("approvals_attempt_positive_check", sql`${table.attempt} > 0`),
    check(
      "approvals_job_revision_nonnegative_check",
      sql`${table.jobRevision} >= 0`,
    ),
    check(
      "approvals_fingerprint_format_check",
      sql`${table.actionFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      "approvals_decision_timestamp_check",
      sql`${table.decision} is null and ${table.decidedAt} is null or ${table.decision} is not null and ${table.decidedAt} is not null`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    clientRequestId: uuid("client_request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", dateTimestamp)
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    unique("idempotency_records_owner_client_request_key").on(
      table.ownerId,
      table.clientRequestId,
    ),
    index("idempotency_records_expiry_idx").on(table.expiresAt),
  ],
);

export const connectorMessages = pgTable(
  "connector_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    direction: connectorMessageDirectionEnum("direction").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    messageId: uuid("message_id").notNull().defaultRandom(),
    type: varchar("type", { length: 64 }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    expiresAt: timestamp("expires_at", dateTimestamp).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", dateTimestamp),
    createdAt: timestamp("created_at", dateTimestamp).notNull().defaultNow(),
  },
  (table) => [
    unique("connector_messages_connector_direction_sequence_key").on(
      table.connectorId,
      table.direction,
      table.sequence,
    ),
    unique("connector_messages_connector_message_id_key").on(
      table.connectorId,
      table.messageId,
    ),
    index("connector_messages_replay_idx").on(
      table.connectorId,
      table.direction,
      table.sequence,
    ),
    check(
      "connector_messages_sequence_positive_check",
      sql`${table.sequence} > 0`,
    ),
  ],
);
