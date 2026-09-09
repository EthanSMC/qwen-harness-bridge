import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorServerMessage } from "@qhb/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePluginStore } from "./plugin-store.js";

const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const offer = (
  n = 1,
): Extract<ConnectorServerMessage, { type: "job.offer" }> => ({
  protocol_version: "1.0",
  type: "job.offer",
  message_id: id(n + 10),
  sequence: n,
  correlation_id: id(n + 20),
  sent_at: "2026-09-01T00:00:00Z",
  expires_at: "2026-09-01T00:01:00Z",
  payload: {
    job_id: id(n),
    attempt: 1,
    repository_id: "example-repo",
    lease_id: id(n + 30),
    request: "Test journal identity",
  },
});
const input = (n = 1) => ({
  offer: offer(n),
  sessionId: id(n + 40),
  initialMessageId: "native: 初始 message ",
  ownerGeneration: id(n + 50),
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "owned-intent-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "store.sqlite");
  const store = new SqlitePluginStore(path);
  const raw = new Database(path);
  cleanups.push(() => {
    raw.close();
    store.close();
  });
  return { store, raw, path };
}
function receipt(store: SqlitePluginStore, value = offer()) {
  store.recordInbound(value.message_id, value.sequence, JSON.stringify(value));
}
const snapshot = (raw: Database.Database) =>
  ["metadata", "job_mappings", "inbound_messages", "outbound_events"].map(
    (table) => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
const key = `owned-intent-v1:${id(1)}:1`;
const activeKey = `owned-active-v1:${id(1)}`;
const generationKey = `owned-generation-v1:${id(51)}`;
const evidence = (
  value: ReturnType<SqlitePluginStore["prepareOwnedIntent"]>,
) => ({
  sessionId: value.owner.sessionId,
  messageId: value.initialMessageId,
  requestDigest: value.requestDigest,
  eventSequence: 0,
});

describe("durable initial-attempt journal", () => {
  it("atomically prepares, returns exact duplicates, and reopens immutable identity", () => {
    const { store, raw, path } = setup();
    receipt(store);
    const result = store.prepareOwnedIntent(input());
    expect(result).toMatchObject({
      phase: "prepared",
      version: 0,
      mode: null,
      startedEvidence: null,
      unavailable: null,
      requestDigest: createHash("sha256")
        .update(offer().payload.request)
        .digest("hex"),
    });
    expect(raw.prepare("SELECT * FROM metadata").all()).toHaveLength(3);
    expect(store.findJob(id(1))).toEqual({
      jobId: id(1),
      attempt: 1,
      sessionId: id(41),
      status: "prepared",
    });
    const before = snapshot(raw);
    expect(store.prepareOwnedIntent(input())).toEqual(result);
    expect(snapshot(raw)).toEqual(before);
    store.close();
    const reopened = new SqlitePluginStore(path);
    try {
      expect(reopened.ownedIntent(id(1), 1)).toEqual(result);
      expect(reopened.listOwnedIntents()).toEqual([result]);
    } finally {
      reopened.close();
    }
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
  });

  it("requires the actual matching full inbound offer", () => {
    const { store, raw } = setup();
    const before = snapshot(raw);
    expect(() => store.prepareOwnedIntent(input())).toThrow(
      "OWNED_INTENT_CONFLICT",
    );
    expect(snapshot(raw)).toEqual(before);
    receipt(store);
    const changed = input();
    changed.offer.payload.request = "Different request";
    expect(() => store.prepareOwnedIntent(changed)).toThrow(
      "OWNED_INTENT_CONFLICT",
    );
  });

  it.each([
    "sessionId",
    "initialMessageId",
    "ownerGeneration",
    "request",
    "lease_id",
    "repository_id",
    "message_id",
    "sequence",
    "correlation_id",
    "sent_at",
    "expires_at",
  ])("conflicts on changed duplicate %s", (field) => {
    const { store, raw } = setup();
    receipt(store);
    store.prepareOwnedIntent(input());
    const candidate = input();
    if (field === "sessionId" || field === "ownerGeneration")
      candidate[field] = id(99);
    else if (field === "initialMessageId")
      candidate.initialMessageId = "another";
    else if (
      field === "request" ||
      field === "repository_id" ||
      field === "lease_id"
    )
      candidate.offer.payload[field] =
        field === "lease_id" ? id(99) : "another";
    else
      Object.assign(candidate.offer, {
        [field]:
          field === "sequence"
            ? 2
            : field.endsWith("_at")
              ? "2026-09-01T00:00:30Z"
              : id(99),
      });
    const before = snapshot(raw);
    expect(() => store.prepareOwnedIntent(candidate)).toThrow(
      "OWNED_INTENT_CONFLICT",
    );
    expect(snapshot(raw)).toEqual(before);
  });

  it.each(["", "é".repeat(129), "a\u0000b", "a\nb", "a\u007fb"])(
    "rejects invalid opaque native message identity %j",
    (initialMessageId) => {
      const { store, raw } = setup();
      receipt(store);
      const before = snapshot(raw);
      expect(() =>
        store.prepareOwnedIntent({ ...input(), initialMessageId }),
      ).toThrow("OWNED_INTENT_INVALID");
      expect(snapshot(raw)).toEqual(before);
    },
  );
  it.each(["é".repeat(128), " ", "Opaque: NOT-A-UUID"])(
    "preserves valid bounded opaque identity %j",
    (initialMessageId) => {
      const { store } = setup();
      receipt(store);
      expect(
        store.prepareOwnedIntent({ ...input(), initialMessageId })
          .initialMessageId,
      ).toBe(initialMessageId);
    },
  );

  it("captures and normalizes input and freezes detached nested return values", () => {
    const { store } = setup();
    receipt(store);
    const candidate = input();
    candidate.sessionId = candidate.sessionId.toUpperCase();
    candidate.offer.payload.job_id = id(1).toUpperCase();
    const value = store.prepareOwnedIntent(candidate);
    candidate.offer.payload.request = "changed";
    expect(value.owner.sessionId).toBe(id(41));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.owner)).toBe(true);
    expect(Object.isFrozen(value.offer)).toBe(true);
    expect(() => Object.assign(value.owner, { sessionId: id(99) })).toThrow();
    expect(store.ownedIntent(id(1).toUpperCase(), 1)).toEqual(value);
    expect(store.ownedIntent(id(1), 1)).not.toBe(value);
    expect(Object.isFrozen(store.listOwnedIntents())).toBe(true);
  });

  it("retains exact retry identity after receipt replacement", () => {
    const { store, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    store.replaceInbound({
      previousMessageId: offer().message_id,
      previousBody: JSON.stringify(offer()),
      messageId: id(99),
      sequence: 1,
      body: JSON.stringify({
        ...offer(),
        message_id: id(99),
        type: "protocol.error",
        payload: {
          code: "MESSAGE_EXPIRED",
          message: "A Connector message expired before delivery.",
        },
      }),
    });
    const before = snapshot(raw);
    expect(store.prepareOwnedIntent(input())).toEqual(value);
    expect(snapshot(raw)).toEqual(before);
  });

  it.each([
    "ack",
    "wrong-message",
    "wrong-sequence",
    "malformed",
    "changed-request",
  ])("refuses first creation with %s receipt proof", (kind) => {
    const { store, raw } = setup();
    const value = offer();
    const body =
      kind === "malformed"
        ? "{}"
        : JSON.stringify(
            kind === "ack"
              ? { ...value, type: "ack", payload: { sequence: 1 } }
              : {
                  ...value,
                  ...(kind === "wrong-message" ? { message_id: id(99) } : {}),
                  ...(kind === "wrong-sequence" ? { sequence: 2 } : {}),
                  payload: {
                    ...value.payload,
                    ...(kind === "changed-request"
                      ? { request: "changed" }
                      : {}),
                  },
                },
          );
    store.recordInbound(value.message_id, value.sequence, body);
    const before = snapshot(raw);
    expect(() => store.prepareOwnedIntent(input())).toThrow(
      kind === "malformed" ? "OWNED_INTENT_CORRUPT" : "OWNED_INTENT_CONFLICT",
    );
    expect(snapshot(raw)).toEqual(before);
  });

  it.each(["attempt", "session", "generation"])(
    "rejects reused %s identity and another attempt",
    (kind) => {
      const { store, raw } = setup();
      receipt(store);
      store.prepareOwnedIntent(input());
      const next = input(2);
      if (kind === "attempt") {
        next.offer.payload.job_id = id(1);
        next.offer.payload.attempt = 2;
      }
      if (kind === "session") next.sessionId = id(41);
      if (kind === "generation") next.ownerGeneration = id(51);
      receipt(store, next.offer);
      const before = snapshot(raw);
      expect(() => store.prepareOwnedIntent(next)).toThrow(
        "OWNED_INTENT_CONFLICT",
      );
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("preserves legacy mappings without promotion and protects owned jobs and sessions", () => {
    const { store, raw } = setup();
    store.mapJob({
      jobId: id(2),
      attempt: 1,
      sessionId: id(42),
      status: "running",
    });
    expect(store.ownedIntent(id(2), 1)).toBeUndefined();
    expect(store.listOwnedIntents()).toEqual([]);
    receipt(store, offer(2));
    expect(() => store.prepareOwnedIntent(input(2))).toThrow(
      "OWNED_INTENT_CONFLICT",
    );
    receipt(store);
    store.prepareOwnedIntent(input());
    for (const mapping of [
      { jobId: id(1), attempt: 1, sessionId: id(41), status: "prepared" },
      { jobId: id(1), attempt: 2, sessionId: id(99), status: "running" },
      { jobId: id(99), attempt: 1, sessionId: id(41), status: "running" },
    ]) {
      const before = snapshot(raw);
      expect(() => store.mapJob(mapping)).toThrow("OWNED_INTENT_CONFLICT");
      expect(snapshot(raw)).toEqual(before);
    }
    store.mapJob({
      jobId: id(2),
      attempt: 1,
      sessionId: id(42),
      status: "succeeded",
    });
    expect(store.findJob(id(2))?.status).toBe("succeeded");
  });

  it.each(["normal", "read_only"] as const)(
    "commits ordered phases and zero-based evidence in %s mode",
    (mode) => {
      const { store, raw } = setup();
      receipt(store);
      let value = store.prepareOwnedIntent(input());
      value = store.advanceOwnedIntent(value.owner, 0, {
        phase: "creating",
        mode,
      });
      expect(value).toMatchObject({ phase: "creating", mode, version: 1 });
      value = store.advanceOwnedIntent(value.owner, 1, { phase: "submitting" });
      value = store.advanceOwnedIntent(value.owner, 2, {
        phase: "started",
        evidence: evidence(value),
      });
      expect(value).toMatchObject({
        phase: "started",
        mode,
        version: 3,
        startedEvidence: { eventSequence: 0 },
      });
      expect(Object.isFrozen(value.startedEvidence)).toBe(true);
      expect(store.findJob(id(1))?.status).toBe("started");
      const before = snapshot(raw);
      expect(store.listOwnedIntents()).toEqual([value]);
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("rejects every non-edge, stale CAS, changed owner and mismatched evidence", () => {
    const { store, raw } = setup();
    receipt(store);
    let value = store.prepareOwnedIntent(input());
    const transitions = [
      { phase: "creating", mode: "normal" },
      { phase: "submitting" },
      { phase: "started", evidence: evidence(value) },
    ] as const;
    for (let phase = 0; phase <= 3; phase++) {
      for (const [edge, transition] of transitions.entries())
        if (edge !== phase) {
          const before = snapshot(raw);
          expect(() =>
            store.advanceOwnedIntent(value.owner, value.version, transition),
          ).toThrow("OWNED_INTENT_CONFLICT");
          expect(snapshot(raw)).toEqual(before);
        }
      for (const field of [
        "jobId",
        "attempt",
        "repositoryId",
        "sessionId",
        "ownerGeneration",
      ]) {
        const owner = {
          ...value.owner,
          [field]:
            field === "attempt"
              ? 2
              : field === "repositoryId"
                ? "another-repo"
                : id(99),
        };
        expect(() =>
          store.advanceOwnedIntent(owner, value.version, transitions[0]),
        ).toThrow("OWNED_INTENT_CONFLICT");
      }
      expect(() =>
        store.advanceOwnedIntent(
          value.owner,
          value.version + 1,
          transitions[0],
        ),
      ).toThrow("OWNED_INTENT_CONFLICT");
      if (phase === 2)
        for (const field of [
          "sessionId",
          "messageId",
          "requestDigest",
        ] as const) {
          expect(() =>
            store.advanceOwnedIntent(value.owner, value.version, {
              phase: "started",
              evidence: {
                ...evidence(value),
                [field]: field === "requestDigest" ? "a".repeat(64) : id(99),
              },
            }),
          ).toThrow("OWNED_INTENT_CONFLICT");
        }
      const transition = transitions[phase];
      if (transition !== undefined)
        value = store.advanceOwnedIntent(
          value.owner,
          value.version,
          transition,
        );
    }
  });

  it.each([0, 1, 2, 3])(
    "latches unavailable from phase %i without clearing or replacing",
    (phase) => {
      const { store, raw } = setup();
      receipt(store);
      let value = store.prepareOwnedIntent(input());
      if (phase >= 1)
        value = store.advanceOwnedIntent(value.owner, value.version, {
          phase: "creating",
          mode: "read_only",
        });
      if (phase >= 2)
        value = store.advanceOwnedIntent(value.owner, value.version, {
          phase: "submitting",
        });
      if (phase >= 3)
        value = store.advanceOwnedIntent(value.owner, value.version, {
          phase: "started",
          evidence: evidence(value),
        });
      const reason = { unavailable: "HARNESS_SESSION_LOST" } as const;
      const latched = store.advanceOwnedIntent(
        value.owner,
        value.version,
        reason,
      );
      expect(latched).toEqual({
        ...value,
        version: value.version + 1,
        ...reason,
      });
      const before = snapshot(raw);
      expect(
        store.advanceOwnedIntent(value.owner, latched.version, reason),
      ).toEqual(latched);
      expect(() =>
        store.advanceOwnedIntent(value.owner, value.version, reason),
      ).toThrow("OWNED_INTENT_CONFLICT");
      expect(() =>
        store.advanceOwnedIntent(value.owner, latched.version, {
          unavailable: "HARNESS_PERSISTENCE_UNAVAILABLE",
        }),
      ).toThrow("OWNED_INTENT_CONFLICT");
      expect(() =>
        store.advanceOwnedIntent(value.owner, latched.version, {
          phase: "creating",
          mode: "normal",
        }),
      ).toThrow("OWNED_INTENT_CONFLICT");
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("rejects invalid inputs, getter failures and increment overflow with fixed errors", () => {
    const { store, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    const before = snapshot(raw);
    for (const invalid of [0, -1, 1.5, 2147483648, NaN])
      expect(() => store.ownedIntent(id(1), invalid)).toThrow(
        "OWNED_INTENT_INVALID",
      );
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      expect(() =>
        store.advanceOwnedIntent(value.owner, invalid, { phase: "submitting" }),
      ).toThrow("OWNED_INTENT_INVALID");
    expect(() =>
      store.prepareOwnedIntent({
        ...input(),
        get sessionId(): string {
          throw new Error("private diagnostic");
        },
      }),
    ).toThrow("OWNED_INTENT_INVALID");
    expect(() =>
      store.prepareOwnedIntent({ ...input(), extra: true } as ReturnType<
        typeof input
      >),
    ).toThrow("OWNED_INTENT_INVALID");
    expect(() =>
      store.advanceOwnedIntent(
        { ...value.owner, extra: true } as typeof value.owner,
        0,
        { phase: "submitting" },
      ),
    ).toThrow("OWNED_INTENT_INVALID");
    expect(() =>
      store.advanceOwnedIntent(value.owner, 0, {
        phase: "submitting",
        mode: "normal",
      } as { phase: "submitting" }),
    ).toThrow("OWNED_INTENT_INVALID");
    for (const eventSequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "started",
          evidence: { ...evidence(value), eventSequence },
        }),
      ).toThrow("OWNED_INTENT_INVALID");
    expect(snapshot(raw)).toEqual(before);
    raw
      .prepare("UPDATE metadata SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...value, version: Number.MAX_SAFE_INTEGER }), key);
    const overflow = snapshot(raw);
    expect(() =>
      store.advanceOwnedIntent(value.owner, Number.MAX_SAFE_INTEGER, {
        phase: "creating",
        mode: "normal",
      }),
    ).toThrow("OWNED_INTENT_CONFLICT");
    expect(snapshot(raw)).toEqual(overflow);
  });

  it.each([
    "record-json",
    "version",
    "unknown",
    "oversize",
    "missing-record",
    "missing-active",
    "missing-generation",
    "bad-active",
    "bad-generation",
    "wrong-key",
    "mapping-status",
    "mapping-session",
    "missing-mapping",
    "phase-mode",
    "phase-evidence",
    "unknown-prefix",
  ])("fails closed on persisted %s corruption", (kind) => {
    const { store, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    const replace = (record: unknown) =>
      raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(JSON.stringify(record), key);
    if (kind === "record-json")
      raw.prepare("UPDATE metadata SET value = '{' WHERE key = ?").run(key);
    if (kind === "version") replace({ ...value, schemaVersion: 2 });
    if (kind === "unknown") replace({ ...value, unknown: true });
    if (kind === "oversize")
      raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(`${JSON.stringify(value)}${" ".repeat(16384)}`, key);
    if (kind.startsWith("missing-")) {
      const target =
        kind === "missing-record"
          ? key
          : kind === "missing-active"
            ? activeKey
            : generationKey;
      if (kind === "missing-mapping") raw.exec("DELETE FROM job_mappings");
      else raw.prepare("DELETE FROM metadata WHERE key = ?").run(target);
    }
    if (kind === "bad-active" || kind === "bad-generation")
      raw
        .prepare("UPDATE metadata SET value = ? WHERE key = ?")
        .run(
          JSON.stringify({ ...value.owner, attempt: 2 }),
          kind === "bad-active" ? activeKey : generationKey,
        );
    if (kind === "wrong-key")
      raw
        .prepare("UPDATE metadata SET key = ? WHERE key = ?")
        .run(`${key}0`, key);
    if (kind === "mapping-status")
      raw.exec("UPDATE job_mappings SET status = 'running'");
    if (kind === "mapping-session")
      raw.prepare("UPDATE job_mappings SET session_id = ?").run(id(99));
    if (kind === "phase-mode") replace({ ...value, mode: "normal" });
    if (kind === "phase-evidence")
      replace({ ...value, startedEvidence: evidence(value) });
    if (kind === "unknown-prefix")
      raw
        .prepare("INSERT INTO metadata VALUES (?, '{}')")
        .run(`owned-intent-v2:${id(99)}:1`);
    const before = snapshot(raw);
    for (const read of [
      () => store.ownedIntent(id(1), 1),
      () => store.listOwnedIntents(),
      () => store.prepareOwnedIntent(input()),
      () =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "creating",
          mode: "normal",
        }),
      () =>
        store.mapJob({
          jobId: id(1),
          attempt: 1,
          sessionId: id(41),
          status: "running",
        }),
    ])
      expect(read).toThrow("OWNED_INTENT_CORRUPT");
    expect(snapshot(raw)).toEqual(before);
  });

  it("detects orphan phase mappings and indexes, and sorts independent jobs", () => {
    const { store, raw } = setup();
    receipt(store, offer(2));
    receipt(store);
    const second = store.prepareOwnedIntent(input(2));
    const first = store.prepareOwnedIntent(input());
    expect(store.listOwnedIntents()).toEqual([first, second]);
    raw.exec("DELETE FROM metadata");
    expect(() => store.ownedIntent(id(1), 1)).toThrow("OWNED_INTENT_CORRUPT");
  });

  it.each(["mapping", "record", "active", "generation"])(
    "rolls back failure after prepare %s insertion",
    (point) => {
      const { store, raw } = setup();
      receipt(store);
      const table = point === "mapping" ? "job_mappings" : "metadata";
      const target =
        point === "record"
          ? key
          : point === "active"
            ? activeKey
            : generationKey;
      let reached = 0;
      // The function runs on the store's actual connection; the independent raw
      // connection supplies the schema trigger and observes committed snapshots.
      const internal = (store as unknown as { database: Database.Database })
        .database;
      internal.function("journal_failure", () => {
        reached++;
        return 1;
      });
      raw.exec(
        `CREATE TRIGGER journal_failure AFTER INSERT ON ${table} ${point === "mapping" ? "" : `WHEN NEW.key = '${target}'`} BEGIN SELECT journal_failure(); SELECT RAISE(ABORT, 'private SQL diagnostic'); END`,
      );
      const before = snapshot(raw);
      expect(() => store.prepareOwnedIntent(input())).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      );
      expect(reached).toBe(1);
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it.each(["metadata", "job_mappings"])(
    "rolls back failure after transition %s update",
    (table) => {
      const { store, raw } = setup();
      receipt(store);
      const value = store.prepareOwnedIntent(input());
      let reached = 0;
      (store as unknown as { database: Database.Database }).database.function(
        "journal_failure",
        () => {
          reached++;
          return 1;
        },
      );
      raw.exec(
        `CREATE TRIGGER journal_failure AFTER UPDATE ON ${table} BEGIN SELECT journal_failure(); SELECT RAISE(ABORT, 'private SQL diagnostic'); END`,
      );
      const before = snapshot(raw);
      expect(() =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "creating",
          mode: "normal",
        }),
      ).toThrow("OWNED_INTENT_UNAVAILABLE");
      expect(reached).toBe(1);
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("rejects nested transactions before mutation and sanitizes closed operations", () => {
    const { store, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    const internal = (store as unknown as { database: Database.Database })
      .database;
    const before = snapshot(raw);
    internal.transaction(() => {
      for (const operation of [
        () => store.prepareOwnedIntent(input()),
        () =>
          store.advanceOwnedIntent(value.owner, 0, {
            phase: "creating",
            mode: "normal",
          }),
        () => store.ownedIntent(id(1), 1),
        () => store.listOwnedIntents(),
      ])
        expect(operation).toThrow("OWNED_INTENT_UNAVAILABLE");
    })();
    expect(snapshot(raw)).toEqual(before);
    store.close();
    for (const operation of [
      () => store.prepareOwnedIntent(input()),
      () =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "creating",
          mode: "normal",
        }),
      () => store.ownedIntent(id(1), 1),
      () => store.listOwnedIntents(),
    ])
      expect(operation).toThrow("OWNED_INTENT_UNAVAILABLE");
  });

  it("observes a separate connection's winning predecessor and rejects stale CAS", () => {
    const { store, path, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    const other = new SqlitePluginStore(path);
    try {
      other.advanceOwnedIntent(value.owner, 0, {
        phase: "creating",
        mode: "normal",
      });
      const before = snapshot(raw);
      expect(() =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "creating",
          mode: "normal",
        }),
      ).toThrow("OWNED_INTENT_CONFLICT");
      expect(snapshot(raw)).toEqual(before);
    } finally {
      other.close();
    }
  });

  it("keeps the 16KiB record bound on effective transitions", () => {
    const { store, raw } = setup();
    receipt(store);
    const value = store.prepareOwnedIntent(input());
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const sentAt = `2026-09-01T00:00:00.${"0".repeat(16384 - bytes - 1)}Z`;
    const bounded = { ...value, offer: { ...value.offer, sentAt } };
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBe(16384);
    raw
      .prepare("UPDATE metadata SET value = ? WHERE key = ?")
      .run(JSON.stringify(bounded), key);
    expect(store.ownedIntent(id(1), 1)).toEqual(bounded);
    const before = snapshot(raw);
    expect(() =>
      store.advanceOwnedIntent(value.owner, 0, {
        phase: "creating",
        mode: "normal",
      }),
    ).toThrow("OWNED_INTENT_INVALID");
    expect(snapshot(raw)).toEqual(before);
  });

  it.each(["metadata", "job_mappings"])(
    "rolls back zero-row %s transition writes",
    (table) => {
      const { store, raw } = setup();
      receipt(store);
      const value = store.prepareOwnedIntent(input());
      let reached = 0;
      (store as unknown as { database: Database.Database }).database.function(
        "journal_ignore",
        () => {
          reached++;
          return 1;
        },
      );
      raw.exec(
        `CREATE TRIGGER journal_ignore BEFORE UPDATE ON ${table} BEGIN SELECT journal_ignore(); SELECT RAISE(IGNORE); END`,
      );
      const before = snapshot(raw);
      expect(() =>
        store.advanceOwnedIntent(value.owner, 0, {
          phase: "creating",
          mode: "normal",
        }),
      ).toThrow("OWNED_INTENT_UNAVAILABLE");
      expect(reached).toBe(1);
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it.each(["job_mappings", "metadata"])(
    "rolls back zero-row %s prepare writes",
    (table) => {
      const { store, raw } = setup();
      receipt(store);
      let reached = 0;
      (store as unknown as { database: Database.Database }).database.function(
        "journal_ignore",
        () => {
          reached++;
          return 1;
        },
      );
      raw.exec(
        `CREATE TRIGGER journal_ignore BEFORE INSERT ON ${table} BEGIN SELECT journal_ignore(); SELECT RAISE(IGNORE); END`,
      );
      const before = snapshot(raw);
      expect(() => store.prepareOwnedIntent(input())).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      );
      expect(reached).toBe(1);
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("sanitizes SQLite lock failures from an independent writer", () => {
    const { store, raw } = setup();
    receipt(store);
    (store as unknown as { database: Database.Database }).database.pragma(
      "busy_timeout = 1",
    );
    const before = snapshot(raw);
    raw.exec("BEGIN IMMEDIATE");
    try {
      expect(() => store.prepareOwnedIntent(input())).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      );
    } finally {
      raw.exec("ROLLBACK");
    }
    expect(snapshot(raw)).toEqual(before);
    expect(store.prepareOwnedIntent(input()).phase).toBe("prepared");
  });

  it("preserves progressed duplicate state and detaches supplied started evidence", () => {
    const { store, raw } = setup();
    receipt(store);
    let value = store.prepareOwnedIntent(input());
    value = store.advanceOwnedIntent(value.owner, 0, {
      phase: "creating",
      mode: "normal",
    });
    value = store.advanceOwnedIntent(value.owner, 1, { phase: "submitting" });
    const supplied = evidence(value);
    value = store.advanceOwnedIntent(value.owner, 2, {
      phase: "started",
      evidence: supplied,
    });
    supplied.messageId = "changed";
    const before = snapshot(raw);
    expect(store.prepareOwnedIntent(input())).toEqual(value);
    expect(snapshot(raw)).toEqual(before);
    expect(value.startedEvidence?.messageId).toBe(input().initialMessageId);
    value = store.advanceOwnedIntent(value.owner, 3, {
      unavailable: "HARNESS_PERSISTENCE_UNAVAILABLE",
    });
    expect(store.prepareOwnedIntent(input())).toEqual(value);
  });

  it.each([
    "sessionId",
    "ownerGeneration",
    "attempt",
    "sequence",
    "timestamp",
    "repository",
    "extra-offer",
    "extra-payload",
    "oversize",
  ])("rejects invalid prepare %s", (field) => {
    const { store, raw } = setup();
    const candidate = input();
    if (field === "sessionId" || field === "ownerGeneration")
      candidate[field] = "invalid";
    if (field === "attempt") candidate.offer.payload.attempt = 2147483648;
    if (field === "sequence")
      candidate.offer.sequence = Number.MAX_SAFE_INTEGER + 1;
    if (field === "timestamp") candidate.offer.sent_at = "2026-02-30T00:00:00Z";
    if (field === "repository")
      candidate.offer.payload.repository_id = "../path";
    if (field === "extra-offer")
      Object.assign(candidate.offer, { extra: true });
    if (field === "extra-payload")
      Object.assign(candidate.offer.payload, { extra: true });
    if (field === "oversize")
      candidate.offer.sent_at = `2026-09-01T00:00:00.${"0".repeat(16384)}Z`;
    store.recordInbound(
      candidate.offer.message_id,
      1,
      JSON.stringify(candidate.offer),
    );
    const before = snapshot(raw);
    expect(() => store.prepareOwnedIntent(candidate)).toThrow(
      "OWNED_INTENT_INVALID",
    );
    expect(snapshot(raw)).toEqual(before);
  });

  it("hashes the parsed request and never copies its text into journal metadata", () => {
    const { store, raw } = setup();
    const candidate = input();
    candidate.offer.payload.request = "  journal test request  ";
    receipt(store, candidate.offer);
    const value = store.prepareOwnedIntent(candidate);
    expect(value.requestDigest).toBe(
      createHash("sha256").update("journal test request").digest("hex"),
    );
    expect(
      JSON.stringify(raw.prepare("SELECT * FROM metadata").all()),
    ).not.toContain("journal test request");
  });

  it.each(["job", "session", "uppercase-job", "uppercase-session"])(
    "refuses a legacy %s identity without backfill",
    (kind) => {
      const { store, raw } = setup();
      store.mapJob({
        jobId: kind.endsWith("job")
          ? kind.startsWith("uppercase")
            ? id(1).toUpperCase()
            : id(1)
          : id(2),
        attempt: 3,
        sessionId: kind.endsWith("session")
          ? kind.startsWith("uppercase")
            ? id(41).toUpperCase()
            : id(41)
          : id(42),
        status: "running",
      });
      receipt(store);
      const before = snapshot(raw);
      expect(() => store.prepareOwnedIntent(input())).toThrow(
        "OWNED_INTENT_CONFLICT",
      );
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it("classifies malformed SQLite mapping values as corruption", () => {
    const { store, raw } = setup();
    receipt(store);
    store.prepareOwnedIntent(input());
    raw.exec("UPDATE job_mappings SET job_id = X'FF'");
    const before = snapshot(raw);
    expect(() => store.listOwnedIntents()).toThrow("OWNED_INTENT_CORRUPT");
    expect(snapshot(raw)).toEqual(before);
  });
});
