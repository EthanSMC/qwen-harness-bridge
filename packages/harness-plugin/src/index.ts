import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { RemoteApprovalBroker } from "./approvals/approval-broker.js";
import { registerAnswerer } from "./approvals/register-answerer.js";
import { parsePluginConfig } from "./config.js";
import { MacOSKeychainCredentialReader } from "./keychain.js";
import { classifyAction } from "./policy/action-classifier.js";
import { createPolicyAgentSetup } from "./policy/register-guard.js";
import { createTrustedExecutionAdapter } from "./policy/trusted-execution-adapter.js";
import { TrustedActionRegistry } from "./runtime/action-registry.js";
import { ApprovalReservationProvider } from "./runtime/approval-reservation.js";
import { CancelHandler } from "./runtime/cancel-handler.js";
import { JobCommandCoordinator } from "./runtime/job-command-coordinator.js";
import { JobStateClient } from "./runtime/job-state-client.js";
import { LiveStateRegistry } from "./runtime/live-state-registry.js";
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
  "tools",
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
export function sessionEndpoint(controlPlaneUrl: `wss://${string}`): string {
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
  const liveStates = new LiveStateRegistry({ connector });
  const actions = new TrustedActionRegistry();
  const policyOptions = {
    repositories: parsed.repositories.map((candidate) => ({
      id: candidate.id,
      canonicalPath: candidate.canonicalPath,
    })),
  };
  const authority = new TerminalAuthorityIssuer({ connector, states, store });
  const reservation = new ApprovalReservationProvider({
    registry: liveStates,
    states,
    epoch: () => connector.currentEpoch(),
    approvalTimeoutSeconds: (repositoryId) =>
      parsed.repositories.find((candidate) => candidate.id === repositoryId)
        ?.approvalTimeoutSeconds,
  });
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
    onAttemptEnded: (agent) => actions.withdraw(agent),
    setupFactory: (sessionId, context) => {
      const adapter = createTrustedExecutionAdapter({
        repositoryId: context.repositoryId,
        repositoryRoot: context.repositoryPath,
      });
      const scoped = {
        repositories: [
          { id: context.repositoryId, canonicalPath: context.repositoryPath },
        ],
      };
      return createPolicyAgentSetup({
        agentId: sessionId,
        ...scoped,
        resolveAction: (execution) => {
          const resolved = adapter(execution);
          if (resolved === undefined) return undefined;
          const full = execution as unknown as {
            agent?: Agent;
            callId?: unknown;
          };
          if (full.agent !== undefined && full.callId !== undefined) {
            try {
              const decision = classifyAction(resolved.action, scoped, {
                provenance: resolved.provenance,
              });
              actions.register(full.agent, String(full.callId), {
                jobId: context.jobId,
                attempt: context.attempt,
                toolName: resolved.action.toolName,
                fingerprint: decision.fingerprint,
                classification: decision.classification,
                actionSummary: decision.actionSummary,
                impactSummary: decision.impactSummary,
              });
            } catch {
              // Registration is best effort; the guard still evaluates the call.
            }
          }
          return resolved;
        },
      });
    },
  });
  const approvals = new RemoteApprovalBroker({
    reserve: (input) => {
      const intent = store.ownedIntent(input.jobId, input.attempt);
      if (intent === undefined) return undefined;
      return reservation.reserve({
        jobId: input.jobId,
        repositoryId: intent.owner.repositoryId,
        attempt: input.attempt,
      });
    },
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
  if (Context.is(ctx)) {
    registerAnswerer(ctx, {
      broker: approvals,
      findOwner: (agentId) => actions.findOwner(agentId),
      resolveAction: (agent, callId) => actions.resolveAction(agent, callId),
      refresh: async (action) => {
        const intent = store.ownedIntent(action.jobId, action.attempt);
        if (intent === undefined) throw new Error("APPROVAL_OWNER_UNAVAILABLE");
        await reservation.refresh({
          jobId: action.jobId,
          repositoryId: intent.owner.repositoryId,
          attempt: action.attempt,
        });
      },
    });
  }
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
