CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "job_status" AS ENUM (
  'queued',
  'dispatched',
  'running',
  'waiting_approval',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'expired'
);

CREATE TYPE "connector_health" AS ENUM ('fresh', 'stale', 'offline');
CREATE TYPE "job_mode" AS ENUM ('normal', 'read_only');
CREATE TYPE "approval_decision" AS ENUM ('approve', 'reject');
CREATE TYPE "connector_message_direction" AS ENUM ('server', 'client');

CREATE TABLE "owners" (
  "id" text PRIMARY KEY NOT NULL,
  "display_name" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "credential_hash" text NOT NULL,
  "public_key" text,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "protocol_version" varchar(32) DEFAULT '1.0' NOT NULL,
  "health" "connector_health" DEFAULT 'offline' NOT NULL,
  "last_server_sequence" bigint DEFAULT 0 NOT NULL,
  "last_client_sequence" bigint DEFAULT 0 NOT NULL,
  "last_heartbeat_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "connectors_server_sequence_nonnegative_check" CHECK ("last_server_sequence" >= 0),
  CONSTRAINT "connectors_client_sequence_nonnegative_check" CHECK ("last_client_sequence" >= 0),
  CONSTRAINT "connectors_credential_id_unique" UNIQUE ("credential_id"),
  CONSTRAINT "connectors_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE
);

CREATE TABLE "repository_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "display_name" text NOT NULL,
  "canonical_path" text NOT NULL,
  "allowed_action_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approval_timeout_minutes" integer DEFAULT 5 NOT NULL,
  "runtime_timeout_seconds" integer DEFAULT 3600 NOT NULL,
  "max_concurrency" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "repository_policies_approval_timeout_check" CHECK ("approval_timeout_minutes" BETWEEN 1 AND 30),
  CONSTRAINT "repository_policies_runtime_timeout_positive_check" CHECK ("runtime_timeout_seconds" > 0),
  CONSTRAINT "repository_policies_concurrency_positive_check" CHECK ("max_concurrency" > 0),
  CONSTRAINT "repository_policies_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE,
  CONSTRAINT "repository_policies_owner_id_key" UNIQUE ("owner_id", "id")
);

CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "short_id" varchar(7) NOT NULL,
  "owner_id" text NOT NULL,
  "connector_id" uuid,
  "repository_id" text NOT NULL,
  "request_ciphertext" text,
  "request_digest" text NOT NULL,
  "mode" "job_mode" DEFAULT 'normal' NOT NULL,
  "status" "job_status" DEFAULT 'queued' NOT NULL,
  "current_stage" varchar(128) DEFAULT 'queued' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "lease_id" uuid,
  "lease_expires_at" timestamptz,
  "harness_agent_id" text,
  "harness_session_id" text,
  "title" varchar(40),
  "summary" jsonb,
  "unread_terminal" boolean DEFAULT false NOT NULL,
  "accepted_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz DEFAULT now() + interval '24 hours' NOT NULL,
  "request_delete_at" timestamptz,
  "retention_delete_at" timestamptz DEFAULT now() + interval '30 days' NOT NULL,
  "terminal_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "jobs_revision_nonnegative_check" CHECK ("revision" >= 0),
  CONSTRAINT "jobs_attempt_nonnegative_check" CHECK ("attempt" >= 0),
  CONSTRAINT "jobs_request_delete_after_terminal_check" CHECK ("request_delete_at" IS NULL OR "terminal_at" IS NOT NULL),
  CONSTRAINT "jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE,
  CONSTRAINT "jobs_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL,
  CONSTRAINT "jobs_owner_repository_id_fkey" FOREIGN KEY ("owner_id", "repository_id") REFERENCES "repository_policies"("owner_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "jobs_short_id_unique" UNIQUE ("short_id")
);

CREATE TABLE "job_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "message_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "event_type" varchar(64) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" varchar(32) DEFAULT 'control-plane' NOT NULL,
  "correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "job_events_sequence_positive_check" CHECK ("sequence" > 0),
  CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE,
  CONSTRAINT "job_events_job_sequence_key" UNIQUE ("job_id", "sequence"),
  CONSTRAINT "job_events_job_message_id_key" UNIQUE ("job_id", "message_id")
);

CREATE TABLE "approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "attempt" integer NOT NULL,
  "job_revision" integer NOT NULL,
  "action_summary" varchar(400) NOT NULL,
  "impact_summary" varchar(800) NOT NULL,
  "action_fingerprint" varchar(71) NOT NULL,
  "risk_class" varchar(64) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "decision" "approval_decision",
  "decided_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "approvals_attempt_positive_check" CHECK ("attempt" > 0),
  CONSTRAINT "approvals_job_revision_nonnegative_check" CHECK ("job_revision" >= 0),
  CONSTRAINT "approvals_fingerprint_format_check" CHECK ("action_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "approvals_decision_timestamp_check" CHECK (("decision" IS NULL AND "decided_at" IS NULL) OR ("decision" IS NOT NULL AND "decided_at" IS NOT NULL)),
  CONSTRAINT "approvals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE
);

CREATE TABLE "idempotency_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL,
  "client_request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "job_id" uuid NOT NULL,
  "expires_at" timestamptz DEFAULT now() + interval '24 hours' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "idempotency_records_owner_client_request_key" UNIQUE ("owner_id", "client_request_id"),
  CONSTRAINT "idempotency_records_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE,
  CONSTRAINT "idempotency_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE
);

CREATE TABLE "connector_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL,
  "direction" "connector_message_direction" NOT NULL,
  "sequence" bigint NOT NULL,
  "message_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "type" varchar(64) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "connector_messages_sequence_positive_check" CHECK ("sequence" > 0),
  CONSTRAINT "connector_messages_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE,
  CONSTRAINT "connector_messages_connector_direction_sequence_key" UNIQUE ("connector_id", "direction", "sequence"),
  CONSTRAINT "connector_messages_connector_message_id_key" UNIQUE ("connector_id", "message_id")
);

CREATE INDEX "connectors_owner_health_idx" ON "connectors" USING btree ("owner_id", "health");
CREATE INDEX "repository_policies_owner_enabled_idx" ON "repository_policies" USING btree ("owner_id", "enabled");
CREATE INDEX "jobs_owner_updated_idx" ON "jobs" USING btree ("owner_id", "updated_at", "id");
CREATE INDEX "jobs_owner_status_updated_idx" ON "jobs" USING btree ("owner_id", "status", "updated_at");
CREATE INDEX "jobs_expiry_idx" ON "jobs" USING btree ("status", "expires_at");
CREATE INDEX "job_events_job_created_idx" ON "job_events" USING btree ("job_id", "created_at");
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("expires_at", "job_id", "decision");
CREATE INDEX "approvals_job_idx" ON "approvals" USING btree ("job_id", "created_at");
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");
CREATE INDEX "connector_messages_replay_idx" ON "connector_messages" USING btree ("connector_id", "direction", "sequence");
