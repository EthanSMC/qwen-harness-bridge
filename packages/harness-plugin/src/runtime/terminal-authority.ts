import {
  ConnectorServerMessageSchema,
  type JobStatePayload,
  JobSyncPayloadSchema,
} from "@qhb/protocol";
import { z } from "zod";
import {
  type OwnedIntent,
  type OwnedIntentOwner,
  OwnedIntentOwnerSchema,
  OwnedIntentSchema,
  OwnedVersionSchema,
  ownedJson,
} from "../store/owned-intent.js";
import type { OwnedIntentPluginStore } from "../store/plugin-store.js";
import type {
  ConnectorEpoch,
  CoordinatingConnectorClient,
} from "../transport/connector-client.js";
import type { JobCancelMessage } from "./cancel-handler.js";
import {
  admitCoordinationTiming,
  admitReconciliationTiming,
  type CoordinationClockSample,
  type CoordinationTiming,
  cancellationCoordinationDeadline,
  isCoordinationTimingCurrent,
  isReconciliationTimingCurrent,
} from "./coordination-deadlines.js";
import type { JobStateClient } from "./job-state-client.js";

export const TerminalOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reconcile") }).strict(),
  z
    .object({
      kind: z.literal("native"),
      outcome: z.enum(["succeeded", "failed"]),
      eventSequence: OwnedVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel"),
      cancelRevision: z.number().int().min(0).max(2147483647),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "HARNESS_SESSION_LOST",
        "HARNESS_PERSISTENCE_UNAVAILABLE",
      ]),
    })
    .strict(),
]);
export type TerminalOperation = Readonly<
  z.infer<typeof TerminalOperationSchema>
>;
export type TerminalAuthorityBinding = {
  owner: OwnedIntentOwner;
  expectedVersion: number;
  operation: TerminalOperation;
};
declare const authorityBrand: unique symbol;
/** Only the private registry grants authority; casts, copies and JSON cannot. */
export type TerminalAuthority = Readonly<{ [authorityBrand]: true }>;
export type TerminalAuthoritySnapshot = Readonly<{
  binding: Readonly<TerminalAuthorityBinding>;
  state: Readonly<JobStatePayload>;
}>;
type ErrorCode =
  | "TERMINAL_AUTHORITY_INVALID"
  | "TERMINAL_AUTHORITY_UNAVAILABLE"
  | "TERMINAL_AUTHORITY_REVOKED";
export class TerminalAuthorityError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "TerminalAuthorityError";
  }
}
const invalid = () => new TerminalAuthorityError("TERMINAL_AUTHORITY_INVALID");
const unavailable = () =>
  new TerminalAuthorityError("TERMINAL_AUTHORITY_UNAVAILABLE");
const revoked = () => new TerminalAuthorityError("TERMINAL_AUTHORITY_REVOKED");

// Detach declared graphs before parsing: discriminator/getter reads cannot
// change values between validation and retention.
function fields(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  if (Object.keys(value).some((key) => !names.includes(key))) throw invalid();
  const captured: Record<string, unknown> = {};
  for (const name of names)
    if (name in value)
      captured[name] = (value as Record<string, unknown>)[name];
  return captured;
}
export function captureTerminalBinding(
  input: TerminalAuthorityBinding,
): Readonly<TerminalAuthorityBinding> {
  try {
    const owner = input.owner;
    const version = input.expectedVersion;
    const operation = input.operation;
    return Object.freeze({
      owner: Object.freeze(
        OwnedIntentOwnerSchema.parse(
          fields(owner, [
            "jobId",
            "attempt",
            "repositoryId",
            "sessionId",
            "ownerGeneration",
          ]),
        ),
      ),
      expectedVersion: OwnedVersionSchema.parse(version),
      operation: Object.freeze(
        TerminalOperationSchema.parse(
          fields(operation, [
            "kind",
            "outcome",
            "eventSequence",
            "cancelRevision",
            "reason",
          ]),
        ),
      ),
    });
  } catch {
    throw invalid();
  }
}
function captureCommand(value: unknown): JobCancelMessage {
  const command = fields(value, [
    "protocol_version",
    "type",
    "message_id",
    "sequence",
    "correlation_id",
    "sent_at",
    "expires_at",
    "payload",
  ]);
  command.payload = fields(command.payload, [
    "job_id",
    "attempt",
    "job_revision",
    "reason",
    "nonce",
  ]);
  const parsed = ConnectorServerMessageSchema.parse(command);
  if (parsed.type !== "job.cancel") throw invalid();
  Object.freeze(parsed.payload);
  return Object.freeze(parsed);
}
function sampleClock(
  clock: () => CoordinationClockSample,
): CoordinationClockSample {
  const value = clock();
  if (
    value === null ||
    typeof value !== "object" ||
    ("then" in value && typeof value.then === "function")
  )
    throw revoked();
  const wallTimeMs = value.wallTimeMs;
  const monotonicTimeMs = value.monotonicTimeMs;
  if (!Number.isFinite(wallTimeMs) || !Number.isFinite(monotonicTimeMs))
    throw revoked();
  return { wallTimeMs, monotonicTimeMs };
}
type Lifetime = {
  connector: CoordinatingConnectorClient;
  clock: () => CoordinationClockSample;
  controller: AbortController;
};
type Capability = {
  lifetime: Lifetime;
  signal: AbortSignal;
  epoch: ConnectorEpoch;
  epochSignal: AbortSignal;
  snapshot: TerminalAuthoritySnapshot;
  bindingKey: string;
  timing: CoordinationTiming;
  commandDeadline: number | undefined;
  lastMonotonic: number;
  admitted: boolean;
  revoked: boolean;
};
const capabilities = new WeakMap<TerminalAuthority, Capability>();
function checkLifetime(value: Capability): void {
  // Composition getters may end lifetimes: inspect signals after currentEpoch.
  const current = value.lifetime.connector.currentEpoch();
  const epochSignal = value.epoch.signal;
  if (
    value.revoked ||
    current !== value.epoch ||
    epochSignal !== value.epochSignal ||
    !(epochSignal instanceof AbortSignal) ||
    epochSignal.aborted ||
    value.signal.aborted ||
    value.lifetime.controller.signal.aborted
  )
    throw revoked();
}
function checkCurrent(value: Capability, snapshot: boolean): void {
  checkLifetime(value);
  const now = sampleClock(value.lifetime.clock);
  if (
    now.monotonicTimeMs < value.lastMonotonic ||
    !(value.snapshot.binding.operation.kind === "reconcile"
      ? isReconciliationTimingCurrent(value.timing, now)
      : isCoordinationTimingCurrent(value.timing, now, {
          snapshot,
          lease: false,
        })) ||
    (value.commandDeadline !== undefined &&
      now.monotonicTimeMs >= value.commandDeadline)
  )
    throw revoked();
  checkLifetime(value);
  // A reentrant epoch getter may have successfully sampled a later time.
  if (now.monotonicTimeMs < value.lastMonotonic) throw revoked();
  value.lastMonotonic = now.monotonicTimeMs;
}
function check(
  authority: TerminalAuthority,
  binding: TerminalAuthorityBinding,
  begin: boolean,
): TerminalAuthoritySnapshot {
  const value = capabilities.get(authority);
  if (!value) throw invalid();
  try {
    if (value.revoked) throw revoked();
    if (ownedJson(captureTerminalBinding(binding)) !== value.bindingKey)
      throw invalid();
    if (!begin && !value.admitted) throw revoked();
    checkCurrent(value, !value.admitted);
    value.admitted = true;
    return value.snapshot;
  } catch {
    value.revoked = true;
    throw revoked();
  }
}
/** Call synchronously immediately before the first native cancellation effect or
 * dedicated terminal transaction. A token proves no native event persistence,
 * flush, idle or drain: the driver must establish that evidence separately.
 * Never await issue() inside serialized transport onCommand intake.
 */
export function beginTerminalAuthority(
  authority: TerminalAuthority,
  binding: TerminalAuthorityBinding,
): TerminalAuthoritySnapshot {
  return check(authority, binding, true);
}
/** Writer-lock/pre-commit fence. No storage, publication, scheduling, user
 * predicates or refreshed deadlines. The frozen result is historical context,
 * never a transferable capability.
 */
export function assertTerminalAuthority(
  authority: TerminalAuthority,
  binding: TerminalAuthorityBinding,
): TerminalAuthoritySnapshot {
  return check(authority, binding, false);
}

function eligible(record: OwnedIntent, operation: TerminalOperation): boolean {
  if (operation.kind === "reconcile") return record.mode !== null;
  if (record.phase === "terminal") return false;
  if (operation.kind === "cancel") return true;
  if (operation.kind === "unavailable")
    return record.unavailable === operation.reason;
  return (
    record.phase === "started" &&
    record.unavailable === null &&
    record.startedEvidence !== null &&
    operation.eventSequence >= record.startedEvidence.eventSequence
  );
}
function stateEligible(
  state: JobStatePayload,
  record: OwnedIntent,
  operation: TerminalOperation,
  command: JobCancelMessage | undefined,
): boolean {
  if (
    state.current_attempt !== record.owner.attempt ||
    (record.mode !== null && record.mode !== state.mode)
  )
    return false;
  if (operation.kind === "reconcile")
    return (
      record.mode !== null &&
      ["succeeded", "failed", "cancelled", "expired"].includes(state.status)
    );
  if (operation.kind === "cancel")
    return (
      state.status === "cancelling" &&
      state.cancel_revision === operation.cancelRevision &&
      command?.payload.job_revision === operation.cancelRevision &&
      command.payload.job_id === record.owner.jobId &&
      command.payload.attempt === record.owner.attempt
    );
  return (
    state.status === "running" ||
    state.status === "cancelling" ||
    (state.status === "waiting_approval" &&
      (operation.kind === "unavailable" || operation.outcome === "failed"))
  );
}

/** One issuer consumes the composition's existing bounded registry and journal.
 * Issuance observes state; begin is still required before any effect. The signal
 * must survive normal-work fencing and end permanently with this operation.
 */
export class TerminalAuthorityIssuer {
  readonly #lifetime: Lifetime;
  readonly #states: JobStateClient;
  readonly #store: OwnedIntentPluginStore;
  #removeParent: (() => void) | undefined;
  constructor(
    options: Readonly<{
      connector: CoordinatingConnectorClient;
      states: JobStateClient;
      store: OwnedIntentPluginStore;
      clock?: () => CoordinationClockSample;
      signal?: AbortSignal;
    }>,
  ) {
    try {
      const connector = options.connector;
      const states = options.states;
      const store = options.store;
      const clock = options.clock;
      const signal = options.signal;
      if (
        !connector ||
        typeof connector.currentEpoch !== "function" ||
        typeof connector.publishSync !== "function" ||
        typeof connector.onState !== "function" ||
        !states ||
        typeof states.observe !== "function" ||
        !store ||
        typeof store.ownedIntent !== "function" ||
        (clock !== undefined && typeof clock !== "function") ||
        (signal !== undefined && !(signal instanceof AbortSignal))
      )
        throw invalid();
      this.#states = states;
      this.#store = store;
      this.#lifetime = {
        connector,
        clock:
          clock ??
          (() => ({
            wallTimeMs: Date.now(),
            monotonicTimeMs: performance.now(),
          })),
        controller: new AbortController(),
      };
      if (signal) {
        const abort = () => this.#stop();
        this.#removeParent = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) this.#stop();
      }
    } catch {
      try {
        this.#removeParent?.();
      } catch {
        /* Fixed constructor failure. */
      }
      throw invalid();
    }
  }
  async issue(
    input: TerminalAuthorityBinding & {
      signal: AbortSignal;
      command?: JobCancelMessage;
    },
  ): Promise<TerminalAuthority> {
    let code: ErrorCode = "TERMINAL_AUTHORITY_INVALID";
    let signal: AbortSignal | undefined;
    const removals: (() => void)[] = [];
    try {
      const binding = captureTerminalBinding(input);
      signal = input.signal;
      const commandInput = input.command;
      if (!(signal instanceof AbortSignal)) throw invalid();
      if (
        (binding.operation.kind === "cancel") !==
        (commandInput !== undefined)
      )
        throw invalid();
      const command =
        commandInput === undefined ? undefined : captureCommand(commandInput);
      if (signal.aborted || this.#lifetime.controller.signal.aborted)
        throw revoked();
      code = "TERMINAL_AUTHORITY_UNAVAILABLE";
      const owner = binding.owner;
      const before = OwnedIntentSchema.parse(
        this.#store.ownedIntent(owner.jobId, owner.attempt),
      );
      if (
        ownedJson(before.owner) !== ownedJson(owner) ||
        before.version !== binding.expectedVersion ||
        !eligible(before, binding.operation)
      )
        throw unavailable();
      const predecessor = ownedJson(before);
      const pending = new AbortController();
      for (const source of [signal, this.#lifetime.controller.signal]) {
        const abort = () => pending.abort();
        removals.push(() => source.removeEventListener("abort", abort));
        source.addEventListener("abort", abort, { once: true });
        if (source.aborted) pending.abort();
      }
      const exchange = await this.#states.observe({
        jobId: owner.jobId,
        repositoryId: owner.repositoryId,
        attempt: owner.attempt,
        signal: pending.signal,
      });
      const envelope = ConnectorServerMessageSchema.parse(exchange.state);
      if (envelope.type !== "job.state") throw unavailable();
      const state = envelope.payload;
      const request = exchange.request;
      const epoch = exchange.epoch;
      const epochSignal = epoch.signal;
      if (
        !(epochSignal instanceof AbortSignal) ||
        epochSignal.aborted ||
        request.epoch !== epoch ||
        epoch !== this.#lifetime.connector.currentEpoch() ||
        !JobSyncPayloadSchema.shape.nonce.safeParse(request.messageId)
          .success ||
        !Number.isSafeInteger(request.sequence) ||
        request.sequence < 1 ||
        request.messageId !== state.request_message_id ||
        request.sequence !== state.request_sequence ||
        request.nonce !== state.nonce ||
        request.correlationId !== envelope.correlation_id ||
        request.jobId !== owner.jobId ||
        request.attempt !== owner.attempt ||
        state.job_id !== owner.jobId ||
        state.repository_id !== owner.repositoryId ||
        state.requested_attempt !== owner.attempt ||
        !stateEligible(state, before, binding.operation, command)
      )
        throw unavailable();
      const timing = (
        binding.operation.kind === "reconcile"
          ? admitReconciliationTiming
          : admitCoordinationTiming
      )(state, exchange.sent, exchange.received);
      if (!timing) throw unavailable();
      const commandDeadline =
        command === undefined
          ? undefined
          : cancellationCoordinationDeadline(timing, command.expires_at);
      if (command !== undefined && commandDeadline === undefined)
        throw unavailable();
      const value: Capability = {
        lifetime: this.#lifetime,
        signal,
        epoch,
        epochSignal,
        snapshot: Object.freeze({ binding, state: Object.freeze(state) }),
        bindingKey: ownedJson(binding),
        timing,
        commandDeadline,
        lastMonotonic: timing.received.monotonicTimeMs,
        admitted: false,
        revoked: false,
      };
      checkCurrent(value, true);
      const after = OwnedIntentSchema.parse(
        this.#store.ownedIntent(owner.jobId, owner.attempt),
      );
      if (ownedJson(after) !== predecessor) throw unavailable();
      checkLifetime(value);
      const token = Object.freeze({}) as TerminalAuthority;
      capabilities.set(token, value);
      return token;
    } catch {
      try {
        if (
          (signal instanceof AbortSignal && signal.aborted) ||
          this.#lifetime.controller.signal.aborted
        )
          code = "TERMINAL_AUTHORITY_REVOKED";
      } catch {
        /* Invalid dependency access cannot replace the bounded error. */
      }
      throw new TerminalAuthorityError(code);
    } finally {
      for (const remove of removals) {
        try {
          remove();
        } catch {
          /* No dependency diagnostics escape. */
        }
      }
    }
  }
  dispose(): void {
    this.#stop();
  }
  #stop(): void {
    this.#lifetime.controller.abort();
    const remove = this.#removeParent;
    this.#removeParent = undefined;
    try {
      remove?.();
    } catch {
      /* Termination stays latched. */
    }
  }
}
