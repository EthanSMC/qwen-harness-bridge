import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import * as https from "node:https";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../apps/control-plane/src/http/app.js";
import { createMcpAuthenticator } from "../../apps/control-plane/src/mcp/auth.js";

const OWNER_ID = "owner-contract";
const TOKEN = "qhb-contract-token-with-enough-entropy";
const MCP_URL = "/mcp";

type HeaderValue = string | readonly string[];

function authenticator(equal = nodeTimingSafeEqual) {
  return createMcpAuthenticator({
    expectedToken: TOKEN,
    ownerId: OWNER_ID,
    timingSafeEqual: equal,
  } as never);
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "initialize-contract-1",
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "qhb-contract-client", version: "1.0.0" },
    },
  };
}

function expectUnauthenticated(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected authentication to fail");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "expected authentication to fail"
    ) {
      throw error;
    }
    expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
  }
}

async function injectMcp(
  app: {
    inject(options: unknown): Promise<{ statusCode: number; body: string }>;
  },
  authorization?: HeaderValue,
): Promise<{ statusCode: number; body: string }> {
  const headers: Record<string, HeaderValue> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return app.inject({
    method: "POST",
    url: MCP_URL,
    headers,
    payload: initializeRequest(),
  });
}

describe("MCP bearer authentication", () => {
  it.each([
    ["missing", undefined],
    ["malformed", "Bearer"],
    ["wrong scheme", "Basic qhb-contract-token-with-enough-entropy"],
    ["wrong token", "Bearer wrong-token"],
    ["empty header", ""],
    ["empty bearer token", "Bearer "],
    ["duplicate headers", [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]],
  ] as const)("rejects %s directly", (_case, authorization) => {
    const auth = authenticator();
    expectUnauthenticated(() =>
      auth.authenticate(authorization === undefined ? {} : { authorization }),
    );
  });

  it("returns exactly the configured owner for one valid token", () => {
    const equal = vi.fn(nodeTimingSafeEqual);
    const result = authenticator(equal).authenticate({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(result).toEqual({ id: OWNER_ID });
    expect(equal).toHaveBeenCalledTimes(1);
    expect(equal.mock.calls[0]?.[0]).toBeInstanceOf(Buffer);
    expect(equal.mock.calls[0]?.[1]).toBeInstanceOf(Buffer);
  });

  it("does not call timingSafeEqual for a token with a different byte length", () => {
    const equal = vi.fn(nodeTimingSafeEqual);
    const auth = authenticator(equal);
    expectUnauthenticated(() =>
      auth.authenticate({ authorization: "Bearer short" }),
    );
    expect(equal).not.toHaveBeenCalled();
  });
});

describe("MCP transport authentication", () => {
  const openApps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
  });

  async function appForTest(): Promise<{
    inject(options: unknown): Promise<{ statusCode: number; body: string }>;
    ready(): Promise<void>;
    close(): Promise<void>;
  }> {
    const coordinator = {
      submit: async () => ({ status: "queued" }),
      list: async () => ({ tasks: [] }),
      get: async () => ({}),
      cancel: async () => ({}),
      listApprovals: async () => ({ approvals: [] }),
      decideApproval: async () => ({}),
      getResult: async () => ({}),
    };
    const app = await createApp({
      coordinator: coordinator as never,
      ownerId: OWNER_ID,
      mcpBearerToken: TOKEN,
      https: {},
    } as never);
    await app.ready();
    openApps.push(app);
    return app;
  }

  it.each([
    ["missing", undefined],
    ["malformed", "Bearer"],
    ["wrong scheme", "Basic qhb-contract-token-with-enough-entropy"],
    ["wrong token", "Bearer wrong-token"],
    ["empty header", ""],
    ["empty bearer token", "Bearer "],
    ["duplicate Authorization", [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]],
  ] as const)(
    "rejects %s through Fastify injection",
    async (_case, authorization) => {
      const app = await appForTest();
      const response = await injectMcp(app, authorization);
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain("UNAUTHENTICATED");
      expect(response.body).not.toMatch(/\bat .*\.tsx?:\d+:\d+/);
      expect(response.body).not.toContain(TOKEN);
    },
  );

  it("accepts one valid authenticated MCP initialize request through injection", async () => {
    const app = await appForTest();
    const response = await injectMcp(app, `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("result");
    expect(response.body).not.toContain(TOKEN);
  });

  it("rejects app construction without TLS options", async () => {
    const coordinator = {
      submit: async () => ({ status: "queued" }),
      list: async () => ({ tasks: [] }),
      get: async () => ({}),
      cancel: async () => ({}),
      listApprovals: async () => ({ approvals: [] }),
      decideApproval: async () => ({}),
      getResult: async () => ({}),
    };
    await expect(
      createApp({
        coordinator: coordinator as never,
        ownerId: OWNER_ID,
        mcpBearerToken: TOKEN,
      } as never),
    ).rejects.toThrow("TLS options are required for the control-plane server");
  });

  it("builds an HTTPS Fastify server when TLS options are supplied", async () => {
    const coordinator = {
      submit: async () => ({ status: "queued" }),
      list: async () => ({ tasks: [] }),
      get: async () => ({}),
      cancel: async () => ({}),
      listApprovals: async () => ({ approvals: [] }),
      decideApproval: async () => ({}),
      getResult: async () => ({}),
    };
    const app = await createApp({
      coordinator: coordinator as never,
      ownerId: OWNER_ID,
      mcpBearerToken: TOKEN,
      https: {},
    } as never);
    try {
      expect(app.server).toBeInstanceOf(https.Server);
    } finally {
      await app.close();
    }
  });
});
