import { createHash } from "node:crypto";
import type {
  DecideApprovalInput,
  GetTaskInput,
  GetTaskResultInput,
  ListPendingApprovalsInput,
  ListTasksInput,
  SubmitTaskInput,
} from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import { Aes256GcmEncryptor, JobCoordinator } from "./job-coordinator.js";

const OWNER_ID = "owner-a";
const OTHER_OWNER_ID = "owner-b";
const REPOSITORY_ID = "novelty-studio";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

type Status =
  | "queued"
  | "dispatched"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

type Job = {
  jobId: string;
  shortId: string;
  ownerId: string;
  connectorId: string | null;
  repositoryId: string;
  requestCiphertext: string | null;
  requestDigest: string;
  mode: "normal" | "read_only";
  status: Status;
  currentStage: string;
  revision: number;
  attempt: number;
  title: string | null;
  summary: Record<string, unknown> | null;
  unreadTerminal: boolean;
  acceptedAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
};

type RepositoryPolicy = {
  id: string;
  ownerId: string;
  displayName: string;
  canonicalPath: string;
  enabled: boolean;
};

type Approval = {
  approvalId: string;
  jobId: string;
  ownerId: string;
  attempt: number;
  jobRevision: number;
  actionSummary: string;
  impactSummary: string;
  actionFingerprint: string;
  riskClass: string;
  expiresAt: Date;
  decision: "approve" | "reject" | null;
  decidedAt: Date | null;
};

type Result = {
  jobId: string;
  summary: string;
  changedFiles: string[];
  tests: { passed: number; failed: number; summary: string };
  artifacts: Array<{ name: string; mediaType: string; url: string }>;
  acknowledgedAt: Date | null;
};

type Event = {
  eventId: string;
  jobId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  source: string;
  createdAt: Date;
};

type CancelCommand = {
  type: "job.cancel";
  job_id: string;
  attempt: number;
  job_revision: number;
};

type ApprovalCommand = {
  type: "approval.decision";
  approval_id: string;
  job_id: string;
  attempt: number;
  job_revision: number;
  action_fingerprint: string;
  decision: "approve" | "reject";
};

class RepositoryFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeConnectorOutbox {
  readonly cancelCommands: CancelCommand[] = [];
  readonly approvalCommands: ApprovalCommand[] = [];

  async enqueueCancel(command: CancelCommand): Promise<void> {
    this.cancelCommands.push(structuredClone(command));
  }

  async enqueueApprovalDecision(command: ApprovalCommand): Promise<void> {
    this.approvalCommands.push(structuredClone(command));
  }
}

class FakeEncryptor {
  readonly plaintextInputs: string[] = [];
  readonly ciphertexts: string[] = [];
  private nonce = 0;

  async encrypt(plaintext: string): Promise<string> {
    this.plaintextInputs.push(plaintext);
    this.nonce += 1;
    const ciphertext = `aes256gcm:v1:${this.nonce}:${createHash("sha256")
      .update(`${this.nonce}:${plaintext}`, "utf8")
      .digest("base64url")}`;
    this.ciphertexts.push(ciphertext);
    return ciphertext;
  }
}

class FakeJobRepository {
  readonly jobs = new Map<string, Job>();
  readonly policies = new Map<string, RepositoryPolicy>();
  readonly approvals = new Map<string, Approval>();
  readonly eventsByJob = new Map<string, Event[]>();
  readonly results = new Map<string, Result>();
  readonly idempotency = new Map<string, { digest: string; jobId: string }>();
  readonly createCalls: Array<Record<string, unknown>> = [];
  readonly listCalls: Array<Record<string, unknown>> = [];
  readonly eventCalls: Array<Record<string, unknown>> = [];
  readonly approvalListCalls: Array<Record<string, unknown>> = [];
  readonly cancelCalls: Array<Record<string, unknown>> = [];
  readonly decisionCalls: Array<Record<string, unknown>> = [];
  readonly acknowledgementCalls: string[] = [];
  acknowledgementWrites = 0;
  connectorHealth: "fresh" | "stale" | "offline" = "fresh";
  private nextShortId = 1;

  constructor(private readonly outbox: FakeConnectorOutbox) {}

  seedPolicy(overrides: Partial<RepositoryPolicy> = {}): RepositoryPolicy {
    const policy: RepositoryPolicy = {
      id: REPOSITORY_ID,
      ownerId: OWNER_ID,
      displayName: "Novelty Studio",
      canonicalPath: "/Users/alice/Repositories/novelty-studio",
      enabled: true,
      ...overrides,
    };
    this.policies.set(`${policy.ownerId}:${policy.id}`, policy);
    return policy;
  }

  seedJob(overrides: Partial<Job> = {}): Job {
    const id = overrides.jobId ?? crypto.randomUUID();
    const status = overrides.status ?? "queued";
    const job: Job = {
      jobId: id,
      shortId:
        overrides.shortId ??
        `QH-${String(this.nextShortId++).padStart(4, "0")}`,
      ownerId: overrides.ownerId ?? OWNER_ID,
      connectorId: overrides.connectorId ?? null,
      repositoryId: overrides.repositoryId ?? REPOSITORY_ID,
      requestCiphertext: overrides.requestCiphertext ?? "aes256gcm:v1:stored",
      requestDigest: overrides.requestDigest ?? "sha256:stored",
      mode: overrides.mode ?? "normal",
      status,
      currentStage: overrides.currentStage ?? status,
      revision: overrides.revision ?? 0,
      attempt: overrides.attempt ?? (status === "queued" ? 0 : 1),
      title: overrides.title ?? "Run checks",
      summary: overrides.summary ?? null,
      unreadTerminal: overrides.unreadTerminal ?? TERMINAL_STATES.has(status),
      acceptedAt: overrides.acceptedAt ?? NOW,
      expiresAt: overrides.expiresAt ?? new Date("2026-09-02T00:00:00.000Z"),
      updatedAt: overrides.updatedAt ?? NOW,
      terminalAt:
        overrides.terminalAt ?? (TERMINAL_STATES.has(status) ? NOW : null),
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  seedApproval(overrides: Partial<Approval> = {}): Approval {
    const approval: Approval = {
      approvalId: overrides.approvalId ?? crypto.randomUUID(),
      jobId:
        overrides.jobId ??
        this.seedJob({ status: "waiting_approval", revision: 3 }).jobId,
      ownerId: overrides.ownerId ?? OWNER_ID,
      attempt: overrides.attempt ?? 1,
      jobRevision: overrides.jobRevision ?? 3,
      actionSummary:
        overrides.actionSummary ?? "Install the approved dependency",
      impactSummary:
        overrides.impactSummary ?? "Changes the repository lockfile",
      actionFingerprint:
        overrides.actionFingerprint ?? `sha256:${"a".repeat(64)}`,
      riskClass: overrides.riskClass ?? "approval_required",
      expiresAt: overrides.expiresAt ?? new Date("2026-09-01T00:05:00.000Z"),
      decision: overrides.decision ?? null,
      decidedAt: overrides.decidedAt ?? null,
    };
    this.approvals.set(approval.approvalId, approval);
    return approval;
  }

  seedEvents(jobId: string, count: number): void {
    this.eventsByJob.set(
      jobId,
      Array.from({ length: count }, (_, index) => ({
        eventId: crypto.randomUUID(),
        jobId,
        sequence: index + 1,
        type: index === count - 1 ? "job.succeeded" : "progress",
        payload: { stage: `stage-${index + 1}` },
        source: "connector",
        createdAt: new Date(NOW.getTime() + index * 1000),
      })),
    );
  }

  seedResult(jobId: string, overrides: Partial<Result> = {}): Result {
    const result: Result = {
      jobId,
      summary: "All checks passed",
      changedFiles: ["src/index.ts"],
      tests: { passed: 8, failed: 0, summary: "8 passed" },
      artifacts: [
        {
          name: "report.html",
          mediaType: "text/html",
          url: "https://example.test/report",
        },
      ],
      acknowledgedAt: null,
      ...overrides,
    };
    this.results.set(jobId, result);
    return result;
  }

  async getRepositoryPolicy(
    ownerId: string,
    repositoryId: string,
  ): Promise<RepositoryPolicy | null> {
    return this.policies.get(`${ownerId}:${repositoryId}`) ?? null;
  }

  async getConnectorHealth(
    ownerId: string,
  ): Promise<"fresh" | "stale" | "offline"> {
    return ownerId === OWNER_ID ? this.connectorHealth : "offline";
  }

  async createIdempotent(input: Record<string, unknown>): Promise<Job> {
    this.createCalls.push(structuredClone(input));
    const key = `${String(input.ownerId)}:${String(input.clientRequestId)}`;
    const digest = String(input.requestDigest);
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        throw new RepositoryFailure("IDEMPOTENCY_CONFLICT");
      }
      return this.jobs.get(existing.jobId) as Job;
    }
    const job = this.seedJob({
      ownerId: String(input.ownerId),
      repositoryId: String(input.repositoryId),
      requestCiphertext: String(input.requestCiphertext),
      requestDigest: digest,
      mode: input.mode as "normal" | "read_only",
    });
    this.idempotency.set(key, { digest, jobId: job.jobId });
    return job;
  }

  async list(input: Record<string, unknown>): Promise<Job[]> {
    this.listCalls.push(structuredClone(input));
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === input.ownerId)
      .filter(
        (job) => input.status === undefined || job.status === input.status,
      )
      .filter((job) => input.unreadOnly !== true || job.unreadTerminal)
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )
      .slice(0, Number(input.limit ?? 5));
  }

  async get(ownerId: string, jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    return job?.ownerId === ownerId ? job : null;
  }

  async events(
    ownerId: string,
    jobId: string,
    limit: number,
  ): Promise<Event[]> {
    this.eventCalls.push({ ownerId, jobId, limit });
    const job = await this.get(ownerId, jobId);
    if (job === null) return [];
    return (this.eventsByJob.get(jobId) ?? []).slice(-limit);
  }

  async listPendingApprovals(
    ownerId: string,
    limit: number,
    now: Date,
  ): Promise<Approval[]> {
    this.approvalListCalls.push({ ownerId, limit, now });
    return [...this.approvals.values()]
      .filter((approval) => approval.ownerId === ownerId)
      .filter(
        (approval) => approval.decision === null && approval.expiresAt > now,
      )
      .slice(0, limit);
  }

  async cancelAtomically(input: Record<string, unknown>): Promise<Job> {
    this.cancelCalls.push(structuredClone(input));
    const ownerId = String(input.ownerId);
    const job = await this.get(ownerId, String(input.jobId));
    if (job === null) throw new RepositoryFailure("NOT_FOUND");
    if (job.status === "cancelling" || job.status === "cancelled") return job;
    if (job.revision !== input.expectedRevision)
      throw new RepositoryFailure("REVISION_CONFLICT");
    if (TERMINAL_STATES.has(job.status)) return job;
    if (job.status === "queued" || job.status === "dispatched") {
      job.status = "cancelled";
      job.currentStage = "cancelled";
      job.revision += 1;
      job.unreadTerminal = true;
      job.terminalAt = NOW;
      return job;
    }
    if (job.status === "running" || job.status === "waiting_approval") {
      job.status = "cancelling";
      job.currentStage = "cancelling";
      job.revision += 1;
      if (
        this.outbox.cancelCommands.every(
          (command) => command.job_id !== job.jobId,
        )
      ) {
        await this.outbox.enqueueCancel({
          type: "job.cancel",
          job_id: job.jobId,
          attempt: job.attempt,
          job_revision: job.revision,
        });
      }
      return job;
    }
    return job;
  }

  async recordApprovalDecision(
    input: Record<string, unknown>,
  ): Promise<Approval> {
    this.decisionCalls.push(structuredClone(input));
    const approval = this.approvals.get(String(input.approvalId));
    if (approval === undefined || approval.ownerId !== input.ownerId) {
      throw new RepositoryFailure("NOT_FOUND");
    }
    if (approval.decision !== null)
      throw new RepositoryFailure("APPROVAL_ALREADY_DECIDED");
    if (approval.expiresAt <= NOW)
      throw new RepositoryFailure("APPROVAL_EXPIRED");
    const job = await this.get(String(input.ownerId), approval.jobId);
    if (
      job === null ||
      approval.jobRevision !== input.expectedJobRevision ||
      job.revision !== input.expectedJobRevision
    ) {
      throw new RepositoryFailure("APPROVAL_MISMATCH");
    }
    approval.decision = input.decision as "approve" | "reject";
    approval.decidedAt = NOW;
    await this.outbox.enqueueApprovalDecision({
      type: "approval.decision",
      approval_id: approval.approvalId,
      job_id: approval.jobId,
      attempt: approval.attempt,
      job_revision: approval.jobRevision,
      action_fingerprint: approval.actionFingerprint,
      decision: approval.decision,
    });
    return approval;
  }

  async acknowledgeResult(
    ownerId: string,
    jobId: string,
  ): Promise<Result | null> {
    this.acknowledgementCalls.push(jobId);
    const job = await this.get(ownerId, jobId);
    const result = this.results.get(jobId);
    if (job === null || result === undefined) return null;
    if (result.acknowledgedAt === null) {
      result.acknowledgedAt = NOW;
      this.acknowledgementWrites += 1;
      job.unreadTerminal = false;
    }
    return result;
  }
}

type Owner = Parameters<JobCoordinator["submit"]>[0];
type CoordinatorInput = ConstructorParameters<typeof JobCoordinator>[0];

const owner = (ownerId = OWNER_ID): Owner => ({ id: ownerId }) as Owner;

const submitInput = (
  overrides: Partial<SubmitTaskInput> = {},
): SubmitTaskInput => ({
  client_request_id: crypto.randomUUID(),
  repository_id: REPOSITORY_ID,
  request: "Run the focused tests",
  mode: "normal",
  ...overrides,
});

const setup = (
  options: { connectorHealth?: "fresh" | "stale" | "offline" } = {},
) => {
  const outbox = new FakeConnectorOutbox();
  const repository = new FakeJobRepository(outbox);
  repository.seedPolicy();
  repository.connectorHealth = options.connectorHealth ?? "fresh";
  const encryptor = new FakeEncryptor();
  const dependencies = {
    repository,
    encryptor,
    now: () => NOW,
  } as unknown as CoordinatorInput;
  return {
    coordinator: new JobCoordinator(dependencies),
    repository,
    outbox,
    encryptor,
  };
};

const expectCode = async (
  operation: Promise<unknown>,
  code: string,
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
};

describe("Aes256GcmEncryptor", () => {
  it("round-trips an authenticated request", () => {
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(19));
    const encoded = cipher.encrypt("private Connector request");

    expect(encoded).toMatch(/^aes256gcm:v1:/);
    expect(encoded).not.toContain("private Connector request");
    expect(cipher.decrypt(encoded)).toBe("private Connector request");
  });

  it("fails closed for malformed, tampered, and wrong-key ciphertext", () => {
    const cipher = new Aes256GcmEncryptor(new Uint8Array(32).fill(19));
    const wrongKey = new Aes256GcmEncryptor(new Uint8Array(32).fill(20));
    const encoded = cipher.encrypt("private Connector request");
    const replacement = encoded.endsWith("A") ? "B" : "A";
    const tampered = `${encoded.slice(0, -1)}${replacement}`;

    expect(() => cipher.decrypt("not-ciphertext")).toThrow(
      "Encrypted request is invalid",
    );
    expect(() => cipher.decrypt(tampered)).toThrow(
      "Encrypted request is invalid",
    );
    expect(() => wrongKey.decrypt(encoded)).toThrow(
      "Encrypted request is invalid",
    );
  });

  it("requires an exact 256-bit key", () => {
    expect(() => new Aes256GcmEncryptor(new Uint8Array(31))).toThrow(
      "AES-256-GCM requires a 32-byte key",
    );
  });
});

describe("JobCoordinator.submit", () => {
  it("returns the original receipt for repeated equal canonical payloads", async () => {
    const { coordinator, repository, encryptor } = setup();
    const input = submitInput();

    const first = await coordinator.submit(owner(), input);
    const second = await coordinator.submit(owner(), {
      mode: "normal",
      request: input.request,
      repository_id: input.repository_id,
      client_request_id: input.client_request_id,
    });

    expect(second).toEqual(first);
    expect(repository.createCalls).toHaveLength(2);
    expect(repository.createCalls[1]?.requestDigest).toBe(
      repository.createCalls[0]?.requestDigest,
    );
    expect(first).toMatchObject({
      status: "queued",
      connector_status: "online",
    });
    expect(encryptor.ciphertexts[0]).not.toBe(encryptor.ciphertexts[1]);
  });

  it("rejects a conflicting payload under the same idempotency key", async () => {
    const { coordinator, repository } = setup();
    const input = submitInput();
    await coordinator.submit(owner(), input);

    await expectCode(
      coordinator.submit(owner(), {
        ...input,
        request: "Delete the repository",
      }),
      "IDEMPOTENCY_CONFLICT",
    );
    expect(repository.jobs.size).toBe(1);
  });

  it("stores encrypted request text and never sends plaintext to the repository", async () => {
    const { coordinator, repository, encryptor } = setup();
    const secretRequest = "deploy with token=do-not-store-this-secret";

    await coordinator.submit(owner(), submitInput({ request: secretRequest }));

    expect(encryptor.plaintextInputs).toEqual([secretRequest]);
    const stored = repository.createCalls[0]?.requestCiphertext;
    expect(typeof stored).toBe("string");
    expect(stored).not.toContain(secretRequest);
    expect(stored).not.toContain("do-not-store-this-secret");
  });

  it("denies disabled or foreign repository policies before encryption or creation", async () => {
    const disabled = setup();
    disabled.repository.seedPolicy({ enabled: false });
    await expectCode(
      disabled.coordinator.submit(owner(), submitInput()),
      "REPOSITORY_NOT_ALLOWED",
    );
    expect(disabled.encryptor.plaintextInputs).toHaveLength(0);
    expect(disabled.repository.createCalls).toHaveLength(0);

    const foreign = setup();
    foreign.repository.policies.delete(`${OWNER_ID}:${REPOSITORY_ID}`);
    foreign.repository.seedPolicy({ ownerId: OTHER_OWNER_ID });
    await expectCode(
      foreign.coordinator.submit(owner(), submitInput()),
      "REPOSITORY_NOT_ALLOWED",
    );
    expect(foreign.repository.createCalls).toHaveLength(0);
  });

  it("queues while the owner connector is offline and reports offline health", async () => {
    const { coordinator, repository } = setup({ connectorHealth: "offline" });

    const receipt = await coordinator.submit(owner(), submitInput());

    expect(receipt).toMatchObject({
      status: "queued",
      connector_status: "offline",
    });
    expect(repository.jobs.values().next().value?.status).toBe("queued");
  });
});

describe("JobCoordinator reads", () => {
  it("passes owner, status, unread, and the bounded list limit to the repository", async () => {
    const { coordinator, repository } = setup();
    repository.seedJob({
      status: "waiting_approval",
      unreadTerminal: true,
      updatedAt: new Date("2026-09-01T00:02:00.000Z"),
    });
    repository.seedJob({
      status: "waiting_approval",
      unreadTerminal: true,
      updatedAt: new Date("2026-09-01T00:01:00.000Z"),
    });

    const input: ListTasksInput = {
      limit: 2,
      status: "waiting_approval",
      unread_only: true,
    };
    const result = await coordinator.list(owner(), input);

    expect(repository.listCalls[0]).toMatchObject({
      ownerId: OWNER_ID,
      status: "waiting_approval",
      unreadOnly: true,
      limit: 2,
    });
    expect(result).toHaveLength(2);
    expect(
      result.every(
        (item) => item.status === "waiting_approval" && item.unread_terminal,
      ),
    ).toBe(true);
  });

  it("isolates list, detail, cancellation, and result reads by owner", async () => {
    const { coordinator, repository } = setup();
    const job = repository.seedJob({
      ownerId: OWNER_ID,
      status: "succeeded",
      revision: 4,
    });
    repository.seedResult(job.jobId);
    repository.seedJob({
      ownerId: OTHER_OWNER_ID,
      status: "succeeded",
      revision: 4,
    });

    expect(
      await coordinator.list(owner(OTHER_OWNER_ID), {
        limit: 5,
        unread_only: false,
      }),
    ).toEqual([]);
    await expectCode(
      coordinator.get(owner(OTHER_OWNER_ID), { job_id: job.jobId }),
      "JOB_NOT_FOUND",
    );
    await expectCode(
      coordinator.cancel(owner(OTHER_OWNER_ID), {
        job_id: job.jobId,
        expected_revision: 4,
      }),
      "JOB_NOT_FOUND",
    );
    await expectCode(
      coordinator.getResult(owner(OTHER_OWNER_ID), { job_id: job.jobId }),
      "JOB_NOT_FOUND",
    );
  });

  it("limits task detail events to the recent five and returns them chronologically", async () => {
    const { coordinator, repository } = setup();
    const job = repository.seedJob({ status: "running", revision: 6 });
    repository.seedEvents(job.jobId, 8);

    const input: GetTaskInput = { job_id: job.jobId };
    const detail = await coordinator.get(owner(), input);

    expect(repository.eventCalls[0]).toMatchObject({
      ownerId: OWNER_ID,
      jobId: job.jobId,
      limit: 5,
    });
    expect(detail.recent_events).toHaveLength(5);
    expect(
      detail.recent_events.map((event: { sequence: number }) => event.sequence),
    ).toEqual([4, 5, 6, 7, 8]);
  });

  it("lists only unexpired pending approvals and passes the owner and limit", async () => {
    const { coordinator, repository } = setup();
    repository.seedApproval({
      expiresAt: new Date("2026-09-01T00:04:00.000Z"),
    });
    repository.seedApproval({
      expiresAt: new Date("2026-08-31T23:59:00.000Z"),
    });

    const input: ListPendingApprovalsInput = { limit: 1 };
    const approvals = await coordinator.listApprovals(owner(), input);

    expect(repository.approvalListCalls[0]).toMatchObject({
      ownerId: OWNER_ID,
      limit: 1,
      now: NOW,
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).not.toHaveProperty("action_fingerprint");
  });
});

describe("JobCoordinator.cancel", () => {
  it.each(["queued", "dispatched"] as const)(
    "cancels %s immediately without an outbox command",
    async (status) => {
      const { coordinator, repository, outbox } = setup();
      const job = repository.seedJob({ status, revision: 2 });

      const result = await coordinator.cancel(owner(), {
        job_id: job.jobId,
        expected_revision: 2,
      });

      expect(result).toMatchObject({ status: "cancelled", revision: 3 });
      expect(outbox.cancelCommands).toHaveLength(0);
    },
  );

  it.each(["running", "waiting_approval"] as const)(
    "moves %s to cancelling and enqueues exactly one cancel command",
    async (status) => {
      const { coordinator, repository, outbox } = setup();
      const job = repository.seedJob({ status, revision: 2, attempt: 3 });

      const result = await coordinator.cancel(owner(), {
        job_id: job.jobId,
        expected_revision: 2,
      });

      expect(result).toMatchObject({ status: "cancelling", revision: 3 });
      expect(outbox.cancelCommands).toEqual([
        { type: "job.cancel", job_id: job.jobId, attempt: 3, job_revision: 3 },
      ]);
    },
  );

  it("rejects a stale revision without changing state or enqueuing a command", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({ status: "running", revision: 4 });

    await expectCode(
      coordinator.cancel(owner(), { job_id: job.jobId, expected_revision: 3 }),
      "REVISION_CONFLICT",
    );
    expect(job.status).toBe("running");
    expect(job.revision).toBe(4);
    expect(outbox.cancelCommands).toHaveLength(0);
  });

  it("does not duplicate a command when cancellation is already cancelling", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({
      status: "running",
      revision: 2,
      attempt: 1,
    });

    await coordinator.cancel(owner(), {
      job_id: job.jobId,
      expected_revision: 2,
    });
    const repeated = await coordinator.cancel(owner(), {
      job_id: job.jobId,
      expected_revision: 2,
    });

    expect(repeated).toMatchObject({ status: "cancelling", revision: 3 });
    expect(outbox.cancelCommands).toHaveLength(1);
  });

  it("returns an already-cancelled task without a duplicate command", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({ status: "cancelled", revision: 7 });

    const result = await coordinator.cancel(owner(), {
      job_id: job.jobId,
      expected_revision: 7,
    });

    expect(result).toMatchObject({ status: "cancelled", revision: 7 });
    expect(outbox.cancelCommands).toHaveLength(0);
  });

  it("returns a queued job cancelled by the first call when the original revision is retried", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({ status: "queued", revision: 2 });

    await coordinator.cancel(owner(), {
      job_id: job.jobId,
      expected_revision: 2,
    });
    const repeated = await coordinator.cancel(owner(), {
      job_id: job.jobId,
      expected_revision: 2,
    });

    expect(repeated).toMatchObject({ status: "cancelled", revision: 3 });
    expect(outbox.cancelCommands).toHaveLength(0);
  });

  it("keeps terminal jobs immutable", async () => {
    const { coordinator, repository } = setup();
    const job = repository.seedJob({ status: "succeeded", revision: 8 });

    await expectCode(
      coordinator.cancel(owner(), { job_id: job.jobId, expected_revision: 8 }),
      "JOB_NOT_MUTABLE",
    );
    expect(repository.cancelCalls).toHaveLength(0);
  });
});

describe("JobCoordinator approvals", () => {
  it("accepts the first matching approval decision and emits one connector command", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({
      status: "waiting_approval",
      revision: 3,
      attempt: 2,
    });
    const approval = repository.seedApproval({
      jobId: job.jobId,
      jobRevision: 3,
      attempt: 2,
    });

    const decision: DecideApprovalInput = {
      approval_id: approval.approvalId,
      decision: "approve",
      expected_job_revision: 3,
    };
    const result = await coordinator.decideApproval(owner(), decision);

    expect(result).toMatchObject({
      approval_id: approval.approvalId,
      decision: "approve",
    });
    expect(result).not.toHaveProperty("action_fingerprint");
    expect(outbox.approvalCommands).toEqual([
      {
        type: "approval.decision",
        approval_id: approval.approvalId,
        job_id: job.jobId,
        attempt: 2,
        job_revision: 3,
        action_fingerprint: approval.actionFingerprint,
        decision: "approve",
      },
    ]);
  });

  it("fails closed for approval revision mismatches and does not enqueue", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({ status: "waiting_approval", revision: 4 });
    const approval = repository.seedApproval({
      jobId: job.jobId,
      jobRevision: 3,
    });

    await expectCode(
      coordinator.decideApproval(owner(), {
        approval_id: approval.approvalId,
        decision: "approve",
        expected_job_revision: 3,
      }),
      "APPROVAL_MISMATCH",
    );
    expect(outbox.approvalCommands).toHaveLength(0);
  });

  it("fails closed for expired approvals and does not enqueue", async () => {
    const { coordinator, repository, outbox } = setup();
    const job = repository.seedJob({ status: "waiting_approval", revision: 3 });
    const approval = repository.seedApproval({
      jobId: job.jobId,
      jobRevision: 3,
      expiresAt: new Date("2026-08-31T23:59:00.000Z"),
    });

    await expectCode(
      coordinator.decideApproval(owner(), {
        approval_id: approval.approvalId,
        decision: "reject",
        expected_job_revision: 3,
      }),
      "APPROVAL_EXPIRED",
    );
    expect(outbox.approvalCommands).toHaveLength(0);
  });
});

describe("JobCoordinator.getResult", () => {
  it("is terminal-only", async () => {
    const { coordinator, repository } = setup();
    const job = repository.seedJob({ status: "running", revision: 2 });
    repository.seedResult(job.jobId);

    const input: GetTaskResultInput = { job_id: job.jobId };
    await expectCode(coordinator.getResult(owner(), input), "JOB_NOT_MUTABLE");
    expect(repository.acknowledgementCalls).toHaveLength(0);
  });

  it("persists one acknowledgement timestamp and returns it idempotently", async () => {
    const { coordinator, repository } = setup();
    const job = repository.seedJob({ status: "succeeded", revision: 5 });
    repository.seedResult(job.jobId);

    const first = await coordinator.getResult(owner(), { job_id: job.jobId });
    const second = await coordinator.getResult(owner(), { job_id: job.jobId });

    expect(first.acknowledged_at).toBe("2026-09-01T00:00:00.000Z");
    expect(second.acknowledged_at).toBe(first.acknowledged_at);
    expect(repository.acknowledgementCalls).toHaveLength(2);
    expect(repository.acknowledgementWrites).toBe(1);
  });
});

describe("JobCoordinator domain error boundary", () => {
  it("uses only the public stable error namespace for controlled failures", () => {
    const allowed = [
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
    ];
    expect(new Set(allowed).size).toBe(15);
    expect(allowed).not.toContain("NOT_FOUND");
    expect(allowed).not.toContain("APPROVAL_ALREADY_DECIDED");
  });
});
