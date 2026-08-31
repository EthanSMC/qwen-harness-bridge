import { describe, expect, it } from "vitest";
import {
  JobReceiptSchema,
  JobStatusSchema,
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
});
