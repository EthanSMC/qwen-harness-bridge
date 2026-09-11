import { randomUUID } from "node:crypto";
import type { JobStatePayload } from "@qhb/protocol";
import { ConnectorServerMessageSchema } from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import { initialOwnedIntent, type OwnedIntent } from "../store/owned-intent.js";
import {
  admitCoordinationTiming,
  type CoordinationClockSample,
} from "./coordination-deadlines.js";
import { admitInitialStart } from "./initial-start-admission.js";
import type { JobOfferMessage } from "./job-command-coordinator.js";

const now = Date.now();
const clock = (offset = 0): CoordinationClockSample => ({
  wallTimeMs: now + offset,
  monotonicTimeMs: 1_000 + offset,
});

const offerOf = (jobId: string, attempt: number, leaseId: string) =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.offer",
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    payload: {
      job_id: jobId,
      attempt,
      repository_id: "example",
      lease_id: leaseId,
      request: "fixture",
    },
  }) as JobOfferMessage;

const stateOf = (
  jobId: string,
  attempt: number,
  leaseId: string | null,
  overrides: Partial<JobStatePayload> = {},
): JobStatePayload =>
  ({
    job_id: jobId,
    repository_id: "example",
    mode: "normal",
    requested_attempt: attempt,
    current_attempt: attempt,
    status: "running",
    job_revision: 3,
    cancel_revision: null,
    lease_id: leaseId,
    lease_expires_at:
      leaseId === null ? null : new Date(now + 30_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    observed_at: new Date(now).toISOString(),
    state_valid_until: new Date(now + 2_000).toISOString(),
    request_message_id: randomUUID(),
    request_sequence: 1,
    nonce: randomUUID(),
    ...overrides,
  }) as JobStatePayload;

const timingFor = (state: JobStatePayload) =>
  admitCoordinationTiming(state, clock(0), clock(10));

const prepared = (offer: JobOfferMessage): OwnedIntent =>
  initialOwnedIntent({
    offer,
    sessionId: randomUUID(),
    initialMessageId: "initial",
    ownerGeneration: randomUUID(),
  });

describe("admitInitialStart", () => {
  it("admits a matching running state and returns its mode", () => {
    const jobId = randomUUID();
    const leaseId = randomUUID();
    const offer = offerOf(jobId, 1, leaseId);
    const state = stateOf(jobId, 1, leaseId);
    const timing = timingFor(state);
    expect(timing).toBeDefined();
    const admitted = admitInitialStart({
      state,
      offer,
      intent: prepared(offer),
      repositoryId: "example",
      timing: timing!,
      now: clock(20),
    });
    expect(admitted).toEqual({ mode: "normal" });
  });

  it("admits read_only mode as the recorded initial mode", () => {
    const jobId = randomUUID();
    const leaseId = randomUUID();
    const offer = offerOf(jobId, 1, leaseId);
    const state = stateOf(jobId, 1, leaseId, { mode: "read_only" });
    expect(
      admitInitialStart({
        state,
        offer,
        intent: prepared(offer),
        repositoryId: "example",
        timing: timingFor(state)!,
        now: clock(20),
      }),
    ).toEqual({ mode: "read_only" });
  });

  it.each([
    ["job", { job_id: randomUUID() }],
    ["repository", { repository_id: "other" }],
    ["requested attempt", { requested_attempt: 2 }],
    ["current attempt", { current_attempt: 2 }],
    ["status", { status: "waiting_approval" }],
    ["lease id", { lease_id: randomUUID() }],
    ["null lease", { lease_id: null, lease_expires_at: null }],
  ])("rejects a mismatched %s", (_label, overrides) => {
    const jobId = randomUUID();
    const leaseId = randomUUID();
    const offer = offerOf(jobId, 1, leaseId);
    const state = stateOf(
      jobId,
      1,
      leaseId,
      overrides as Partial<JobStatePayload>,
    );
    const timing = timingFor(state);
    if (timing === undefined) {
      expect(timing).toBeUndefined();
      return;
    }
    expect(
      admitInitialStart({
        state,
        offer,
        intent: prepared(offer),
        repositoryId: "example",
        timing,
        now: clock(20),
      }),
    ).toBeUndefined();
  });

  it("rejects an already-advanced intent", () => {
    const jobId = randomUUID();
    const leaseId = randomUUID();
    const offer = offerOf(jobId, 1, leaseId);
    const state = stateOf(jobId, 1, leaseId);
    const intent = {
      ...prepared(offer),
      phase: "creating" as const,
      mode: "normal" as const,
    };
    expect(
      admitInitialStart({
        state,
        offer,
        intent,
        repositoryId: "example",
        timing: timingFor(state)!,
        now: clock(20),
      }),
    ).toBeUndefined();
  });

  it("rejects a timing window that is no longer current", () => {
    const jobId = randomUUID();
    const leaseId = randomUUID();
    const offer = offerOf(jobId, 1, leaseId);
    const state = stateOf(jobId, 1, leaseId);
    expect(
      admitInitialStart({
        state,
        offer,
        intent: prepared(offer),
        repositoryId: "example",
        timing: timingFor(state)!,
        now: clock(5_000),
      }),
    ).toBeUndefined();
  });
});
