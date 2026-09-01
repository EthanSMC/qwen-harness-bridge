import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpOwnerContext } from "./auth.js";
import { type McpCoordinator, registerMcpTools } from "./tools.js";

export type McpServerOptions = Readonly<{
  coordinator: McpCoordinator;
  ownerId: string;
}>;

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({
    name: "qwen-harness-bridge",
    version: "0.1.0",
  });
  const owner: McpOwnerContext = { id: options.ownerId };
  registerMcpTools(server, options.coordinator, owner);
  return server;
}
