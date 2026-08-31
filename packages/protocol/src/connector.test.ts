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
  SequenceCursor,
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
const validActionFingerprint = `sha256:${"a".repeat(64)}`;

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
          action_fingerprint: validActionFingerprint,
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
          action_fingerprint: validActionFingerprint,
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

  it("requires approval expiry to be later than the envelope sent_at", () => {
    const approval = {
      ...commonEnvelope,
      type: "approval.requested" as const,
      payload: {
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 2,
        action_summary: "Install a package",
        impact_summary: "Changes dependencies",
        risk_class: "approval_required",
        action_fingerprint: validActionFingerprint,
        expires_at: "2026-09-01T00:05:00.000Z",
      },
    };
    expect(ConnectorClientMessageSchema.parse(approval).type).toBe(
      "approval.requested",
    );
    expect(() =>
      ConnectorClientMessageSchema.parse({
        ...approval,
        payload: { ...approval.payload, expires_at: approval.sent_at },
      }),
    ).toThrow();
    expect(() =>
      ConnectorClientMessageSchema.parse({
        ...approval,
        payload: {
          ...approval.payload,
          expires_at: "2026-08-31T23:59:59.000Z",
        },
      }),
    ).toThrow();
    expect(() =>
      ConnectorClientMessageSchema.parse({
        ...approval,
        sent_at: "2026-09-01T08:00:00.000+08:00",
        expires_at: "2026-09-01T00:01:00.000Z",
        payload: {
          ...approval.payload,
          expires_at: "2026-09-01T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("accepts only canonical SHA-256 action fingerprints", () => {
    expect(
      ApprovalRequestedPayloadSchema.parse({
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        action_summary: "Install a package",
        impact_summary: "Changes dependencies",
        risk_class: "approval_required",
        action_fingerprint: validActionFingerprint,
        expires_at: "2026-09-01T00:05:00.000Z",
      }).action_fingerprint,
    ).toBe(validActionFingerprint);

    expect(
      ApprovalDecisionPayloadSchema.parse({
        approval_id: ids.approval,
        job_id: ids.job,
        attempt: 1,
        job_revision: 0,
        action_fingerprint: validActionFingerprint,
        decision: "approve",
      }).action_fingerprint,
    ).toBe(validActionFingerprint);

    for (const action_fingerprint of [
      "sha256:one",
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      `sha-256:${"a".repeat(64)}`,
    ]) {
      expect(() =>
        ApprovalRequestedPayloadSchema.parse({
          approval_id: ids.approval,
          job_id: ids.job,
          attempt: 1,
          job_revision: 0,
          action_summary: "Install a package",
          impact_summary: "Changes dependencies",
          risk_class: "approval_required",
          action_fingerprint,
          expires_at: "2026-09-01T00:05:00.000Z",
        }),
      ).toThrow();
      expect(() =>
        ApprovalDecisionPayloadSchema.parse({
          approval_id: ids.approval,
          job_id: ids.job,
          attempt: 1,
          job_revision: 0,
          action_fingerprint,
          decision: "approve",
        }),
      ).toThrow();
    }
  });

  it("rejects malformed UUIDs and RFC 3339 timestamps", () => {
    expect(() =>
      JobClaimPayloadSchema.parse({
        job_id: "not-a-uuid",
        attempt: 1,
        lease_id: ids.lease,
      }),
    ).toThrow();
    expect(() =>
      EnvelopeSchema.parse({
        ...commonEnvelope,
        message_id: "not-a-uuid",
        type: "ack",
        payload: { sequence: 1 },
      }),
    ).toThrow();
    expect(() =>
      EnvelopeSchema.parse({
        ...commonEnvelope,
        correlation_id: "not-a-uuid",
        type: "ack",
        payload: { sequence: 1 },
      }),
    ).toThrow();

    for (const timestamp of [
      "2026-02-29T00:00:00.000Z",
      "2026-09-01T00:00:00.000+24:00",
      "2026-09-01T00:00:00.000+09:60",
      "2026-09-01 00:00:00.000Z",
      "2026-09-01T00:00:00.000",
      "2026-09-01T00:00:00.000+0800",
    ]) {
      expect(() =>
        EnvelopeSchema.parse({
          ...commonEnvelope,
          sent_at: timestamp,
          type: "ack",
          payload: { sequence: 1 },
        }),
      ).toThrow();
    }
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
        action_fingerprint: validActionFingerprint,
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
        action_fingerprint: validActionFingerprint,
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
        action_fingerprint: validActionFingerprint,
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

  it("accepts bounded summaries and rejects unsafe nested event payloads", () => {
    const validEvent = {
      job_id: ids.job,
      attempt: 1,
      event_type: "progress",
      payload: {
        stage: "testing",
        summary: "Running the bounded test summary",
        progress: 0.5,
        details: { completed: 3, artifacts: ["report"] },
        metadata: { token: "[REDACTED]" },
      },
      source: "harness",
    };
    expect(JobEventPayloadSchema.parse(validEvent).payload).toMatchObject({
      stage: "testing",
      details: { completed: 3 },
    });

    const unsafePayloads: Record<string, unknown>[] = [
      { credentials: "not redacted" },
      { secrets: "not redacted" },
      { accessToken: "raw-token" },
      { sourceContent: "const answer = 42" },
      { stdout: "not redacted" },
      { environment: "not redacted" },
      { HOME: "owner-home" },
      { terminal_log: "stdout: raw command output" },
      { nested: { stderr: "raw terminal output" } },
      { source_content: "const password = 'raw-secret'" },
      { credentials: { api_key: "raw-secret" } },
      { envVars: { HOME: "/Users/alice" } },
      { privateKey: "raw-private-key" },
      { terminalLog: "raw terminal output" },
      { constructor: "raw-constructor-value" },
      { secret: "raw-secret" },
      { token: "raw-token" },
      { password: "raw-password" },
      { environment: { HOME: "owner-home" } },
      { summary: "/Users/alice/project" },
      { summary: "HOME=/Users/alice/project" },
      { summary: "Bearer abcdefghijklmnop" },
      { summary: "https://example.test/run?access_token=raw-token" },
      { summary: "AWS_SECRET_ACCESS_KEY=raw-secret" },
      { summary: "line one\nline two" },
      { summary: "x".repeat(501) },
      { summary: "C:\\Users\\alice\\project" },
      { summary: "file:///Users/alice/project" },
      { summary: "~/project" },
      { toJSON: "not redacted" },
      {
        nested: {
          deeper: {
            values: { too: { deep: { for: { event: { payload: true } } } } },
          },
        },
      },
    ];

    for (const payload of unsafePayloads) {
      expect(() =>
        JobEventPayloadSchema.parse({ ...validEvent, payload }),
      ).toThrow();
    }

    expect(() =>
      JobEventPayloadSchema.parse({
        ...validEvent,
        payload: { items: Array.from({ length: 33 }, (_, index) => index) },
      }),
    ).toThrow();
    expect(() =>
      JobEventPayloadSchema.parse({
        ...validEvent,
        payload: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`field_${index}`, index]),
        ),
      }),
    ).toThrow();
  });

  it("enforces event payload size and nesting boundaries", () => {
    const base = {
      job_id: ids.job,
      attempt: 1,
      event_type: "progress",
      source: "harness",
    };
    expect(
      JobEventPayloadSchema.parse({
        ...base,
        payload: { summary: "x".repeat(500) },
      }),
    ).toMatchObject({ payload: { summary: "x".repeat(500) } });
    expect(
      JobEventPayloadSchema.parse({
        ...base,
        payload: { summary: "stage=testing" },
      }),
    ).toMatchObject({ payload: { summary: "stage=testing" } });
    expect(() =>
      JobEventPayloadSchema.parse({
        ...base,
        payload: { summary: "x".repeat(501) },
      }),
    ).toThrow();

    const withinDepth = { value: "ok" } as Record<string, unknown>;
    let nestedWithinDepth: Record<string, unknown> = withinDepth;
    for (let index = 0; index < 5; index += 1) {
      nestedWithinDepth = { level: nestedWithinDepth };
    }
    expect(
      JobEventPayloadSchema.parse({ ...base, payload: nestedWithinDepth }),
    ).toMatchObject({ payload: { level: expect.anything() } });

    let nestedBeyondDepth: Record<string, unknown> = withinDepth;
    for (let index = 0; index < 6; index += 1) {
      nestedBeyondDepth = { level: nestedBeyondDepth };
    }
    expect(() =>
      JobEventPayloadSchema.parse({ ...base, payload: nestedBeyondDepth }),
    ).toThrow();

    const withinFieldCount = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`field_${index}`, index]),
    );
    expect(
      JobEventPayloadSchema.parse({ ...base, payload: withinFieldCount }),
    ).toMatchObject({ payload: { field_31: 31 } });

    const withinItemCount = Array.from({ length: 32 }, (_, index) => index);
    expect(
      JobEventPayloadSchema.parse({
        ...base,
        payload: { items: withinItemCount },
      }),
    ).toMatchObject({ payload: { items: withinItemCount } });

    const withinByteLimit = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [
        `field_${index}`,
        "x".repeat(500),
      ]),
    );
    expect(
      JobEventPayloadSchema.parse({ ...base, payload: withinByteLimit }),
    ).toMatchObject({ payload: { field_30: "x".repeat(500) } });
    const overByteLimit = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `field_${index}`,
        "x".repeat(500),
      ]),
    );
    expect(() =>
      JobEventPayloadSchema.parse({ ...base, payload: overByteLimit }),
    ).toThrow();
  });

  it("rejects non-JSON event values and cycles", () => {
    const base = {
      job_id: ids.job,
      attempt: 1,
      event_type: "progress",
      source: "harness",
    };
    expect(() =>
      JobEventPayloadSchema.parse({ ...base, payload: { progress: Infinity } }),
    ).toThrow();
    expect(() =>
      JobEventPayloadSchema.parse({
        ...base,
        payload: { generated_at: new Date("2026-09-01T00:00:00.000Z") },
      }),
    ).toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      JobEventPayloadSchema.parse({ ...base, payload: cyclic }),
    ).toThrow();
  });
});

describe("sequence cursor", () => {
  it("accepts increasing sequences and exact duplicates", () => {
    const cursor = new SequenceCursor();

    expect(cursor.accept(1)).toBe("accepted");
    expect(cursor.accept(1)).toBe("duplicate");
    expect(cursor.accept(3)).toBe("accepted");
    expect(cursor.lastSequence).toBe(3);
  });

  it("rejects regressions and invalid sequence values with stable errors", () => {
    const cursor = new SequenceCursor(3);

    expect(() => cursor.accept(2)).toThrow("INVALID_SEQUENCE_ORDER:3:2");
    expect(cursor.lastSequence).toBe(3);
    expect(() => cursor.accept(0)).toThrow("INVALID_SEQUENCE:0");
    expect(() => cursor.accept(Number.NaN)).toThrow("INVALID_SEQUENCE");
  });
});
