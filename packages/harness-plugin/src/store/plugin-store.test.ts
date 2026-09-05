import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type OutboundEventInput,
  SqlitePluginStore,
  StoreInboundConflictError,
  StoreSequenceError,
} from "./plugin-store.js";

const temporaryDirectories: string[] = [];

const coordinationId = "22222222-2222-4222-8222-222222222222";
const coordinationJob = "11111111-1111-4111-8111-111111111111";
const coordinationNonce = "33333333-3333-4333-8333-333333333333";
const coordinationEnvelope = {
  protocol_version: "1.0",
  message_id: coordinationId,
  sequence: 1,
  sent_at: "2026-09-05T12:00:00Z",
  expires_at: "2026-09-05T12:01:00Z",
  correlation_id: coordinationNonce,
};
const coordinationRequest = (): OutboundEventInput => ({
  messageId: coordinationId,
  sequence: 1,
  expectedReceiptProfile: "job-coordination-v1",
  payload: JSON.stringify({
    ...coordinationEnvelope,
    type: "job.sync",
    payload: { job_id: coordinationJob, attempt: 1, nonce: coordinationNonce },
  }),
});

const databaseSnapshot = (database: Database.Database) => ({
  outbound: database
    .prepare("SELECT * FROM outbound_events ORDER BY sequence")
    .all(),
  inbound: database
    .prepare("SELECT * FROM inbound_messages ORDER BY sequence")
    .all(),
  metadata: database.prepare("SELECT * FROM metadata ORDER BY key").all(),
});

const coordinationState = {
  job_id: coordinationJob,
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
  request_message_id: coordinationId,
  request_sequence: 1,
  nonce: coordinationNonce,
};
const coordinationResponse = (
  payload: unknown = coordinationState,
  type = "job.state",
  messageId = coordinationJob,
) => ({
  ...coordinationEnvelope,
  message_id: messageId,
  type,
  payload,
});
const expiryResponse = () =>
  coordinationResponse(
    {
      code: "MESSAGE_EXPIRED",
      message: "A Connector message expired before delivery.",
    },
    "protocol.error",
    coordinationNonce,
  );
const evidence = { coordinationRequestSequence: 1 };

describe("immutable coordination receipts", () => {
  it("rejects malformed supplied evidence instead of using the legacy overload", () => {
    const store = new SqlitePluginStore(makeDatabasePath());
    store.enqueueEvent(coordinationRequest());
    for (const invalid of [
      {},
      null,
      { coordinationRequestSequence: undefined },
    ]) {
      expect(() =>
        store.recordInbound(
          coordinationJob,
          1,
          JSON.stringify(coordinationResponse()),
          invalid as unknown as typeof evidence,
        ),
      ).toThrow("STORE_INBOUND_WRITE_FAILED");
      expect(store.maxInboundSequence()).toBe(0);
    }
    store.close();
  });
  it.each([
    [
      "job.sync",
      { job_id: coordinationJob, attempt: 1, nonce: coordinationNonce },
      "JOB_AUTHORITY_UNAVAILABLE",
      "The job authority is unavailable.",
    ],
    [
      "job.claim",
      { job_id: coordinationJob, attempt: 1, lease_id: coordinationNonce },
      "CLAIM_REJECTED",
      "The job authority has changed.",
    ],
    [
      "job.claim",
      { job_id: coordinationJob, attempt: 1, lease_id: coordinationNonce },
      "CLAIM_REJECTED",
      "The job business limit has been reached.",
    ],
    [
      "job.cancelled",
      { job_id: coordinationJob, attempt: 1, reason: "cancelled" },
      "EVENT_REJECTED",
      "The job authority has changed.",
    ],
    [
      "job.cancelled",
      { job_id: coordinationJob, attempt: 1, reason: "cancelled" },
      "EVENT_REJECTED",
      "The job business limit has been reached.",
    ],
    [
      "job.event",
      {
        job_id: coordinationJob,
        attempt: 1,
        event_type: "progress",
        payload: {},
        source: "harness",
      },
      "EVENT_REJECTED",
      "The job authority has changed.",
    ],
    [
      "job.event",
      {
        job_id: coordinationJob,
        attempt: 1,
        event_type: "progress",
        payload: {},
        source: "harness",
      },
      "EVENT_REJECTED",
      "The job business limit has been reached.",
    ],
    [
      "approval.requested",
      {
        approval_id: coordinationNonce,
        job_id: coordinationJob,
        attempt: 1,
        job_revision: 1,
        action_summary: "Run tests",
        impact_summary: "Test output",
        risk_class: "low",
        action_fingerprint: `sha256:${"a".repeat(64)}`,
        expires_at: "2026-09-05T12:01:00Z",
      },
      "EVENT_REJECTED",
      "The job authority has changed.",
    ],
    [
      "approval.requested",
      {
        approval_id: coordinationNonce,
        job_id: coordinationJob,
        attempt: 1,
        job_revision: 1,
        action_summary: "Run tests",
        impact_summary: "Test output",
        risk_class: "low",
        action_fingerprint: `sha256:${"a".repeat(64)}`,
        expires_at: "2026-09-05T12:01:00Z",
      },
      "EVENT_REJECTED",
      "The job business limit has been reached.",
    ],
  ])(
    "retains only the exact safe disposition for %s",
    (type, payload, code, message) => {
      const path = makeDatabasePath();
      const store = new SqlitePluginStore(path);
      const database = new Database(path);
      store.enqueueEvent({
        ...coordinationRequest(),
        payload: JSON.stringify({ ...coordinationEnvelope, type, payload }),
      });
      const before = databaseSnapshot(database);
      for (const invalid of [
        { code, message: "The business deadline has expired." },
        { code: "INTERNAL", message },
        { code, message, extra: true },
      ]) {
        expect(() =>
          store.recordInbound(
            coordinationJob,
            1,
            JSON.stringify(coordinationResponse(invalid, "protocol.error")),
            evidence,
          ),
        ).toThrow();
        expect(databaseSnapshot(database)).toEqual(before);
      }
      store.acknowledgeThrough(1, coordinationNonce);
      store.recordInbound(
        coordinationJob,
        1,
        JSON.stringify(
          coordinationResponse({ code, message }, "protocol.error"),
        ),
        evidence,
      );
      expect(store.coordinationReceipt(1)?.responsePayloadJson).toBe(
        JSON.stringify({ code, message }),
      );
      expect(
        store.coordinationRequest(coordinationNonce)?.acknowledgedAt,
      ).not.toBeNull();
      database.close();
      store.close();
    },
  );
  it("stores canonical expired descriptive evidence without ACK or cursor authority", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    store.enqueueEvent(coordinationRequest());
    const response = coordinationResponse();
    expect(
      store.recordInbound(
        response.message_id,
        1,
        JSON.stringify(response),
        evidence,
      ),
    ).toBe("new");
    const receipt = store.coordinationReceipt(1);
    expect(receipt).toEqual({
      expectedReceiptProfile: "job-coordination-v1",
      requestSequence: 1,
      requestMessageId: coordinationId,
      requestCorrelationId: coordinationNonce,
      requestType: "job.sync",
      responseSequence: 1,
      responseCorrelationId: coordinationNonce,
      responseType: "job.state",
      responsePayloadJson: JSON.stringify(
        Object.fromEntries(
          Object.entries(coordinationState).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      ),
    });
    expect(store.provenClientSequence()).toBe(0);
    expect(store.outboundEvent(1)?.acknowledgedAt).toBeNull();
    store.markInboundExpired(response.message_id);
    store.acknowledgeThrough(1, coordinationNonce);
    store.close();
    const reopened = new SqlitePluginStore(path);
    expect(reopened.coordinationReceipt(1)).toEqual(receipt);
    reopened.close();
  });

  it.each([
    { request_message_id: coordinationNonce },
    { request_sequence: 2 },
    { job_id: coordinationNonce },
    { nonce: coordinationJob },
    { requested_attempt: 2 },
    { state_valid_until: "2026-09-05T12:00:03Z" },
    { cancel_revision: 1 },
  ])("rejects invalid state binding %j atomically", (patch) => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const before = databaseSnapshot(database);
    expect(() =>
      store.recordInbound(
        coordinationJob,
        1,
        JSON.stringify(
          coordinationResponse({ ...coordinationState, ...patch }),
        ),
        evidence,
      ),
    ).toThrow();
    expect(databaseSnapshot(database)).toEqual(before);
    database.close();
    store.close();
  });

  it("retains original evidence across tombstones and requires exact proven restoration", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const original = JSON.stringify(coordinationResponse());
    store.recordInbound(coordinationJob, 1, original, evidence);
    store.markInboundDelivered(coordinationJob);
    const receipt = store.coordinationReceipt(1);
    const tombstone = JSON.stringify(expiryResponse());
    store.replaceInbound({
      previousMessageId: coordinationJob,
      previousBody: original,
      messageId: coordinationNonce,
      sequence: 1,
      body: tombstone,
    });
    expect(store.coordinationReceipt(1)).toEqual(receipt);
    const before = databaseSnapshot(database);
    const restore = {
      previousMessageId: coordinationNonce,
      previousBody: tombstone,
      messageId: coordinationJob,
      sequence: 1,
      body: original,
    };
    expect(() => store.replaceInbound(restore)).toThrow();
    expect(() =>
      store.replaceInbound({
        ...restore,
        ...evidence,
        body: JSON.stringify(
          coordinationResponse({ ...coordinationState, job_revision: 1 }),
        ),
      }),
    ).toThrow();
    expect(databaseSnapshot(database)).toEqual(before);
    const reordered = JSON.stringify(
      coordinationResponse(
        Object.fromEntries(Object.entries(coordinationState).reverse()),
      ),
    );
    store.replaceInbound({ ...restore, body: reordered, ...evidence });
    expect(store.coordinationReceipt(1)).toEqual(receipt);
    expect(store.inboundMessage(coordinationJob)?.delivered).toBe(false);
    expect(store.recordInbound(coordinationJob, 1, reordered, evidence)).toBe(
      "duplicate",
    );
    const restored = databaseSnapshot(database);
    expect(() =>
      store.recordInbound(coordinationJob, 1, reordered, {
        coordinationRequestSequence: 2,
      }),
    ).toThrow();
    expect(() => store.recordInbound(coordinationJob, 1, reordered)).toThrow();
    expect(databaseSnapshot(database)).toEqual(restored);
    database.close();
    store.close();
  });

  it("establishes first evidence only from a proven original after an exact tombstone", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const tombstone = JSON.stringify(expiryResponse());
    store.recordInbound(coordinationNonce, 1, tombstone);
    store.markInboundExpired(coordinationNonce);
    expect(store.coordinationReceipt(1)).toBeUndefined();
    database.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON metadata WHEN NEW.key = 'inbound-coordination-receipt:1' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    const replacement = {
      previousMessageId: coordinationNonce,
      previousBody: tombstone,
      messageId: coordinationJob,
      sequence: 1,
      body: JSON.stringify(coordinationResponse()),
      ...evidence,
    };
    try {
      const before = databaseSnapshot(database);
      expect(() => store.replaceInbound(replacement)).toThrow(
        "STORE_INBOUND_WRITE_FAILED",
      );
      expect(databaseSnapshot(database)).toEqual(before);
    } finally {
      database.exec("DROP TRIGGER fail_receipt");
    }
    store.replaceInbound(replacement);
    expect(store.coordinationReceipt(1)?.requestSequence).toBe(1);
    database.close();
    store.close();
  });

  it("does not retrofit unknown already received history", () => {
    const store = new SqlitePluginStore(makeDatabasePath());
    store.enqueueEvent(coordinationRequest());
    const body = JSON.stringify(coordinationResponse());
    store.recordInbound(coordinationJob, 1, body);
    expect(() =>
      store.recordInbound(coordinationJob, 1, body, evidence),
    ).toThrow();
    expect(store.coordinationReceipt(1)).toBeUndefined();
    store.close();
  });

  it.each([
    "missing",
    "legacy",
    "corrupt-profile",
    "request-id",
    "request-sequence",
    "request-json",
    "response-id",
    "response-sequence",
    "correlation",
    "type",
    "request-type",
    "error-category",
  ])("fails closed on %s evidence", (fault) => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    if (fault !== "missing") store.enqueueEvent(coordinationRequest());
    if (fault === "legacy") database.prepare("DELETE FROM metadata").run();
    if (fault === "corrupt-profile")
      database.prepare("UPDATE metadata SET value = 'unknown'").run();
    if (fault === "request-id")
      database
        .prepare("UPDATE outbound_events SET message_id = ?")
        .run(coordinationNonce);
    if (fault === "request-sequence")
      database
        .prepare(
          "UPDATE outbound_events SET payload_json = json_set(payload_json, '$.sequence', 2)",
        )
        .run();
    if (fault === "request-json")
      database.prepare("UPDATE outbound_events SET payload_json = '{}'").run();
    if (fault === "request-type")
      database.prepare("UPDATE outbound_events SET payload_json = ?").run(
        JSON.stringify({
          ...coordinationEnvelope,
          type: "job.claim",
          payload: {
            job_id: coordinationJob,
            attempt: 1,
            lease_id: coordinationNonce,
          },
        }),
      );
    const response = {
      ...coordinationResponse(),
      ...(fault === "response-id" ? { message_id: coordinationNonce } : {}),
      ...(fault === "response-sequence" ? { sequence: 2 } : {}),
      ...(fault === "correlation" ? { correlation_id: coordinationJob } : {}),
      ...(fault === "type" ? { type: "ack", payload: { sequence: 1 } } : {}),
      ...(fault === "error-category"
        ? {
            type: "protocol.error",
            payload: {
              code: "CLAIM_REJECTED",
              message: "The job authority has changed.",
            },
          }
        : {}),
    };
    const before = databaseSnapshot(database);
    expect(() =>
      store.recordInbound(
        coordinationJob,
        1,
        JSON.stringify(response),
        evidence,
      ),
    ).toThrow("STORE_INBOUND_WRITE_FAILED");
    expect(databaseSnapshot(database)).toEqual(before);
    database.close();
    store.close();
  });

  it("rolls back first row and descriptor on either insertion failure", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    for (const trigger of [
      "CREATE TRIGGER fail_initial BEFORE INSERT ON metadata WHEN NEW.key = 'inbound-coordination-receipt:1' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      "CREATE TRIGGER fail_initial BEFORE INSERT ON inbound_messages WHEN NEW.sequence = 1 BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    ]) {
      database.exec(trigger);
      try {
        const before = databaseSnapshot(database);
        expect(() =>
          store.recordInbound(
            coordinationJob,
            1,
            JSON.stringify(coordinationResponse()),
            evidence,
          ),
        ).toThrow("STORE_INBOUND_WRITE_FAILED");
        expect(databaseSnapshot(database)).toEqual(before);
      } finally {
        database.exec("DROP TRIGGER fail_initial");
      }
    }
    database.close();
    store.close();
  });

  it.each(["payload", "message", "correlation", "sequence"])(
    "rejects generic replacement bypass through %s",
    (fault) => {
      const path = makeDatabasePath();
      const store = new SqlitePluginStore(path);
      const database = new Database(path);
      store.enqueueEvent(coordinationRequest());
      const original = JSON.stringify(coordinationResponse());
      store.recordInbound(coordinationJob, 1, original, evidence);
      store.markInboundExpired(coordinationJob);
      const replacement = {
        ...expiryResponse(),
        ...(fault === "payload"
          ? {
              type: "job.state",
              payload: { ...coordinationState, job_revision: 1 },
            }
          : {}),
        ...(fault === "message"
          ? { payload: { code: "MESSAGE_EXPIRED", message: "Expired" } }
          : {}),
        ...(fault === "correlation" ? { correlation_id: coordinationJob } : {}),
        ...(fault === "sequence" ? { sequence: 2 } : {}),
      };
      const before = databaseSnapshot(database);
      expect(() =>
        store.replaceInbound({
          previousMessageId: coordinationJob,
          previousBody: original,
          messageId: coordinationNonce,
          sequence: 1,
          body: JSON.stringify(replacement),
        }),
      ).toThrow();
      expect(databaseSnapshot(database)).toEqual(before);
      database.close();
      store.close();
    },
  );

  it("rejects corrupt, orphaned or contradictory original metadata", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    store.recordInbound(
      coordinationJob,
      1,
      JSON.stringify(coordinationResponse()),
      evidence,
    );
    const original = store.coordinationReceipt(1);
    for (const value of [
      "{}",
      "not-json",
      JSON.stringify({ ...original, requestSequence: 2 }),
      JSON.stringify({ ...original, responseSequence: 2 }),
      JSON.stringify({ ...original, extra: true }),
    ]) {
      database
        .prepare(
          "UPDATE metadata SET value = ? WHERE key = 'inbound-coordination-receipt:1'",
        )
        .run(value);
      expect(() => store.coordinationReceipt(1)).toThrow(
        "STORE_COORDINATION_INVALID",
      );
    }
    database
      .prepare(
        "UPDATE metadata SET value = ? WHERE key = 'inbound-coordination-receipt:1'",
      )
      .run(JSON.stringify(original));
    database.prepare("DELETE FROM inbound_messages").run();
    expect(() => store.coordinationReceipt(1)).toThrow(
      "STORE_COORDINATION_INVALID",
    );
    database.close();
    store.close();
  });

  it("preserves the descriptor and delivered marker when replacement row update fails", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const body = JSON.stringify(coordinationResponse());
    store.recordInbound(coordinationJob, 1, body, evidence);
    store.markInboundDelivered(coordinationJob);
    database.exec(
      "CREATE TRIGGER fail_replacement BEFORE UPDATE ON inbound_messages WHEN OLD.sequence = 1 BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    try {
      const before = databaseSnapshot(database);
      expect(() =>
        store.replaceInbound({
          previousMessageId: coordinationJob,
          previousBody: body,
          messageId: coordinationNonce,
          sequence: 1,
          body: JSON.stringify(expiryResponse()),
        }),
      ).toThrow("STORE_INBOUND_WRITE_FAILED");
      expect(databaseSnapshot(database)).toEqual(before);
    } finally {
      database.exec("DROP TRIGGER fail_replacement");
      database.close();
      store.close();
    }
  });

  it("refuses changed original observation times even with the same nonce and status", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const body = JSON.stringify(coordinationResponse());
    store.recordInbound(coordinationJob, 1, body, evidence);
    const before = databaseSnapshot(database);
    const changed = coordinationResponse(
      {
        ...coordinationState,
        observed_at: "2026-09-05T12:00:01.123456Z",
        state_valid_until: "2026-09-05T12:00:03.123456Z",
      },
      "job.state",
      coordinationNonce,
    );
    expect(() =>
      store.replaceInbound({
        previousMessageId: coordinationJob,
        previousBody: body,
        messageId: coordinationNonce,
        sequence: 1,
        body: JSON.stringify(changed),
        ...evidence,
      }),
    ).toThrow();
    expect(databaseSnapshot(database)).toEqual(before);
    database.close();
    store.close();
  });
});

describe("coordination outbound profiles", () => {
  it("preserves pinned hello atomically with its profile", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    const hello = {
      ...coordinationRequest(),
      payload: JSON.stringify({
        ...coordinationEnvelope,
        type: "connector.hello",
        payload: {
          connector_id: coordinationJob,
          last_server_sequence: 0,
          capabilities: ["job-coordination-v1"],
        },
      }),
    };
    database.exec(
      "CREATE TRIGGER fail_hello_profile BEFORE INSERT ON metadata WHEN NEW.key = 'outbound-receipt-profile:1' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    try {
      const before = databaseSnapshot(database);
      expect(() => store.enqueueEvent(hello, true)).toThrow(
        "STORE_OUTBOUND_WRITE_FAILED",
      );
      expect(databaseSnapshot(database)).toEqual(before);
      expect(store.activeHello()).toBeUndefined();
    } finally {
      database.exec("DROP TRIGGER fail_hello_profile");
    }
    store.enqueueEvent(hello, true);
    expect(store.activeHello()?.expectedReceiptProfile).toBe(
      "job-coordination-v1",
    );
    database
      .prepare(
        "UPDATE metadata SET value = 'unknown' WHERE key = 'outbound-receipt-profile:1'",
      )
      .run();
    expect(() => store.activeHello()).toThrow("STORE_COORDINATION_INVALID");
    database.close();
    store.close();
  });

  it("validates retained lookup identity without materializing or mutating delivery", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    expect(store.coordinationRequest(coordinationNonce)).toBeUndefined();
    store.enqueueEvent(coordinationRequest());
    for (const payload of [
      JSON.stringify({
        ...coordinationEnvelope,
        type: "job.sync",
        payload: {
          job_id: coordinationJob,
          attempt: 1,
          nonce: coordinationNonce,
        },
        message_id: coordinationJob,
      }),
      JSON.stringify({ ...coordinationEnvelope, sequence: 2 }),
      "invalid-json",
    ]) {
      database
        .prepare("UPDATE outbound_events SET payload_json = ?")
        .run(payload);
      const before = databaseSnapshot(database);
      expect(() => store.coordinationRequest(coordinationNonce)).toThrow(
        "STORE_COORDINATION_INVALID",
      );
      expect(databaseSnapshot(database)).toEqual(before);
    }
    database.close();
    store.close();
  });
  it("rejects renewal that would corrupt a coordinated envelope", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    const before = databaseSnapshot(database);
    expect(() => store.renewDelivery(1, "September 6, 2026")).toThrow();
    expect(databaseSnapshot(database)).toEqual(before);
    database.close();
    store.close();
  });
  it("retains the original profile through retry, delivery, ACK and restart", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    expect(
      database
        .prepare("SELECT json_extract(?, '$.sequence') AS value")
        .get(coordinationRequest().payload),
    ).toEqual({ value: 1 });
    store.enqueueEvent(coordinationRequest());
    const before = databaseSnapshot(database);
    store.enqueueEvent(coordinationRequest());
    expect(databaseSnapshot(database)).toEqual(before);
    expect(store.outboundEvent(1)?.expectedReceiptProfile).toBe(
      "job-coordination-v1",
    );
    expect(store.pendingEvents(0)[0]?.expectedReceiptProfile).toBe(
      "job-coordination-v1",
    );
    expect(
      store.renewDelivery(1, "2026-09-05T12:02:00Z").expectedReceiptProfile,
    ).toBe("job-coordination-v1");
    store.acknowledgeThrough(1, coordinationNonce);
    expect(store.pendingEvents(0)).toEqual([]);
    const acknowledged = databaseSnapshot(database);
    expect(store.coordinationRequest(coordinationNonce)?.sequence).toBe(1);
    expect(databaseSnapshot(database)).toEqual(acknowledged);
    store.close();
    const reopened = new SqlitePluginStore(path);
    expect(
      reopened.coordinationRequest(coordinationNonce)?.expectedReceiptProfile,
    ).toBe("job-coordination-v1");
    reopened.close();
    database.close();
  });

  it("rejects profile upgrade, downgrade, unknown and malformed envelopes without effects", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    const request = coordinationRequest();
    const { expectedReceiptProfile: _profile, ...legacy } = request;
    store.enqueueEvent(legacy);
    expect(store.outboundEvent(1)).not.toHaveProperty("expectedReceiptProfile");
    expect(store.coordinationRequest(coordinationNonce)).toBeUndefined();
    const before = databaseSnapshot(database);
    expect(() => store.enqueueEvent(request)).toThrow();
    expect(databaseSnapshot(database)).toEqual(before);
    for (const candidate of [
      { ...event(2), expectedReceiptProfile: "unknown" },
      { ...event(2), expectedReceiptProfile: "job-coordination-v1" },
      { ...request, sequence: 2 },
    ]) {
      expect(() =>
        store.enqueueEvent(candidate as OutboundEventInput, true),
      ).toThrow();
      expect(databaseSnapshot(database)).toEqual(before);
    }
    store.enqueueEvent(event(2));
    expect(store.pendingEvents(1)[0]).not.toHaveProperty(
      "expectedReceiptProfile",
    );
    database.close();
    store.close();
    const other = new SqlitePluginStore(makeDatabasePath());
    other.enqueueEvent(request);
    expect(() => other.enqueueEvent(legacy)).toThrow();
    other.close();
  });

  it("fails closed on ambiguous retained correlations and corrupt profiles", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    store.enqueueEvent(coordinationRequest());
    store.enqueueEvent({
      ...event(2),
      payload: JSON.stringify({
        ...coordinationEnvelope,
        message_id: coordinationJob,
        sequence: 2,
      }),
    });
    expect(() => store.coordinationRequest(coordinationNonce)).toThrow();
    database
      .prepare(
        "UPDATE metadata SET value = 'unknown' WHERE key = 'outbound-receipt-profile:1'",
      )
      .run();
    const before = databaseSnapshot(database);
    for (const read of [
      () => store.outboundEvent(1),
      () => store.pendingEvents(0),
      () => store.renewDelivery(1, "2026-09-05T12:02:00Z"),
    ]) {
      expect(read).toThrow();
      expect(databaseSnapshot(database)).toEqual(before);
    }
    database.close();
    store.close();
  });

  it("rolls back outbound insertion when profile metadata cannot commit", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const database = new Database(path);
    database.exec(
      "CREATE TRIGGER fail_profile BEFORE INSERT ON metadata WHEN NEW.key = 'outbound-receipt-profile:1' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    try {
      const before = databaseSnapshot(database);
      expect(() => store.enqueueEvent(coordinationRequest())).toThrow();
      expect(databaseSnapshot(database)).toEqual(before);
    } finally {
      database.exec("DROP TRIGGER fail_profile");
      database.close();
      store.close();
    }
  });
});

const makeDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-plugin-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
};

const event = (
  sequence: number,
  messageId = `event-${sequence}`,
): OutboundEventInput => ({
  messageId,
  sequence,
  payload: JSON.stringify({ sequence }),
});

const captureStoreError = (
  operation: () => void,
): Error & { code?: string } => {
  try {
    operation();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected store operation to fail");
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, {
      recursive: true,
      force: true,
    });
  }
});

describe("SQLite Harness plugin store", () => {
  it("persists a proven prefix separately from its pinned reconnect hello", () => {
    const path = makeDatabasePath();
    const store = new SqlitePluginStore(path);
    const hello = {
      ...event(1),
      payload: JSON.stringify({
        sequence: 1,
        type: "connector.hello",
        correlation_id: "hello",
      }),
    };
    store.enqueueEvent(hello, true);
    store.enqueueEvent({
      ...event(2),
      payload: JSON.stringify({ sequence: 2, correlation_id: "event" }),
    });
    expect(() => store.acknowledgeThrough(2, "wrong")).toThrow();
    expect(store.provenClientSequence()).toBe(0);
    store.acknowledgeThrough(2, "event");
    expect(store.pendingEvents(0)).toEqual([]);
    expect(store.activeHello()?.messageId).toBe(hello.messageId);
    store.close();
    const reopened = new SqlitePluginStore(path);
    expect(reopened.provenClientSequence()).toBe(2);
    expect(reopened.activeHello()?.messageId).toBe(hello.messageId);
    reopened.enqueueEvent(
      {
        ...event(3),
        payload: JSON.stringify({
          sequence: 3,
          type: "connector.hello",
          correlation_id: "next",
        }),
      },
      true,
    );
    expect(reopened.activeHello()?.sequence).toBe(3);
    reopened.close();
  });
  it("creates an atomic WAL schema with the expected durable tables", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(tables).toEqual([
      "inbound_messages",
      "job_mappings",
      "metadata",
      "outbound_events",
    ]);
    database.close();
  });

  it.each([-1, 2, 99])(
    "rejects unsupported schema version %s without applying a partial migration",
    (version) => {
      const databasePath = makeDatabasePath();
      const database = new Database(databasePath);
      database.pragma(`user_version = ${version}`);
      database.close();

      expect(() => new SqlitePluginStore(databasePath)).toThrow(
        "STORE_SCHEMA_VERSION_UNSUPPORTED",
      );

      const reopened = new Database(databasePath, { readonly: true });
      expect(reopened.pragma("user_version", { simple: true })).toBe(version);
      expect(
        reopened
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'",
          )
          .get(),
      ).toBeUndefined();
      reopened.close();
    },
  );

  it("rolls back a malformed version-zero schema instead of blessing it", () => {
    const databasePath = makeDatabasePath();
    const database = new Database(databasePath);
    database.exec(
      "CREATE TABLE inbound_messages (message_id TEXT PRIMARY KEY NOT NULL)",
    );
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(0);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["inbound_messages"]);
    expect(reopened.pragma("table_info(inbound_messages)")).toHaveLength(1);
    reopened.close();
  });

  it("rejects a malformed version-one schema instead of trusting user_version", () => {
    const databasePath = makeDatabasePath();
    const database = new Database(databasePath);
    database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL)");
    database.pragma("user_version = 1");
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(1);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["metadata"]);
    reopened.close();
  });

  it("rejects a version-one schema missing a required check constraint", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(`
      ALTER TABLE inbound_messages RENAME TO inbound_messages_old;
      CREATE TABLE inbound_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      DROP TABLE inbound_messages_old;
    `);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it.each([
    ["table", "CREATE TABLE unexpected_table (value TEXT)"],
    ["index", "CREATE INDEX unexpected_index ON metadata(value)"],
    ["view", "CREATE VIEW unexpected_view AS SELECT key FROM metadata"],
    [
      "trigger",
      "CREATE TRIGGER unexpected_trigger AFTER INSERT ON metadata BEGIN SELECT 1; END",
    ],
  ])("rejects an unexpected user %s", (_kind, sql) => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(sql);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it("rejects a tautological check hidden behind the canonical text in a comment", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();

    const database = new Database(databasePath);
    database.exec(`
      ALTER TABLE inbound_messages RENAME TO inbound_messages_old;
      CREATE TABLE inbound_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        sequence INTEGER NOT NULL UNIQUE CHECK (1 = 1) /*CHECK(sequence>=1)*/,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      DROP TABLE inbound_messages_old;
    `);
    database.close();

    expect(() => new SqlitePluginStore(databasePath)).toThrow(
      "STORE_SCHEMA_INCOMPATIBLE",
    );
  });

  it("deduplicates inbound message IDs and persists the decision after reopen", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);

    expect(first.recordInbound("message-1", 1, "body")).toBe("new");
    expect(first.recordInbound("message-1", 1, "body")).toBe("duplicate");
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.recordInbound("message-1", 1, "body")).toBe("duplicate");
    reopened.close();
  });

  it("restores the maximum durable inbound sequence after reopen", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);

    expect(first.maxInboundSequence()).toBe(0);
    first.recordInbound("message-1", 1, "body-1");
    first.recordInbound("message-2", 2, "body-2");
    expect(first.maxInboundSequence()).toBe(2);
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.maxInboundSequence()).toBe(2);
    reopened.close();
  });

  it("persists completed inbound delivery while leaving unfinished receipts retryable", () => {
    const databasePath = makeDatabasePath();
    const first = new SqlitePluginStore(databasePath);
    first.recordInbound("message-1", 1, "body-1");
    first.recordInbound("message-2", 2, "body-2");

    expect(first.inboundMessage("message-1")).toEqual({
      messageId: "message-1",
      sequence: 1,
      body: "body-1",
      delivered: false,
    });
    expect(
      first.pendingInboundMessages().map(({ messageId }) => messageId),
    ).toEqual(["message-1", "message-2"]);
    first.markInboundDelivered("message-1");
    first.markInboundDelivered("message-1");
    expect(first.inboundMessage("message-1")?.delivered).toBe(true);
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(
      reopened.pendingInboundMessages().map(({ messageId }) => messageId),
    ).toEqual(["message-2"]);
    expect(reopened.inboundMessage("message-1")?.delivered).toBe(true);
    reopened.close();
  });

  it("transactionally replaces one inbound identity at the same sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("old-message", 1, "old-body");
    store.markInboundDelivered("old-message");

    expect(store.inboundMessageBySequence(1)?.messageId).toBe("old-message");
    store.replaceInbound({
      previousMessageId: "old-message",
      previousBody: "old-body",
      messageId: "replacement-message",
      sequence: 1,
      body: "replacement-body",
    });

    expect(store.inboundMessage("old-message")).toBeUndefined();
    expect(store.inboundMessageBySequence(1)).toEqual({
      messageId: "replacement-message",
      sequence: 1,
      body: "replacement-body",
      delivered: false,
    });
    expect(store.pendingInboundMessages()).toEqual([
      {
        messageId: "replacement-message",
        sequence: 1,
        body: "replacement-body",
        delivered: false,
      },
    ]);
    const audit = new Database(databasePath, { readonly: true });
    expect(
      audit
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("inbound-delivered:old-message"),
    ).toBeUndefined();
    audit.close();
    expect(() =>
      store.replaceInbound({
        previousMessageId: "old-message",
        previousBody: "old-body",
        messageId: "attacker-message",
        sequence: 1,
        body: "attacker-body",
      }),
    ).toThrowError(StoreInboundConflictError);
    expect(store.inboundMessageBySequence(1)?.messageId).toBe(
      "replacement-message",
    );
    store.close();
  });

  it("rejects reused inbound IDs unless sequence and body match exactly", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("message-private", 1, "body-private");

    for (const [sequence, body] of [
      [2, "body-private"],
      [1, "body-changed-private"],
    ] as const) {
      const error = captureStoreError(() =>
        store.recordInbound("message-private", sequence, body),
      );
      expect(error).toMatchObject({
        name: "StoreInboundConflictError",
        code: "STORE_INBOUND_CONFLICT",
        message: "STORE_INBOUND_CONFLICT",
      });
      expect(error).toBeInstanceOf(StoreInboundConflictError);
      expect(error.message).not.toMatch(
        /message-private|body-private|body-changed-private/,
      );
    }

    expect(store.recordInbound("message-private", 1, "body-private")).toBe(
      "duplicate",
    );
    store.close();
  });

  it("rejects a different inbound message at an already recorded sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.recordInbound("message-1", 1, "first-body");

    const error = captureStoreError(() =>
      store.recordInbound("message-2-private", 1, "second-body-private"),
    );
    expect(error).toMatchObject({
      name: "StoreInboundConflictError",
      code: "STORE_INBOUND_CONFLICT",
      message: "STORE_INBOUND_CONFLICT",
    });
    expect(error).toBeInstanceOf(StoreInboundConflictError);
    expect(error.message).not.toMatch(/message-2-private|second-body-private/);
    expect(store.recordInbound("message-1", 1, "first-body")).toBe("duplicate");
    store.close();
  });

  it("stores the latest job mapping and rejects conflicting unique identities", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.mapJob({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "running",
    });
    store.mapJob({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "waiting_approval",
    });

    expect(store.findJob("job-1")).toEqual({
      jobId: "job-1",
      attempt: 1,
      sessionId: "session-1",
      status: "waiting_approval",
    });
    expect(() =>
      store.mapJob({
        jobId: "job-1",
        attempt: 1,
        sessionId: "session-2",
        status: "running",
      }),
    ).toThrow(/STORE_MAPPING_CONFLICT/);
    expect(() =>
      store.mapJob({
        jobId: "job-2",
        attempt: 1,
        sessionId: "session-1",
        status: "running",
      }),
    ).toThrow(/STORE_MAPPING_CONFLICT/);
    store.close();
  });

  it("chooses the greatest attempt deterministically when a job has multiple attempts", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.mapJob({
      jobId: "job-retry",
      attempt: 1,
      sessionId: "session-retry-1",
      status: "failed",
    });
    store.mapJob({
      jobId: "job-retry",
      attempt: 2,
      sessionId: "session-retry-2",
      status: "running",
    });

    expect(store.findJob("job-retry")).toEqual({
      jobId: "job-retry",
      attempt: 2,
      sessionId: "session-retry-2",
      status: "running",
    });
    store.close();
  });

  it("lists active job mappings deterministically and excludes terminal mappings", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    for (const mapping of [
      {
        jobId: "job-zulu",
        attempt: 2,
        sessionId: "session-zulu-2",
        status: "running",
      },
      {
        jobId: "job-alpha",
        attempt: 2,
        sessionId: "session-alpha-2",
        status: "waiting_approval",
      },
      {
        jobId: "job-alpha",
        attempt: 1,
        sessionId: "session-alpha-1",
        status: "failed",
      },
      {
        jobId: "job-bravo",
        attempt: 1,
        sessionId: "session-bravo-1",
        status: "cancelling",
      },
      {
        jobId: "job-cancelled",
        attempt: 1,
        sessionId: "session-cancelled",
        status: "cancelled",
      },
      {
        jobId: "job-expired",
        attempt: 1,
        sessionId: "session-expired",
        status: "expired",
      },
      {
        jobId: "job-succeeded",
        attempt: 1,
        sessionId: "session-succeeded",
        status: "succeeded",
      },
    ]) {
      store.mapJob(mapping);
    }
    store.close();

    const reopened = new SqlitePluginStore(databasePath);

    expect(reopened.listNonterminalJobs()).toEqual([
      {
        jobId: "job-alpha",
        attempt: 2,
        sessionId: "session-alpha-2",
        status: "waiting_approval",
      },
      {
        jobId: "job-bravo",
        attempt: 1,
        sessionId: "session-bravo-1",
        status: "cancelling",
      },
      {
        jobId: "job-zulu",
        attempt: 2,
        sessionId: "session-zulu-2",
        status: "running",
      },
    ]);
    reopened.close();
  });

  it("fails closed with a safe error when the mapping query is unavailable", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    const sabotagingConnection = new Database(databasePath);
    sabotagingConnection.exec("DROP TABLE job_mappings");
    sabotagingConnection.close();

    const error = captureStoreError(() => store.listNonterminalJobs());

    expect(error).toMatchObject({
      code: "STORE_JOB_MAPPING_READ_FAILED",
      message: "STORE_JOB_MAPPING_READ_FAILED",
    });
    expect(error.message).not.toMatch(/job_mappings|SELECT|sqlite/iu);
    store.close();
  });

  it("keeps outbound event sequences monotonic, replays pending events, and acknowledges idempotently", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    store.enqueueEvent(event(1));
    store.enqueueEvent(event(2));
    expect(store.pendingEvents(0)).toMatchObject([
      { messageId: "event-1", sequence: 1, attempts: 1 },
      { messageId: "event-2", sequence: 2, attempts: 1 },
    ]);
    expect(store.pendingEvents(1)).toMatchObject([
      { messageId: "event-2", sequence: 2, attempts: 2 },
    ]);
    expect(() => store.enqueueEvent(event(2, "event-conflict"))).toThrow(
      StoreSequenceError,
    );
    expect(() => store.enqueueEvent(event(1, "event-1-conflict"))).toThrow(
      StoreSequenceError,
    );

    store.acknowledgeEvent("event-1");
    store.acknowledgeEvent("event-1");
    expect(store.pendingEvents(0).map(({ messageId }) => messageId)).toEqual([
      "event-2",
    ]);
    store.close();

    const reopened = new SqlitePluginStore(databasePath);
    reopened.enqueueEvent(event(3, "event-3"));
    expect(reopened.pendingEvents(0).map(({ messageId }) => messageId)).toEqual(
      ["event-2", "event-3"],
    );
    reopened.close();
    expect(existsSync(databasePath)).toBe(true);
  });

  it("reports the durable maximum outbound sequence across acknowledged and pending rows", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);

    expect(store.maxOutboundSequence()).toBe(0);
    store.enqueueEvent(event(7, "pending-event"));
    store.enqueueEvent(event(11, "acknowledged-event"));
    store.acknowledgeEvent("acknowledged-event");
    expect(store.maxOutboundSequence()).toBe(11);
    store.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.maxOutboundSequence()).toBe(11);
    expect(reopened.pendingEvents(0)).toMatchObject([
      { messageId: "pending-event", sequence: 7 },
    ]);
    reopened.close();
  });

  it("rejects an unsafe durable outbound sequence", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    store.close();
    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO outbound_events
          (message_id, sequence, payload_json, attempts, acknowledged_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "unsafe-event",
        Number.MAX_SAFE_INTEGER + 1,
        "{}",
        0,
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
      );
    database.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(() => reopened.maxOutboundSequence()).toThrow(
      "STORE_SEQUENCE_INVALID",
    );
    reopened.close();
  });

  it("always initializes outbound delivery state instead of accepting forged state", () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    const forgedInput = {
      ...event(1, "event-forged"),
      attempts: 41,
      acknowledgedAt: "2026-09-04T00:00:00.000Z",
    } as OutboundEventInput;

    store.enqueueEvent(forgedInput);

    expect(store.pendingEvents(0)).toEqual([
      {
        messageId: "event-forged",
        sequence: 1,
        payload: JSON.stringify({ sequence: 1 }),
        attempts: 1,
        acknowledgedAt: null,
      },
    ]);
    store.close();
  });

  it("preserves mappings and unacknowledged events across a simulated process exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "qhb-plugin-store-parent-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "nested", "state.sqlite");
    mkdirSync(join(directory, "nested"));
    const first = new SqlitePluginStore(databasePath);
    first.mapJob({
      jobId: "job-reopen",
      attempt: 2,
      sessionId: "session-reopen",
      status: "running",
    });
    first.enqueueEvent(event(7, "event-reopen"));
    first.close();

    const reopened = new SqlitePluginStore(databasePath);
    expect(reopened.findJob("job-reopen")).toEqual({
      jobId: "job-reopen",
      attempt: 2,
      sessionId: "session-reopen",
      status: "running",
    });
    expect(reopened.pendingEvents(0)).toMatchObject([
      { messageId: "event-reopen", sequence: 7 },
    ]);
    reopened.close();
  });
});
