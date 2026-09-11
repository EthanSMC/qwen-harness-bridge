import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import { RemoteApprovalBroker } from "./approvals/approval-broker.js";
import { parsePluginConfig } from "./config.js";
import { MacOSKeychainCredentialReader } from "./keychain.js";
import { CancelHandler } from "./runtime/cancel-handler.js";
import { JobCommandCoordinator } from "./runtime/job-command-coordinator.js";
import { JobStateClient } from "./runtime/job-state-client.js";
import { OwnedAgentDriver } from "./runtime/owned-agent-driver.js";
import { createPluginComposition } from "./runtime/plugin-composition.js";
import { TerminalAuthorityIssuer } from "./runtime/terminal-authority.js";
import { SqlitePluginStore } from "./store/plugin-store.js";
import { DurableConnectorClient } from "./transport/connector-client.js";
import { HttpsSessionTokenClient } from "./transport/session-token-client.js";

// Cordis plugin identity.
export const name = "qwen-harness-bridge";
export const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
  "approval",
] as const;

export * from "./config.js";
export {
  AgentAdapter,
  HarnessAgentAdapterImpl,
} from "./harness/agent-adapter.js";
export type { NormalizationOptions } from "./harness/event-normalizer.js";
export {
  MAX_SUMMARY_LENGTH,
  normalizeSessionEvent,
  normalizeTerminalEvent,
} from "./harness/event-normalizer.js";
export { registerSessionListener } from "./harness/register-session-listener.js";
export type {
  HarnessAdapterOptions,
  HarnessAgent,
  HarnessAgentAdapter,
  HarnessAgentRegistry,
  HarnessContext,
  HarnessMappingStore,
  HarnessSessionEventHandler,
  NormalizedHarnessEvent,
  OwnedSession,
} from "./harness/types.js";
export * from "./keychain.js";
export * from "./store/plugin-store.js";

/** Derive the HTTPS bootstrap-token endpoint from the configured WebSocket
 * address. The Control Plane serves the exchange at `/connector/v1/session`
 * and `HttpsSessionTokenClient` appends the trailing `/session`. */
function sessionEndpoint(controlPlaneUrl: `wss://${string}`): string {
  const url = new URL(controlPlaneUrl);
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Compose the durable outbound Connector under the Cordis fiber. Configuration
 * is validated before any effect. This release supports exactly one configured
 * repository root so that outbound redaction has one canonical authority; more
 * than one fails closed until per-job redaction is specified.
 *
 * Approval reservations are not yet wired to a live-state revision, so
 * `approval_required` actions fail closed until that integration lands. */
export function apply(ctx: Context, config?: unknown): void {
  const parsed = parsePluginConfig(config ?? {});
  if (parsed.repositories.length !== 1)
    throw new Error("MULTI_REPOSITORY_UNSUPPORTED");
  const repository = parsed.repositories[0];
  const store = new SqlitePluginStore(parsed.databasePath);
  const credentials = new MacOSKeychainCredentialReader();
  const tokenClient = new HttpsSessionTokenClient({
    endpoint: sessionEndpoint(parsed.controlPlaneUrl),
    credentialId: parsed.keychainAccount,
  });
  const connector = new DurableConnectorClient({
    connectorId: parsed.connectorId,
    controlPlaneUrl: parsed.controlPlaneUrl,
    store,
    requireJobCoordination: true,
    requireOwnedTerminal: true,
    redaction: {
      repositoryRoot: repository.canonicalPath,
      homeDirectory: homedir(),
    },
    sessionTokenClient: tokenClient,
    bootstrapCredentialProvider: () =>
      credentials.read(parsed.keychainService, parsed.keychainAccount),
  });
  const states = new JobStateClient({ connector });
  const authority = new TerminalAuthorityIssuer({ connector, states, store });
  const repositories = {
    resolve: (id: string): string | undefined =>
      parsed.repositories.find((candidate) => candidate.id === id)
        ?.canonicalPath,
  };
  const driver = new OwnedAgentDriver({
    agents: ctx.agents,
    store,
    states,
    authority,
    terminal: connector,
    epoch: () => connector.currentEpoch(),
    repositories,
    publishClaim: async (offer) => {
      await connector.publish(
        "job.claim",
        {
          job_id: offer.payload.job_id,
          attempt: offer.payload.attempt,
          lease_id: offer.payload.lease_id,
        },
        randomUUID(),
      );
    },
    flush: (session) => ctx.sessions.flush(session),
  });
  const approvals = new RemoteApprovalBroker({
    reserve: () => undefined,
    publish: (type, payload, correlationId) =>
      connector.publish(type, payload, correlationId),
  });
  const cancelHandler = new CancelHandler({
    resolveOwner: (command) => driver.cancellationOwner(command),
    beforeCancel: (owner) => driver.beginCancellation(owner),
  });
  const coordinator = new JobCommandCoordinator({
    starter: driver,
    cancel: {
      handle: async (command) => {
        await driver.admitCancellation(command);
        return cancelHandler.handle(command);
      },
    },
    approvals,
    repositories,
  });
  const composition = createPluginComposition({
    coordinator,
    connector,
    approvals,
    driver,
    store,
    report: () => undefined,
  });
  ctx.effect(() => {
    composition.connect();
    return () => composition.dispose();
  });
}
