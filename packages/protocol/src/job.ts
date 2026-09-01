import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "waiting_approval",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const ConnectorHealthSchema = z.enum(["fresh", "stale", "offline"]);

export const RepositoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/);

export const ShortJobIdSchema = z.string().regex(/^QH-[A-Z0-9]{4}$/);

const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isValidRfc3339Timestamp = (value: string): boolean => {
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
  .refine(isValidRfc3339Timestamp, "Invalid RFC 3339 timestamp");

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

export const JobSummarySchema = z
  .object({
    short_id: ShortJobIdSchema,
    title: boundedUtf8Text(40),
    status: JobStatusSchema,
    current_stage: boundedUtf8Text(36),
    freshness: ConnectorHealthSchema,
    unread_terminal: z.boolean(),
    updated_at: Rfc3339TimestampSchema,
  })
  .strict();

export const SubmitTaskInputSchema = z
  .object({
    client_request_id: z.string().uuid(),
    repository_id: RepositoryIdSchema,
    request: boundedUtf8Text(4000),
    mode: z.enum(["normal", "read_only"]).default("normal"),
  })
  .strict();

export const JobReceiptSchema = z
  .object({
    job_id: z.string().uuid(),
    short_id: ShortJobIdSchema,
    status: z.literal("queued"),
    connector_status: z.enum(["online", "offline"]),
    accepted_at: Rfc3339TimestampSchema,
    expires_at: Rfc3339TimestampSchema,
  })
  .strict();

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;
export type JobSummary = z.infer<typeof JobSummarySchema>;
export type SubmitTaskInput = z.infer<typeof SubmitTaskInputSchema>;
export type JobReceipt = z.infer<typeof JobReceiptSchema>;
