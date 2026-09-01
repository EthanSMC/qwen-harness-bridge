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

const PUBLIC_OBJECT_SCHEMA = z.object({}).passthrough();
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
const MAX_PUBLIC_TEXT_CODE_POINTS = 600;
const INTERNAL_FIELD_PATTERN =
  /(?:request|prompt|raw[_-]?log|logs?|ciphertext|digest|credentials?|(?:harness|agent|session|database|connector|internal)[_-]?id)$/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)/;

const truncateUnicode = (value: string, limit: number): string =>
  Array.from(value).slice(0, limit).join("");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizePublicValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return ABSOLUTE_PATH_PATTERN.test(value)
      ? "[redacted path]"
      : truncateUnicode(value, MAX_PUBLIC_TEXT_CODE_POINTS);
  }
  if (depth > 8 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map((item) => sanitizePublicValue(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (INTERNAL_FIELD_PATTERN.test(key)) {
      continue;
    }
    output[key] = sanitizePublicValue(item, depth + 1);
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
  return truncateUnicode(serialized, MAX_PUBLIC_TEXT_CODE_POINTS);
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
): Promise<CallToolResult> => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return failure("INTERNAL");
  }

  try {
    return success(await invoke(owner, parsed.data));
  } catch (error) {
    return failure(stableErrorCode(error));
  }
};

type ToolSchema = z.ZodTypeAny;

const register = <T extends ToolSchema>(
  server: McpServer,
  name: string,
  schema: T,
  owner: McpOwnerContext,
  invoke: (owner: McpOwnerContext, input: z.infer<T>) => Promise<unknown>,
): void => {
  server.registerTool(
    name,
    {
      inputSchema: schema,
      outputSchema: PUBLIC_OBJECT_SCHEMA,
    },
    (async (args: z.infer<T>) => execute(schema, args, owner, invoke)) as never,
  );
};

export function registerMcpTools(
  server: McpServer,
  coordinator: McpCoordinator,
  owner: McpOwnerContext,
): void {
  register(
    server,
    "submit_task",
    SubmitTaskMcpInputSchema,
    owner,
    (boundOwner, input) => coordinator.submit(boundOwner, input),
  );
  register(
    server,
    "list_tasks",
    ListTasksInputSchema,
    owner,
    async (boundOwner, input) => ({
      tasks: await coordinator.list(boundOwner, input),
    }),
  );
  register(server, "get_task", GetTaskInputSchema, owner, (boundOwner, input) =>
    coordinator.get(boundOwner, input),
  );
  register(
    server,
    "cancel_task",
    CancelTaskInputSchema,
    owner,
    (boundOwner, input) => coordinator.cancel(boundOwner, input),
  );
  register(
    server,
    "list_pending_approvals",
    ListPendingApprovalsInputSchema,
    owner,
    async (boundOwner, input) => ({
      approvals: await coordinator.listApprovals(boundOwner, input),
    }),
  );
  register(
    server,
    "decide_approval",
    DecideApprovalInputSchema,
    owner,
    (boundOwner, input) => coordinator.decideApproval(boundOwner, input),
  );
  register(
    server,
    "get_task_result",
    GetTaskResultInputSchema,
    owner,
    (boundOwner, input) => coordinator.getResult(boundOwner, input),
  );
}
