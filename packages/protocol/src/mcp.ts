import { z } from "zod";
import { JobStatusSchema } from "./job.js";

const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const BoundedListLimitSchema = SafeNonNegativeIntegerSchema.min(1).max(5);
const RevisionSchema = SafeNonNegativeIntegerSchema;
const JobIdSchema = z.string().uuid();

export const ListTasksInputSchema = z
  .object({
    limit: BoundedListLimitSchema.default(5),
    status: JobStatusSchema.optional(),
    unread_only: z.boolean().default(false),
  })
  .strict();

export const GetTaskInputSchema = z
  .object({
    job_id: JobIdSchema,
  })
  .strict();

export const CancelTaskInputSchema = z
  .object({
    job_id: JobIdSchema,
    expected_revision: RevisionSchema,
  })
  .strict();

export const ListPendingApprovalsInputSchema = z
  .object({
    limit: BoundedListLimitSchema.default(5),
  })
  .strict();

export const DecideApprovalInputSchema = z
  .object({
    approval_id: JobIdSchema,
    decision: z.enum(["approve", "reject"]),
    expected_job_revision: RevisionSchema,
  })
  .strict();

export const GetTaskResultInputSchema = z
  .object({
    job_id: JobIdSchema,
  })
  .strict();

export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;
export type GetTaskInput = z.infer<typeof GetTaskInputSchema>;
export type CancelTaskInput = z.infer<typeof CancelTaskInputSchema>;
export type ListPendingApprovalsInput = z.infer<
  typeof ListPendingApprovalsInputSchema
>;
export type DecideApprovalInput = z.infer<typeof DecideApprovalInputSchema>;
export type GetTaskResultInput = z.infer<typeof GetTaskResultInputSchema>;
