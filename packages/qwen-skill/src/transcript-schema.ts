import { z } from "zod";

/** The seven stable MCP tools the private Qwen Skill may import. */
export const MCP_TOOL_NAMES = [
  "submit_task",
  "list_tasks",
  "get_task",
  "cancel_task",
  "list_pending_approvals",
  "decide_approval",
  "get_task_result",
] as const;

/** MCP tools that change Control Plane state; a turn may target at most one. */
export const MUTATION_TOOL_NAMES: ReadonlySet<(typeof MCP_TOOL_NAMES)[number]> =
  new Set(["submit_task", "cancel_task", "decide_approval"]);

/** The three documented Qwen glasses UI tools. */
export const UI_TOOL_NAMES = [
  "UiTool.list",
  "UiTool.all_text",
  "UiTool.pic_and_text",
] as const;

/** Visible user/assistant/TTS text stays short enough for glasses and speech. */
export const MAX_VISIBLE_TEXT_LENGTH = 600;

/** Spoken TTS templates stay within the documented 120-character bound. */
export const MAX_TTS_TEXT_LENGTH = 120;

/** A list rendering carries at most the five documented rows. */
export const MAX_LIST_ITEMS = 5;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const SECRET_REFERENCE_PATTERN = /^\$\{[A-Z][A-Z0-9_]*\}$/;

const boundedText = (label: string, limit: number) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine(
      (value) => [...value].length <= limit,
      `${label} text exceeds ${limit} characters`,
    )
    .refine(
      (value) =>
        ![...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20),
      `${label} text contains control characters`,
    );

const visibleText = (label: string) =>
  boundedText(label, MAX_VISIBLE_TEXT_LENGTH);

const requestId = z
  .string()
  .uuid("request_id must be a UUID")
  .refine(
    (value) => value === value.toLowerCase(),
    "request_id must be lowercase",
  );

export const SkillMetadataSchema = z
  .object({
    name: z.literal("qwen-harness-bridge"),
    display_name: z.string().min(1, "display_name must not be empty"),
    version: z
      .string()
      .regex(SEMVER_PATTERN, "version must be a synchronized SemVer"),
    visibility: z
      .string()
      .refine((value) => value === "private", "visibility must be private"),
    language: z
      .string()
      .refine((value) => value === "zh-CN", "language must be zh-CN"),
    stable_mode: z
      .boolean()
      .refine((value) => value === true, "stable_mode must be enabled"),
    rtc_mode: z
      .boolean()
      .refine((value) => value === false, "rtc_mode must be false"),
    mcp_import: z.string().min(1, "mcp_import reference is required"),
    transcript_schema: z
      .string()
      .min(1, "transcript_schema reference is required"),
  })
  .strict();

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

const McpServerSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/u, "server name must be a lowercase slug"),
    type: z
      .string()
      .refine(
        (value) => value === "streamable-http",
        "server type must be streamable-http",
      ),
    url: z
      .string()
      .url("server url must be an absolute URL")
      .refine(
        (value) => value.startsWith("https://"),
        "server url must use https",
      ),
    auth: z
      .object({
        type: z
          .string()
          .refine((value) => value === "bearer", "auth type must be bearer"),
        token_secret_ref: z
          .string()
          .regex(
            SECRET_REFERENCE_PATTERN,
            "token_secret_ref must be an environment secret reference, never a literal secret",
          ),
      })
      .strict(),
    tools: z.array(z.string()).superRefine((tools, context) => {
      const unique = new Set(tools);
      if (unique.size !== tools.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tools must not repeat",
        });
      }
      const approved = new Set<string>(MCP_TOOL_NAMES);
      for (const tool of tools) {
        if (!approved.has(tool)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tool ${tool} is not one of the seven approved MCP tools`,
          });
        }
      }
      if (tools.length !== MCP_TOOL_NAMES.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `tools must list exactly the ${MCP_TOOL_NAMES.length} approved MCP tools`,
        });
      }
    }),
  })
  .strict();

const McpImportDocumentSchema = z
  .object({
    version: z.literal(1),
    servers: z
      .array(McpServerSchema)
      .length(1, "mcp import must declare one server"),
  })
  .strict();

export type NormalizedMcpImport = {
  servers: {
    name: string;
    type: "streamable-http";
    url: string;
    auth: { type: "bearer"; token_secret_ref: string };
    tools: string[];
  }[];
};

const McpCallStepSchema = z
  .object({
    kind: z.literal("mcp_call"),
    tool: z.enum(MCP_TOOL_NAMES, {
      errorMap: () => ({
        message: "tool must be one of the seven approved MCP tools",
      }),
    }),
    request_id: requestId,
    arguments: z.record(z.unknown()).default({}),
  })
  .strict();

const McpResultStepSchema = z
  .object({
    kind: z.literal("mcp_result"),
    tool: z.enum(MCP_TOOL_NAMES, {
      errorMap: () => ({
        message: "tool must be one of the seven approved MCP tools",
      }),
    }),
    request_id: requestId,
    ok: z.boolean(),
    text: visibleText("mcp_result").optional(),
  })
  .strict();

const UiCallStepSchema = z
  .object({
    kind: z.literal("ui_call"),
    tool: z.enum(UI_TOOL_NAMES, {
      errorMap: () => ({
        message: "tool must be one of the three documented UI tools",
      }),
    }),
    request_id: requestId,
    payload: z
      .object({
        lines: z
          .array(visibleText("ui_call"))
          .max(
            MAX_LIST_ITEMS,
            `ui_call lines exceed the ${MAX_LIST_ITEMS} row bound`,
          )
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const UserStepSchema = z
  .object({ kind: z.literal("user"), text: visibleText("user") })
  .strict();

const TtsStepSchema = z
  .object({
    kind: z.literal("tts"),
    text: boundedText("tts", MAX_TTS_TEXT_LENGTH),
  })
  .strict();

const AssistantStepSchema = z
  .object({ kind: z.literal("assistant"), text: visibleText("assistant") })
  .strict();

export const TranscriptStepSchema = z.union([
  UserStepSchema,
  McpCallStepSchema,
  McpResultStepSchema,
  UiCallStepSchema,
  TtsStepSchema,
  AssistantStepSchema,
]);

export type TranscriptStep = z.infer<typeof TranscriptStepSchema>;

export const TranscriptTurnSchema = z
  .object({
    request_id: requestId,
    steps: z
      .array(TranscriptStepSchema)
      .min(1, "turn requires at least one step"),
  })
  .strict()
  .superRefine((turn, context) => {
    const mutations = turn.steps
      .filter(
        (step): step is z.infer<typeof McpCallStepSchema> =>
          step.kind === "mcp_call",
      )
      .filter((step) => MUTATION_TOOL_NAMES.has(step.tool));
    if (mutations.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "a turn must target at most one mutation",
      });
    }
  });

export const TranscriptFixtureSchema = z
  .object({
    fixture_id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/u, "fixture_id must be a lowercase slug"),
    turns: z
      .array(TranscriptTurnSchema)
      .min(1, "fixture requires at least one turn"),
  })
  .strict();

export type TranscriptFixture = z.infer<typeof TranscriptFixtureSchema>;

/** Protocol source files that define the input schema for each approved tool. */
export const PROTOCOL_TOOL_SCHEMA_SOURCES = {
  submit_task: {
    file: "packages/protocol/src/job.ts",
    schema: "SubmitTaskInputSchema",
  },
  list_tasks: {
    file: "packages/protocol/src/mcp.ts",
    schema: "ListTasksInputSchema",
  },
  get_task: {
    file: "packages/protocol/src/mcp.ts",
    schema: "GetTaskInputSchema",
  },
  cancel_task: {
    file: "packages/protocol/src/mcp.ts",
    schema: "CancelTaskInputSchema",
  },
  list_pending_approvals: {
    file: "packages/protocol/src/mcp.ts",
    schema: "ListPendingApprovalsInputSchema",
  },
  decide_approval: {
    file: "packages/protocol/src/mcp.ts",
    schema: "DecideApprovalInputSchema",
  },
  get_task_result: {
    file: "packages/protocol/src/mcp.ts",
    schema: "GetTaskResultInputSchema",
  },
} as const;

export const parseSkillMetadata = (value: unknown): SkillMetadata =>
  SkillMetadataSchema.parse(value);

export const parseMcpImport = (value: unknown): NormalizedMcpImport => {
  const document = McpImportDocumentSchema.parse(value);
  return {
    servers: document.servers.map((server) => ({
      name: server.name,
      type: server.type,
      url: server.url,
      auth: {
        type: server.auth.type,
        token_secret_ref: server.auth.token_secret_ref,
      },
      tools: [...server.tools],
    })),
  } as NormalizedMcpImport;
};

export const parseTranscriptFixture = (value: unknown): TranscriptFixture =>
  TranscriptFixtureSchema.parse(value);
