import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type CancelTaskInput,
  CancelTaskInputSchema,
  type DecideApprovalInput,
  DecideApprovalInputSchema,
  type GetTaskInput,
  GetTaskInputSchema,
  type GetTaskResultInput,
  GetTaskResultInputSchema,
  JobReceiptSchema,
  JobStatusSchema,
  JobSummarySchema,
  type ListPendingApprovalsInput,
  ListPendingApprovalsInputSchema,
  type ListTasksInput,
  ListTasksInputSchema,
  type SubmitTaskInput,
  SubmitTaskInputSchema,
} from "@qhb/protocol";
import { z } from "zod";
import {
  type DomainErrorCode,
  isDomainErrorCode,
  publicMessageFor,
} from "../domain/errors.js";
import { sanitizePublicText } from "../domain/presenters.js";
import type { MetricsRegistry } from "../http/metrics.js";
import type { McpOwnerContext } from "./auth.js";

export type McpCoordinator = Readonly<{
  submit(owner: McpOwnerContext, input: SubmitTaskInput): Promise<unknown>;
  list(owner: McpOwnerContext, input: ListTasksInput): Promise<unknown>;
  get(owner: McpOwnerContext, input: GetTaskInput): Promise<unknown>;
  cancel(owner: McpOwnerContext, input: CancelTaskInput): Promise<unknown>;
  listApprovals(
    owner: McpOwnerContext,
    input: ListPendingApprovalsInput,
  ): Promise<unknown>;
  decideApproval(
    owner: McpOwnerContext,
    input: DecideApprovalInput,
  ): Promise<unknown>;
  getResult(
    owner: McpOwnerContext,
    input: GetTaskResultInput,
  ): Promise<unknown>;
}>;

const SubmitTaskMcpInputSchema = SubmitTaskInputSchema.extend({
  request: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 4000,
      "Request must contain at most 4000 UTF-8 bytes",
    ),
});
const PublicTimestampSchema = z.string().min(1).max(64);
const PublicPathSchema = z.string().min(1).max(512);
const PublicApprovalSchema = z
  .object({
    approval_id: z.string().uuid(),
    job_id: z.string().uuid().optional(),
    job_short_id: z.string().min(1).max(7),
    job_revision: z.number().int().nonnegative(),
    action_summary: z.string().max(600),
    impact_summary: z.string().max(600),
    risk_class: z.string().min(1).max(64),
    expires_at: PublicTimestampSchema,
  })
  .strict();
const PublicEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: z.string().min(1).max(64),
    current_stage: z.string().min(1).max(36).optional(),
    detail: z.string().max(600).optional(),
    changed_files: z.array(PublicPathSchema).max(5).optional(),
    created_at: PublicTimestampSchema,
  })
  .strict();
const SubmitTaskOutputSchema = JobReceiptSchema;
const ListTasksOutputSchema = z
  .object({ tasks: z.array(JobSummarySchema).max(5) })
  .strict();
const GetTaskOutputSchema = z
  .object({
    job_id: z.string().uuid(),
    title: z.string().min(1).max(40),
    repository: z.string().min(1).max(120),
    status: JobStatusSchema,
    current_stage: z.string().min(1).max(36),
    freshness: z.enum(["fresh", "stale", "offline"]),
    revision: z.number().int().nonnegative(),
    text: z.string().max(600),
    recent_events: z.array(PublicEventSchema).max(5),
    pending_approval: PublicApprovalSchema.nullable(),
    terminal_summary: z.string().max(600).nullable(),
  })
  .strict();
const CancelTaskOutputSchema = z
  .object({
    job_id: z.string().uuid(),
    status: JobStatusSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
const ListApprovalsOutputSchema = z
  .object({ approvals: z.array(PublicApprovalSchema).max(5) })
  .strict();
const DecideApprovalOutputSchema = z
  .object({
    approval_id: z.string().uuid(),
    job_id: z.string().uuid().optional(),
    decision: z.enum(["approve", "reject"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const GetTaskResultOutputSchema = z
  .object({
    job_id: z.string().uuid(),
    summary: z.string().max(120),
    changed_files: z.array(PublicPathSchema).max(5),
    tests: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        summary: z.string().max(120),
      })
      .strict(),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            media_type: z.string().min(1).max(120),
            url: z.string().url().max(2048),
          })
          .strict(),
      )
      .max(5),
    acknowledged_at: PublicTimestampSchema,
  })
  .strict();
const MAX_PUBLIC_TEXT_CODE_POINTS = 600;
const MAX_PUBLIC_OBJECT_ITEMS = 25;
const TOOL_DEADLINE_MS = 1_500;
const PUBLIC_OUTPUT_KEYS = new Set([
  "job_id",
  "short_id",
  "status",
  "connector_status",
  "accepted_at",
  "expires_at",
  "tasks",
  "title",
  "repository",
  "current_stage",
  "freshness",
  "unread_terminal",
  "updated_at",
  "revision",
  "text",
  "recent_events",
  "pending_approval",
  "terminal_summary",
  "sequence",
  "type",
  "detail",
  "changed_files",
  "created_at",
  "approval_id",
  "job_short_id",
  "job_revision",
  "action_summary",
  "impact_summary",
  "risk_class",
  "approvals",
  "decision",
  "summary",
  "tests",
  "passed",
  "failed",
  "artifacts",
  "name",
  "media_type",
  "url",
  "acknowledged_at",
  "error",
  "code",
  "message",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sanitizePublicValue = (
  value: unknown,
  depth = 0,
  key?: string,
): unknown => {
  if (typeof value === "string") {
    return sanitizePublicText(
      value,
      MAX_PUBLIC_TEXT_CODE_POINTS,
      undefined,
      MAX_PUBLIC_TEXT_CODE_POINTS,
    );
  }
  if (depth > 8) {
    return "[redacted]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    if (key === "changed_files") {
      return value
        .slice(0, 5)
        .filter((item): item is string => typeof item === "string")
        .filter((item) => {
          const sanitized = sanitizePublicText(
            item,
            Array.from(item).length,
            new TextEncoder().encode(item).byteLength,
            item.length,
          );
          return sanitized === item;
        })
        .map((item) =>
          sanitizePublicText(item, MAX_PUBLIC_TEXT_CODE_POINTS, undefined, 512),
        );
    }
    return value
      .slice(0, 5)
      .map((item) => sanitizePublicValue(item, depth + 1, key));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, item] of Object.entries(value).slice(
    0,
    MAX_PUBLIC_OBJECT_ITEMS,
  )) {
    if (!PUBLIC_OUTPUT_KEYS.has(childKey)) continue;
    output[childKey] = sanitizePublicValue(item, depth + 1, childKey);
  }
  return output;
};

const boundedText = (value: unknown): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "{}";
  } catch {
    serialized = "{}";
  }
  return sanitizePublicText(
    serialized,
    MAX_PUBLIC_TEXT_CODE_POINTS,
    undefined,
    MAX_PUBLIC_TEXT_CODE_POINTS,
  );
};

const success = (value: unknown): CallToolResult => {
  const publicValue = sanitizePublicValue(value);
  const structuredContent = isRecord(publicValue) ? publicValue : {};
  return {
    content: [{ type: "text", text: boundedText(structuredContent) }],
    structuredContent,
  };
};

const stableErrorCode = (error: unknown): string => {
  if (isRecord(error) && typeof error.code === "string") {
    return isDomainErrorCode(error.code) ? error.code : "INTERNAL";
  }
  return "INTERNAL";
};

const failure = (code: string): CallToolResult => {
  const safeCode: DomainErrorCode = isDomainErrorCode(code) ? code : "INTERNAL";
  const message = publicMessageFor(safeCode);
  const structuredContent = { error: { code: safeCode, message } };
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent,
  };
};

const execute = async (
  schema: z.ZodTypeAny,
  args: unknown,
  owner: McpOwnerContext,
  invoke: (owner: McpOwnerContext, input: unknown) => Promise<unknown>,
  metrics?: Pick<MetricsRegistry, "recordError">,
): Promise<CallToolResult> => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    metrics?.recordError("INTERNAL");
    return failure("INTERNAL");
  }

  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject({ code: "TASK_TIMEOUT" }),
        TOOL_DEADLINE_MS,
      );
    });
    try {
      return success(
        await Promise.race([
          Promise.resolve().then(() => invoke(owner, parsed.data)),
          deadline,
        ]),
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } catch (error) {
    const code = stableErrorCode(error);
    metrics?.recordError(code);
    return failure(code);
  }
};

type ToolSchema = z.ZodTypeAny;

const register = <TInput extends ToolSchema, TOutput extends ToolSchema>(
  server: McpServer,
  name: string,
  inputSchema: TInput,
  outputSchema: TOutput,
  owner: McpOwnerContext,
  invoke: (owner: McpOwnerContext, input: z.infer<TInput>) => Promise<unknown>,
  metrics?: Pick<MetricsRegistry, "recordError">,
): void => {
  server.registerTool(
    name,
    {
      inputSchema,
      outputSchema,
    },
    (async (args: z.infer<TInput>) =>
      execute(inputSchema, args, owner, invoke, metrics)) as never,
  );
};

export function registerMcpTools(
  server: McpServer,
  coordinator: McpCoordinator,
  owner: McpOwnerContext,
  metrics?: MetricsRegistry,
): void {
  register(
    server,
    "submit_task",
    SubmitTaskMcpInputSchema,
    SubmitTaskOutputSchema,
    owner,
    async (boundOwner, input) => {
      const stopMcpSubmit = metrics?.startMcpSubmit();
      try {
        return await coordinator.submit(boundOwner, input);
      } finally {
        stopMcpSubmit?.();
      }
    },
    metrics,
  );
  register(
    server,
    "list_tasks",
    ListTasksInputSchema,
    ListTasksOutputSchema,
    owner,
    async (boundOwner, input) => ({
      tasks: await coordinator.list(boundOwner, input),
    }),
    metrics,
  );
  register(
    server,
    "get_task",
    GetTaskInputSchema,
    GetTaskOutputSchema,
    owner,
    (boundOwner, input) => coordinator.get(boundOwner, input),
    metrics,
  );
  register(
    server,
    "cancel_task",
    CancelTaskInputSchema,
    CancelTaskOutputSchema,
    owner,
    (boundOwner, input) => coordinator.cancel(boundOwner, input),
    metrics,
  );
  register(
    server,
    "list_pending_approvals",
    ListPendingApprovalsInputSchema,
    ListApprovalsOutputSchema,
    owner,
    async (boundOwner, input) => ({
      approvals: await coordinator.listApprovals(boundOwner, input),
    }),
    metrics,
  );
  register(
    server,
    "decide_approval",
    DecideApprovalInputSchema,
    DecideApprovalOutputSchema,
    owner,
    (boundOwner, input) => coordinator.decideApproval(boundOwner, input),
    metrics,
  );
  register(
    server,
    "get_task_result",
    GetTaskResultInputSchema,
    GetTaskResultOutputSchema,
    owner,
    (boundOwner, input) => coordinator.getResult(boundOwner, input),
    metrics,
  );
}
