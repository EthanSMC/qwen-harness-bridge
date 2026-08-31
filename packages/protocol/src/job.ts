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

export const JobSummarySchema = z
  .object({
    short_id: ShortJobIdSchema,
    title: z.string().trim().min(1).max(40),
    status: JobStatusSchema,
    current_stage: z.string().trim().min(1).max(36),
    freshness: ConnectorHealthSchema,
    unread_terminal: z.boolean(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const SubmitTaskInputSchema = z
  .object({
    client_request_id: z.string().uuid(),
    repository_id: RepositoryIdSchema,
    request: z.string().trim().min(1).max(4000),
    mode: z.enum(["normal", "read_only"]).default("normal"),
  })
  .strict();

export const JobReceiptSchema = z
  .object({
    job_id: z.string().uuid(),
    short_id: ShortJobIdSchema,
    status: z.literal("queued"),
    connector_status: z.enum(["online", "offline"]),
    accepted_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict();

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;
export type JobSummary = z.infer<typeof JobSummarySchema>;
export type SubmitTaskInput = z.infer<typeof SubmitTaskInputSchema>;
export type JobReceipt = z.infer<typeof JobReceiptSchema>;
