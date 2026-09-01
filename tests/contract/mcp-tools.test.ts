import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CancelTaskInputSchema,
  DecideApprovalInputSchema,
  GetTaskInputSchema,
  GetTaskResultInputSchema,
  ListPendingApprovalsInputSchema,
  ListTasksInputSchema,
  SubmitTaskInputSchema,
} from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../apps/control-plane/src/domain/errors.js";
import { createMcpServer } from "../../apps/control-plane/src/mcp/server.js";
import { sanitizePublicValue } from "../../apps/control-plane/src/mcp/tools.js";

const OWNER_ID = "owner-contract";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000002";
const ACCEPTED_AT = "2026-09-01T00:00:00.000Z";
const EXPIRES_AT = "2026-09-02T00:00:00.000Z";

const TOOL_NAMES = [
  "submit_task",
  "list_tasks",
  "get_task",
  "cancel_task",
  "list_pending_approvals",
  "decide_approval",
  "get_task_result",
] as const;

const VALID_SUBMIT = {
  client_request_id: "00000000-0000-4000-8000-000000000010",
  repository_id: "novelty-studio",
  request: "run the login tests",
  mode: "normal" as const,
};

const SUBMIT_RESULT = {
  job_id: JOB_ID,
  short_id: "QH-7M2P",
  status: "queued" as const,
  connector_status: "offline" as const,
  accepted_at: ACCEPTED_AT,
  expires_at: EXPIRES_AT,
};

const TASK_SUMMARY = {
  short_id: "QH-7M2P",
  title: "登录测试",
  status: "queued" as const,
  current_stage: "排队",
  freshness: "offline" as const,
  unread_terminal: false,
  updated_at: ACCEPTED_AT,
};

const LIST_RESULT = { tasks: [TASK_SUMMARY] };
const DETAIL_RESULT = {
  job_id: JOB_ID,
  title: "登录测试",
  repository: "Novelty Studio",
  status: "queued" as const,
  current_stage: "排队",
  freshness: "offline" as const,
  recent_events: [],
  pending_approval: null,
  terminal_summary: null,
  revision: 0,
  text: "登录测试 排队",
};
const CANCEL_RESULT = {
  job_id: JOB_ID,
  status: "cancelled" as const,
  revision: 1,
};
const APPROVAL_LIST_RESULT = { approvals: [] };
const DECISION_RESULT = {
  approval_id: APPROVAL_ID,
  job_id: JOB_ID,
  decision: "approve" as const,
  revision: 1,
};
const TASK_RESULT_OUTPUT = {
  job_id: JOB_ID,
  summary: "登录测试已完成",
  changed_files: ["src/auth/login.test.ts"],
  tests: { passed: 1, failed: 0, summary: "1 passed" },
  artifacts: [],
  acknowledged_at: ACCEPTED_AT,
};

type RecordedCall = {
  method: string;
  owner: unknown;
  input: unknown;
};

type FakeCoordinator = {
  calls: RecordedCall[];
  submit(owner: unknown, input: unknown): Promise<unknown>;
  list(owner: unknown, input: unknown): Promise<unknown>;
  get(owner: unknown, input: unknown): Promise<unknown>;
  cancel(owner: unknown, input: unknown): Promise<unknown>;
  listApprovals(owner: unknown, input: unknown): Promise<unknown>;
  decideApproval(owner: unknown, input: unknown): Promise<unknown>;
  getResult(owner: unknown, input: unknown): Promise<unknown>;
};

function fakeCoordinator(
  overrides: Partial<
    Pick<FakeCoordinator, "get" | "submit" | "decideApproval">
  > = {},
): FakeCoordinator {
  const calls: RecordedCall[] = [];
  const record = (method: string, owner: unknown, input: unknown): void => {
    calls.push({ method, owner, input });
  };

  return {
    calls,
    submit: overrides.submit
      ? async (owner, input) => {
          record("submit", owner, input);
          return overrides.submit?.(owner, input);
        }
      : async (owner, input) => {
          record("submit", owner, input);
          return SUBMIT_RESULT;
        },
    list: async (owner, input) => {
      record("list", owner, input);
      return LIST_RESULT.tasks;
    },
    get: overrides.get
      ? async (owner, input) => {
          record("get", owner, input);
          return overrides.get?.(owner, input);
        }
      : async (owner, input) => {
          record("get", owner, input);
          return DETAIL_RESULT;
        },
    cancel: async (owner, input) => {
      record("cancel", owner, input);
      return CANCEL_RESULT;
    },
    listApprovals: async (owner, input) => {
      record("listApprovals", owner, input);
      return APPROVAL_LIST_RESULT.approvals;
    },
    decideApproval: overrides.decideApproval
      ? async (owner, input) => {
          record("decideApproval", owner, input);
          return overrides.decideApproval?.(owner, input);
        }
      : async (owner, input) => {
          record("decideApproval", owner, input);
          return DECISION_RESULT;
        },
    getResult: async (owner, input) => {
      record("getResult", owner, input);
      return TASK_RESULT_OUTPUT;
    },
  };
}

async function connectedClient(coordinator: FakeCoordinator): Promise<{
  client: Client;
  server: { close(): Promise<void> | void };
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    coordinator: coordinator as never,
    ownerId: OWNER_ID,
  } as never);
  const client = new Client({ name: "qhb-contract-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function closeConnection(
  connection: Awaited<ReturnType<typeof connectedClient>>,
): Promise<void> {
  await connection.client.close();
  await connection.server.close();
}

function asToolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function expectProperty(
  tool: Tool,
  property: string,
  expected: Record<string, unknown>,
): void {
  expect(tool.inputSchema.properties?.[property]).toMatchObject(expected);
}

function expectNoInternalFields(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("request_ciphertext");
  expect(serialized).not.toContain("request_digest");
  expect(serialized).not.toContain("harness_agent_id");
  expect(serialized).not.toContain("database_id");
  expect(serialized).not.toContain("connector_credentials");
  expect(serialized).not.toContain("/Users/secret");
}

describe("MCP public tool contract", () => {
  it("exposes exactly the seven public tools through the official SDK transport", async () => {
    const connection = await connectedClient(fakeCoordinator());
    try {
      const result = await connection.client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(new Set(result.tools.map((tool) => tool.name)).size).toBe(7);
      for (const tool of result.tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
    } finally {
      await closeConnection(connection);
    }
  });

  it("advertises exact bounded output object shapes", async () => {
    const connection = await connectedClient(fakeCoordinator());
    try {
      const tools = asToolMap((await connection.client.listTools()).tools);
      expect(tools.get("submit_task")?.outputSchema?.required).toEqual([
        "job_id",
        "short_id",
        "status",
        "connector_status",
        "accepted_at",
        "expires_at",
      ]);
      expect(
        tools.get("list_tasks")?.outputSchema?.properties?.tasks,
      ).toMatchObject({ type: "array", maxItems: 5 });
      expect(
        tools.get("get_task")?.outputSchema?.properties?.recent_events,
      ).toMatchObject({ type: "array", maxItems: 5 });
      expect(
        tools.get("list_pending_approvals")?.outputSchema?.properties
          ?.approvals,
      ).toMatchObject({ type: "array", maxItems: 5 });
      expect(
        tools.get("get_task_result")?.outputSchema?.properties?.artifacts,
      ).toMatchObject({ type: "array", maxItems: 5 });
      expect(tools.get("cancel_task")?.outputSchema?.required).toEqual([
        "job_id",
        "status",
        "revision",
      ]);
      expect(tools.get("decide_approval")?.outputSchema?.required).toEqual([
        "approval_id",
        "decision",
        "revision",
      ]);
    } finally {
      await closeConnection(connection);
    }
  });

  it("advertises every Task 1 input schema with its exact bounded fields", async () => {
    const connection = await connectedClient(fakeCoordinator());
    try {
      const tools = asToolMap((await connection.client.listTools()).tools);
      const submit = tools.get("submit_task");
      const list = tools.get("list_tasks");
      const get = tools.get("get_task");
      const cancel = tools.get("cancel_task");
      const approvals = tools.get("list_pending_approvals");
      const decide = tools.get("decide_approval");
      const result = tools.get("get_task_result");
      expect(
        submit && list && get && cancel && approvals && decide && result,
      ).toBeTruthy();

      expect(submit?.inputSchema.required).toEqual([
        "client_request_id",
        "repository_id",
        "request",
      ]);
      expectProperty(submit as Tool, "client_request_id", {
        type: "string",
        format: "uuid",
      });
      expectProperty(submit as Tool, "repository_id", { type: "string" });
      expectProperty(submit as Tool, "request", {
        type: "string",
        minLength: 1,
        maxLength: 4000,
      });
      expectProperty(submit as Tool, "mode", { enum: ["normal", "read_only"] });

      expect(list?.inputSchema.required ?? []).toEqual([]);
      expectProperty(list as Tool, "limit", {
        type: "integer",
        minimum: 1,
        maximum: 5,
      });
      expectProperty(list as Tool, "status", {
        enum: [
          "queued",
          "dispatched",
          "running",
          "waiting_approval",
          "cancelling",
          "succeeded",
          "failed",
          "cancelled",
          "expired",
        ],
      });
      expectProperty(list as Tool, "unread_only", { type: "boolean" });

      expect(get?.inputSchema.required).toEqual(["job_id"]);
      expectProperty(get as Tool, "job_id", { type: "string", format: "uuid" });
      expect(cancel?.inputSchema.required).toEqual([
        "job_id",
        "expected_revision",
      ]);
      expectProperty(cancel as Tool, "expected_revision", {
        type: "integer",
        minimum: 0,
      });
      expect(approvals?.inputSchema.required ?? []).toEqual([]);
      expectProperty(approvals as Tool, "limit", {
        type: "integer",
        minimum: 1,
        maximum: 5,
      });
      expect(decide?.inputSchema.required).toEqual([
        "approval_id",
        "decision",
        "expected_job_revision",
      ]);
      expectProperty(decide as Tool, "approval_id", {
        type: "string",
        format: "uuid",
      });
      expectProperty(decide as Tool, "decision", {
        enum: ["approve", "reject"],
      });
      expectProperty(decide as Tool, "expected_job_revision", {
        type: "integer",
        minimum: 0,
      });
      expect(result?.inputSchema.required).toEqual(["job_id"]);
      expectProperty(result as Tool, "job_id", {
        type: "string",
        format: "uuid",
      });
    } finally {
      await closeConnection(connection);
    }
  });

  it("parses each Task 1 input schema before invoking the coordinator", async () => {
    const coordinator = fakeCoordinator();
    const connection = await connectedClient(coordinator);
    const invalidInputs: Record<string, Record<string, unknown>> = {
      submit_task: { ...VALID_SUBMIT, request: "" },
      list_tasks: { limit: 6 },
      get_task: { job_id: "not-a-uuid" },
      cancel_task: { job_id: JOB_ID, expected_revision: -1 },
      list_pending_approvals: { limit: 0 },
      decide_approval: {
        approval_id: APPROVAL_ID,
        decision: "maybe",
        expected_job_revision: 0,
      },
      get_task_result: { job_id: "not-a-uuid" },
    };
    try {
      for (const name of TOOL_NAMES) {
        const result = await connection.client.callTool({
          name,
          arguments: invalidInputs[name],
        });
        expect(result.isError, name).toBe(true);
        expectNoInternalFields(result);
        expect(JSON.stringify(result)).not.toMatch(/\bat .*\.tsx?:\d+:\d+/);
      }
      expect(coordinator.calls).toHaveLength(0);
    } finally {
      await closeConnection(connection);
    }
  });

  it("returns bounded structured success content and binds every call to the owner", async () => {
    const coordinator = fakeCoordinator();
    const connection = await connectedClient(coordinator);
    const calls: Array<{
      name: (typeof TOOL_NAMES)[number];
      arguments: Record<string, unknown>;
      expected: unknown;
    }> = [
      { name: "submit_task", arguments: VALID_SUBMIT, expected: SUBMIT_RESULT },
      {
        name: "list_tasks",
        arguments: { limit: 5, unread_only: false },
        expected: LIST_RESULT,
      },
      {
        name: "get_task",
        arguments: { job_id: JOB_ID },
        expected: DETAIL_RESULT,
      },
      {
        name: "cancel_task",
        arguments: { job_id: JOB_ID, expected_revision: 0 },
        expected: CANCEL_RESULT,
      },
      {
        name: "list_pending_approvals",
        arguments: { limit: 5 },
        expected: APPROVAL_LIST_RESULT,
      },
      {
        name: "decide_approval",
        arguments: {
          approval_id: APPROVAL_ID,
          decision: "approve",
          expected_job_revision: 1,
        },
        expected: DECISION_RESULT,
      },
      {
        name: "get_task_result",
        arguments: { job_id: JOB_ID },
        expected: TASK_RESULT_OUTPUT,
      },
    ];
    try {
      for (const call of calls) {
        const result = await connection.client.callTool(call);
        expect(result.isError, call.name).not.toBe(true);
        expect(result.structuredContent, call.name).toEqual(call.expected);
        expectNoInternalFields(result.structuredContent);
      }
      expect(coordinator.calls).toHaveLength(7);
      expect(coordinator.calls.map((call) => call.method)).toEqual([
        "submit",
        "list",
        "get",
        "cancel",
        "listApprovals",
        "decideApproval",
        "getResult",
      ]);
      expect(
        coordinator.calls.every(
          (call) =>
            JSON.stringify(call.owner) === JSON.stringify({ id: OWNER_ID }),
        ),
      ).toBe(true);
    } finally {
      await closeConnection(connection);
    }
  });

  it("maps DomainError to a stable redacted MCP error", async () => {
    const sensitive = "raw prompt /Users/secret/repo credential=do-not-return";
    const coordinator = fakeCoordinator({
      get: async () => {
        throw new DomainError("JOB_NOT_FOUND", sensitive);
      },
    });
    const connection = await connectedClient(coordinator);
    try {
      const result = await connection.client.callTool({
        name: "get_task",
        arguments: { job_id: JOB_ID },
      });
      const serialized = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_FOUND" },
      });
      expect(serialized).not.toContain(sensitive);
      expect(serialized).not.toContain("stack");
      expect(serialized).not.toMatch(/\bat .*\.tsx?:\d+:\d+/);
    } finally {
      await closeConnection(connection);
    }
  });

  it("keeps submit_task below the two-second service budget", async () => {
    const connection = await connectedClient(fakeCoordinator());
    try {
      const started = performance.now();
      const result = await connection.client.callTool({
        name: "submit_task",
        arguments: VALID_SUBMIT,
      });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.structuredContent).toMatchObject({ status: "queued" });
    } finally {
      await closeConnection(connection);
    }
  });

  it("fails a blocked coordinator call before the two-second server budget", async () => {
    const coordinator = fakeCoordinator({
      submit: async () => new Promise(() => undefined),
    });
    const connection = await connectedClient(coordinator);
    try {
      const started = performance.now();
      const result = await connection.client.callTool({
        name: "submit_task",
        arguments: VALID_SUBMIT,
      });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "TASK_TIMEOUT" },
      });
    } finally {
      await closeConnection(connection);
    }
  });

  it("fails closed on deeply nested unexpected coordinator output", async () => {
    let nested: Record<string, unknown> = {
      credential: "do-not-return-this-secret",
      path: "/Users/secret/private.key",
    };
    for (let depth = 0; depth < 12; depth += 1) nested = { child: nested };
    const coordinator = fakeCoordinator({
      get: async () => ({ ...DETAIL_RESULT, debug: nested }),
    });
    const connection = await connectedClient(coordinator);
    try {
      const result = await connection.client.callTool({
        name: "get_task",
        arguments: { job_id: JOB_ID },
      });
      const serialized = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(serialized).not.toContain("do-not-return-this-secret");
      expect(serialized).not.toContain("/Users/secret");
    } finally {
      await closeConnection(connection);
    }
  });

  it("recursively redacts sensitive keys, secret values, paths, and bounds output", () => {
    const value = {
      password: "nested-password",
      token: "nested-token",
      secret: "nested-secret",
      api_key: "nested-api-key",
      harness_agent_id: "internal-agent-id",
      path: "/Users/secret/private.key",
      nested: {
        credentials: {
          password: "deep-password",
          token: "deep-token",
        },
        text: "password=deep-text-password token=deep-text-token",
      },
      items: Array.from({ length: 8 }, (_, index) => ({ index })),
    };

    const sanitized = sanitizePublicValue(value);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("nested-password");
    expect(serialized).not.toContain("nested-token");
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("nested-api-key");
    expect(serialized).not.toContain("internal-agent-id");
    expect(serialized).not.toContain("/Users/secret");
    expect(serialized).not.toContain("deep-password");
    expect(serialized).not.toContain("deep-text-password");
    expect((sanitized as { items: unknown[] }).items).toHaveLength(5);
  });

  it("allows an identical decide_approval retry after the first call times out", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markFirstDecisionPersisted!: () => void;
    const firstDecisionPersisted = new Promise<void>((resolve) => {
      markFirstDecisionPersisted = resolve;
    });
    let persisted = false;
    const coordinator = fakeCoordinator({
      decideApproval: async () => {
        if (!persisted) {
          await pending;
          persisted = true;
          markFirstDecisionPersisted();
        }
        return DECISION_RESULT;
      },
    });
    const connection = await connectedClient(coordinator);
    const decision = {
      name: "decide_approval" as const,
      arguments: {
        approval_id: APPROVAL_ID,
        decision: "approve" as const,
        expected_job_revision: 1,
      },
    };
    try {
      const first = await connection.client.callTool(decision);
      expect(first.isError).toBe(true);
      expect(first.structuredContent).toMatchObject({
        error: { code: "TASK_TIMEOUT" },
      });

      setTimeout(release, 50);
      await firstDecisionPersisted;
      const retry = await connection.client.callTool(decision);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toEqual(DECISION_RESULT);
      expect(
        coordinator.calls.filter((call) => call.method === "decideApproval"),
      ).toHaveLength(2);
    } finally {
      release();
      await closeConnection(connection);
    }
  });
});

// Keep the protocol schemas referenced in this contract so schema drift cannot
// be hidden by a hand-written JSON Schema in the MCP adapter.
void [
  SubmitTaskInputSchema,
  ListTasksInputSchema,
  GetTaskInputSchema,
  CancelTaskInputSchema,
  ListPendingApprovalsInputSchema,
  DecideApprovalInputSchema,
  GetTaskResultInputSchema,
];
