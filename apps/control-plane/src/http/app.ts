import type {
  Server as HttpsServer,
  ServerOptions as HttpsServerOptions,
} from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createConnectorBootstrapAuthenticator } from "../connector/auth.js";
import {
  type ConnectorGatewayOptions,
  connectorSessionExpiry,
  createConnectorGateway,
} from "../connector/gateway.js";
import { createMcpAuthenticator, McpAuthenticationError } from "../mcp/auth.js";
import { createMcpServer } from "../mcp/server.js";
import type { McpCoordinator } from "../mcp/tools.js";
import type { ReadinessProbe } from "./health.js";
import type { MetricsRegistry } from "./metrics.js";

export type CreateAppOptions = Readonly<{
  coordinator: McpCoordinator;
  ownerId: string;
  mcpBearerToken: string;
  https: HttpsServerOptions;
  connectorGateway?: ConnectorGatewayOptions;
  readinessProbe?: ReadinessProbe;
  isDraining?: () => boolean;
  metrics?: MetricsRegistry;
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
  if (options.https === undefined) {
    throw new Error("TLS options are required for the control-plane server");
  }
  const app = Fastify({ logger: false, https: options.https });
  const authenticator = createMcpAuthenticator({
    expectedToken: options.mcpBearerToken,
    ownerId: options.ownerId,
  });
  const connectorGateway =
    options.connectorGateway === undefined
      ? undefined
      : createConnectorGateway(
          app.server as unknown as HttpsServer,
          options.connectorGateway,
        );

  if (connectorGateway !== undefined) {
    const bootstrap = createConnectorBootstrapAuthenticator({
      credentialStore: connectorGateway.store,
    });
    app.post("/connector/v1/session", async (request, reply) => {
      try {
        const body = request.body;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("invalid");
        }
        const input = body as Record<string, unknown>;
        if (
          Object.keys(input).length !== 3 ||
          typeof input.connector_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            input.connector_id,
          ) ||
          typeof input.credential_id !== "string" ||
          input.credential_id.length < 1 ||
          input.credential_id.length > 256 ||
          typeof input.credential_secret !== "string" ||
          input.credential_secret.length < 16 ||
          input.credential_secret.length > 1024
        ) {
          throw new Error("invalid");
        }
        const identity = await bootstrap.exchange({
          credentialId: input.credential_id,
          credentialSecret: input.credential_secret,
        });
        if (identity.connectorId !== input.connector_id.toLowerCase()) {
          throw new Error("invalid");
        }
        const token = connectorGateway.sessionService.issue(identity);
        const claims = connectorGateway.sessionService.verify(token);
        return reply.type("application/json").send({
          token,
          expires_at: connectorSessionExpiry(claims),
        });
      } catch {
        options.metrics?.recordError("AUTHORIZATION_FAILED");
        return reply
          .code(401)
          .type("application/json")
          .send(authenticationFailure);
      }
    });
    const closeConnectorGateway = async (): Promise<void> => {
      await connectorGateway.close(app.server as unknown as HttpsServer);
    };
    app.addHook("preClose", closeConnectorGateway);
  }

  const liveHandler = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type("application/json").send({ status: "ok" });
  app.get("/health/live", liveHandler);
  app.get("/healthz", liveHandler);

  app.get("/health/ready", async (_request, reply) => {
    if (
      options.isDraining?.() === true ||
      options.readinessProbe === undefined
    ) {
      return reply
        .code(503)
        .type("application/json")
        .send({ status: "not_ready" });
    }
    try {
      await options.readinessProbe.assertReady();
      return reply.type("application/json").send({ status: "ready" });
    } catch {
      options.metrics?.recordError("INTERNAL");
      return reply
        .code(503)
        .type("application/json")
        .send({ status: "not_ready" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    if (options.metrics === undefined) {
      return reply
        .code(503)
        .type("application/json")
        .send({ status: "unavailable" });
    }
    try {
      const body = await options.metrics.render();
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
    } catch {
      options.metrics.recordError("INTERNAL");
      return reply
        .code(503)
        .type("application/json")
        .send({ status: "unavailable" });
    }
  });

  app.post("/mcp", async (request, reply) => {
    let owner: ReturnType<typeof authenticator.authenticate>;
    try {
      if (duplicateAuthorizationHeader(request.raw.rawHeaders)) {
        throw new McpAuthenticationError();
      }
      owner = authenticator.authenticate(request.headers);
    } catch {
      options.metrics?.recordError("UNAUTHENTICATED");
      return reply
        .code(401)
        .type("application/json")
        .send(authenticationFailure);
    }

    const server = createMcpServer({
      coordinator: options.coordinator,
      ownerId: owner.id,
      metrics: options.metrics,
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
