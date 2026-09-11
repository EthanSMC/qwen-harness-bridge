ALTER TABLE "jobs" ADD COLUMN "cancel_revision" integer;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_cancel_revision_check" CHECK ("jobs"."cancel_revision" is null or ("jobs"."cancel_revision" >= 0 and "jobs"."cancel_revision" <= "jobs"."revision"));
