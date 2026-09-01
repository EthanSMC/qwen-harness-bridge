import { describe, expect, it } from "vitest";
import {
  CancelTaskInputSchema,
  DecideApprovalInputSchema,
  GetTaskInputSchema,
  GetTaskResultInputSchema,
  JobReceiptSchema,
  JobStatusSchema,
  JobSummarySchema,
  ListPendingApprovalsInputSchema,
  ListTasksInputSchema,
  SubmitTaskInputSchema,
} from "./index.js";

describe("job protocol", () => {
  it("accepts only public job states", () => {
    expect(JobStatusSchema.parse("waiting_approval")).toBe("waiting_approval");
    expect(() => JobStatusSchema.parse("reconciling")).toThrow();
  });

  it("rejects arbitrary paths and oversized requests", () => {
    expect(() =>
      SubmitTaskInputSchema.parse({
        client_request_id: crypto.randomUUID(),
        repository_id: "/Users/owner/repo",
        request: "run tests",
      }),
    ).toThrow();
    expect(() =>
      SubmitTaskInputSchema.parse({
        client_request_id: crypto.randomUUID(),
        repository_id: "novelty-studio",
        request: "x".repeat(4001),
      }),
    ).toThrow();
  });

  it("parses the bounded submission receipt", () => {
    const value = JobReceiptSchema.parse({
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued",
      connector_status: "online",
      accepted_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-02T00:00:00.000Z",
    });
    expect(value.short_id).toBe("QH-7M2P");
  });

  it("counts UTF-8 bytes for bounded text", () => {
    expect(() =>
      SubmitTaskInputSchema.parse({
        client_request_id: crypto.randomUUID(),
        repository_id: "novelty-studio",
        request: "😀".repeat(1001),
      }),
    ).toThrow();
    expect(() =>
      JobSummarySchema.parse({
        short_id: "QH-7M2P",
        title: "界".repeat(14),
        status: "queued",
        current_stage: "准备中",
        freshness: "fresh",
        unread_terminal: false,
        updated_at: "2026-09-01T00:00:00Z",
      }),
    ).toThrow();
    expect(() =>
      JobSummarySchema.parse({
        short_id: "QH-7M2P",
        title: "修复登录",
        status: "queued",
        current_stage: "界".repeat(13),
        freshness: "fresh",
        unread_terminal: false,
        updated_at: "2026-09-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("accepts RFC 3339 numeric offsets", () => {
    const value = JobReceiptSchema.parse({
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued",
      connector_status: "online",
      accepted_at: "2026-09-01T08:00:00+08:00",
      expires_at: "2026-09-02T08:00:00+08:00",
    });
    expect(value.accepted_at).toContain("+08:00");
    expect(() =>
      JobReceiptSchema.parse({
        job_id: crypto.randomUUID(),
        short_id: "QH-7M2P",
        status: "queued",
        connector_status: "online",
        accepted_at: "not-a-timestamp",
        expires_at: "2026-09-02T08:00:00+08:00",
      }),
    ).toThrow();
  });

  it("rejects malformed RFC 3339 offsets", () => {
    const receipt = {
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued" as const,
      connector_status: "online" as const,
      accepted_at: "2026-09-01T08:00:00+08:00",
      expires_at: "2026-09-02T08:00:00+08:00",
    };
    expect(() =>
      JobReceiptSchema.parse({
        ...receipt,
        accepted_at: "2026-09-01T08:00:00+0800",
      }),
    ).toThrow();
  });

  it("rejects impossible RFC 3339 offsets", () => {
    const receipt = {
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued" as const,
      connector_status: "online" as const,
      accepted_at: "2026-09-01T08:00:00+08:00",
      expires_at: "2026-09-02T08:00:00+08:00",
    };
    expect(() =>
      JobReceiptSchema.parse({
        ...receipt,
        accepted_at: "2026-09-01T08:00:00+99:99",
      }),
    ).toThrow();
  });

  it("rejects invalid RFC 3339 calendar dates", () => {
    const receipt = {
      job_id: crypto.randomUUID(),
      short_id: "QH-7M2P",
      status: "queued" as const,
      connector_status: "online" as const,
      accepted_at: "2026-09-01T08:00:00+08:00",
      expires_at: "2026-09-02T08:00:00+08:00",
    };
    expect(() =>
      JobReceiptSchema.parse({
        ...receipt,
        accepted_at: "2026-02-30T08:00:00+08:00",
      }),
    ).toThrow();
  });

  it("parses a bounded job summary", () => {
    const value = JobSummarySchema.parse({
      short_id: "QH-7M2P",
      title: "修复登录测试",
      status: "running",
      current_stage: "运行测试",
      freshness: "stale",
      unread_terminal: false,
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(value.status).toBe("running");
    expect(value.freshness).toBe("stale");
  });

  it("validates list task input bounds and filters", () => {
    expect(ListTasksInputSchema.parse({})).toEqual({
      limit: 5,
      unread_only: false,
    });
    expect(
      ListTasksInputSchema.parse({
        limit: 1,
        status: "waiting_approval",
        unread_only: true,
      }),
    ).toMatchObject({
      limit: 1,
      status: "waiting_approval",
      unread_only: true,
    });
    expect(() => ListTasksInputSchema.parse({ limit: 6 })).toThrow();
  });

  it("validates get task input IDs", () => {
    const jobId = crypto.randomUUID();
    expect(GetTaskInputSchema.parse({ job_id: jobId })).toEqual({
      job_id: jobId,
    });
    expect(() => GetTaskInputSchema.parse({ job_id: "QH-7M2P" })).toThrow();
  });

  it("validates cancellation revisions", () => {
    const jobId = crypto.randomUUID();
    expect(
      CancelTaskInputSchema.parse({ job_id: jobId, expected_revision: 0 }),
    ).toEqual({
      job_id: jobId,
      expected_revision: 0,
    });
    expect(() =>
      CancelTaskInputSchema.parse({ job_id: jobId, expected_revision: -1 }),
    ).toThrow();
  });

  it("accepts safe revision boundaries and rejects unsafe revisions", () => {
    const maxSafeInteger = Number.MAX_SAFE_INTEGER;
    const unsafeInteger = maxSafeInteger + 1;
    const jobId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();

    expect(
      CancelTaskInputSchema.parse({
        job_id: jobId,
        expected_revision: maxSafeInteger,
      }),
    ).toMatchObject({ expected_revision: maxSafeInteger });
    expect(
      DecideApprovalInputSchema.parse({
        approval_id: approvalId,
        decision: "approve",
        expected_job_revision: maxSafeInteger,
      }),
    ).toMatchObject({ expected_job_revision: maxSafeInteger });
    expect(() =>
      CancelTaskInputSchema.parse({
        job_id: jobId,
        expected_revision: unsafeInteger,
      }),
    ).toThrow();
    expect(() =>
      DecideApprovalInputSchema.parse({
        approval_id: approvalId,
        decision: "approve",
        expected_job_revision: unsafeInteger,
      }),
    ).toThrow();
    expect(() =>
      ListTasksInputSchema.parse({ limit: unsafeInteger }),
    ).toThrow();
    expect(() =>
      ListPendingApprovalsInputSchema.parse({ limit: unsafeInteger }),
    ).toThrow();
  });

  it("validates pending approval list bounds", () => {
    expect(ListPendingApprovalsInputSchema.parse({})).toEqual({ limit: 5 });
    expect(ListPendingApprovalsInputSchema.parse({ limit: 1 })).toEqual({
      limit: 1,
    });
    expect(() => ListPendingApprovalsInputSchema.parse({ limit: 6 })).toThrow();
  });

  it("validates approval decisions and revisions", () => {
    const approvalId = crypto.randomUUID();
    expect(
      DecideApprovalInputSchema.parse({
        approval_id: approvalId,
        decision: "approve",
        expected_job_revision: 3,
      }),
    ).toEqual({
      approval_id: approvalId,
      decision: "approve",
      expected_job_revision: 3,
    });
    expect(() =>
      DecideApprovalInputSchema.parse({
        approval_id: approvalId,
        decision: "defer",
        expected_job_revision: 3,
      }),
    ).toThrow();
  });

  it("validates task result input IDs", () => {
    const jobId = crypto.randomUUID();
    expect(GetTaskResultInputSchema.parse({ job_id: jobId })).toEqual({
      job_id: jobId,
    });
    expect(() =>
      GetTaskResultInputSchema.parse({ job_id: "not-a-uuid" }),
    ).toThrow();
  });
});
