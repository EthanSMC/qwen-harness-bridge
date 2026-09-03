import { z } from "zod";
import { RepositoryIdSchema } from "./job.js";

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const PositiveIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const INVALID_SEQUENCE_ERROR = "INVALID_SEQUENCE";
export const INVALID_SEQUENCE_ORDER_ERROR = "INVALID_SEQUENCE_ORDER";

export type SequenceCursorResult = "accepted" | "duplicate";

export class SequenceCursor {
  #lastSequence: number;

  constructor(initialSequence = 0) {
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new Error(`${INVALID_SEQUENCE_ERROR}:${initialSequence}`);
    }
    this.#lastSequence = initialSequence;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  accept(sequence: number): SequenceCursorResult {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error(`${INVALID_SEQUENCE_ERROR}:${sequence}`);
    }
    if (sequence === this.#lastSequence) {
      return "duplicate";
    }
    if (sequence < this.#lastSequence) {
      throw new Error(
        `${INVALID_SEQUENCE_ORDER_ERROR}:${this.#lastSequence}:${sequence}`,
      );
    }
    this.#lastSequence = sequence;
    return "accepted";
  }
}

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

const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isValidRfc3339CalendarDate = (value: string): boolean => {
  const match = value.match(RFC3339_TIMESTAMP_PATTERN);
  if (match === null) {
    return false;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  );
};

const Rfc3339TimestampSchema = z
  .string()
  .regex(RFC3339_TIMESTAMP_PATTERN, "Invalid RFC 3339 timestamp")
  .refine(isValidRfc3339CalendarDate, "Invalid RFC 3339 calendar date");

type ParsedRfc3339Instant = {
  wholeSeconds: number;
  fraction: string;
};

// Returns days relative to 1970-01-01 in the proleptic Gregorian calendar.
const daysFromUnixEpoch = (
  year: number,
  month: number,
  day: number,
): number => {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

const parseRfc3339Instant = (value: string): ParsedRfc3339Instant | null => {
  const match = value.match(RFC3339_TIMESTAMP_PATTERN);
  if (match === null) {
    return null;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction,
    timezone,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  const localSeconds =
    daysFromUnixEpoch(year, month, day) * 86400 +
    Number(hourText) * 3600 +
    Number(minuteText) * 60 +
    Number(secondText);
  const offsetSeconds =
    timezone === "Z"
      ? 0
      : (timezone[0] === "+" ? 1 : -1) *
        (Number(timezone.slice(1, 3)) * 3600 +
          Number(timezone.slice(4, 6)) * 60);

  return {
    wholeSeconds: localSeconds - offsetSeconds,
    fraction: fraction ?? "",
  };
};

export const rfc3339InstantKey = (value: string): string | null => {
  const instant = parseRfc3339Instant(value);
  if (instant === null) return null;
  const fraction = instant.fraction.replace(/0+$/, "");
  return `${instant.wholeSeconds}.${fraction}`;
};

const compareRfc3339Instants = (left: string, right: string): number | null => {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (leftInstant === null || rightInstant === null) {
    return null;
  }

  if (leftInstant.wholeSeconds !== rightInstant.wholeSeconds) {
    return leftInstant.wholeSeconds < rightInstant.wholeSeconds ? -1 : 1;
  }

  const fractionLength = Math.max(
    leftInstant.fraction.length,
    rightInstant.fraction.length,
  );
  const leftFraction = leftInstant.fraction.padEnd(fractionLength, "0");
  const rightFraction = rightInstant.fraction.padEnd(fractionLength, "0");
  if (leftFraction === rightFraction) {
    return 0;
  }
  return leftFraction < rightFraction ? -1 : 1;
};

const ConnectorIdSchema = UuidSchema;
const AttemptSchema = PositiveIntegerSchema;
const JobRevisionSchema = NonNegativeIntegerSchema;
const CapabilitySchema = boundedUtf8Text(64);
const VersionSchema = boundedUtf8Text(32);
const EventTypeSchema = boundedUtf8Text(64);
const SourceSchema = boundedUtf8Text(32);
const ReasonSchema = boundedUtf8Text(400);
const ActionFingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Invalid SHA-256 action fingerprint");

const MAX_EVENT_PAYLOAD_DEPTH = 6;
const MAX_EVENT_PAYLOAD_KEYS = 32;
const MAX_EVENT_PAYLOAD_ITEMS = 32;
const MAX_EVENT_STRING_BYTES = 500;
const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
const REDACTED_VALUE_PATTERN = /^\[redacted\]$/i;
const normalizeEventKey = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toLowerCase();
const UNSAFE_EVENT_KEY_PATTERN =
  /(?:^|_)(?:__proto__|constructor|prototype|to_json|access_tokens?|api_keys?|auth(?:entication|orization)?|bearer|client_secrets?|cookies?|credentials?|env(?:ironment)?(?:_(?:value|variables?|vars?))?|home|passwords?|passwd|private_keys?|secrets?|session_(?:ids?|tokens?)|source_(?:code|content|text)|(?:raw_)?(?:arguments?|command|content|diff|log|logs|output|patch|snippet|stack(?:_trace)?|stderr|stdout|terminal|trace)|tokens?)(?:$|_)/;
const isUnsafeEventKey = (key: string): boolean =>
  UNSAFE_EVENT_KEY_PATTERN.test(normalizeEventKey(key));
const ENVIRONMENT_KEY_PATTERN =
  /^(?:CI|HOME|NODE_ENV|PATH|PWD|SHELL|TEMP|TMP|TMPDIR|USER|(?:[A-Z][A-Z0-9]*_){1,}[A-Z0-9]+)$/;
const UNSAFE_EVENT_VALUE_PATTERNS = [
  /(?:^|[\s"'`?&])(?:access[_-]?tokens?|api[_-]?keys?|authorization|client[_-]?secrets?|cookies?|credentials?|env(?:ironment)?(?:[_-]?value)?|passwords?|passwd|secrets?|tokens?)\s*[:=]\s*\S+/i,
  /\b[A-Z][A-Z0-9_]{1,}\s*=\s*\S+/,
  /\b(?:home|node_env|path|pwd|shell|temp|tmp|tmpdir|user)\s*=\s*\S+/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];
const RAW_EVENT_VALUE_PATTERN =
  /[\r\n]|(?:^|\n)\s*(?:[$>#]\s+|stdout:|stderr:|traceback\b|stack trace\b)/i;
const ABSOLUTE_LOCAL_PATH_PATTERN =
  /(?:^|[\s"'(=])(?:file:\/\/|~\/|[A-Za-z]:[\\/]|\\\\|\/[^\s/]+(?:\/[^\s/]*)*)/;

type SafeEventValue =
  | string
  | number
  | boolean
  | null
  | SafeEventValue[]
  | { [key: string]: SafeEventValue };
type SafeEventPayload = { [key: string]: SafeEventValue };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasOwnToJSON = (value: object): boolean =>
  Object.getOwnPropertyNames(value).includes("toJSON");

const utf8Encoder = new TextEncoder();
const jsonByteLength = (value: unknown): number =>
  utf8Encoder.encode(JSON.stringify(value)).byteLength;

const SafeEventPayloadSchema = z
  .custom<SafeEventPayload>(
    isPlainObject,
    "Event payload must be a plain object",
  )
  .superRefine((payload, context) => {
    if (!isPlainObject(payload)) {
      return;
    }

    const activeObjects = new Set<object>();
    let estimatedBytes = 0;
    let payloadTooLarge = false;

    const addIssue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    const addJsonBytes = (value: unknown): void => {
      estimatedBytes += jsonByteLength(value);
      if (estimatedBytes > MAX_EVENT_PAYLOAD_BYTES) {
        payloadTooLarge = true;
      }
    };

    const addStructuralBytes = (bytes: number): void => {
      estimatedBytes += bytes;
      if (estimatedBytes > MAX_EVENT_PAYLOAD_BYTES) {
        payloadTooLarge = true;
      }
    };

    const visit = (
      value: unknown,
      path: (string | number)[],
      depth: number,
      key?: string,
      hasSeparator = false,
    ): void => {
      if (payloadTooLarge) {
        return;
      }
      if (depth > MAX_EVENT_PAYLOAD_DEPTH) {
        addIssue(path, "Event payload nesting is too deep");
        return;
      }

      if (key !== undefined) {
        if (hasSeparator) {
          addStructuralBytes(1);
        }
        addJsonBytes(key);
        addStructuralBytes(1);
        if (
          (isUnsafeEventKey(key) || ENVIRONMENT_KEY_PATTERN.test(key)) &&
          !(typeof value === "string" && REDACTED_VALUE_PATTERN.test(value))
        ) {
          addIssue(path, "Event payload contains a restricted field");
        }
      }

      if (typeof value === "string") {
        const stringBytes = utf8Encoder.encode(value).byteLength;
        if (stringBytes > MAX_EVENT_STRING_BYTES) {
          addIssue(path, "Event payload string is too large");
        }
        if (
          !REDACTED_VALUE_PATTERN.test(value) &&
          (UNSAFE_EVENT_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
            RAW_EVENT_VALUE_PATTERN.test(value) ||
            ABSOLUTE_LOCAL_PATH_PATTERN.test(value))
        ) {
          addIssue(path, "Event payload contains restricted content");
        }
        addJsonBytes(value);
        return;
      }

      if (value === null) {
        addJsonBytes(value);
        return;
      }

      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          addIssue(path, "Event payload numbers must be finite");
          return;
        }
        addJsonBytes(value);
        return;
      }

      if (typeof value === "boolean") {
        addJsonBytes(value);
        return;
      }

      if (typeof value !== "object" || value === undefined) {
        addIssue(path, "Event payload must contain JSON-safe values");
        return;
      }

      if (activeObjects.has(value)) {
        addIssue(path, "Event payload must not contain cyclic values");
        return;
      }
      activeObjects.add(value);

      if (hasOwnToJSON(value)) {
        addIssue(path, "Event payload must not contain own toJSON properties");
      }

      if (Array.isArray(value)) {
        addStructuralBytes(1);
        if (value.length > MAX_EVENT_PAYLOAD_ITEMS) {
          addIssue(path, "Event payload array is too large");
        }
        const itemCount = Math.min(value.length, MAX_EVENT_PAYLOAD_ITEMS);
        for (let index = 0; index < itemCount; index += 1) {
          if (index > 0) {
            addStructuralBytes(1);
          }
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (descriptor === undefined || !("value" in descriptor)) {
            addIssue([...path, index], "Event payload arrays must be dense");
            continue;
          }
          visit(descriptor.value, [...path, index], depth + 1);
        }
        addStructuralBytes(1);
      } else if (!isPlainObject(value)) {
        addIssue(path, "Event payload must contain plain objects");
      } else {
        addStructuralBytes(1);
        let fieldCount = 0;
        for (const entryKey in value) {
          if (!Object.hasOwn(value, entryKey)) {
            continue;
          }
          if (fieldCount >= MAX_EVENT_PAYLOAD_KEYS) {
            addIssue(path, "Event payload object has too many fields");
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, entryKey);
          if (descriptor === undefined || !("value" in descriptor)) {
            addIssue(
              [...path, entryKey],
              "Event payload must not contain accessor properties",
            );
            fieldCount += 1;
            continue;
          }
          visit(
            descriptor.value,
            [...path, entryKey],
            depth + 1,
            entryKey,
            fieldCount > 0,
          );
          fieldCount += 1;
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          addIssue(path, "Event payload must contain string keys only");
        }
        addStructuralBytes(1);
      }

      activeObjects.delete(value);
    };

    visit(payload, [], 0);
    if (payloadTooLarge || estimatedBytes > MAX_EVENT_PAYLOAD_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Event payload must contain at most ${MAX_EVENT_PAYLOAD_BYTES} JSON bytes`,
      });
    }
  });

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
    payload: SafeEventPayloadSchema,
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
      compareRfc3339Instants(
        envelopeValue.expires_at,
        envelopeValue.sent_at,
      ) !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "expires_at must be later than sent_at",
      });
    }
  });

const enforceApprovalPayloadExpiry = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value, context) => {
    if (
      value === null ||
      typeof value !== "object" ||
      value.type !== "approval.requested" ||
      value.payload === null ||
      typeof value.payload !== "object" ||
      typeof value.sent_at !== "string" ||
      typeof value.payload.expires_at !== "string"
    ) {
      return;
    }

    if (compareRfc3339Instants(value.payload.expires_at, value.sent_at) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "expires_at"],
        message: "payload.expires_at must be later than sent_at",
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

const enforceEnvelopeConstraints = <T extends z.ZodTypeAny>(schema: T) =>
  enforceApprovalPayloadExpiry(enforceExpiry(schema));

export const ConnectorClientMessageSchema = enforceEnvelopeConstraints(
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

export const ConnectorServerMessageSchema = enforceEnvelopeConstraints(
  z.discriminatedUnion("type", [
    ConnectorWelcomeMessageSchema,
    JobOfferMessageSchema,
    JobCancelMessageSchema,
    ApprovalDecisionMessageSchema,
    AckMessageSchema,
    ProtocolErrorMessageSchema,
  ]),
);

export const EnvelopeSchema = enforceEnvelopeConstraints(
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
