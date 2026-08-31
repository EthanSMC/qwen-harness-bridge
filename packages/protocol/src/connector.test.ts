import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ConnectorClientMessageSchema,
  ConnectorEnvelopeSchema,
  ConnectorHeartbeatPayloadSchema,
  ConnectorHelloPayloadSchema,
  ConnectorServerMessageSchema,
  ConnectorWelcomePayloadSchema,
  EnvelopeSchema,
  JobCancelledPayloadSchema,
  JobCancelPayloadSchema,
  JobClaimPayloadSchema,
  JobEventPayloadSchema,
  JobOfferPayloadSchema,
  ProtocolErrorPayloadSchema,
} from "./connector.js";

const ids = {
  connector: crypto.randomUUID(),
  job: crypto.randomUUID(),
  lease: crypto.randomUUID(),
  approval: crypto.randomUUID(),
};

const commonEnvelope = {
  protocol_version: "1.0" as const,
  message_id: crypto.randomUUID(),
  sequence: 1,
  sent_at: "2026-09-01T00:00:00.000Z",
  expires_at: "2026-09-01T00:01:00.000Z",
  correlation_id: crypto.randomUUID(),
};

describe("connector envelope", () => {
  it("rejects unsupported versions and invalid expiry", () => {
    const base = {
      protocol_version: "2.0",
      message_id: crypto.randomUUID(),
      sequence: 1,
      sent_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-01T00:01:00.000Z",
      correlation_id: crypto.randomUUID(),
      type: "ack",
      payload: { sequence: 1 },
    };
    expect(() => ConnectorEnvelopeSchema.parse(base)).toThrow();

    const valid = {
      ...base,
      protocol_version: "1.0",
    };
    expect(ConnectorEnvelopeSchema.parse(valid)).toMatchObject({
      protocol_version: "1.0",
      type: "ack",
    });
    expect(() =>
      ConnectorEnvelopeSchema.parse({
        ...valid,
        expires_at: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      ConnectorEnvelopeSchema.parse({
        ...valid,
        sequence: 0,
      }),
    ).toThrow();
    expect(() =>
      ConnectorEnvelopeSchema.parse({
        ...valid,
        unexpected: true,
      }),
    ).toThrow();
  });

  it("accepts the versioned client and server message unions", () => {
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        type: "connector.hello",
        payload: {
          connector_id: ids.connector,
          connector_version: "0.1.0",
          capabilities: ["harness"],
          last_server_sequence: 0,
          last_client_sequence: 0,
        },
      }).type,
    ).toBe("connector.hello");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "connector.heartbeat",
        payload: {},
      }).type,
    ).toBe("connector.heartbeat");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "job.claim",
        payload: { job_id: ids.job, attempt: 1, lease_id: ids.lease },
      }).type,
    ).toBe("job.claim");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "job.event",
        payload: {
          job_id: ids.job,
          attempt: 1,
          event_type: "progress",
          payload: { stage: "testing" },
          source: "harness",
        },
      }).type,
    ).toBe("job.event");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "approval.requested",
        payload: {
          approval_id: ids.approval,
          job_id: ids.job,
          attempt: 1,
          job_revision: 2,
          action_summary: "Install a package",
          impact_summary: "Changes the local dependency tree",
          risk_class: "approval_required",
          action_fingerprint: "sha256:one",
          expires_at: "2026-09-01T00:05:00.000Z",
        },
      }).type,
    ).toBe("approval.requested");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "job.cancelled",
        payload: { job_id: ids.job, attempt: 1, reason: "user requested" },
      }).type,
    ).toBe("job.cancelled");
    expect(
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "ack",
        payload: { sequence: 1 },
      }).type,
    ).toBe("ack");

    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        type: "connector.welcome",
        payload: {
          connector_id: ids.connector,
          server_sequence: 1,
          replay_from: 1,
        },
      }).type,
    ).toBe("connector.welcome");
    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "job.offer",
        payload: {
          job_id: ids.job,
          attempt: 1,
          lease_id: ids.lease,
          repository_id: "novelty-studio",
          request: "run the tests",
        },
      }).type,
    ).toBe("job.offer");
    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "job.cancel",
        payload: {
          job_id: ids.job,
          attempt: 1,
          job_revision: 2,
          reason: "expired",
          nonce: crypto.randomUUID(),
        },
      }).type,
    ).toBe("job.cancel");
    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "approval.decision",
        payload: {
          approval_id: ids.approval,
          job_id: ids.job,
          attempt: 1,
          job_revision: 2,
          action_fingerprint: "sha256:one",
          decision: "approve",
        },
      }).type,
    ).toBe("approval.decision");
    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "protocol.error",
        payload: { code: "INVALID_SEQUENCE", message: "Sequence gap" },
      }).type,
    ).toBe("protocol.error");
    expect(
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        message_id: crypto.randomUUID(),
        type: "ack",
        payload: { sequence: 1 },
      }).type,
    ).toBe("ack");

    expect(() =>
      ConnectorClientMessageSchema.parse({
        ...commonEnvelope,
        type: "job.offer",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      ConnectorServerMessageSchema.parse({
        ...commonEnvelope,
        type: "job.event",
        payload: {},
      }),
    ).toThrow();
  });

  it("keeps every payload object strict and bounded", () => {
    expect(
      ConnectorHelloPayloadSchema.parse({
        connector_id: ids.connector,
        last_server_sequence: 0,
      }),
    ).toMatchObject({ connector_id: ids.connector });
    expect(ConnectorHeartbeatPayloadSchema.parse({})).toEqual({});
    expect(
      JobClaimPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        lease_id: ids.lease,
      }),
    ).toMatchObject({ job_id: ids.job });
    expect(
      JobEventPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        event_type: "progress",
        payload: {},
        source: "harness",
      }),
    ).toMatchObject({ event_type: "progress" });
    expect(
      ApprovalRequestedPayloadSchema.parse({
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        action_summary: "Install a package",
        impact_summary: "Changes dependencies",
        risk_class: "approval_required",
        action_fingerprint: "sha256:one",
        expires_at: "2026-09-01T00:05:00.000Z",
      }),
    ).toMatchObject({ approval_id: ids.approval });
    expect(
      JobCancelledPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        reason: "cancelled",
      }),
    ).toMatchObject({ job_id: ids.job });
    expect(
      ConnectorWelcomePayloadSchema.parse({
        connector_id: ids.connector,
        server_sequence: 1,
        replay_from: 1,
      }),
    ).toMatchObject({ connector_id: ids.connector });
    expect(
      JobOfferPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        lease_id: ids.lease,
        repository_id: "novelty-studio",
        request: "run the tests",
      }),
    ).toMatchObject({ repository_id: "novelty-studio" });
    expect(
      JobCancelPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        reason: "expired",
        nonce: crypto.randomUUID(),
      }),
    ).toMatchObject({ job_id: ids.job });
    expect(
      ApprovalDecisionPayloadSchema.parse({
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        action_fingerprint: "sha256:one",
        decision: "reject",
      }),
    ).toMatchObject({ decision: "reject" });
    expect(
      ProtocolErrorPayloadSchema.parse({
        code: "INVALID_SEQUENCE",
        message: "Sequence gap",
      }),
    ).toMatchObject({ code: "INVALID_SEQUENCE" });

    expect(() =>
      JobClaimPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        lease_id: ids.lease,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      EnvelopeSchema.parse({
        ...commonEnvelope,
        type: "ack",
        payload: { sequence: 0 },
      }),
    ).toThrow();
    expect(() =>
      ConnectorHeartbeatPayloadSchema.parse({ unexpected: true }),
    ).toThrow();
    expect(() =>
      ConnectorHelloPayloadSchema.parse({
        connector_id: ids.connector,
        last_server_sequence: 0,
        capabilities: ["x".repeat(65)],
      }),
    ).toThrow();
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        action_summary: "x".repeat(401),
        impact_summary: "Changes dependencies",
        risk_class: "approval_required",
        action_fingerprint: "sha256:one",
        expires_at: "2026-09-01T00:05:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      JobOfferPayloadSchema.parse({
        job_id: ids.job,
        attempt: 1,
        lease_id: ids.lease,
        repository_id: "novelty-studio",
        request: "x".repeat(4001),
      }),
    ).toThrow();
    expect(() =>
      ProtocolErrorPayloadSchema.parse({
        code: "INVALID_SEQUENCE",
        message: "x".repeat(401),
      }),
    ).toThrow();
  });
});
