import type { JobStatus } from "@qhb/protocol";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { assertTransition, TERMINAL_JOB_STATES } from "../domain/job-state.js";
import type { Database } from "./client.js";
import {
  approvals,
  connectorMessages,
  connectors,
  idempotencyRecords,
  jobEvents,
  jobs,
  repositoryPolicies,
} from "./schema.js";

type JobRow = typeof jobs.$inferSelect;
type JobEventRow = typeof jobEvents.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

type QueryDatabase = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export type JobRepositoryErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "APPROVAL_ALREADY_DECIDED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "CONNECTOR_OWNER_MISMATCH"
  | "INVALID_ATTEMPT"
  | "INVALID_EVENT"
  | "INVALID_LEASE_ID"
  | "INVALID_LIMIT"
  | "NOT_FOUND"
  | "SHORT_ID_EXHAUSTED";

export class JobRepositoryError extends Error {
  readonly code: JobRepositoryErrorCode;

  constructor(code: JobRepositoryErrorCode, message: string = code) {
    super(message);
    this.name = "JobRepositoryError";
    this.code = code;
  }
}

export type CreateIdempotentInput = {
  ownerId: string;
  clientRequestId: string;
  repositoryId: string;
  requestCiphertext: string;
  requestDigest: string;
  mode?: "normal" | "read_only";
};

export type JobRecord = {
  jobId: string;
  shortId: string;
  ownerId: string;
  connectorId: string | null;
  repositoryId: string;
  requestCiphertext: string | null;
  requestDigest: string;
  mode: "normal" | "read_only";
  status: JobStatus;
  currentStage: string;
  revision: number;
  attempt: number;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  harnessAgentId: string | null;
  harnessSessionId: string | null;
  title: string | null;
  summary: Record<string, unknown> | null;
  unreadTerminal: boolean;
  acknowledgedAt: Date | null;
  acceptedAt: Date;
  expiresAt: Date;
  requestDeleteAt: Date | null;
  retentionDeleteAt: Date;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobEventInput = {
  type: string;
  payload: Record<string, unknown>;
  source?: string;
  messageId?: string;
  correlationId?: string;
};

export type JobEventRecord = {
  eventId: string;
  jobId: string;
  sequence: number;
  messageId: string;
  type: string;
  payload: Record<string, unknown>;
  source: string;
  correlationId: string;
  createdAt: Date;
};

export type ListJobsInput = {
  ownerId: string;
  limit?: number;
  status?: JobStatus;
  unreadOnly?: boolean;
};

export type RepositoryPolicyRecord = {
  id: string;
  ownerId: string;
  displayName: string;
  canonicalPath: string;
  allowedActionClasses: string[];
  approvalTimeoutMinutes: number;
  runtimeTimeoutSeconds: number;
  maxConcurrency: number;
  enabled: boolean;
};

export type ConnectorHealth = "fresh" | "stale" | "offline";

export type CancelJobInput = {
  ownerId: string;
  jobId: string;
  expectedRevision: number;
  reason?: string;
  now?: Date;
};

export type ClaimOfferInput = {
  connectorId: string;
  attempt: number;
  leaseId: string;
};

export type ApprovalDecision = "approve" | "reject";

export type RecordApprovalDecisionInput = {
  approvalId: string;
  decision: ApprovalDecision;
  expectedJobRevision: number;
  ownerId?: string;
  actionFingerprint?: string;
  expectedAttempt?: number;
  now?: Date;
};

export type ApprovalRecord = {
  approvalId: string;
  jobId: string;
  ownerId?: string;
  jobShortId?: string;
  attempt: number;
  jobRevision: number;
  actionSummary: string;
  impactSummary: string;
  actionFingerprint: string;
  riskClass: string;
  expiresAt: Date;
  decision: ApprovalDecision | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobResultRecord = {
  jobId: string;
  summary: string;
  changedFiles: string[];
  tests: {
    passed: number;
    failed: number;
    summary: string;
  };
  artifacts: Array<{
    name: string;
    mediaType: string;
    url: string;
  }>;
  acknowledgedAt: Date;
};

const MAX_LIST_LIMIT = 5;
const SHORT_ID_RETRIES = 32;
const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const newShortId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const randomBits = ((bytes[0] & 0x0f) << 16) | (bytes[1] << 8) | bytes[2];
  let suffix = "";
  for (let shift = 15; shift >= 0; shift -= 5) {
    suffix += CROCKFORD_BASE32_ALPHABET[(randomBits >>> shift) & 0x1f];
  }
  return `QH-${suffix}`;
};

const toJobRecord = (row: JobRow): JobRecord => ({
  jobId: row.id,
  shortId: row.shortId,
  ownerId: row.ownerId,
  connectorId: row.connectorId,
  repositoryId: row.repositoryId,
  requestCiphertext: row.requestCiphertext,
  requestDigest: row.requestDigest,
  mode: row.mode,
  status: row.status,
  currentStage: row.currentStage,
  revision: row.revision,
  attempt: row.attempt,
  leaseId: row.leaseId,
  leaseExpiresAt: row.leaseExpiresAt,
  harnessAgentId: row.harnessAgentId,
  harnessSessionId: row.harnessSessionId,
  title: row.title,
  summary: row.summary,
  unreadTerminal: row.unreadTerminal,
  acknowledgedAt: row.acknowledgedAt,
  acceptedAt: row.acceptedAt,
  expiresAt: row.expiresAt,
  requestDeleteAt: row.requestDeleteAt,
  retentionDeleteAt: row.retentionDeleteAt,
  terminalAt: row.terminalAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toEventRecord = (row: JobEventRow): JobEventRecord => ({
  eventId: row.id,
  jobId: row.jobId,
  sequence: row.sequence,
  messageId: row.messageId,
  type: row.eventType,
  payload: row.payload,
  source: row.source,
  correlationId: row.correlationId,
  createdAt: row.createdAt,
});

const toApprovalRecord = (
  row: ApprovalRow,
  ownerId?: string,
  jobShortId?: string,
): ApprovalRecord => ({
  approvalId: row.id,
  jobId: row.jobId,
  ...(ownerId === undefined ? {} : { ownerId }),
  ...(jobShortId === undefined ? {} : { jobShortId }),
  attempt: row.attempt,
  jobRevision: row.jobRevision,
  actionSummary: row.actionSummary,
  impactSummary: row.impactSummary,
  actionFingerprint: row.actionFingerprint,
  riskClass: row.riskClass,
  expiresAt: row.expiresAt,
  decision: row.decision,
  decidedAt: row.decidedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRepositoryPolicyRecord = (
  row: typeof repositoryPolicies.$inferSelect,
): RepositoryPolicyRecord => ({
  id: row.id,
  ownerId: row.ownerId,
  displayName: row.displayName,
  canonicalPath: row.canonicalPath,
  allowedActionClasses: row.allowedActionClasses,
  approvalTimeoutMinutes: row.approvalTimeoutMinutes,
  runtimeTimeoutSeconds: row.runtimeTimeoutSeconds,
  maxConcurrency: row.maxConcurrency,
  enabled: row.enabled,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const toJobResultRecord = (row: JobRow): JobResultRecord | null => {
  const summary = asRecord(row.summary);
  if (
    summary === null ||
    typeof summary.summary !== "string" ||
    summary.summary.trim().length === 0 ||
    row.acknowledgedAt === null
  ) {
    return null;
  }
  const testSummary = asRecord(summary.tests);
  const artifacts = Array.isArray(summary.artifacts)
    ? summary.artifacts.flatMap((artifact) => {
        const value = asRecord(artifact);
        const mediaType =
          typeof value?.mediaType === "string"
            ? value.mediaType
            : typeof value?.media_type === "string"
              ? value.media_type
              : null;
        if (
          value === null ||
          typeof value.name !== "string" ||
          mediaType === null ||
          typeof value.url !== "string"
        ) {
          return [];
        }
        return [
          {
            name: value.name,
            mediaType,
            url: value.url,
          },
        ];
      })
    : [];
  return {
    jobId: row.id,
    summary: typeof summary.summary === "string" ? summary.summary : "",
    changedFiles: asStringArray(summary.changed_files ?? summary.changedFiles),
    tests: {
      passed:
        testSummary !== null && typeof testSummary.passed === "number"
          ? testSummary.passed
          : 0,
      failed:
        testSummary !== null && typeof testSummary.failed === "number"
          ? testSummary.failed
          : 0,
      summary:
        testSummary !== null && typeof testSummary.summary === "string"
          ? testSummary.summary
          : "",
    },
    artifacts,
    acknowledgedAt: row.acknowledgedAt,
  };
};

const readJob = async (
  database: QueryDatabase,
  jobId: string,
  ownerId?: string,
): Promise<JobRow | undefined> => {
  const condition =
    ownerId === undefined
      ? eq(jobs.id, jobId)
      : and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId));
  const rows = await database.select().from(jobs).where(condition).limit(1);
  return rows[0];
};

const readDatabaseTime = async (database: QueryDatabase): Promise<Date> => {
  const rows = await database.execute(
    sql`select clock_timestamp() as "currentTime"`,
  );
  const value = (rows[0] as { currentTime?: Date | string } | undefined)
    ?.currentTime;
  if (value === undefined) {
    throw new Error("Current database time is missing");
  }
  const currentTime = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(currentTime.getTime())) {
    throw new Error("Current database time is invalid");
  }
  return currentTime;
};

const commandExpiresAt = (jobExpiresAt: Date, now: Date): Date =>
  new Date(Math.min(jobExpiresAt.getTime(), now.getTime() + 60_000));

const isTerminal = (status: JobStatus): boolean =>
  TERMINAL_JOB_STATES.has(status);

type ConnectorCommandType = "job.cancel" | "approval.decision";

const enqueueServerCommand = async (
  database: QueryDatabase,
  ownerId: string,
  connectorId: string,
  type: ConnectorCommandType,
  payload: Record<string, unknown>,
  expiresAt: Date,
): Promise<void> => {
  const connectorRows = await database
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
    .for("update");
  const connector = connectorRows[0];
  if (connector === undefined || connector.ownerId !== ownerId) {
    throw new JobRepositoryError(
      "CONNECTOR_OWNER_MISMATCH",
      "The connector is not owned by the job owner",
    );
  }

  const sequence = connector.lastServerSequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new JobRepositoryError(
      "INVALID_EVENT",
      "The connector server sequence is invalid",
    );
  }

  const updatedConnectors = await database
    .update(connectors)
    .set({
      lastServerSequence: sequence,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.lastServerSequence, connector.lastServerSequence),
      ),
    )
    .returning({ lastServerSequence: connectors.lastServerSequence });
  if (updatedConnectors[0]?.lastServerSequence !== sequence) {
    throw new JobRepositoryError(
      "REVISION_CONFLICT",
      "The connector server sequence is stale",
    );
  }

  await database.insert(connectorMessages).values({
    connectorId,
    direction: "server",
    sequence,
    type,
    payload,
    expiresAt,
  });
};

const nextEventSequence = async (
  database: QueryDatabase,
  jobId: string,
): Promise<number> => {
  const rows = await database
    .select({
      sequence: sql<number>`coalesce(max(${jobEvents.sequence}), 0)`.as(
        "sequence",
      ),
    })
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId));
  const current = Number(rows[0]?.sequence ?? 0);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error(`INVALID_EVENT_SEQUENCE:${current}`);
  }
  return current + 1;
};

const appendEvent = async (
  database: QueryDatabase,
  jobId: string,
  sequence: number,
  input: JobEventInput,
): Promise<void> => {
  await database.insert(jobEvents).values({
    jobId,
    sequence,
    eventType: input.type,
    payload: input.payload,
    source: input.source ?? "control-plane",
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  });
};

const validateEvent = (input: JobEventInput): void => {
  if (input.type.trim().length === 0 || input.type.length > 64) {
    throw new JobRepositoryError("INVALID_EVENT", "Invalid event type");
  }
  if (
    input.source !== undefined &&
    (input.source.trim().length === 0 || input.source.length > 32)
  ) {
    throw new JobRepositoryError("INVALID_EVENT", "Invalid event source");
  }
};

const validateClaim = (input: ClaimOfferInput): void => {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new JobRepositoryError("INVALID_ATTEMPT", "Attempt must be positive");
  }
  if (!UUID_PATTERN.test(input.leaseId)) {
    throw new JobRepositoryError("INVALID_LEASE_ID", "Lease ID must be a UUID");
  }
};

export class JobRepository {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async getRepositoryPolicy(
    ownerId: string,
    repositoryId: string,
  ): Promise<RepositoryPolicyRecord | null> {
    const rows = await this.#db
      .select()
      .from(repositoryPolicies)
      .where(
        and(
          eq(repositoryPolicies.ownerId, ownerId),
          eq(repositoryPolicies.id, repositoryId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRepositoryPolicyRecord(row);
  }

  async getConnectorHealth(ownerId: string): Promise<ConnectorHealth> {
    const rows = await this.#db
      .select({ health: connectors.health })
      .from(connectors)
      .where(eq(connectors.ownerId, ownerId));
    if (rows.some((row) => row.health === "fresh")) {
      return "fresh";
    }
    if (rows.some((row) => row.health === "stale")) {
      return "stale";
    }
    return "offline";
  }

  async createIdempotent(input: CreateIdempotentInput): Promise<JobRecord> {
    return this.#db.transaction(async (tx) => {
      const lockKey = JSON.stringify([input.ownerId, input.clientRequestId]);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );

      const existingRows = await tx
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.ownerId, input.ownerId),
            eq(idempotencyRecords.clientRequestId, input.clientRequestId),
          ),
        )
        .for("update");
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (existing.requestDigest !== input.requestDigest) {
          throw new JobRepositoryError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was used with a different request digest",
          );
        }
        const original = await readJob(tx, existing.jobId);
        if (original === undefined) {
          throw new JobRepositoryError(
            "NOT_FOUND",
            "The idempotency record points to a missing job",
          );
        }
        return toJobRecord(original);
      }

      let created: JobRow | undefined;
      for (let attempt = 0; attempt < SHORT_ID_RETRIES; attempt += 1) {
        const rows = await tx
          .insert(jobs)
          .values({
            shortId: newShortId(),
            ownerId: input.ownerId,
            repositoryId: input.repositoryId,
            requestCiphertext: input.requestCiphertext,
            requestDigest: input.requestDigest,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
          })
          .onConflictDoNothing({ target: jobs.shortId })
          .returning();
        created = rows[0];
        if (created !== undefined) {
          break;
        }
      }
      if (created === undefined) {
        throw new JobRepositoryError(
          "SHORT_ID_EXHAUSTED",
          "Could not allocate a unique short job ID",
        );
      }

      const insertedRecords = await tx
        .insert(idempotencyRecords)
        .values({
          ownerId: input.ownerId,
          clientRequestId: input.clientRequestId,
          requestDigest: input.requestDigest,
          jobId: created.id,
        })
        .onConflictDoNothing({
          target: [
            idempotencyRecords.ownerId,
            idempotencyRecords.clientRequestId,
          ],
        })
        .returning();

      if (insertedRecords.length === 0) {
        await tx.delete(jobs).where(eq(jobs.id, created.id));
        const winnerRows = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.ownerId, input.ownerId),
              eq(idempotencyRecords.clientRequestId, input.clientRequestId),
            ),
          )
          .for("update");
        const winner = winnerRows[0];
        if (winner === undefined) {
          throw new JobRepositoryError(
            "NOT_FOUND",
            "The concurrent idempotency record was not found",
          );
        }
        if (winner.requestDigest !== input.requestDigest) {
          throw new JobRepositoryError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was used with a different request digest",
          );
        }
        const original = await readJob(tx, winner.jobId);
        if (original === undefined) {
          throw new JobRepositoryError(
            "NOT_FOUND",
            "The idempotency record points to a missing job",
          );
        }
        return toJobRecord(original);
      }

      return toJobRecord(created);
    });
  }

  async get(jobId: string): Promise<JobRecord | null>;
  async get(ownerId: string, jobId: string): Promise<JobRecord | null>;
  async get(first: string, second?: string): Promise<JobRecord | null> {
    const row = await readJob(
      this.#db,
      second ?? first,
      second === undefined ? undefined : first,
    );
    return row === undefined ? null : toJobRecord(row);
  }

  async list(input: ListJobsInput): Promise<JobRecord[]> {
    const limit = input.limit ?? MAX_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new JobRepositoryError(
        "INVALID_LIMIT",
        "Job list limit must be between 1 and 5",
      );
    }

    const conditions = [eq(jobs.ownerId, input.ownerId)];
    if (input.status !== undefined) {
      conditions.push(eq(jobs.status, input.status));
    }
    if (input.unreadOnly === true) {
      conditions.push(eq(jobs.unreadTerminal, true));
    }
    const rows = await this.#db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.updatedAt), asc(jobs.id))
      .limit(limit);
    return rows.map(toJobRecord);
  }

  async events(jobId: string): Promise<JobEventRecord[]>;
  async events(
    ownerId: string,
    jobId: string,
    limit?: number,
  ): Promise<JobEventRecord[]>;
  async events(
    first: string,
    second?: string,
    requestedLimit = MAX_LIST_LIMIT,
  ): Promise<JobEventRecord[]> {
    const legacyUnboundedRead = second === undefined;
    const ownerId = second === undefined ? undefined : first;
    const jobId = second ?? first;
    const limit = requestedLimit;
    if (
      !legacyUnboundedRead &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
    ) {
      throw new JobRepositoryError(
        "INVALID_LIMIT",
        "Event list limit must be between 1 and 5",
      );
    }
    const condition =
      ownerId === undefined
        ? eq(jobEvents.jobId, jobId)
        : and(eq(jobEvents.jobId, jobId), eq(jobs.ownerId, ownerId));
    const query = this.#db
      .select({ event: jobEvents })
      .from(jobEvents)
      .innerJoin(jobs, eq(jobEvents.jobId, jobs.id))
      .where(condition)
      .orderBy(desc(jobEvents.sequence));
    const rows = legacyUnboundedRead ? await query : await query.limit(limit);
    return rows.map((row) => toEventRecord(row.event)).reverse();
  }

  async listPendingApprovals(
    ownerId: string,
    limit = MAX_LIST_LIMIT,
    _callerNow = new Date(),
  ): Promise<ApprovalRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new JobRepositoryError(
        "INVALID_LIMIT",
        "Approval list limit must be between 1 and 5",
      );
    }
    const rows = await this.#db
      .select({
        approval: approvals,
        ownerId: jobs.ownerId,
        jobShortId: jobs.shortId,
      })
      .from(approvals)
      .innerJoin(jobs, eq(approvals.jobId, jobs.id))
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          eq(jobs.status, "waiting_approval"),
          eq(approvals.attempt, jobs.attempt),
          eq(approvals.jobRevision, jobs.revision),
          isNull(approvals.decision),
          sql`${approvals.expiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(asc(approvals.expiresAt), asc(approvals.createdAt))
      .limit(limit);
    return rows.map((row) =>
      toApprovalRecord(row.approval, row.ownerId, row.jobShortId),
    );
  }

  async getPendingApproval(
    ownerId: string,
    jobId: string,
    _callerNow = new Date(),
  ): Promise<ApprovalRecord | null> {
    const rows = await this.#db
      .select({
        approval: approvals,
        ownerId: jobs.ownerId,
        jobShortId: jobs.shortId,
      })
      .from(approvals)
      .innerJoin(jobs, eq(approvals.jobId, jobs.id))
      .where(
        and(
          eq(jobs.ownerId, ownerId),
          eq(jobs.id, jobId),
          eq(jobs.status, "waiting_approval"),
          eq(approvals.attempt, jobs.attempt),
          eq(approvals.jobRevision, jobs.revision),
          isNull(approvals.decision),
          sql`${approvals.expiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : toApprovalRecord(row.approval, row.ownerId, row.jobShortId);
  }

  async transitionAndAppend(
    jobId: string,
    expectedRevision: number,
    status: JobStatus,
    event: JobEventInput,
  ): Promise<JobRecord> {
    validateEvent(event);
    return this.#db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .for("update");
      const current = lockedRows[0];
      if (current === undefined) {
        throw new JobRepositoryError("NOT_FOUND", "Job not found");
      }
      if (current.revision !== expectedRevision) {
        throw new JobRepositoryError(
          "REVISION_CONFLICT",
          "The job revision is stale",
        );
      }

      assertTransition(current.status, status);
      const eventStage = event.payload.stage ?? event.payload.current_stage;
      const currentStage =
        typeof eventStage === "string" && eventStage.length <= 128
          ? eventStage
          : status;
      const terminal = TERMINAL_JOB_STATES.has(status);
      const updatedRows = await tx
        .update(jobs)
        .set({
          status,
          currentStage,
          revision: sql`${jobs.revision} + 1`,
          updatedAt: sql`now()`,
          ...(terminal
            ? {
                terminalAt: sql`coalesce(${jobs.terminalAt}, now())`,
                requestDeleteAt: sql`coalesce(${jobs.requestDeleteAt}, now() + interval '24 hours')`,
                unreadTerminal: true,
              }
            : {}),
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.revision, expectedRevision)))
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new JobRepositoryError(
          "REVISION_CONFLICT",
          "The job revision is stale",
        );
      }

      await appendEvent(tx, jobId, await nextEventSequence(tx, jobId), event);
      return toJobRecord(updated);
    });
  }

  async cancelAtomically(input: CancelJobInput): Promise<JobRecord> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw new JobRepositoryError(
        "REVISION_CONFLICT",
        "The job revision is invalid",
      );
    }
    const reason = input.reason?.trim() || "user requested";
    if (reason.length > 400) {
      throw new JobRepositoryError(
        "INVALID_EVENT",
        "Cancellation reason is too long",
      );
    }

    return this.#db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, input.ownerId)))
        .for("update");
      const current = lockedRows[0];
      if (current === undefined) {
        throw new JobRepositoryError("NOT_FOUND", "Job not found");
      }

      // Cancellation is intentionally idempotent when its own transition has
      // already won, including retries carrying the original revision.
      if (current.status === "cancelling" || current.status === "cancelled") {
        return toJobRecord(current);
      }
      if (isTerminal(current.status)) {
        return toJobRecord(current);
      }
      if (current.revision !== input.expectedRevision) {
        throw new JobRepositoryError(
          "REVISION_CONFLICT",
          "The job revision is stale",
        );
      }

      const immediate =
        current.status === "queued" || current.status === "dispatched";
      const nextStatus: JobStatus = immediate ? "cancelled" : "cancelling";
      assertTransition(current.status, nextStatus);
      const updatedRows = await tx
        .update(jobs)
        .set({
          status: nextStatus,
          currentStage: nextStatus,
          revision: sql`${jobs.revision} + 1`,
          updatedAt: sql`now()`,
          ...(immediate
            ? {
                terminalAt: sql`coalesce(${jobs.terminalAt}, now())`,
                requestDeleteAt: sql`coalesce(${jobs.requestDeleteAt}, now() + interval '24 hours')`,
                unreadTerminal: true,
              }
            : {}),
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.ownerId, input.ownerId),
            eq(jobs.revision, input.expectedRevision),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new JobRepositoryError(
          "REVISION_CONFLICT",
          "The job revision is stale",
        );
      }

      await appendEvent(
        tx,
        input.jobId,
        await nextEventSequence(tx, input.jobId),
        {
          type: immediate ? "job.cancelled" : "job.cancelling",
          payload: {
            job_id: input.jobId,
            reason,
            revision: updated.revision,
          },
        },
      );

      if (!immediate) {
        if (updated.connectorId === null) {
          throw new JobRepositoryError(
            "CONNECTOR_OWNER_MISMATCH",
            "A running job has no connector for cancellation",
          );
        }
        await enqueueServerCommand(
          tx,
          input.ownerId,
          updated.connectorId,
          "job.cancel",
          {
            job_id: updated.id,
            attempt: updated.attempt,
            job_revision: updated.revision,
            reason,
            nonce: crypto.randomUUID(),
          },
          updated.expiresAt,
        );
      }

      return toJobRecord(updated);
    });
  }

  async claimOffer(
    jobId: string,
    input: ClaimOfferInput,
  ): Promise<JobRecord | null> {
    validateClaim(input);
    return this.#db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .for("update");
      const current = lockedRows[0];
      if (
        current === undefined ||
        current.status !== "dispatched" ||
        current.connectorId !== input.connectorId ||
        current.leaseId !== input.leaseId ||
        current.leaseExpiresAt === null ||
        input.attempt !== current.attempt + 1
      ) {
        return null;
      }

      const connectorRows = await tx
        .select({ id: connectors.id, ownerId: connectors.ownerId })
        .from(connectors)
        .where(eq(connectors.id, input.connectorId))
        .limit(1);
      const connector = connectorRows[0];
      if (connector === undefined || connector.ownerId !== current.ownerId) {
        return null;
      }

      const currentTime = await readDatabaseTime(tx);
      if (
        current.leaseExpiresAt.getTime() <= currentTime.getTime() ||
        current.expiresAt.getTime() <= currentTime.getTime()
      ) {
        return null;
      }

      const updatedRows = await tx
        .update(jobs)
        .set({
          status: "running",
          currentStage: "running",
          connectorId: input.connectorId,
          attempt: input.attempt,
          leaseId: input.leaseId,
          leaseExpiresAt: sql`least(clock_timestamp() + interval '30 seconds', ${jobs.expiresAt})`,
          revision: sql`${jobs.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "dispatched"),
            eq(jobs.revision, current.revision),
            eq(jobs.attempt, input.attempt - 1),
            eq(jobs.connectorId, input.connectorId),
            eq(jobs.leaseId, input.leaseId),
            sql`${jobs.leaseExpiresAt} > clock_timestamp()`,
            sql`${jobs.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        return null;
      }

      await appendEvent(tx, jobId, await nextEventSequence(tx, jobId), {
        type: "job.claimed",
        payload: {
          connector_id: input.connectorId,
          attempt: input.attempt,
        },
      });
      return toJobRecord(updated);
    });
  }

  async recordApprovalDecision(
    input: RecordApprovalDecisionInput,
  ): Promise<ApprovalRecord> {
    const outcome = await this.#db.transaction(async (tx) => {
      const approvalRows = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .for("update");
      const approval = approvalRows[0];
      if (approval === undefined) {
        throw new JobRepositoryError("NOT_FOUND", "Approval not found");
      }

      const jobRows = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, approval.jobId))
        .for("update");
      const job = jobRows[0];
      if (
        job === undefined ||
        (input.ownerId !== undefined && job.ownerId !== input.ownerId)
      ) {
        throw new JobRepositoryError("NOT_FOUND", "Approval not found");
      }

      const task4 = input.ownerId !== undefined;
      if (approval.decision !== null) {
        const sameDecision = approval.decision === input.decision;
        const sameFingerprint =
          input.actionFingerprint === undefined ||
          input.actionFingerprint === approval.actionFingerprint;
        if (
          task4 &&
          sameDecision &&
          sameFingerprint &&
          approval.jobRevision === input.expectedJobRevision
        ) {
          return {
            approval: toApprovalRecord(approval, job.ownerId, job.shortId),
            expired: false,
          };
        }
        if (task4) {
          throw new JobRepositoryError(
            "APPROVAL_MISMATCH",
            "The approval no longer matches the requested decision",
          );
        }
        throw new JobRepositoryError(
          "APPROVAL_ALREADY_DECIDED",
          "The approval already has a decision",
        );
      }
      const currentTime = task4
        ? await readDatabaseTime(tx)
        : (input.now ?? new Date());
      if (
        approval.jobRevision !== input.expectedJobRevision ||
        job.revision !== input.expectedJobRevision ||
        (task4 && job.status !== "waiting_approval") ||
        (task4 && job.attempt !== approval.attempt) ||
        (task4 &&
          input.expectedAttempt !== undefined &&
          input.expectedAttempt !== approval.attempt) ||
        (task4 &&
          input.actionFingerprint !== undefined &&
          input.actionFingerprint !== approval.actionFingerprint)
      ) {
        throw new JobRepositoryError(
          "APPROVAL_MISMATCH",
          "The approval and job state do not match",
        );
      }

      let expired = approval.expiresAt.getTime() <= currentTime.getTime();
      if (expired && !task4) {
        throw new JobRepositoryError(
          "APPROVAL_EXPIRED",
          "The approval has expired",
        );
      }

      const recordDecision = async (
        decision: ApprovalDecision,
      ): Promise<ApprovalRow> => {
        const updatedRows = await tx
          .update(approvals)
          .set({
            decision,
            decidedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(approvals.id, input.approvalId),
              isNull(approvals.decision),
              eq(approvals.jobRevision, input.expectedJobRevision),
              task4
                ? sql`${approvals.expiresAt} > clock_timestamp()`
                : gt(approvals.expiresAt, currentTime),
            ),
          )
          .returning();
        return updatedRows[0];
      };

      const recordExpired = async (): Promise<ApprovalRow | undefined> => {
        const expiredRows = await tx
          .update(approvals)
          .set({
            decision: "reject",
            decidedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(approvals.id, input.approvalId),
              isNull(approvals.decision),
              eq(approvals.jobRevision, input.expectedJobRevision),
              sql`${approvals.expiresAt} <= clock_timestamp()`,
            ),
          )
          .returning();
        return expiredRows[0];
      };

      let updated: ApprovalRow | undefined;
      if (expired) {
        updated = await recordExpired();
      } else {
        updated = await recordDecision(input.decision);
        if (updated === undefined && task4) {
          updated = await recordExpired();
          expired = updated !== undefined;
        }
        if (updated === undefined) {
          throw new JobRepositoryError(
            "APPROVAL_EXPIRED",
            "The approval expired before it could be decided",
          );
        }
      }
      if (updated === undefined) {
        throw new JobRepositoryError(
          "APPROVAL_EXPIRED",
          "The approval expired before it could be decided",
        );
      }

      // The owner-bearing form is the Task 4 atomic operation. The legacy
      // overload remains persistence-compatible with Task 3 callers, which
      // had no Connector command port and therefore only recorded a decision.
      if (input.ownerId !== undefined) {
        if (job.connectorId === null) {
          throw new JobRepositoryError(
            "CONNECTOR_OWNER_MISMATCH",
            "The approval job has no Connector",
          );
        }
        await appendEvent(tx, job.id, await nextEventSequence(tx, job.id), {
          type: "approval.decided",
          payload: {
            approval_id: updated.id,
            decision: updated.decision,
            attempt: updated.attempt,
            job_revision: updated.jobRevision,
          },
        });
        await enqueueServerCommand(
          tx,
          input.ownerId,
          job.connectorId,
          "approval.decision",
          {
            approval_id: updated.id,
            job_id: job.id,
            attempt: updated.attempt,
            job_revision: updated.jobRevision,
            action_fingerprint: updated.actionFingerprint,
            decision: updated.decision,
          },
          commandExpiresAt(job.expiresAt, currentTime),
        );
      }

      return {
        approval: toApprovalRecord(updated, job.ownerId, job.shortId),
        expired,
      };
    });
    if (outcome.expired) {
      throw new JobRepositoryError(
        "APPROVAL_EXPIRED",
        "The approval has expired and was rejected",
      );
    }
    return outcome.approval;
  }

  async acknowledgeResult(
    ownerId: string,
    jobId: string,
  ): Promise<JobResultRecord | null> {
    return this.#db.transaction(async (tx) => {
      const lockedRows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId)))
        .for("update");
      const current = lockedRows[0];
      const summary = asRecord(current?.summary);
      if (
        current === undefined ||
        !isTerminal(current.status) ||
        summary === null ||
        typeof summary.summary !== "string" ||
        summary.summary.trim().length === 0
      ) {
        return null;
      }

      let acknowledged = current;
      if (current.acknowledgedAt === null) {
        const updatedRows = await tx
          .update(jobs)
          .set({
            acknowledgedAt: sql`clock_timestamp()`,
            unreadTerminal: false,
          })
          .where(and(eq(jobs.id, jobId), isNull(jobs.acknowledgedAt)))
          .returning();
        acknowledged = updatedRows[0] ?? current;
      }
      return toJobResultRecord(acknowledged);
    });
  }
}
