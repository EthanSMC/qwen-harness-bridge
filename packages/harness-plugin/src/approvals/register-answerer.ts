import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import type {} from "@deepseek-ai/dsh-user-approval";
import type { PolicyClass } from "../policy/types.js";
import type { ApprovalBroker } from "./approval-broker.js";

/** Trusted registry projection of the canonical action for this exact Agent and
 * callId. Task 6 must populate it from local tool execution, not approval reason
 * or cloud data, and reclassify on every lookup. Retain denied monotonically.
 * The signal withdraws this execution on cancellation, ownership loss or action
 * replacement; invalidation is monotonic and it cannot be reused for another
 * execution. Lookups may synchronously revoke lifetimes, including registration
 * teardown, but must not revive previously withdrawn ownership or action authority.
 * Existing policy guard
 * remains the final per-execution one-use proof and path reclassification gate. */
export type AnswererAction = Readonly<{
  jobId: string;
  attempt: number;
  toolName: string;
  fingerprint: string;
  classification: PolicyClass;
  actionSummary: string;
  impactSummary: string;
  signal: AbortSignal;
}>;
export type AnswererOptions = Readonly<{
  broker: ApprovalBroker;
  findOwner(agentId: string): Agent | undefined;
  resolveAction(agent: Agent, callId: string): AnswererAction | undefined;
}>;

export function registerAnswerer(
  ctx: Context,
  options: AnswererOptions,
): () => void {
  if (!Context.is(ctx)) throw new Error("APPROVAL_CONTEXT_REQUIRED");
  const lifetime = new AbortController();
  const unregister = ctx.on(
    "approval/request",
    async (req, next) => {
      try {
        const owner = options.findOwner(String(req.agent.id));
        if (!owner) return next();
        if (
          owner !== req.agent ||
          owner.ctx.agent !== owner ||
          scopeOf(owner.ctx) !== owner ||
          !req.callId ||
          lifetime.signal.aborted
        )
          return "unavailable";
        const resolved = options.resolveAction(owner, req.callId);
        if (!resolved || resolved.toolName !== req.toolName)
          return "unavailable";
        const action = Object.freeze({ ...resolved });
        if (action.classification === "denied") return "rejected";
        if (
          action.classification !== "approval_required" ||
          action.signal.aborted
        )
          return "unavailable";
        const signal = AbortSignal.any([
          lifetime.signal,
          action.signal,
          ...(req.signal ? [req.signal] : []),
        ]);
        const outcome = await options.broker.request({
          jobId: action.jobId,
          attempt: action.attempt,
          fingerprint: action.fingerprint,
          actionSummary: action.actionSummary,
          impactSummary: action.impactSummary,
          riskClass: action.classification,
          signal,
        });
        const currentOwner = options.findOwner(String(owner.id));
        const current =
          outcome === "allowed-once" && currentOwner === owner
            ? options.resolveAction(owner, req.callId)
            : undefined;
        // All registry callbacks finish before passive validation. A later lookup
        // could revoke even a previously checked registration or scope lifetime.
        if (req.signal?.aborted) return "cancelled";
        if (
          signal.aborted ||
          currentOwner !== owner ||
          owner.ctx.agent !== owner ||
          scopeOf(owner.ctx) !== owner
        )
          return "unavailable";
        if (outcome !== "allowed-once") return outcome;
        if (
          current?.classification !== "approval_required" ||
          current.signal !== action.signal ||
          current.signal.aborted ||
          current.jobId !== action.jobId ||
          current.attempt !== action.attempt ||
          current.toolName !== action.toolName ||
          current.fingerprint !== action.fingerprint
        )
          return "unavailable";
        return "allowed-once";
      } catch {
        return req.signal?.aborted ? "cancelled" : "unavailable";
      }
    },
    { prepend: true },
  );
  return () => {
    lifetime.abort();
    unregister();
  };
}
