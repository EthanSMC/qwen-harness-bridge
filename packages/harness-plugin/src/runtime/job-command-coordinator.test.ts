import { randomUUID } from "node:crypto";
import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { describe, expect, it, vi } from "vitest";
import { JobCommandCoordinator } from "./job-command-coordinator.js";

const envelope = (
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type,
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    payload,
    ...overrides,
  });

const offer = (repositoryId = "example") =>
  envelope("job.offer", {
    job_id: randomUUID(),
    attempt: 1,
    repository_id: repositoryId,
    lease_id: randomUUID(),
    request: "fixture request",
  }) as Extract<ConnectorServerMessage, { type: "job.offer" }>;

const build = (starterStart = vi.fn(async () => undefined)) => {
  const starter = { start: starterStart };
  const cancel = { handle: vi.fn(async () => "cancelled") };
  const approvals = { acceptDecision: vi.fn(() => "accepted" as const) };
  const repositories = {
    resolve: vi.fn((id: string) => (id === "example" ? "/repo" : undefined)),
  };
  const onUnknown = vi.fn();
  const coordinator = new JobCommandCoordinator({
    starter,
    cancel,
    approvals,
    repositories,
    onUnknown,
  });
  return { coordinator, starter, cancel, approvals, repositories, onUnknown };
};

describe("JobCommandCoordinator", () => {
  it("starts exactly one owned attempt for a valid offer", async () => {
    const { coordinator, starter } = build();
    const command = offer();
    await coordinator.handle(command);
    await coordinator.handle(command);
    expect(starter.start).toHaveBeenCalledTimes(1);
    expect(starter.start).toHaveBeenCalledWith(command);
  });

  it("ignores an expired offer without starting", async () => {
    const { coordinator, starter } = build();
    const command = offer();
    const expired = {
      ...command,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    await coordinator.handle(expired as ConnectorServerMessage);
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("ignores an offer for an unknown repository alias", async () => {
    const { coordinator, starter } = build();
    await coordinator.handle(offer("missing"));
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("contains a starter failure and permits a later retry", async () => {
    const start = vi.fn(async () => {
      throw new Error("fixture");
    });
    const { coordinator } = build(start);
    await expect(coordinator.handle(offer())).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("routes cancellation to the cancel handler", async () => {
    const { coordinator, cancel } = build();
    const command = envelope("job.cancel", {
      job_id: randomUUID(),
      attempt: 1,
      job_revision: 3,
      reason: "owner",
      nonce: randomUUID(),
    }) as Extract<ConnectorServerMessage, { type: "job.cancel" }>;
    await coordinator.handle(command);
    expect(cancel.handle).toHaveBeenCalledWith(command);
  });

  it("routes approval decisions to the broker", async () => {
    const { coordinator, approvals } = build();
    const command = envelope("approval.decision", {
      approval_id: randomUUID(),
      job_id: randomUUID(),
      attempt: 1,
      job_revision: 4,
      action_fingerprint: `sha256:${"a".repeat(64)}`,
      decision: "approve",
    }) as Extract<ConnectorServerMessage, { type: "approval.decision" }>;
    await coordinator.handle(command);
    expect(approvals.acceptDecision).toHaveBeenCalledWith(command);
  });

  it("never executes an unsupported or malformed message", async () => {
    const { coordinator, starter, cancel, approvals, onUnknown } = build();
    await coordinator.handle(
      envelope("ack", { sequence: 1 }) as ConnectorServerMessage,
    );
    await coordinator.handle({ type: "job.offer" } as ConnectorServerMessage);
    expect(starter.start).not.toHaveBeenCalled();
    expect(cancel.handle).not.toHaveBeenCalled();
    expect(approvals.acceptDecision).not.toHaveBeenCalled();
    expect(onUnknown).toHaveBeenCalled();
  });
});
