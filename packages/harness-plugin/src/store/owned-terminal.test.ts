import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ownedJson } from "./owned-intent.js";
import {
  captureTerminalProposal,
  terminalCorrelation,
} from "./owned-terminal.js";
import { SqlitePluginStore } from "./plugin-store.js";

const owner = {
  jobId: "11111111-1111-4111-8111-111111111111",
  attempt: 1,
  repositoryId: "example-repo",
  sessionId: "22222222-2222-4222-8222-222222222222",
  ownerGeneration: "33333333-3333-4333-8333-333333333333",
};
it.each([
  { summary: " " },
  { summary: " Done" },
  { summary: "Done\t" },
  { summary: "Done", stage: "INVALID" },
  { summary: "Done", changed_files: ["../escape"] },
  { summary: "Done", changed_files: Array(51).fill("a.ts") },
  { summary: "Done", tests: { passed: -1, failed: 0 } },
  { summary: "Done", tests: { passed: 0.5, failed: 0 } },
  { summary: "Done", tests: { passed: Number.MAX_SAFE_INTEGER, failed: 1 } },
  { summary: "Done", tests: { passed: 0, failed: 0, status: "failed" } },
  ...[
    "https://example.com/?",
    "https://example.com/#",
    "https://user@example.com/",
    "HTTP://example.com",
    "ftp://example.com/",
  ].map((url) => ({
    summary: "Done",
    artifacts: [{ name: "Report", media_type: "text/plain", url }],
  })),
  {
    summary: "Done",
    artifacts: [
      { name: "", media_type: "text/plain", url: "https://example.com/" },
    ],
  },
  {
    summary: "Done",
    artifacts: [
      { name: "Report", media_type: "invalid", url: "https://example.com/" },
    ],
  },
  {
    summary: "Done",
    artifacts: [
      {
        name: "Report",
        media_type: "text/plain",
        url: "https://example.com/",
        status: "failed",
      },
    ],
  },
])("I3 strict minimized DTO rejects %j", (payload) => {
  const binding = {
    owner,
    expectedVersion: 3,
    operation: {
      kind: "native" as const,
      outcome: "succeeded" as const,
      eventSequence: 1,
    },
  };
  expect(() =>
    captureTerminalProposal({
      binding,
      correlationId: terminalCorrelation(binding),
      type: "job.event",
      payload: {
        job_id: owner.jobId,
        attempt: 1,
        event_type: "job.succeeded",
        source: "harness",
        payload,
      },
    }),
  ).toThrow("OWNED_INTENT_INVALID");
});
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
function historical() {
  const path = join(
    mkdtempSync(join(tmpdir(), "terminal-history-")),
    "store.sqlite",
  );
  const store = new SqlitePluginStore(path);
  const raw = new Database(path);
  closes.push(() => {
    raw.close();
    store.close();
  });
  const offer = {
    protocol_version: "1.0" as const,
    type: "job.offer" as const,
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: "2026-09-01T00:00:00Z",
    expires_at: "2026-09-01T00:01:00Z",
    payload: {
      job_id: owner.jobId,
      attempt: 1,
      repository_id: owner.repositoryId,
      lease_id: randomUUID(),
      request: "fixture",
    },
  };
  store.recordInbound(offer.message_id, 1, JSON.stringify(offer));
  let predecessor = store.prepareOwnedIntent({
    offer,
    sessionId: owner.sessionId,
    ownerGeneration: owner.ownerGeneration,
    initialMessageId: "initial",
  });
  predecessor = store.advanceOwnedIntent(owner, predecessor.version, {
    phase: "creating",
    mode: "normal",
  });
  const markerKey = `owned-terminal-v1:${owner.jobId}:1`;
  const intentKey = `owned-intent-v1:${owner.jobId}:1`;
  const record = {
    schemaVersion: 1,
    kind: "remote",
    predecessor,
    committedVersion: 2,
    status: "expired",
    state: {
      job_id: owner.jobId,
      repository_id: owner.repositoryId,
      mode: "normal",
      requested_attempt: 1,
      current_attempt: 1,
      status: "expired",
      job_revision: 5,
      cancel_revision: null,
      lease_id: null,
      lease_expires_at: null,
      expires_at: "2026-09-01T00:00:00Z",
      observed_at: "2026-09-01T00:00:01Z",
      state_valid_until: "2026-09-01T00:00:03Z",
      request_message_id: randomUUID(),
      request_sequence: 3,
      nonce: randomUUID(),
    },
  };
  const seed = () =>
    raw.transaction(() => {
      raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(
          ownedJson({ ...predecessor, phase: "terminal", version: 2 }),
          intentKey,
        );
      raw.prepare("UPDATE job_mappings SET status = 'expired'").run();
      raw
        .prepare("INSERT INTO metadata(key, value) VALUES (?, ?)")
        .run(markerKey, ownedJson(record));
    })();
  const snapshot = () =>
    ["metadata", "outbound_events", "job_mappings"].map((table) =>
      raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  return { store, raw, path, record, seed, markerKey, intentKey, snapshot };
}

describe("real-store historical terminal joins", () => {
  it("refuses a native winner whose joined predecessor never recorded started evidence", () => {
    const f = historical();
    f.seed();
    const operation = {
      kind: "native" as const,
      outcome: "succeeded" as const,
      eventSequence: 0,
    };
    const correlationId = terminalCorrelation({
      owner,
      expectedVersion: 1,
      operation,
    });
    const payload = {
      job_id: owner.jobId,
      attempt: 1,
      event_type: "job.succeeded",
      source: "harness",
      payload: { summary: "Done" },
    };
    const messageId = randomUUID();
    const sentAt = "2026-09-01T00:00:01Z";
    const local = {
      schemaVersion: 1,
      kind: "local",
      predecessor: f.record.predecessor,
      committedVersion: 2,
      status: "succeeded",
      operation,
      correlationId,
      type: "job.event",
      payload,
      outbound: { messageId, sequence: 1, sentAt },
    };
    f.raw
      .prepare("UPDATE metadata SET value = ? WHERE key = ?")
      .run(ownedJson(local), f.markerKey);
    f.raw.prepare("UPDATE job_mappings SET status = 'succeeded'").run();
    f.raw
      .prepare(
        "INSERT INTO outbound_events(message_id, sequence, payload_json, attempts, acknowledged_at, created_at) VALUES (?, 1, ?, 0, NULL, ?)",
      )
      .run(
        messageId,
        JSON.stringify({
          protocol_version: "1.0",
          type: "job.event",
          message_id: messageId,
          sequence: 1,
          correlation_id: correlationId,
          sent_at: sentAt,
          expires_at: "2026-09-01T00:01:01Z",
          payload,
        }),
        sentAt,
      );
    f.raw
      .prepare(
        "INSERT INTO metadata(key, value) VALUES ('outbound-receipt-profile:1', 'job-coordination-v1')",
      )
      .run();
    expect(() => f.store.readTerminal(owner)).toThrow("OWNED_INTENT_CORRUPT");
  });
  it("distinguishes an existing nonterminal from absent and wrong owners", () => {
    const f = historical();
    expect(f.store.readTerminal(owner)).toBeUndefined();
    expect(() => f.store.readTerminal({ ...owner, attempt: 2 })).toThrow();
    expect(() =>
      f.store.readTerminal({ ...owner, ownerGeneration: randomUUID() }),
    ).toThrow();
  });
  it("reads detached remote history across true reopen without any live authority", () => {
    const f = historical();
    f.seed();
    const before = f.snapshot();
    f.store.close();
    const reopened = new SqlitePluginStore(f.path);
    closes.push(() => reopened.close());
    const result = reopened.readTerminal(owner);
    expect(result).toEqual(f.record);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.predecessor.owner)).toBe(true);
    expect(f.snapshot()).toEqual(before);
    expect(reopened.listNonterminalJobs()).toEqual([]);
    expect(() =>
      reopened.advanceOwnedIntent(owner, 2, {
        unavailable: "HARNESS_SESSION_LOST",
      }),
    ).toThrow();
  });
  it.each([
    "missing-marker",
    "orphan",
    "version",
    "mapping",
    "mode",
    "attempt",
    "unknown",
    "blob-value",
    "blob-key",
    "oversize",
  ])("rejects %s corruption without repairing any surface", (kind) => {
    const f = historical();
    f.seed();
    if (kind === "missing-marker")
      f.raw.prepare("DELETE FROM metadata WHERE key = ?").run(f.markerKey);
    else if (kind === "orphan")
      f.raw.prepare("DELETE FROM metadata WHERE key = ?").run(f.intentKey);
    else if (kind === "mapping")
      f.raw.prepare("UPDATE job_mappings SET status = 'succeeded'").run();
    else if (kind === "blob-key")
      f.raw
        .prepare("UPDATE metadata SET key = ? WHERE key = ?")
        .run(Buffer.from(f.markerKey), f.markerKey);
    else if (kind === "blob-value")
      f.raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(Buffer.from(ownedJson(f.record)), f.markerKey);
    else {
      const record = structuredClone(f.record);
      if (kind === "version") record.committedVersion++;
      if (kind === "mode") record.state.mode = "read_only";
      if (kind === "attempt") record.state.current_attempt++;
      if (kind === "unknown") Object.assign(record, { unexpected: true });
      f.raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(
          kind === "oversize"
            ? `${" ".repeat(65536)}${ownedJson(record)}`
            : ownedJson(record),
          f.markerKey,
        );
    }
    const before = f.snapshot();
    expect(() => f.store.readTerminal(owner)).toThrow("OWNED_INTENT_CORRUPT");
    expect(f.snapshot()).toEqual(before);
  });
});
describe("owned terminal logical identity", () => {
  it.each([
    "jobId",
    "attempt",
    "repositoryId",
    "sessionId",
    "ownerGeneration",
  ] as const)("binds owner field %s", (field) => {
    const changed = {
      ...owner,
      [field]:
        field === "attempt"
          ? 2
          : field === "repositoryId"
            ? "other"
            : "44444444-4444-4444-8444-444444444444",
    };
    expect(
      terminalCorrelation({
        owner: changed,
        expectedVersion: 3,
        operation: { kind: "native", outcome: "succeeded", eventSequence: 0 },
      }),
    ).not.toBe("fd54f118-2af3-8581-b9b9-1a5c0403d090");
  });
  it("excludes outcome and CAS version, while binding native sequence and cancellation revision", () => {
    expect(
      terminalCorrelation({
        owner,
        expectedVersion: 99,
        operation: { kind: "native", outcome: "failed", eventSequence: 0 },
      }),
    ).toBe("fd54f118-2af3-8581-b9b9-1a5c0403d090");
    expect(
      terminalCorrelation({
        owner,
        expectedVersion: 3,
        operation: { kind: "native", outcome: "failed", eventSequence: 1 },
      }),
    ).not.toBe("fd54f118-2af3-8581-b9b9-1a5c0403d090");
    expect(
      terminalCorrelation({
        owner,
        expectedVersion: 3,
        operation: { kind: "cancel", cancelRevision: 8 },
      }),
    ).not.toBe("ef2c128e-bc3d-8c0f-905c-d84ce13acd8d");
  });
  it.each([
    [
      { kind: "native", outcome: "succeeded", eventSequence: 0 },
      "fd54f118-2af3-8581-b9b9-1a5c0403d090",
    ],
    [
      { kind: "cancel", cancelRevision: 7 },
      "ef2c128e-bc3d-8c0f-905c-d84ce13acd8d",
    ],
    [
      { kind: "unavailable", reason: "HARNESS_SESSION_LOST" },
      "1da8c380-30aa-8a8e-ad4e-eeb04870d5d4",
    ],
  ] as const)(
    "uses the independent reference for %j",
    (operation, expected) => {
      expect(
        terminalCorrelation({ owner, expectedVersion: 3, operation }),
      ).toBe(expected);
    },
  );
});
