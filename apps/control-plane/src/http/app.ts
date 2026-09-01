import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { createMcpAuthenticator, McpAuthenticationError } from "../mcp/auth.js";
import { createMcpServer } from "../mcp/server.js";
import type { McpCoordinator } from "../mcp/tools.js";

export type CreateAppOptions = Readonly<{
  coordinator: McpCoordinator;
  ownerId: string;
  mcpBearerToken: string;
}>;

const authenticationFailure = {
  error: {
    code: "UNAUTHENTICATED",
    message: "Authentication failed.",
  },
} as const;

const internalFailure = {
  error: {
    code: "INTERNAL",
    message: "Internal error.",
  },
} as const;

const duplicateAuthorizationHeader = (
  rawHeaders: readonly string[] | undefined,
): boolean => {
  if (rawHeaders === undefined) {
    return false;
  }
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      count += 1;
    }
  }
  return count > 1;
};

export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const authenticator = createMcpAuthenticator({
    expectedToken: options.mcpBearerToken,
    ownerId: options.ownerId,
  });

  app.post("/mcp", async (request, reply) => {
    let owner: ReturnType<typeof authenticator.authenticate>;
    try {
      if (duplicateAuthorizationHeader(request.raw.rawHeaders)) {
        throw new McpAuthenticationError();
      }
      owner = authenticator.authenticate(request.headers);
    } catch {
      return reply
        .code(401)
        .type("application/json")
        .send(authenticationFailure);
    }

    const server = createMcpServer({
      coordinator: options.coordinator,
      ownerId: owner.id,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    let closed = false;

    const closeResources = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.allSettled([server.close(), transport.close()]);
    };

    const closeOnResponse = (): void => {
      void closeResources();
    };
    reply.raw.once("close", closeOnResponse);
    request.raw.once("aborted", closeOnResponse);
    transport.onclose = closeOnResponse;

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      await closeResources();
      if (!reply.sent) {
        return reply.code(500).type("application/json").send(internalFailure);
      }
    }
  });

  return app;
}
