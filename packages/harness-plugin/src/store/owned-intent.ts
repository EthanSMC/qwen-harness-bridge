import { createHash } from "node:crypto";
import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
  JobStatePayloadSchema,
  JobSyncPayloadSchema,
  RepositoryIdSchema,
} from "@qhb/protocol";
import { z } from "zod";

const uuid = JobSyncPayloadSchema.shape.job_id;
const timestamp = JobStatePayloadSchema.innerType().shape.observed_at;
export const OwnedAttemptSchema = z.number().int().min(1).max(2147483647);
export const OwnedVersionSchema = z.number().int().nonnegative().safe();
const messageId = z.string().refine((value) => {
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes >= 1 &&
    bytes <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mode = z.enum(["normal", "read_only"]);
const unavailable = z.enum([
  "HARNESS_SESSION_LOST",
  "HARNESS_PERSISTENCE_UNAVAILABLE",
]);
export const OwnedIntentOwnerSchema = z
  .object({
    jobId: uuid,
    attempt: OwnedAttemptSchema,
    repositoryId: RepositoryIdSchema,
    sessionId: uuid,
    ownerGeneration: uuid,
  })
  .strict();
const evidence = z
  .object({
    sessionId: uuid,
    messageId,
    requestDigest: digest,
    eventSequence: OwnedVersionSchema,
  })
  .strict();

export const OwnedIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: OwnedIntentOwnerSchema,
    leaseId: uuid,
    offer: z
      .object({
        messageId: uuid,
        sequence: z.number().int().positive().safe(),
        correlationId: uuid,
        sentAt: timestamp,
        expiresAt: timestamp,
      })
      .strict(),
    initialMessageId: messageId,
    requestDigest: digest,
    phase: z.enum(["prepared", "creating", "submitting", "started"]),
    version: OwnedVersionSchema,
    mode: mode.nullable(),
    startedEvidence: evidence.nullable(),
    unavailable: unavailable.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.phase === "prepared"
        ? value.mode === null && value.startedEvidence === null
        : value.mode !== null &&
          (value.phase === "started"
            ? value.startedEvidence !== null &&
              value.startedEvidence.sessionId === value.owner.sessionId &&
              value.startedEvidence.messageId === value.initialMessageId &&
              value.startedEvidence.requestDigest === value.requestDigest
            : value.startedEvidence === null);
    if (!valid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid phase relationships",
      });
    // Reuse the protocol's full envelope calendar/expiry validation without
    // retaining a request body in the journal.
    if (
      !ConnectorServerMessageSchema.safeParse({
        protocol_version: "1.0",
        type: "job.offer",
        message_id: value.offer.messageId,
        sequence: value.offer.sequence,
        correlation_id: value.offer.correlationId,
        sent_at: value.offer.sentAt,
        expires_at: value.offer.expiresAt,
        payload: {
          job_id: value.owner.jobId,
          attempt: value.owner.attempt,
          repository_id: value.owner.repositoryId,
          lease_id: value.leaseId,
          request: "identity validation",
        },
      }).success
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid offer identity",
      });
  });

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};
export type OwnedIntentOwner = Readonly<z.infer<typeof OwnedIntentOwnerSchema>>;
export type OwnedIntent = Readonly<
  Omit<z.infer<typeof OwnedIntentSchema>, "owner" | "offer" | "startedEvidence">
> & {
  readonly owner: OwnedIntentOwner;
  readonly offer: DeepReadonly<z.infer<typeof OwnedIntentSchema>["offer"]>;
  readonly startedEvidence: Readonly<z.infer<typeof evidence>> | null;
};
export const OwnedTransitionSchema = z.union([
  z.object({ phase: z.literal("creating"), mode }).strict(),
  z.object({ phase: z.literal("submitting") }).strict(),
  z.object({ phase: z.literal("started"), evidence }).strict(),
  z.object({ unavailable }).strict(),
]);
export type OwnedIntentTransition = z.infer<typeof OwnedTransitionSchema>;
export type PrepareOwnedIntentInput = {
  offer: Extract<ConnectorServerMessage, { type: "job.offer" }>;
  sessionId: string;
  initialMessageId: string;
  ownerGeneration: string;
};
export const PrepareOwnedIntentSchema = z
  .object({
    offer: ConnectorServerMessageSchema.refine(
      (value) => value.type === "job.offer",
    ),
    sessionId: uuid,
    initialMessageId: messageId,
    ownerGeneration: uuid,
  })
  .strict();

export class OwnedIntentError extends Error {
  constructor(
    readonly code:
      | "OWNED_INTENT_INVALID"
      | "OWNED_INTENT_CONFLICT"
      | "OWNED_INTENT_UNAVAILABLE"
      | "OWNED_INTENT_CORRUPT",
  ) {
    super(code);
    this.name = "OwnedIntentError";
  }
}

export function captureOwned<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new OwnedIntentError("OWNED_INTENT_INVALID");
  }
}

export function freezeOwned(value: OwnedIntent): OwnedIntent {
  Object.freeze(value.owner);
  Object.freeze(value.offer);
  if (value.startedEvidence !== null) Object.freeze(value.startedEvidence);
  return Object.freeze(value);
}

export const ownedKey = (owner: Pick<OwnedIntentOwner, "jobId" | "attempt">) =>
  `owned-intent-v1:${owner.jobId}:${owner.attempt}`;
export const activeOwnedKey = (owner: OwnedIntentOwner) =>
  `owned-active-v1:${owner.jobId}`;
export const generationOwnedKey = (owner: OwnedIntentOwner) =>
  `owned-generation-v1:${owner.ownerGeneration}`;

export function initialOwnedIntent(
  input: PrepareOwnedIntentInput,
): OwnedIntent {
  const { offer, sessionId, initialMessageId, ownerGeneration } = input;
  return {
    schemaVersion: 1,
    owner: {
      jobId: offer.payload.job_id,
      attempt: offer.payload.attempt,
      repositoryId: offer.payload.repository_id,
      sessionId,
      ownerGeneration,
    },
    leaseId: offer.payload.lease_id,
    offer: {
      messageId: offer.message_id,
      sequence: offer.sequence,
      correlationId: offer.correlation_id,
      sentAt: offer.sent_at,
      expiresAt: offer.expires_at,
    },
    initialMessageId,
    requestDigest: createHash("sha256")
      .update(offer.payload.request, "utf8")
      .digest("hex"),
    phase: "prepared",
    version: 0,
    mode: null,
    startedEvidence: null,
    unavailable: null,
  };
}

// Schema parsing gives deterministic field order; compare normalized values,
// while requiring persisted values to already be canonical (no silent repair).
export function ownedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return item;
  });
}
export function parseOwnedRecord<T>(schema: z.ZodType<T>, text: string): T {
  try {
    if (Buffer.byteLength(text, "utf8") > 16384) throw new Error();
    const decoded: unknown = JSON.parse(text);
    const parsed = schema.parse(decoded);
    if (ownedJson(decoded) !== ownedJson(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new OwnedIntentError("OWNED_INTENT_CORRUPT");
  }
}
