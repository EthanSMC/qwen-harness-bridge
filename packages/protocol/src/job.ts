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

const Rfc3339TimestampSchema = z.string().datetime({ offset: true });

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
