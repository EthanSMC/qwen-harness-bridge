import { z } from "zod";
import { RepositoryIdSchema } from "./job.js";

const UuidSchema = z.string().uuid();
const PositiveIntegerSchema = z.number().int().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

const boundedUtf8Text = (maxBytes: number) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((value, context) => {
      if (new TextEncoder().encode(value).byteLength > maxBytes) {
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          inclusive: true,
          maximum: maxBytes,
          message: `String must contain at most ${maxBytes} UTF-8 bytes`,
          type: "string",
        });
      }
    });

const Rfc3339TimestampSchema = z
  .string()
  .regex(
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    "Invalid RFC 3339 timestamp",
  )
  .refine((value) => {
    const [, yearText, monthText, dayText] =
      value.match(/^(\d{4})-(\d{2})-(\d{2})T/) ?? [];
    if (
      yearText === undefined ||
      monthText === undefined ||
      dayText === undefined
    ) {
      return false;
    }

    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth =
      month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
  }, "Invalid RFC 3339 calendar date");

const ConnectorIdSchema = UuidSchema;
const AttemptSchema = PositiveIntegerSchema;
const JobRevisionSchema = NonNegativeIntegerSchema;
const CapabilitySchema = boundedUtf8Text(64);
const VersionSchema = boundedUtf8Text(32);
const EventTypeSchema = boundedUtf8Text(64);
const SourceSchema = boundedUtf8Text(32);
const ReasonSchema = boundedUtf8Text(400);
const ActionFingerprintSchema = boundedUtf8Text(256);

export const ConnectorHelloPayloadSchema = z
  .object({
    connector_id: ConnectorIdSchema,
    connector_version: VersionSchema.optional(),
    capabilities: z.array(CapabilitySchema).max(32).optional(),
    last_server_sequence: NonNegativeIntegerSchema,
    last_client_sequence: NonNegativeIntegerSchema.optional(),
  })
  .strict();

export const ConnectorHeartbeatPayloadSchema = z.object({}).strict();

export const JobClaimPayloadSchema = z
  .object({
    job_id: UuidSchema,
    attempt: AttemptSchema,
    lease_id: UuidSchema,
  })
  .strict();

export const JobEventPayloadSchema = z
  .object({
    job_id: UuidSchema,
    attempt: AttemptSchema,
    event_type: EventTypeSchema,
    payload: z.record(z.unknown()),
    source: SourceSchema,
  })
  .strict();

export const ApprovalRequestedPayloadSchema = z
  .object({
    approval_id: UuidSchema,
    job_id: UuidSchema,
    attempt: AttemptSchema,
    job_revision: JobRevisionSchema,
    action_summary: boundedUtf8Text(400),
    impact_summary: boundedUtf8Text(800),
    risk_class: boundedUtf8Text(64),
    action_fingerprint: ActionFingerprintSchema,
    expires_at: Rfc3339TimestampSchema,
  })
  .strict();

export const JobCancelledPayloadSchema = z
  .object({
    job_id: UuidSchema,
    attempt: AttemptSchema,
    reason: ReasonSchema,
  })
  .strict();

export const ConnectorWelcomePayloadSchema = z
  .object({
    connector_id: ConnectorIdSchema,
    server_sequence: NonNegativeIntegerSchema,
    replay_from: NonNegativeIntegerSchema,
  })
  .strict();

export const JobOfferPayloadSchema = z
  .object({
    job_id: UuidSchema,
    attempt: AttemptSchema,
    lease_id: UuidSchema,
    repository_id: RepositoryIdSchema,
    request: boundedUtf8Text(4000),
  })
  .strict();

export const JobCancelPayloadSchema = z
  .object({
    job_id: UuidSchema,
    attempt: AttemptSchema,
    job_revision: JobRevisionSchema,
    reason: ReasonSchema,
    nonce: UuidSchema,
  })
  .strict();

export const ApprovalDecisionPayloadSchema = z
  .object({
    approval_id: UuidSchema,
    job_id: UuidSchema,
    attempt: AttemptSchema,
    job_revision: JobRevisionSchema,
    action_fingerprint: ActionFingerprintSchema,
    decision: z.enum(["approve", "reject"]),
  })
  .strict();

export const AckPayloadSchema = z
  .object({
    sequence: PositiveIntegerSchema,
  })
  .strict();

export const ProtocolErrorPayloadSchema = z
  .object({
    code: boundedUtf8Text(64),
    message: boundedUtf8Text(400),
  })
  .strict();

const EnvelopeFields = {
  protocol_version: z.literal("1.0"),
  message_id: UuidSchema,
  sequence: PositiveIntegerSchema,
  sent_at: Rfc3339TimestampSchema,
  expires_at: Rfc3339TimestampSchema,
  correlation_id: UuidSchema,
};

const envelope = <T extends string, P>(type: T, payload: z.ZodType<P>) =>
  z
    .object({
      ...EnvelopeFields,
      type: z.literal(type),
      payload,
    })
    .strict();

const enforceExpiry = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value, context) => {
    const envelopeValue = value as z.infer<T> & {
      expires_at: string;
      sent_at: string;
    };
    if (
      Date.parse(envelopeValue.expires_at) <= Date.parse(envelopeValue.sent_at)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "expires_at must be later than sent_at",
      });
    }
  });

const ConnectorHelloMessageSchema = envelope(
  "connector.hello",
  ConnectorHelloPayloadSchema,
);
const ConnectorHeartbeatMessageSchema = envelope(
  "connector.heartbeat",
  ConnectorHeartbeatPayloadSchema,
);
const JobClaimMessageSchema = envelope("job.claim", JobClaimPayloadSchema);
const JobEventMessageSchema = envelope("job.event", JobEventPayloadSchema);
const ApprovalRequestedMessageSchema = envelope(
  "approval.requested",
  ApprovalRequestedPayloadSchema,
);
const JobCancelledMessageSchema = envelope(
  "job.cancelled",
  JobCancelledPayloadSchema,
);
const ConnectorWelcomeMessageSchema = envelope(
  "connector.welcome",
  ConnectorWelcomePayloadSchema,
);
const JobOfferMessageSchema = envelope("job.offer", JobOfferPayloadSchema);
const JobCancelMessageSchema = envelope("job.cancel", JobCancelPayloadSchema);
const ApprovalDecisionMessageSchema = envelope(
  "approval.decision",
  ApprovalDecisionPayloadSchema,
);
const AckMessageSchema = envelope("ack", AckPayloadSchema);
const ProtocolErrorMessageSchema = envelope(
  "protocol.error",
  ProtocolErrorPayloadSchema,
);

export const ConnectorClientMessageSchema = enforceExpiry(
  z.discriminatedUnion("type", [
    ConnectorHelloMessageSchema,
    ConnectorHeartbeatMessageSchema,
    JobClaimMessageSchema,
    JobEventMessageSchema,
    ApprovalRequestedMessageSchema,
    JobCancelledMessageSchema,
    AckMessageSchema,
  ]),
);

export const ConnectorServerMessageSchema = enforceExpiry(
  z.discriminatedUnion("type", [
    ConnectorWelcomeMessageSchema,
    JobOfferMessageSchema,
    JobCancelMessageSchema,
    ApprovalDecisionMessageSchema,
    AckMessageSchema,
    ProtocolErrorMessageSchema,
  ]),
);

export const EnvelopeSchema = enforceExpiry(
  z.discriminatedUnion("type", [
    ConnectorHelloMessageSchema,
    ConnectorHeartbeatMessageSchema,
    JobClaimMessageSchema,
    JobEventMessageSchema,
    ApprovalRequestedMessageSchema,
    JobCancelledMessageSchema,
    ConnectorWelcomeMessageSchema,
    JobOfferMessageSchema,
    JobCancelMessageSchema,
    ApprovalDecisionMessageSchema,
    AckMessageSchema,
    ProtocolErrorMessageSchema,
  ]),
);

export const ConnectorEnvelopeSchema = EnvelopeSchema;

export type ConnectorClientMessage = z.infer<
  typeof ConnectorClientMessageSchema
>;
export type ConnectorServerMessage = z.infer<
  typeof ConnectorServerMessageSchema
>;
export type ConnectorEnvelope = z.infer<typeof ConnectorEnvelopeSchema>;
export type JobOfferPayload = z.infer<typeof JobOfferPayloadSchema>;
export type JobEventPayload = z.infer<typeof JobEventPayloadSchema>;
export type ApprovalDecisionPayload = z.infer<
  typeof ApprovalDecisionPayloadSchema
>;
