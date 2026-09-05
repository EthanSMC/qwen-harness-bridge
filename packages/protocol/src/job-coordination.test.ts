import { describe, expect, it } from "vitest";
import {
  ConnectorClientMessageSchema,
  ConnectorEnvelopeSchema,
  ConnectorHelloPayloadSchema,
  ConnectorServerMessageSchema,
  ConnectorWelcomePayloadSchema,
  EnvelopeSchema,
  JobClaimPayloadSchema,
  type JobStatePayload,
  JobStatePayloadSchema,
  type JobSyncPayload,
  JobSyncPayloadSchema,
} from "./connector.js";

const job = "11111111-1111-4111-8111-111111111111";
const nonce = "33333333-3333-4333-8333-333333333333";
const uuidUpper = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
const uuidLower = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
const sync = { job_id: job, attempt: 1, nonce };
const state = {
  job_id: job,
  repository_id: "example-repo",
  mode: "normal",
  requested_attempt: 1,
  current_attempt: 0,
  status: "queued",
  job_revision: 0,
  cancel_revision: null,
  lease_id: null,
  lease_expires_at: null,
  expires_at: "2026-09-05T11:00:00Z",
  observed_at: "2026-09-05T12:00:00.123456Z",
  state_valid_until: "2026-09-05T12:00:02.123456Z",
  request_message_id: "22222222-2222-4222-8222-222222222222",
  request_sequence: 1,
  nonce,
};

describe("job coordination payload validation", () => {
  it("returns complete sync and expired descriptive state without adding fields", () => {
    const parsedSync: JobSyncPayload = JobSyncPayloadSchema.parse(sync);
    const parsedState: JobStatePayload = JobStatePayloadSchema.parse(state);
    expect(parsedSync).toEqual(sync);
    expect(parsedState).toEqual(state);
  });

  for (const field of ["job_id", "nonce"] as const) {
    it(`normalizes sync ${field}`, () => {
      expect(
        JobSyncPayloadSchema.parse({ ...sync, [field]: uuidUpper })[field],
      ).toBe(uuidLower);
    });
  }
  for (const field of [
    "job_id",
    "nonce",
    "request_message_id",
    "lease_id",
  ] as const) {
    it(`normalizes state ${field}`, () => {
      expect(
        JobStatePayloadSchema.parse({
          ...state,
          lease_id: job,
          lease_expires_at: state.expires_at,
          [field]: uuidUpper,
        })[field],
      ).toBe(uuidLower);
    });
  }

  for (const mode of ["normal", "read_only"]) {
    it.each([
      "queued",
      "dispatched",
      "running",
      "waiting_approval",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ])(
      `accepts descriptive ${mode} %s without admission assumptions`,
      (status) => {
        expect(
          JobStatePayloadSchema.safeParse({
            ...state,
            mode,
            status,
            requested_attempt: 9,
            lease_id: job,
            lease_expires_at: state.expires_at,
          }).success,
        ).toBe(true);
      },
    );
  }

  for (const [name, fixture, parse] of [
    ["sync", sync, (value: unknown) => JobSyncPayloadSchema.safeParse(value)],
    [
      "state",
      state,
      (value: unknown) => JobStatePayloadSchema.safeParse(value),
    ],
  ] as const) {
    it(`${name} rejects unknown fields and nonobjects`, () => {
      for (const value of [{ ...fixture, extra: true }, null, [], "{}", 1])
        expect(parse(value).success).toBe(false);
    });
    for (const field of Object.keys(fixture)) {
      it(`${name} requires ${field} with no coercion or defaults`, () => {
        const missing: Record<string, unknown> = { ...fixture };
        delete missing[field];
        expect(parse(missing).success).toBe(false);
        for (const value of [undefined, true, {}, [], "1"]) {
          expect(parse({ ...fixture, [field]: value }).success).toBe(false);
        }
      });
    }
  }

  for (const [field, minimum] of [
    ["attempt", 1],
    ["requested_attempt", 1],
    ["current_attempt", 0],
    ["job_revision", 0],
    ["cancel_revision", 0],
  ] as const) {
    it(`enforces PostgreSQL integer bounds on ${field}`, () => {
      const parse = (value: unknown) =>
        field === "attempt"
          ? JobSyncPayloadSchema.safeParse({ ...sync, attempt: value })
          : JobStatePayloadSchema.safeParse({
              ...state,
              job_revision: 2147483647,
              [field]: value,
            });
      for (const value of [minimum, 2147483647])
        expect(parse(value).success).toBe(true);
      for (const value of [
        minimum - 1,
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        2147483648,
        Number.MAX_SAFE_INTEGER,
        "1",
      ])
        expect(parse(value).success).toBe(false);
    });
  }
  it("keeps request_sequence in the independent positive safe-integer domain", () => {
    for (const request_sequence of [1, 2147483648, Number.MAX_SAFE_INTEGER])
      expect(
        JobStatePayloadSchema.safeParse({ ...state, request_sequence }).success,
      ).toBe(true);
    for (const request_sequence of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
    ])
      expect(
        JobStatePayloadSchema.safeParse({ ...state, request_sequence }).success,
      ).toBe(false);
  });
  it("accepts null, earlier and equal cancellation provenance but rejects a future revision", () => {
    for (const cancel_revision of [null, 0, 2, 3])
      expect(
        JobStatePayloadSchema.safeParse({
          ...state,
          job_revision: 3,
          cancel_revision,
        }).success,
      ).toBe(true);
    expect(
      JobStatePayloadSchema.safeParse({
        ...state,
        job_revision: 3,
        cancel_revision: 4,
      }).success,
    ).toBe(false);
  });
  it("requires lease fields to be null together", () => {
    expect(
      JobStatePayloadSchema.safeParse({ ...state, lease_id: job }).success,
    ).toBe(false);
    expect(
      JobStatePayloadSchema.safeParse({
        ...state,
        lease_expires_at: state.expires_at,
      }).success,
    ).toBe(false);
  });
  it("rejects invalid identities and enums", () => {
    for (const field of ["job_id", "nonce"])
      expect(
        JobSyncPayloadSchema.safeParse({ ...sync, [field]: "invalid" }).success,
      ).toBe(false);
    for (const field of [
      "job_id",
      "nonce",
      "request_message_id",
      "lease_id",
      "repository_id",
      "mode",
      "status",
    ])
      expect(
        JobStatePayloadSchema.safeParse({
          ...state,
          lease_id: job,
          lease_expires_at: state.expires_at,
          [field]: "INVALID/alias",
        }).success,
      ).toBe(false);
  });

  for (const field of [
    "expires_at",
    "observed_at",
    "state_valid_until",
    "lease_expires_at",
  ]) {
    it.each([
      "2026-02-29T12:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-00-05T12:00:00Z",
      "2026-09-00T12:00:00Z",
      "2026-09-05T24:00:00Z",
      "2026-09-05T12:00:60Z",
      "2026-09-05T12:00:00+24:00",
      "2026-09-05T12:00:00+00:60",
      "2026-09-05T12:00:00",
      "not-a-time",
    ])(`rejects invalid ${field}: %s`, (value) => {
      expect(
        JobStatePayloadSchema.safeParse({
          ...state,
          lease_id: job,
          lease_expires_at: state.expires_at,
          [field]: value,
        }).success,
      ).toBe(false);
    });
  }
  it.each([
    ["2026-09-05T12:00:00.123456Z", "2026-09-05T14:00:02.123456000+02:00"],
    ["2026-09-05T07:00:00-05:00", "2026-09-05T12:00:02.000Z"],
    [
      "2024-02-29T23:59:59.1234567890123456789Z",
      "2024-03-01T00:00:01.123456789012345678900Z",
    ],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z"],
  ])(
    "accepts exactly two seconds from %s to %s",
    (observed_at, state_valid_until) => {
      expect(
        JobStatePayloadSchema.safeParse({
          ...state,
          observed_at,
          state_valid_until,
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    "2026-09-05T12:00:02.123455Z",
    "2026-09-05T12:00:02.123457Z",
    "2026-09-05T12:00:02.123456000000000001Z",
    "2026-09-05T12:00:01.123456Z",
    "2026-09-05T12:00:03.123456Z",
    "2026-09-05T12:00:00.123456Z",
  ])(
    "rejects inexact validity including submillisecond near miss %s",
    (state_valid_until) => {
      expect(
        JobStatePayloadSchema.safeParse({ ...state, state_valid_until })
          .success,
      ).toBe(false);
    },
  );
});

describe("negotiated coordination envelopes", () => {
  const envelope = {
    protocol_version: "1.0",
    message_id: job,
    sequence: 1,
    sent_at: "2026-09-05T12:00:00Z",
    expires_at: "2026-09-05T12:01:00Z",
    correlation_id: nonce,
  };
  it("accepts sync only clientward and state only serverward", () => {
    for (const schema of [ConnectorEnvelopeSchema, EnvelopeSchema]) {
      expect(
        schema.safeParse({ ...envelope, type: "job.sync", payload: sync })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...envelope, type: "job.state", payload: state })
          .success,
      ).toBe(true);
    }
    expect(
      ConnectorClientMessageSchema.safeParse({
        ...envelope,
        type: "job.sync",
        payload: sync,
      }).success,
    ).toBe(true);
    expect(
      ConnectorServerMessageSchema.safeParse({
        ...envelope,
        type: "job.state",
        payload: state,
      }).success,
    ).toBe(true);
    expect(
      ConnectorServerMessageSchema.safeParse({
        ...envelope,
        type: "job.sync",
        payload: sync,
      }).success,
    ).toBe(false);
    expect(
      ConnectorClientMessageSchema.safeParse({
        ...envelope,
        type: "job.state",
        payload: state,
      }).success,
    ).toBe(false);
  });
  it("preserves legacy attempt bounds and optional capability behavior", () => {
    expect(
      JobClaimPayloadSchema.safeParse({
        job_id: job,
        attempt: Number.MAX_SAFE_INTEGER,
        lease_id: nonce,
      }).success,
    ).toBe(true);
    const hello = { connector_id: job, last_server_sequence: 0 };
    const welcome = { connector_id: job, server_sequence: 0, replay_from: 0 };
    expect(ConnectorHelloPayloadSchema.parse(hello)).toEqual(hello);
    expect(ConnectorWelcomePayloadSchema.parse(welcome)).toEqual(welcome);
    expect(
      ConnectorClientMessageSchema.safeParse({
        ...envelope,
        type: "connector.hello",
        payload: hello,
      }).success,
    ).toBe(true);
    expect(
      ConnectorServerMessageSchema.safeParse({
        ...envelope,
        type: "connector.welcome",
        payload: welcome,
      }).success,
    ).toBe(true);
  });
  it.each([
    ["job.sync", sync, ConnectorClientMessageSchema],
    ["job.state", state, ConnectorServerMessageSchema],
  ] as const)(
    "checks outer identity, expiry and strict shape for %s",
    (type, payload, schema) => {
      const valid = { ...envelope, type, payload };
      for (const invalid of [
        { ...valid, message_id: "invalid" },
        { ...valid, correlation_id: "invalid" },
        { ...valid, sequence: 0 },
        { ...valid, protocol_version: "2.0" },
        { ...valid, expires_at: envelope.sent_at },
        { ...valid, expires_at: "2026-09-05T11:59:59Z" },
        { ...valid, payload: { ...payload, request: "unapproved field" } },
      ])
        expect(schema.safeParse(invalid).success).toBe(false);
    },
  );
});
