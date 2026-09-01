import type { JobStatus } from "@qhb/protocol";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { assertTransition, TERMINAL_JOB_STATES } from "../domain/job-state.js";
import type { Database } from "./client.js";
import {
  approvals,
  connectors,
  idempotencyRecords,
  jobEvents,
  jobs,
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
};

export type ApprovalRecord = {
  approvalId: string;
  jobId: string;
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

const toApprovalRecord = (row: ApprovalRow): ApprovalRecord => ({
  approvalId: row.id,
  jobId: row.jobId,
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

const readJob = async (
  database: QueryDatabase,
  jobId: string,
): Promise<JobRow | undefined> => {
  const rows = await database
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return rows[0];
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

  async get(jobId: string): Promise<JobRecord | null> {
    const row = await readJob(this.#db, jobId);
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

    const condition =
      input.status === undefined
        ? eq(jobs.ownerId, input.ownerId)
        : and(eq(jobs.ownerId, input.ownerId), eq(jobs.status, input.status));
    const rows = await this.#db
      .select()
      .from(jobs)
      .where(condition)
      .orderBy(desc(jobs.updatedAt), asc(jobs.id))
      .limit(limit);
    return rows.map(toJobRecord);
  }

  async events(jobId: string): Promise<JobEventRecord[]> {
    const rows = await this.#db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(asc(jobEvents.sequence));
    return rows.map(toEventRecord);
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

      const updatedRows = await tx
        .update(jobs)
        .set({
          status: "running",
          currentStage: "running",
          connectorId: input.connectorId,
          attempt: input.attempt,
          leaseId: input.leaseId,
          leaseExpiresAt: sql`now() + interval '30 seconds'`,
          revision: sql`${jobs.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "dispatched"),
            eq(jobs.revision, current.revision),
            eq(jobs.attempt, input.attempt - 1),
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
    return this.#db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({ approval: approvals, job: jobs })
        .from(approvals)
        .innerJoin(jobs, eq(approvals.jobId, jobs.id))
        .where(eq(approvals.id, input.approvalId))
        .for("update");
      const locked = lockedRows[0];
      if (locked === undefined) {
        throw new JobRepositoryError("NOT_FOUND", "Approval not found");
      }

      if (locked.approval.decision !== null) {
        throw new JobRepositoryError(
          "APPROVAL_ALREADY_DECIDED",
          "The approval already has a decision",
        );
      }
      if (locked.approval.expiresAt.getTime() <= Date.now()) {
        throw new JobRepositoryError(
          "APPROVAL_EXPIRED",
          "The approval has expired",
        );
      }
      if (
        locked.approval.jobRevision !== input.expectedJobRevision ||
        locked.job.revision !== input.expectedJobRevision
      ) {
        throw new JobRepositoryError(
          "APPROVAL_MISMATCH",
          "The approval and job revisions do not match",
        );
      }

      const updatedRows = await tx
        .update(approvals)
        .set({
          decision: input.decision,
          decidedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            isNull(approvals.decision),
            gt(approvals.expiresAt, sql`now()`),
            eq(approvals.jobRevision, input.expectedJobRevision),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        throw new JobRepositoryError(
          "APPROVAL_EXPIRED",
          "The approval expired before it could be decided",
        );
      }
      return toApprovalRecord(updated);
    });
  }
}
