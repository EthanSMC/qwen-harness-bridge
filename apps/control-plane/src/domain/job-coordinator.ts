import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type {
  CancelTaskInput,
  ConnectorHealth,
  DecideApprovalInput,
  GetTaskInput,
  GetTaskResultInput,
  JobReceipt,
  JobStatus,
  ListPendingApprovalsInput,
  ListTasksInput,
  SubmitTaskInput,
} from "@qhb/protocol";
import {
  DomainError,
  type DomainErrorCode,
  isDomainErrorCode,
} from "./errors.js";
import { TERMINAL_JOB_STATES } from "./job-state.js";
import {
  type PresentableApproval,
  type PresentableEvent,
  type PresentableJob,
  type PresentableResult,
  type PublicTaskDetail,
  type PublicTaskResult,
  presentApprovalDecision,
  presentJobDetail,
  presentJobList,
  presentPendingApprovals,
  presentTaskResult,
  type RepositoryDisplay,
} from "./presenters.js";

export type OwnerContext = { id: string };

export type RepositoryPolicy = RepositoryDisplay & {
  id: string;
  ownerId: string;
  enabled: boolean;
};

export type JobRecord = PresentableJob & {
  connectorId: string | null;
  requestCiphertext: string | null;
  requestDigest: string;
  mode: "normal" | "read_only";
  attempt: number;
  acceptedAt: Date;
  expiresAt: Date;
  terminalAt: Date | null;
};

export type JobEventRecord = PresentableEvent & {
  eventId?: string;
  jobId?: string;
};

export type ApprovalRecord = PresentableApproval & {
  ownerId?: string;
  decision: "approve" | "reject" | null;
  decidedAt: Date | null;
};

export type ResultRecord = PresentableResult;

export type CreateJobInput = {
  ownerId: string;
  clientRequestId: string;
  repositoryId: string;
  requestCiphertext: string;
  requestDigest: string;
  mode: "normal" | "read_only";
};

export type ListRepositoryJobsInput = {
  ownerId: string;
  limit: number;
  status?: JobStatus;
  unreadOnly?: boolean;
};

export type CancelAtomicallyInput = {
  ownerId: string;
  jobId: string;
  expectedRevision: number;
};

export type RecordApprovalDecisionInput = {
  ownerId: string;
  approvalId: string;
  decision: "approve" | "reject";
  expectedJobRevision: number;
  now?: Date;
};

/**
 * This is deliberately a domain port. It contains no SQL primitives and no
 * outbox object: the repository owns the transaction that changes state and
 * emits connector messages.
 */
export interface JobRepositoryPort {
  getRepositoryPolicy(
    ownerId: string,
    repositoryId: string,
  ): Promise<RepositoryPolicy | null>;
  getConnectorHealth(ownerId: string): Promise<ConnectorHealth>;
  createIdempotent(input: CreateJobInput): Promise<JobRecord>;
  list(input: ListRepositoryJobsInput): Promise<readonly JobRecord[]>;
  get(ownerId: string, jobId: string): Promise<JobRecord | null>;
  events(
    ownerId: string,
    jobId: string,
    limit: number,
  ): Promise<readonly JobEventRecord[]>;
  listPendingApprovals(
    ownerId: string,
    limit: number,
    now: Date,
  ): Promise<readonly ApprovalRecord[]>;
  cancelAtomically(input: CancelAtomicallyInput): Promise<JobRecord>;
  recordApprovalDecision(
    input: RecordApprovalDecisionInput,
  ): Promise<ApprovalRecord>;
  acknowledgeResult(
    ownerId: string,
    jobId: string,
  ): Promise<ResultRecord | null>;
  getPendingApproval?(
    ownerId: string,
    jobId: string,
    now: Date,
  ): Promise<ApprovalRecord | null>;
}

export interface RequestEncryptor {
  encrypt(plaintext: string): Promise<string> | string;
}

export interface RequestDecryptor {
  decrypt(ciphertext: string): Promise<string> | string;
}

export interface JobCoordinatorDependencies {
  repository: JobRepositoryPort;
  encryptor: RequestEncryptor;
  now: () => Date;
}

const MAX_LIST_LIMIT = 5;
const DETAIL_EVENT_LIMIT = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const internalCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const translateError = (
  error: unknown,
  notFoundCode: DomainErrorCode = "INTERNAL",
): DomainError => {
  if (error instanceof DomainError) return error;
  const code = internalCode(error);
  if (code === "NOT_FOUND") return new DomainError(notFoundCode);
  if (code === "APPROVAL_ALREADY_DECIDED") {
    return new DomainError("APPROVAL_MISMATCH");
  }
  if (code === "CONNECTOR_OWNER_MISMATCH") {
    return new DomainError("CONNECTOR_LOST");
  }
  if (code !== undefined && isDomainErrorCode(code)) {
    return new DomainError(code);
  }
  return new DomainError("INTERNAL");
};

const requireOwner = (owner: OwnerContext): void => {
  if (
    !isRecord(owner) ||
    typeof owner.id !== "string" ||
    owner.id.trim() === ""
  ) {
    throw new DomainError("UNAUTHENTICATED");
  }
};

const asIso = (value: Date): string => value.toISOString();

const canonicalSubmitPayload = (input: SubmitTaskInput): string =>
  JSON.stringify({
    client_request_id: input.client_request_id,
    mode: input.mode ?? "normal",
    repository_id: input.repository_id,
    request: input.request.trim(),
  });

export const requestDigest = (input: SubmitTaskInput): string =>
  `sha256:${createHash("sha256").update(canonicalSubmitPayload(input), "utf8").digest("hex")}`;

const connectorStatus = (health: ConnectorHealth): "online" | "offline" =>
  health === "fresh" ? "online" : "offline";

const publicRepository = (
  policy: RepositoryPolicy | null,
): RepositoryDisplay =>
  policy === null
    ? {}
    : { displayName: policy.displayName, canonicalPath: policy.canonicalPath };

const isKnownStatus = (value: unknown): value is JobStatus =>
  typeof value === "string" &&
  [
    "queued",
    "dispatched",
    "running",
    "waiting_approval",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ].includes(value);

/** Authenticated AES-256-GCM request encryption for persisted job payloads. */
export class Aes256GcmEncryptor implements RequestEncryptor {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    const copy = Buffer.from(key);
    if (copy.byteLength !== 32) {
      throw new TypeError("AES-256-GCM requires a 32-byte key");
    }
    this.#key = copy;
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const encode = (value: Uint8Array): string =>
      Buffer.from(value).toString("base64url");
    return `aes256gcm:v1:${encode(nonce)}:${encode(ciphertext)}:${encode(tag)}`;
  }

  decrypt(encoded: string): string {
    const parts = encoded.split(":");
    if (parts.length !== 5 || parts[0] !== "aes256gcm" || parts[1] !== "v1") {
      throw new Error("Encrypted request is invalid");
    }
    const decode = (value: string | undefined): Buffer => {
      if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("Encrypted request is invalid");
      }
      const decoded = Buffer.from(value, "base64url");
      if (decoded.toString("base64url") !== value) {
        throw new Error("Encrypted request is invalid");
      }
      return decoded;
    };
    const nonce = decode(parts[2]);
    const ciphertext = decode(parts[3]);
    const tag = decode(parts[4]);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("Encrypted request is invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Encrypted request is invalid");
    }
  }
}

export { Aes256GcmEncryptor as AES256GCMEncryptor };

export class JobCoordinator {
  readonly #repository: JobRepositoryPort;
  readonly #encryptor: RequestEncryptor;
  readonly #now: () => Date;

  constructor(dependencies: JobCoordinatorDependencies) {
    this.#repository = dependencies.repository;
    this.#encryptor = dependencies.encryptor;
    this.#now = dependencies.now;
  }

  async submit(
    owner: OwnerContext,
    input: SubmitTaskInput,
  ): Promise<JobReceipt> {
    requireOwner(owner);
    try {
      const policy = await this.#repository.getRepositoryPolicy(
        owner.id,
        input.repository_id,
      );
      if (policy === null || policy.ownerId !== owner.id || !policy.enabled) {
        throw new DomainError("REPOSITORY_NOT_ALLOWED");
      }

      const mode = input.mode ?? "normal";
      const request = input.request.trim();
      const digest = requestDigest(input);
      const ciphertext = await this.#encryptor.encrypt(request);
      const job = await this.#repository.createIdempotent({
        ownerId: owner.id,
        clientRequestId: input.client_request_id,
        repositoryId: input.repository_id,
        requestCiphertext: ciphertext,
        requestDigest: digest,
        mode,
      });
      const health =
        job.connectorHealth ??
        (await this.#repository.getConnectorHealth(owner.id));
      return {
        job_id: job.jobId,
        short_id: job.shortId,
        status: "queued",
        connector_status: connectorStatus(health),
        accepted_at: asIso(job.acceptedAt),
        expires_at: asIso(job.expiresAt),
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  async list(
    owner: OwnerContext,
    input: ListTasksInput,
  ): Promise<ReturnType<typeof presentJobList>> {
    requireOwner(owner);
    try {
      const limit = Math.min(
        Math.max(input.limit ?? MAX_LIST_LIMIT, 1),
        MAX_LIST_LIMIT,
      );
      const jobs = await this.#repository.list({
        ownerId: owner.id,
        status: input.status,
        unreadOnly: input.unread_only,
        limit,
      });
      const health = await this.#repository.getConnectorHealth(owner.id);
      const ownerJobs = (
        await Promise.all(
          jobs.map(async (job) => {
            if (job.ownerId !== undefined && job.ownerId !== owner.id)
              return null;
            const policy = await this.#repository.getRepositoryPolicy(
              owner.id,
              job.repositoryId ?? "",
            );
            return policy !== null && policy.ownerId === owner.id ? job : null;
          }),
        )
      ).filter((job): job is JobRecord => job !== null);
      return presentJobList(
        ownerJobs.map((job) => ({
          ...job,
          connectorHealth: job.connectorHealth ?? health,
        })),
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  async get(
    owner: OwnerContext,
    input: GetTaskInput,
  ): Promise<PublicTaskDetail> {
    requireOwner(owner);
    try {
      const job = await this.#repository.get(owner.id, input.job_id);
      if (
        job === null ||
        (job.ownerId !== undefined && job.ownerId !== owner.id)
      ) {
        throw new DomainError("JOB_NOT_FOUND");
      }
      const [events, policy] = await Promise.all([
        this.#repository.events(owner.id, job.jobId, DETAIL_EVENT_LIMIT),
        this.#repository.getRepositoryPolicy(owner.id, job.repositoryId ?? ""),
      ]);
      let pendingApproval: ApprovalRecord | null = null;
      if (job.status === "waiting_approval") {
        if (this.#repository.getPendingApproval !== undefined) {
          pendingApproval = await this.#repository.getPendingApproval(
            owner.id,
            job.jobId,
            this.#now(),
          );
        } else {
          pendingApproval =
            (
              await this.#repository.listPendingApprovals(
                owner.id,
                MAX_LIST_LIMIT,
                this.#now(),
              )
            ).find((approval) => approval.jobId === job.jobId) ?? null;
        }
      }
      const terminalSummary =
        job.summary !== null && typeof job.summary?.summary === "string"
          ? job.summary.summary
          : null;
      const health =
        job.connectorHealth ??
        (await this.#repository.getConnectorHealth(owner.id));
      return presentJobDetail({
        job: { ...job, connectorHealth: health },
        repository: publicRepository(policy),
        events,
        pendingApproval,
        terminalSummary,
      });
    } catch (error) {
      throw translateError(error, "JOB_NOT_FOUND");
    }
  }

  async cancel(
    owner: OwnerContext,
    input: CancelTaskInput,
  ): Promise<{ job_id: string; status: JobStatus; revision: number }> {
    requireOwner(owner);
    try {
      const current = await this.#repository.get(owner.id, input.job_id);
      if (
        current === null ||
        (current.ownerId !== undefined && current.ownerId !== owner.id)
      ) {
        throw new DomainError("JOB_NOT_FOUND");
      }

      if (current.status === "cancelling" || current.status === "cancelled") {
        return {
          job_id: current.jobId,
          status: current.status,
          revision: current.revision,
        };
      }
      if (TERMINAL_JOB_STATES.has(current.status)) {
        throw new DomainError("JOB_NOT_MUTABLE");
      }
      if (
        current.status !== "queued" &&
        current.status !== "dispatched" &&
        current.status !== "running" &&
        current.status !== "waiting_approval"
      ) {
        throw new DomainError("JOB_NOT_MUTABLE");
      }

      const job = await this.#repository.cancelAtomically({
        ownerId: owner.id,
        jobId: input.job_id,
        expectedRevision: input.expected_revision,
      });
      return { job_id: job.jobId, status: job.status, revision: job.revision };
    } catch (error) {
      throw translateError(error, "JOB_NOT_FOUND");
    }
  }

  async listApprovals(
    owner: OwnerContext,
    input: ListPendingApprovalsInput,
  ): Promise<ReturnType<typeof presentPendingApprovals>> {
    requireOwner(owner);
    try {
      const approvals = await this.#repository.listPendingApprovals(
        owner.id,
        Math.min(Math.max(input.limit ?? MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT),
        this.#now(),
      );
      return presentPendingApprovals(
        approvals.filter(
          (approval) =>
            (approval.ownerId === undefined || approval.ownerId === owner.id) &&
            approval.decision === null,
        ),
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  async decideApproval(owner: OwnerContext, input: DecideApprovalInput) {
    requireOwner(owner);
    try {
      const approval = await this.#repository.recordApprovalDecision({
        ownerId: owner.id,
        approvalId: input.approval_id,
        decision: input.decision,
        expectedJobRevision: input.expected_job_revision,
        now: this.#now(),
      });
      return presentApprovalDecision(approval);
    } catch (error) {
      throw translateError(error, "APPROVAL_MISMATCH");
    }
  }

  async getResult(
    owner: OwnerContext,
    input: GetTaskResultInput,
  ): Promise<PublicTaskResult> {
    requireOwner(owner);
    try {
      const job = await this.#repository.get(owner.id, input.job_id);
      if (
        job === null ||
        (job.ownerId !== undefined && job.ownerId !== owner.id)
      ) {
        throw new DomainError("JOB_NOT_FOUND");
      }
      if (!TERMINAL_JOB_STATES.has(job.status)) {
        throw new DomainError("JOB_NOT_MUTABLE");
      }

      const result = await this.#repository.acknowledgeResult(
        owner.id,
        input.job_id,
      );
      if (result === null) throw new DomainError("JOB_NOT_FOUND");
      const policy = await this.#repository.getRepositoryPolicy(
        owner.id,
        job.repositoryId ?? "",
      );
      return presentTaskResult(
        result.jobId === undefined ? { ...result, jobId: job.jobId } : result,
        publicRepository(policy),
      );
    } catch (error) {
      throw translateError(error, "JOB_NOT_FOUND");
    }
  }
}

export const isJobStatus = isKnownStatus;
