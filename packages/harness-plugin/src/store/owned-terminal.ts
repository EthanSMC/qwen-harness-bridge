import { createHash } from "node:crypto";
import {
  type ConnectorClientMessage,
  ConnectorClientMessageSchema,
  JobEventPayloadSchema,
  JobStatePayloadSchema,
  JobSyncPayloadSchema,
} from "@qhb/protocol";
import { z } from "zod";
import {
  captureTerminalBinding,
  type TerminalAuthorityBinding,
  TerminalOperationSchema,
} from "../runtime/terminal-authority.js";
import {
  NonterminalOwnedIntentSchema,
  OwnedIntentError,
  OwnedVersionSchema,
  ownedJson,
} from "./owned-intent.js";

export type LocalTerminalBinding = TerminalAuthorityBinding & {
  operation: Exclude<
    TerminalAuthorityBinding["operation"],
    { kind: "reconcile" }
  >;
};
export type ReconciliationBinding = TerminalAuthorityBinding & {
  operation: { kind: "reconcile" };
};
export const terminalKey = (owner: TerminalAuthorityBinding["owner"]) =>
  `owned-terminal-v1:${owner.jobId}:${owner.attempt}`;
const fail = () => new OwnedIntentError("OWNED_INTENT_INVALID");

// Negative eligibility only: ownership is checked independently at insertion.
export function forbiddenOwnedGeneric(
  message: ConnectorClientMessage,
  originalPayload: unknown,
): boolean {
  const raw = originalPayload as { event_type?: unknown; payload?: unknown };
  return (
    message.type === "job.cancelled" ||
    (message.type === "job.event" &&
      (typeof raw.event_type !== "string" ||
        ![
          "stage.changed",
          "progress.updated",
          "tool.started",
          "tool.finished",
        ].includes(raw.event_type) ||
        (raw.payload !== null &&
          typeof raw.payload === "object" &&
          Object.hasOwn(raw.payload, "status"))))
  );
}

const humanText = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= 500 &&
      value.trim() === value &&
      !/[\p{Cc}\u2028\u2029]/u.test(value),
  );
const count = z.number().int().nonnegative().safe();
const minimizedProjection = z
  .object({
    summary: humanText,
    stage: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/)
      .optional(),
    changed_files: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (value) =>
              Buffer.byteLength(value, "utf8") <= 500 &&
              !/[\p{Cc}\u2028\u2029\\]|^[A-Za-z]:|^~|^file:/u.test(value) &&
              value
                .split("/")
                .every((part) => part !== "" && part !== "." && part !== ".."),
          ),
      )
      .max(50)
      .optional(),
    tests: z
      .object({ passed: count, failed: count, total: count.optional() })
      .strict()
      .refine(
        (value) =>
          Number.isSafeInteger(value.passed + value.failed) &&
          (value.total === undefined ||
            value.total >= value.passed + value.failed),
      )
      .optional(),
    artifacts: z
      .array(
        z
          .object({
            name: humanText,
            media_type: z
              .string()
              .max(127)
              .regex(
                /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i,
              ),
            url: z.string().refine((value) => {
              try {
                const url = new URL(value);
                if (url.username || url.password || url.search || url.hash)
                  return false;
                url.search = "";
                url.hash = "";
                return (
                  Buffer.byteLength(value, "utf8") <= 500 &&
                  /^https?:$/.test(url.protocol) &&
                  url.toString() === value &&
                  !/[\p{Cc}\u2028\u2029]/u.test(decodeURIComponent(value))
                );
              } catch {
                return false;
              }
            }),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict()
  .refine(
    (value) => JobEventPayloadSchema.shape.payload.safeParse(value).success,
  );

export function terminalCorrelation(input: LocalTerminalBinding): string {
  const { owner, operation } = captureTerminalBinding(input);
  if (operation.kind === "reconcile") throw fail();
  const identity =
    operation.kind === "native"
      ? operation.eventSequence
      : operation.kind === "cancel"
        ? operation.cancelRevision
        : null;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "qhb-owned-terminal-v1",
        owner.jobId,
        owner.attempt,
        owner.repositoryId,
        owner.sessionId,
        owner.ownerGeneration,
        operation.kind,
        identity,
      ]),
      "utf8",
    )
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 15) | 128;
  digest[8] = (digest[8] & 63) | 128;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const uuid = JobSyncPayloadSchema.shape.job_id;
const timestamp = JobStatePayloadSchema.innerType().shape.observed_at;
const localOperation = TerminalOperationSchema.refine(
  (value) => value.kind !== "reconcile",
);
const fields = {
  schemaVersion: z.literal(1),
  predecessor: NonterminalOwnedIntentSchema,
  committedVersion: OwnedVersionSchema,
};
export const TerminalRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...fields,
      kind: z.literal("local"),
      operation: localOperation,
      correlationId: uuid,
      type: z.enum(["job.event", "job.cancelled"]),
      payload: z.unknown(),
      status: z.enum(["succeeded", "failed", "cancelled"]),
      outbound: z
        .object({
          messageId: uuid,
          sequence: z.number().int().positive().safe(),
          sentAt: timestamp,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...fields,
      kind: z.literal("remote"),
      status: z.enum(["succeeded", "failed", "cancelled", "expired"]),
      state: JobStatePayloadSchema,
    })
    .strict(),
]);
export type TerminalRecord = z.infer<typeof TerminalRecordSchema>;
export type LocalTerminalRecord = Extract<TerminalRecord, { kind: "local" }>;
export type RemoteTerminalRecord = Extract<TerminalRecord, { kind: "remote" }>;
export type TerminalProposal = {
  binding: LocalTerminalBinding;
  correlationId: string;
  type: "job.event" | "job.cancelled";
  payload: unknown;
};
export type TerminalCommitResult =
  | { kind: "committed"; winner: LocalTerminalRecord }
  | {
      kind: "existing";
      relation: "same" | "competing";
      winner: LocalTerminalRecord;
    }
  | { kind: "remote"; record: RemoteTerminalRecord };
export type TerminalReconcileResult =
  | { kind: "reconciled"; record: RemoteTerminalRecord }
  | {
      kind: "existing";
      record: TerminalRecord;
      observedRemote: RemoteTerminalRecord["state"];
    };

// Capture every own field once, with no JSON hooks or repeated discriminator
// access. The detached graph is what all subsequent validation compares.
export function captureTerminalValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw fail();
  if (value === null || typeof value !== "object") {
    if (["function", "symbol", "bigint"].includes(typeof value)) throw fail();
    return value;
  }
  if (Object.getOwnPropertySymbols(value).length) throw fail();
  if (Array.isArray(value))
    return value.map((item) => captureTerminalValue(item, depth + 1));
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "toJSON" || key === "__proto__") throw fail();
    result[key] = captureTerminalValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
  }
  return result;
}
export function freezeTerminal<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeTerminal(child);
    Object.freeze(value);
  }
  return value;
}
export function captureTerminalProposal(
  input: TerminalProposal,
): TerminalProposal {
  try {
    const captured = captureTerminalValue(input) as TerminalProposal;
    if (
      Object.keys(captured).sort().join(",") !==
      "binding,correlationId,payload,type"
    )
      throw fail();
    const binding = captureTerminalBinding(captured.binding);
    if (binding.operation.kind === "reconcile") throw fail();
    const result = { ...captured, binding: binding as LocalTerminalBinding };
    validateTerminalProposal(result);
    return freezeTerminal(result);
  } catch {
    throw fail();
  }
}
export function validateTerminalProposal(
  proposal: TerminalProposal,
): "succeeded" | "failed" | "cancelled" {
  const { binding, type, correlationId } = proposal;
  const { operation, owner } = binding;
  if (correlationId !== terminalCorrelation(binding)) throw fail();
  const message = ConnectorClientMessageSchema.parse({
    protocol_version: "1.0",
    message_id: correlationId,
    correlation_id: correlationId,
    sequence: 1,
    sent_at: "2026-09-01T00:00:00Z",
    expires_at: "2026-09-01T00:01:00Z",
    type,
    payload: proposal.payload,
  });
  if (message.type !== "job.cancelled" && message.type !== "job.event")
    throw fail();
  if (
    message.payload.job_id !== owner.jobId ||
    message.payload.attempt !== owner.attempt ||
    ownedJson(message.payload) !== ownedJson(proposal.payload)
  )
    throw fail();
  if (operation.kind === "cancel") {
    if (
      message.type !== "job.cancelled" ||
      message.payload.reason !== "Cancelled by owner"
    )
      throw fail();
    return "cancelled";
  }
  const status = operation.kind === "native" ? operation.outcome : "failed";
  if (
    message.type !== "job.event" ||
    message.payload.event_type !== `job.${status}` ||
    message.payload.source !== "harness"
  )
    throw fail();
  if (
    operation.kind === "native" &&
    !minimizedProjection.safeParse(message.payload.payload).success
  )
    throw fail();
  if (
    operation.kind === "unavailable" &&
    ownedJson(message.payload.payload) !==
      ownedJson({ stage: "failed", summary: operation.reason })
  )
    throw fail();
  return status;
}
export function parseTerminalRecord(text: string): TerminalRecord {
  try {
    if (Buffer.byteLength(text, "utf8") > 65536) throw fail();
    const decoded: unknown = JSON.parse(text);
    const record = TerminalRecordSchema.parse(decoded);
    if (
      ownedJson(decoded) !== ownedJson(record) ||
      record.predecessor.version >= Number.MAX_SAFE_INTEGER ||
      record.committedVersion !== record.predecessor.version + 1
    )
      throw fail();
    if (record.kind === "local") {
      const { predecessor, operation } = record;
      if (
        operation.kind === "native" &&
        (predecessor.phase !== "started" ||
          predecessor.unavailable !== null ||
          !predecessor.startedEvidence ||
          operation.eventSequence < predecessor.startedEvidence.eventSequence)
      )
        throw fail();
      if (
        operation.kind === "unavailable" &&
        predecessor.unavailable !== operation.reason
      )
        throw fail();
      if (
        validateTerminalProposal({
          binding: {
            owner: record.predecessor.owner,
            expectedVersion: record.predecessor.version,
            operation: record.operation,
          },
          type: record.type,
          payload: record.payload,
          correlationId: record.correlationId,
        }) !== record.status
      )
        throw fail();
    } else {
      const { owner, mode } = record.predecessor;
      const state = record.state;
      if (
        mode === null ||
        state.mode !== mode ||
        state.job_id !== owner.jobId ||
        state.repository_id !== owner.repositoryId ||
        state.current_attempt !== owner.attempt ||
        state.requested_attempt !== owner.attempt ||
        state.status !== record.status
      )
        throw fail();
    }
    return freezeTerminal(record);
  } catch {
    throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
  }
}
