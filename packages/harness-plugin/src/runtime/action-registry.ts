import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AnswererAction } from "../approvals/register-answerer.js";
import type { PolicyClass } from "../policy/types.js";

/** Canonical facts captured by local policy evaluation for one tool call. */
export type TrustedActionRegistration = Readonly<{
  jobId: string;
  attempt: number;
  toolName: string;
  fingerprint: string;
  classification: PolicyClass;
  actionSummary: string;
  impactSummary: string;
}>;

type Entry = Readonly<{
  action: AnswererAction;
  controller: AbortController;
  token: object;
}>;

/** Per-Agent projection of the canonical action for one tool call. The
 * answerer re-reads this projection after a remote decision, so replacement and
 * withdrawal must revoke the previous signal monotonically. */
export class TrustedActionRegistry {
  readonly #owners = new Map<string, Agent>();
  readonly #actions = new Map<string, Map<string, Entry>>();

  registerOwner(agent: Agent): () => void {
    const id = String(agent.id);
    this.#owners.set(id, agent);
    return () => {
      if (this.#owners.get(id) === agent) this.#owners.delete(id);
    };
  }

  findOwner(agentId: string): Agent | undefined {
    return this.#owners.get(agentId);
  }

  withdraw(agent: Agent): void {
    const id = String(agent.id);
    if (this.#owners.get(id) === agent) this.#owners.delete(id);
    const actions = this.#actions.get(id);
    if (actions === undefined) return;
    this.#actions.delete(id);
    for (const entry of actions.values()) {
      try {
        entry.controller.abort();
      } catch {
        // Revocation stays latched.
      }
    }
  }

  register(
    agent: Agent,
    callId: string,
    input: TrustedActionRegistration,
  ): () => void {
    const id = String(agent.id);
    if (this.#owners.get(id) !== agent || callId.length === 0)
      throw new Error("ACTION_REGISTRY_OWNER_REQUIRED");
    let actions = this.#actions.get(id);
    if (actions === undefined) {
      actions = new Map();
      this.#actions.set(id, actions);
    }
    actions.get(callId)?.controller.abort();
    const controller = new AbortController();
    const token = {};
    actions.set(callId, {
      action: Object.freeze({ ...input, signal: controller.signal }),
      controller,
      token,
    });
    return () => {
      const current = this.#actions.get(id)?.get(callId);
      if (current?.token !== token) return;
      current.controller.abort();
      const remaining = this.#actions.get(id);
      remaining?.delete(callId);
      if (remaining?.size === 0) this.#actions.delete(id);
    };
  }

  resolveAction(agent: Agent, callId: string): AnswererAction | undefined {
    const entry = this.#actions.get(String(agent.id))?.get(callId);
    if (entry === undefined || entry.controller.signal.aborted)
      return undefined;
    return entry.action;
  }
}
