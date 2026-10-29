import type {
  JobReceipt,
  JobStatus,
  ListPendingApprovalsInput,
  ListTasksInput,
  SubmitTaskInput,
} from "@qhb/protocol";

/** One recognized live utterance; only final ASR hypotheses become intents. */
export type LiveIntent =
  | {
      kind: "submit";
      repositoryId: string;
      request: string;
      mode: "normal" | "read_only";
    }
  | { kind: "list" }
  | { kind: "inspect"; jobId: string }
  | { kind: "cancel"; jobId: string; expectedRevision: number }
  | {
      kind: "approve" | "reject";
      approvalId: string;
      expectedJobRevision: number;
    }
  | { kind: "result"; jobId: string }
  | { kind: "exit" }
  | { kind: "clarify"; prompt: string };

export type LiveUtterance = Readonly<{
  sessionId: string;
  ownerId: string;
  /** Stable final-ASR event id used for idempotency. */
  eventId: string;
  text: string;
}>;

export type RouterResponse = Readonly<{
  intent: LiveIntent;
  speech: string;
  highlight?: string;
  focusedJobId?: string;
  focusedApprovalId?: string;
}>;

/** Task rows come from the same task query used by MCP, with ids kept internal. */
export type RouterTask = Readonly<{
  job_id: string;
  short_id: string;
  status: JobStatus;
  current_stage: string;
  revision: number;
  title?: string;
}>;

export type RouterApproval = Readonly<{
  approval_id: string;
  job_short_id: string;
  job_revision: number;
  action_summary: string;
  impact_summary: string;
  expires_at: string;
}>;

export type RouterTaskDetail = Readonly<{
  job_id: string;
  status: JobStatus;
  current_stage: string;
  revision: number;
}>;

export type RouterTaskResult = Readonly<{
  job_id?: string;
  summary: string;
  changed_files: readonly string[];
  tests: Readonly<{ passed: number; failed: number; summary: string }>;
  acknowledged_at: string | null;
}>;

export type RouterCancelResult = Readonly<{
  job_id?: string;
  status?: string;
  short_id?: string;
}>;

export type ApprovalDecisionResult = Readonly<{
  approval_id: string;
  decision: "approve" | "reject";
  revision: number;
}>;

/**
 * Stable job/task/result services also used by MCP; the router never touches SQL.
 * Each call accepts the live-session signal so a closing session can stop a call
 * that has not completed yet.
 */
export type StableJobServices = Readonly<{
  submit: (input: SubmitTaskInput, signal?: AbortSignal) => Promise<JobReceipt>;
  list: (
    input: ListTasksInput,
    signal?: AbortSignal,
  ) => Promise<readonly RouterTask[]>;
  get: (
    input: { job_id: string },
    signal?: AbortSignal,
  ) => Promise<RouterTaskDetail>;
  cancel: (
    input: { job_id: string; expected_revision: number },
    signal?: AbortSignal,
  ) => Promise<RouterCancelResult>;
  getResult: (
    input: { job_id: string },
    signal?: AbortSignal,
  ) => Promise<RouterTaskResult>;
}>;

/** Approval service port backed by the same ApprovalService used by MCP. */
export type StableApprovalServices = Readonly<{
  listPending: (
    input: ListPendingApprovalsInput,
    signal?: AbortSignal,
  ) => Promise<readonly RouterApproval[]>;
  decide: (
    input: {
      approval_id: string;
      decision: "approve" | "reject";
      expected_job_revision: number;
    },
    signal?: AbortSignal,
  ) => Promise<ApprovalDecisionResult>;
}>;

export type RepositoryOption = Readonly<{
  id: string;
  displayName: string;
  aliases?: readonly string[];
}>;

export type RouterOptions = Readonly<{
  sessionId: string;
  ownerId: string;
  repositories: readonly RepositoryOption[];
  jobs: StableJobServices;
  approvals: StableApprovalServices;
  now?: () => number;
  signal?: AbortSignal;
  ttlMs?: number;
}>;
