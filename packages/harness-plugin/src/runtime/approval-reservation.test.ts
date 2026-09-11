import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ApprovalReservationProvider } from "./approval-reservation.js";
import type { CoordinationClockSample } from "./coordination-deadlines.js";
import type { JobStateClient } from "./job-state-client.js";
import { LiveStateRegistry } from "./live-state-registry.js";

const WALL = Date.parse("2026-09-11T00:00:00.000Z");
const MONO = 1_000;
const now = { wallTimeMs: WALL, monotonicTimeMs: MONO };
const epoch = { signal: new AbortController().signal };
const jobId = randomUUID();

const payloadOf = (overrides: Record<string, unknown> = {}) => ({
  job_id: jobId,
  repository_id: "example",
  mode: "normal",
  requested_attempt: 1,
  current_attempt: 1,
  status: "running",
  job_revision: 7,
  cancel_revision: null,
  lease_id: null,
  lease_expires_at: null,
  expires_at: new Date(now.wallTimeMs + 60_000).toISOString(),
  observed_at: new Date(now.wallTimeMs).toISOString(),
  state_valid_until: new Date(now.wallTimeMs + 2_000).toISOString(),
  request_message_id: randomUUID(),
  request_sequence: 1,
  nonce: randomUUID(),
  ...overrides,
});

const exchange = (
  overrides: Record<string, unknown> = {},
  exchangeEpoch: unknown = epoch,
) => ({
  state: {
    type: "job.state",
    correlation_id: randomUUID(),
    payload: payloadOf(overrides),
  },
  request: {
    messageId: randomUUID(),
    sequence: 1,
    correlationId: randomUUID(),
    jobId,
    attempt: 1,
    nonce: randomUUID(),
    epoch,
  },
  epoch: exchangeEpoch,
  sent: { wallTimeMs: now.wallTimeMs, monotonicTimeMs: now.monotonicTimeMs },
  received: {
    wallTimeMs: now.wallTimeMs,
    monotonicTimeMs: now.monotonicTimeMs,
  },
});

const build = (
  options: { timeout?: number | undefined; value?: unknown } = {},
) => {
  const registry = new LiveStateRegistry({
    connector: { onState: () => () => undefined, currentEpoch: () => epoch },
    clock: (): CoordinationClockSample => ({ ...now }),
  });
  const observe = async () => options.value ?? exchange();
  return new ApprovalReservationProvider({
    registry,
    states: { observe } as unknown as Pick<JobStateClient, "observe">,
    epoch: () => epoch,
    approvalTimeoutSeconds: () =>
      "timeout" in options ? options.timeout : 120,
    clock: () => ({ ...now }),
  });
};

it("reserves revision+1 after a fresh observation and revokes on release", async () => {
  const provider = build();
  expect(
    await provider.refresh({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBe(true);
  const reservation = provider.reserve({
    jobId,
    repositoryId: "example",
    attempt: 1,
  });
  expect(reservation?.requestedRevision).toBe(8);
  expect(reservation?.approvalTimeoutSeconds).toBe(120);
  expect(reservation?.isCurrent()).toBe(true);
  reservation?.release();
  expect(reservation?.isCurrent()).toBe(false);
});

it("fails closed without a fresh observation or a valid timeout", async () => {
  const provider = build();
  expect(
    provider.reserve({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBeUndefined();
  const invalid = build({ timeout: undefined });
  expect(
    await invalid.refresh({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBe(true);
  expect(
    invalid.reserve({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBeUndefined();
});

it("rejects a foreign epoch or mismatched job on refresh", async () => {
  const foreign = build({
    value: exchange({}, { signal: new AbortController().signal }),
  });
  expect(
    await foreign.refresh({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBe(false);
  const mismatched = build({ value: exchange({ job_id: randomUUID() }) });
  expect(
    await mismatched.refresh({ jobId, repositoryId: "example", attempt: 1 }),
  ).toBe(false);
});
