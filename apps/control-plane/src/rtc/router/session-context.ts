export type TaskContextEntry = Readonly<{
  jobId: string;
  shortId: string;
  revision: number;
}>;

export type ApprovalContextEntry = Readonly<{
  approvalId: string;
  jobShortId: string;
  jobRevision: number;
}>;

export type ContextSnapshot = Readonly<{
  taskIds: readonly string[];
  approvalIds: readonly string[];
  focusedJobId?: string;
  lastFinalDigest?: string;
  ordinalFresh: boolean;
}>;

export type SessionContextOptions = Readonly<{ ttlMs?: number }>;

const MAX_TRACKED = 5;
const DEFAULT_TTL_MS = 120_000;

/**
 * Bounded live-session context: the last task list (five ids), the last approval
 * list (five ids/revisions), the focused task, and the last final-ASR digest.
 * Ordinal lists expire after two minutes and any new list replaces the previous
 * one. No free-form transcript is retained.
 */
export class RtcSessionContext {
  readonly #ttlMs: number;
  #tasks: readonly TaskContextEntry[] = [];
  #approvals: readonly ApprovalContextEntry[] = [];
  #tasksAt: number | undefined;
  #approvalsAt: number | undefined;
  #focusedJobId: string | undefined;
  #lastFinalDigest: string | undefined;

  constructor(options: SessionContextOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  recordTaskList(entries: readonly TaskContextEntry[], nowMs: number): void {
    this.#tasks = entries.slice(0, MAX_TRACKED);
    this.#tasksAt = nowMs;
  }

  recordApprovalList(
    entries: readonly ApprovalContextEntry[],
    nowMs: number,
  ): void {
    this.#approvals = entries.slice(0, MAX_TRACKED);
    this.#approvalsAt = nowMs;
  }

  taskEntries(nowMs: number): readonly TaskContextEntry[] | undefined {
    if (this.#tasksAt === undefined || nowMs - this.#tasksAt > this.#ttlMs) {
      return undefined;
    }
    return this.#tasks;
  }

  approvalEntries(nowMs: number): readonly ApprovalContextEntry[] | undefined {
    if (
      this.#approvalsAt === undefined ||
      nowMs - this.#approvalsAt > this.#ttlMs
    ) {
      return undefined;
    }
    return this.#approvals;
  }

  focus(jobId: string): void {
    this.#focusedJobId = jobId;
  }

  focusedJobId(): string | undefined {
    return this.#focusedJobId;
  }

  recordFinalDigest(digest: string): void {
    this.#lastFinalDigest = digest;
  }

  lastDigest(): string | undefined {
    return this.#lastFinalDigest;
  }

  snapshot(nowMs: number): ContextSnapshot {
    const fresh =
      this.#tasksAt !== undefined && nowMs - this.#tasksAt <= this.#ttlMs;
    return {
      taskIds: this.#tasks.map((entry) => entry.jobId),
      approvalIds: this.#approvals.map((entry) => entry.approvalId),
      ...(this.#focusedJobId === undefined
        ? {}
        : { focusedJobId: this.#focusedJobId }),
      ...(this.#lastFinalDigest === undefined
        ? {}
        : { lastFinalDigest: this.#lastFinalDigest }),
      ordinalFresh: fresh,
    };
  }
}
