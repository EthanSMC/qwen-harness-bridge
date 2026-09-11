import { randomUUID } from "node:crypto";
import {
  type ConnectorServerMessage,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CoordinationClockSample } from "./coordination-deadlines.js";
import { LiveStateRegistry } from "./live-state-registry.js";

const WALL = Date.parse("2026-09-11T00:00:00.000Z");
const MONO = 5_000;

type StateDelivery = Readonly<{
  epoch: Readonly<{ signal: AbortSignal }> | null;
  recovered: boolean;
}>;
type StateHandler = (
  message: Extract<ConnectorServerMessage, { type: "job.state" }>,
  delivery: StateDelivery,
) => undefined;

const stateEnvelope = (
  jobId: string,
  overrides: Record<string, unknown> = {},
  observedAt = WALL,
) =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.state",
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: new Date(observedAt).toISOString(),
    expires_at: new Date(observedAt + 60_000).toISOString(),
    payload: {
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
      expires_at: new Date(observedAt + 60_000).toISOString(),
      observed_at: new Date(observedAt).toISOString(),
      state_valid_until: new Date(observedAt + 2_000).toISOString(),
      request_message_id: randomUUID(),
      request_sequence: 1,
      nonce: randomUUID(),
      ...overrides,
    },
  });

const build = () => {
  let handler: StateHandler | undefined;
  const epoch = { signal: new AbortController().signal };
  const onState = vi.fn((value: StateHandler) => {
    handler = value;
    return () => {
      handler = undefined;
    };
  });
  const registry = new LiveStateRegistry({
    connector: { onState, currentEpoch: () => epoch },
    clock: (): CoordinationClockSample => ({
      wallTimeMs: WALL,
      monotonicTimeMs: MONO,
    }),
  });
  return {
    registry,
    epoch,
    deliver: (message: unknown, delivery: StateDelivery = {
      epoch,
      recovered: false,
    }) =>
      handler?.(
        message as Extract<ConnectorServerMessage, { type: "job.state" }>,
        delivery,
      ),
  };
};

const at = (offset: number): CoordinationClockSample => ({
  wallTimeMs: WALL + offset,
  monotonicTimeMs: MONO + offset,
});

describe("LiveStateRegistry", () => {
  it("keeps the latest live revision inside the snapshot window", () => {
    const harness = build();
    const jobId = randomUUID();
    harness.deliver(stateEnvelope(jobId));
    expect(harness.registry.revisionFor(jobId, 1, at(0))).toBe(7);
    expect(harness.registry.revisionFor(jobId, 1, at(900))).toBe(7);
    expect(harness.registry.revisionFor(jobId, 1, at(1_100))).toBeUndefined();
  });

  it("ignores recovered, foreign-epoch and non-state deliveries", () => {
    const harness = build();
    const jobId = randomUUID();
    harness.deliver(stateEnvelope(jobId), { epoch: null, recovered: false });
    harness.deliver(stateEnvelope(jobId), {
      epoch: harness.epoch,
      recovered: true,
    });
    harness.deliver(stateEnvelope(jobId), {
      epoch: { signal: new AbortController().signal },
      recovered: false,
    });
    harness.deliver(
      ConnectorServerMessageSchema.parse({
        protocol_version: "1.0",
        type: "ack",
        message_id: randomUUID(),
        sequence: 1,
        correlation_id: randomUUID(),
        sent_at: new Date(WALL).toISOString(),
        expires_at: new Date(WALL + 60_000).toISOString(),
        payload: { sequence: 1 },
      }),
    );
    expect(harness.registry.revisionFor(jobId, 1, at(0))).toBeUndefined();
  });

  it("clears an entry and latches disposal", () => {
    const harness = build();
    const jobId = randomUUID();
    harness.deliver(stateEnvelope(jobId));
    expect(harness.registry.revisionFor(jobId, 1, at(0))).toBe(7);
    harness.registry.clear(jobId, 1);
    expect(harness.registry.revisionFor(jobId, 1, at(0))).toBeUndefined();
    harness.deliver(stateEnvelope(jobId));
    harness.registry.dispose();
    expect(harness.registry.revisionFor(jobId, 1, at(0))).toBeUndefined();
  });
});
