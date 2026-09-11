import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatePayload, JobSyncPayload } from "@qhb/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactEvent } from "../redaction/redact-event.js";
import type { OwnedIntent } from "../store/owned-intent.js";
import {
  parseTerminalRecord,
  terminalCorrelation,
} from "../store/owned-terminal.js";
import {
  SqlitePluginStore,
  StoreSequenceError,
} from "../store/plugin-store.js";
import type {
  ConnectorEpoch,
  CoordinatingConnectorClient,
  PublishedSync,
  ServerEnvelope,
} from "../transport/connector-client.js";
import type { JobCancelMessage } from "./cancel-handler.js";
import type { CoordinationClockSample } from "./coordination-deadlines.js";
import { JobStateClient } from "./job-state-client.js";
import {
  assertTerminalAuthority,
  beginTerminalAuthority,
  captureTerminalBinding,
  type TerminalAuthorityBinding,
  TerminalAuthorityError,
  TerminalAuthorityIssuer,
  type TerminalOperation,
} from "./terminal-authority.js";

type State = Extract<ServerEnvelope, { type: "job.state" }>;
type Handler = Parameters<CoordinatingConnectorClient["onState"]>[0];
const origin = Date.parse("2026-09-01T00:00:00Z");
const stamp = (ms: number) => new Date(origin + ms).toISOString();
// Only the external delivery/allocation boundary is doubled. Registry and journal are real.
class Delivery implements CoordinatingConnectorClient {
  controller = new AbortController();
  epoch: ConnectorEpoch = { signal: this.controller.signal };
  handlers = new Set<Handler>();
  requests: PublishedSync[] = [];
  afterPersist = (_request: PublishedSync) => {};
  currentEpoch = () => this.epoch;
  async start() {
    throw new Error("unexpected native/transport effect");
  }
  async publish() {
    throw new Error("unexpected publication");
  }
  onCommand() {
    return () => {};
  }
  onEpoch() {
    return () => {};
  }
  onState(handler: Handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  publishSync(
    payload: JobSyncPayload,
    correlationId: string,
    registered: (request: PublishedSync) => undefined,
  ) {
    const request = {
      messageId: randomUUID(),
      sequence: this.requests.length + 1,
      correlationId,
      jobId: payload.job_id,
      attempt: payload.attempt,
      nonce: payload.nonce,
      epoch: this.epoch,
    };
    this.requests.push(request);
    registered(request);
    this.afterPersist(request);
  }
  state(
    request = this.requests.at(-1) as PublishedSync,
    patch: Partial<JobStatePayload> = {},
  ): State {
    return {
      protocol_version: "1.0",
      type: "job.state",
      message_id: randomUUID(),
      sequence: 90,
      correlation_id: request.correlationId,
      sent_at: stamp(0),
      expires_at: stamp(60000),
      payload: {
        job_id: request.jobId,
        repository_id: "example",
        mode: "normal",
        requested_attempt: request.attempt,
        current_attempt: request.attempt,
        status: "running",
        job_revision: 9,
        cancel_revision: null,
        lease_id: randomUUID(),
        lease_expires_at: stamp(-1000),
        expires_at: stamp(10000),
        observed_at: stamp(0),
        state_valid_until: stamp(2000),
        request_message_id: request.messageId,
        request_sequence: request.sequence,
        nonce: request.nonce,
        ...patch,
      },
    };
  }
  deliver(
    state = this.state(),
    delivery = { epoch: this.epoch, recovered: false },
  ) {
    for (const handler of this.handlers) handler(state, delivery);
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
function fixture(
  phase: OwnedIntent["phase"] = "started",
  mode: "normal" | "read_only" = "normal",
  eventSequence = 0,
) {
  vi.useFakeTimers();
  const path = join(
    mkdtempSync(join(tmpdir(), "terminal-authority-")),
    "store.sqlite",
  );
  const store = new SqlitePluginStore(path);
  const raw = new Database(path);
  const connector = new Delivery();
  let sample: CoordinationClockSample = {
    wallTimeMs: origin,
    monotonicTimeMs: 10000,
  };
  let clock = () => sample;
  const states = new JobStateClient({ connector, clock: () => sample });
  const parent = new AbortController();
  const lifetime = new AbortController();
  const issuer = new TerminalAuthorityIssuer({
    connector,
    states,
    store,
    clock: () => clock(),
    signal: parent.signal,
  });
  cleanup.push(() => {
    issuer.dispose();
    states.dispose();
    raw.close();
    store.close();
  });
  function prepare() {
    const offer: Extract<ServerEnvelope, { type: "job.offer" }> = {
      protocol_version: "1.0",
      type: "job.offer",
      message_id: randomUUID(),
      sequence: store.maxInboundSequence() + 1,
      correlation_id: randomUUID(),
      sent_at: stamp(0),
      expires_at: stamp(60000),
      payload: {
        job_id: randomUUID(),
        attempt: 1,
        repository_id: "example",
        lease_id: randomUUID(),
        request: "fixture",
      },
    };
    store.recordInbound(
      offer.message_id,
      offer.sequence,
      JSON.stringify(offer),
    );
    let record = store.prepareOwnedIntent({
      offer,
      sessionId: randomUUID(),
      initialMessageId: "native:initial",
      ownerGeneration: randomUUID(),
    });
    if (phase !== "prepared")
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "creating",
        mode,
      });
    if (phase === "submitting" || phase === "started")
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "submitting",
      });
    if (phase === "started")
      record = store.advanceOwnedIntent(record.owner, record.version, {
        phase: "started",
        evidence: {
          sessionId: record.owner.sessionId,
          messageId: record.initialMessageId,
          requestDigest: record.requestDigest,
          eventSequence,
        },
      });
    return record;
  }
  const record = prepare();
  const binding = (
    operation: TerminalOperation = {
      kind: "native",
      outcome: "succeeded",
      eventSequence,
    },
    value = record,
  ): TerminalAuthorityBinding => ({
    owner: { ...value.owner },
    expectedVersion: value.version,
    operation,
  });
  const command = (): JobCancelMessage => ({
    protocol_version: "1.0",
    type: "job.cancel",
    message_id: randomUUID(),
    sequence: 99,
    correlation_id: randomUUID(),
    sent_at: stamp(0),
    expires_at: stamp(5000),
    payload: {
      job_id: record.owner.jobId,
      attempt: 1,
      job_revision: 4,
      reason: "user request",
      nonce: randomUUID(),
    },
  });
  const issue = (bound = binding(), cmd?: JobCancelMessage) =>
    issuer.issue({
      ...bound,
      signal: lifetime.signal,
      ...(cmd === undefined ? {} : { command: cmd }),
    });
  const respond = (patch: Partial<JobStatePayload> = {}) => {
    sample = { wallTimeMs: origin + 100, monotonicTimeMs: 10100 };
    if (connector.requests.length === 0) return;
    connector.deliver(connector.state(undefined, { mode, ...patch }));
  };
  const ready = async (
    bound = binding(),
    patch: Partial<JobStatePayload> = {},
    cmd?: JobCancelMessage,
  ) => {
    const pending = issue(bound, cmd);
    respond(patch);
    return pending;
  };
  return {
    store,
    raw,
    connector,
    states,
    parent,
    lifetime,
    issuer,
    record,
    prepare,
    binding,
    command,
    issue,
    respond,
    ready,
    time: (ms: number, wall = ms - 10000) => {
      sample = { wallTimeMs: origin + wall, monotonicTimeMs: ms };
    },
    clock: (replacement: () => CoordinationClockSample) => {
      clock = replacement;
    },
    rows: () =>
      ["metadata", "job_mappings", "inbound_messages", "outbound_events"].map(
        (table) => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
  };
}
async function failure(
  pending: Promise<unknown>,
  code = "TERMINAL_AUTHORITY_UNAVAILABLE",
) {
  const error = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(TerminalAuthorityError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain("private");
  expect(error).not.toHaveProperty("cause");
}
function revoked(effect: () => unknown) {
  expect(effect).toThrow(TerminalAuthorityError);
  try {
    effect();
  } catch (error) {
    expect(error).toMatchObject({ code: "TERMINAL_AUTHORITY_REVOKED" });
  }
}

function cancellationProposal(f: ReturnType<typeof fixture>) {
  const binding = {
    ...f.binding(),
    operation: { kind: "cancel" as const, cancelRevision: 4 },
  };
  const proposal = {
    binding,
    type: "job.cancelled" as const,
    correlationId: terminalCorrelation(binding),
    payload: {
      job_id: binding.owner.jobId,
      attempt: binding.owner.attempt,
      reason: "Cancelled by owner",
    },
  };
  const factory = () => {
    const messageId = randomUUID();
    return {
      messageId,
      sequence: 1,
      expectedReceiptProfile: "job-coordination-v1" as const,
      payload: JSON.stringify({
        protocol_version: "1.0",
        type: proposal.type,
        message_id: messageId,
        sequence: 1,
        correlation_id: proposal.correlationId,
        sent_at: stamp(100),
        expires_at: stamp(60100),
        payload: proposal.payload,
      }),
    };
  };
  return { binding, proposal, factory };
}

describe("live terminal authority", () => {
  it.each([
    "missing-outbox",
    "missing-profile",
    "wrong-profile",
    "sent-at",
    "correlation",
    "payload",
    "status",
    "outcome",
    "type",
  ])(
    "I4 local committed history fails closed after %s corruption",
    async (fault) => {
      const f = fixture();
      const cancel = cancellationProposal(f);
      const binding = {
        ...f.binding(),
        operation: {
          kind: "native" as const,
          outcome: "succeeded" as const,
          eventSequence: 1,
        },
      };
      const token = await f.ready(binding);
      const proposal = {
        binding,
        type: "job.event" as const,
        correlationId: terminalCorrelation(binding),
        payload: {
          job_id: binding.owner.jobId,
          attempt: 1,
          event_type: "job.succeeded",
          source: "harness",
          payload: { summary: "Done" },
        },
      };
      const result = f.store.commitTerminal(proposal, token, () => {
        const event = cancel.factory();
        return {
          ...event,
          payload: JSON.stringify({
            ...JSON.parse(event.payload),
            type: proposal.type,
            correlation_id: proposal.correlationId,
            payload: proposal.payload,
          }),
        };
      });
      if (result.kind !== "committed") throw new Error();
      const winner = result.winner;
      if (fault === "missing-outbox") f.raw.exec("DELETE FROM outbound_events");
      else if (fault === "missing-profile")
        f.raw.exec(
          "DELETE FROM metadata WHERE key LIKE 'outbound-receipt-profile:%'",
        );
      else if (fault === "wrong-profile")
        f.raw.exec(
          "UPDATE metadata SET value = 'wrong' WHERE key LIKE 'outbound-receipt-profile:%'",
        );
      else {
        const row = f.raw
          .prepare("SELECT payload_json FROM outbound_events")
          .get() as { payload_json: string };
        const message = JSON.parse(row.payload_json);
        if (fault === "sent-at") message.sent_at = stamp(101);
        else if (fault === "correlation") message.correlation_id = randomUUID();
        else if (fault === "payload")
          message.payload.payload.summary = "Changed";
        else {
          message.payload.payload[fault] = "failed";
          const corrupt = { ...winner, payload: message.payload };
          expect(() => parseTerminalRecord(JSON.stringify(corrupt))).toThrow(
            "OWNED_INTENT_CORRUPT",
          );
          f.raw
            .prepare("UPDATE metadata SET value = ? WHERE key = ?")
            .run(
              JSON.stringify(corrupt),
              `owned-terminal-v1:${binding.owner.jobId}:1`,
            );
        }
        f.raw
          .prepare("UPDATE outbound_events SET payload_json = ?")
          .run(JSON.stringify(message));
      }
      const before = f.rows();
      expect(() => f.store.readTerminal(binding.owner)).toThrow(
        "OWNED_INTENT_CORRUPT",
      );
      expect(() => f.store.ownedIntent(binding.owner.jobId, 1)).toThrow(
        "OWNED_INTENT_CORRUPT",
      );
      let allocations = 0;
      expect(() =>
        f.store.commitTerminal(proposal, token, () => {
          allocations++;
          return cancel.factory();
        }),
      ).toThrow();
      expect(allocations).toBe(0);
      expect(f.rows()).toEqual(before);
    },
  );
  it("I3 accepts actual structured redactor output and I4 rejects same-event changed summary", async () => {
    const f = fixture();
    const binding = {
      ...f.binding(),
      operation: {
        kind: "native" as const,
        outcome: "succeeded" as const,
        eventSequence: 1,
      },
    };
    const token = await f.ready(binding);
    const payload = redactEvent(
      {
        summary: "Done",
        stage: "complete",
        changed_files: ["package.json"],
        tests: { passed: 2, failed: 0, total: 2 },
        artifacts: [
          {
            name: "Report",
            media_type: "text/plain",
            url: "https://example.com/report",
          },
        ],
      },
      { repositoryRoot: process.cwd(), homeDirectory: tmpdir() },
    );
    const proposal = {
      binding,
      type: "job.event" as const,
      correlationId: terminalCorrelation(binding),
      payload: {
        job_id: binding.owner.jobId,
        attempt: 1,
        event_type: "job.succeeded",
        source: "harness",
        payload,
      },
    };
    const result = f.store.commitTerminal(proposal, token, () => {
      const event = cancellationProposal(f).factory();
      return {
        ...event,
        payload: JSON.stringify({
          ...JSON.parse(event.payload),
          type: proposal.type,
          correlation_id: proposal.correlationId,
          payload: proposal.payload,
        }),
      };
    });
    if (result.kind !== "committed") throw new Error();
    expect(parseTerminalRecord(JSON.stringify(result.winner))).toEqual(
      result.winner,
    );
    const before = f.rows();
    let allocations = 0;
    expect(() =>
      f.store.commitTerminal(
        {
          ...proposal,
          payload: {
            ...proposal.payload,
            payload: { ...payload, summary: "Changed" },
          },
        },
        token,
        () => {
          allocations++;
          return cancellationProposal(f).factory();
        },
      ),
    ).toThrow("OWNED_INTENT_CONFLICT");
    expect(allocations).toBe(0);
    expect(f.rows()).toEqual(before);
    expect(f.store.readTerminal(binding.owner)).toEqual(result.winner);
  });
  it.each([
    { summary: "Done", status: "failed" },
    { summary: "Done", outcome: "failed" },
    { summary: "Done", type: "failed" },
    {},
    { summary: "" },
    { summary: "x".repeat(501) },
    { summary: "Done", tests: { passed: 1, failed: 1, total: 1 } },
    {
      summary: "Done",
      artifacts: [
        {
          name: "Report",
          media_type: "text/plain",
          url: "https://example.com/?secret=x",
        },
      ],
    },
  ])(
    "I3 rejects malformed native projection %j before factory",
    async (payload) => {
      const f = fixture();
      const binding = {
        ...f.binding(),
        operation: {
          kind: "native" as const,
          outcome: "succeeded" as const,
          eventSequence: 1,
        },
      };
      const token = await f.ready(binding);
      const before = f.rows();
      let allocations = 0;
      expect
        .soft(() =>
          f.store.commitTerminal(
            {
              binding,
              type: "job.event",
              correlationId: terminalCorrelation(binding),
              payload: {
                job_id: binding.owner.jobId,
                attempt: 1,
                event_type: "job.succeeded",
                source: "harness",
                payload,
              },
            },
            token,
            () => {
              allocations++;
              throw new Error("factory reached");
            },
          ),
        )
        .toThrow("OWNED_INTENT_INVALID");
      expect(allocations).toBe(0);
      expect(f.rows()).toEqual(before);
    },
  );
  it("keeps the shared binding capture error fixed for invalid private input", () => {
    const f = fixture();
    expect(() =>
      captureTerminalBinding({
        ...f.binding(),
        operation: { kind: "unavailable", reason: "private input" } as never,
      }),
    ).toThrow("TERMINAL_AUTHORITY_INVALID");
  });
  it("prevents a terminal factory from mutating unrelated legacy mappings", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    expect(
      f.store.commitTerminal(proposal, token, () => {
        expect(() =>
          f.store.mapJob({
            jobId: randomUUID(),
            attempt: 1,
            sessionId: randomUUID(),
            status: "running",
          }),
        ).toThrow("OWNED_INTENT_UNAVAILABLE");
        return factory();
      }).kind,
    ).toBe("committed");
    expect(f.raw.prepare("SELECT * FROM job_mappings").all()).toHaveLength(1);
  });
  it("rolls back when the original lifetime ends at the precommit fence", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    let checks = 0;
    f.clock(() => {
      if (++checks === 3) f.lifetime.abort();
      return { wallTimeMs: origin + 100, monotonicTimeMs: 10100 };
    });
    const before = f.rows();
    expect(() => f.store.commitTerminal(proposal, token, factory)).toThrow();
    expect(checks).toBe(3);
    expect(f.rows()).toEqual(before);
  });
  it("rejects asynchronous envelope construction with no partial writes", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const before = f.rows();
    expect(() =>
      f.store.commitTerminal(proposal, token, (() =>
        Promise.resolve(factory())) as never),
    ).toThrow("OWNED_INTENT_INVALID");
    expect(f.rows()).toEqual(before);
  });
  it.each(["payload_json", "attempts", "acknowledged_at"])(
    "rejects BLOB %s in retained local outbound evidence",
    async (field) => {
      const f = fixture();
      const { binding, proposal, factory } = cancellationProposal(f);
      const token = await f.ready(
        binding,
        { status: "cancelling", cancel_revision: 4 },
        f.command(),
      );
      f.store.commitTerminal(proposal, token, factory);
      const row = f.raw
        .prepare(`SELECT ${field} AS value FROM outbound_events`)
        .get() as { value: unknown };
      f.raw
        .prepare(`UPDATE outbound_events SET ${field} = ?`)
        .run(Buffer.from(String(row.value ?? stamp(100))));
      const before = f.rows();
      expect(() => f.store.readTerminal(binding.owner)).toThrow(
        "OWNED_INTENT_CORRUPT",
      );
      expect(f.rows()).toEqual(before);
    },
  );
  it.each(["native", "cancel"] as const)(
    "arbitrates %s first, rejects contradictory native content, and retains the local winner during remote reconciliation",
    async (first) => {
      const f = fixture();
      const cancel = cancellationProposal(f);
      const nativeBinding = {
        ...cancel.binding,
        operation: {
          kind: "native" as const,
          outcome: "succeeded" as const,
          eventSequence: 1,
        },
      };
      const changedBinding = {
        ...nativeBinding,
        operation: { ...nativeBinding.operation, outcome: "failed" as const },
      };
      const cancelToken = await f.ready(
        cancel.binding,
        { status: "cancelling", cancel_revision: 4 },
        f.command(),
      );
      const nativeToken = await f.ready(nativeBinding);
      const changedToken = await f.ready(changedBinding);
      const nativeProposal = {
        binding: nativeBinding,
        type: "job.event" as const,
        correlationId: terminalCorrelation(nativeBinding),
        payload: {
          job_id: f.record.owner.jobId,
          attempt: 1,
          event_type: "job.succeeded",
          source: "harness",
          payload: { summary: "Done" },
        },
      };
      const nativeFactory = () => {
        const event = cancel.factory();
        return {
          ...event,
          payload: JSON.stringify({
            ...JSON.parse(event.payload),
            type: nativeProposal.type,
            correlation_id: nativeProposal.correlationId,
            payload: nativeProposal.payload,
          }),
        };
      };
      const winner =
        first === "native"
          ? f.store.commitTerminal(nativeProposal, nativeToken, nativeFactory)
          : f.store.commitTerminal(
              cancel.proposal,
              cancelToken,
              cancel.factory,
            );
      expect(winner.kind).toBe("committed");
      const before = f.rows();
      const forbidden = () => {
        throw new Error("existing winner allocated");
      };
      expect(
        first === "native"
          ? f.store.commitTerminal(cancel.proposal, cancelToken, forbidden)
          : f.store.commitTerminal(nativeProposal, nativeToken, forbidden),
      ).toMatchObject({ kind: "existing", relation: "competing" });
      if (first === "native")
        expect(() =>
          f.store.commitTerminal(
            {
              ...nativeProposal,
              binding: changedBinding,
              payload: { ...nativeProposal.payload, event_type: "job.failed" },
            },
            changedToken,
            forbidden,
          ),
        ).toThrow("OWNED_INTENT_CONFLICT");
      expect(f.rows()).toEqual(before);
      const current = f.store.ownedIntent(f.record.owner.jobId, 1);
      if (!current) throw new Error();
      const remoteBinding = {
        owner: current.owner,
        expectedVersion: current.version,
        operation: { kind: "reconcile" as const },
      };
      const remote = await f.ready(remoteBinding, {
        status: "expired",
        expires_at: stamp(-1000),
      });
      expect(f.store.reconcileTerminal(remoteBinding, remote)).toMatchObject({
        kind: "existing",
        record: {
          kind: "local",
          status: first === "native" ? "succeeded" : "cancelled",
        },
        observedRemote: { status: "expired" },
      });
      expect(f.rows()).toEqual(before);
    },
  );
  it("commits the fixed latched unavailable reason from a prepared predecessor", async () => {
    const f = fixture("prepared");
    const current = f.store.advanceOwnedIntent(
      f.record.owner,
      f.record.version,
      { unavailable: "HARNESS_SESSION_LOST" },
    );
    const binding = {
      owner: current.owner,
      expectedVersion: current.version,
      operation: {
        kind: "unavailable" as const,
        reason: "HARNESS_SESSION_LOST" as const,
      },
    };
    const token = await f.ready(binding);
    const proposal = {
      binding,
      correlationId: terminalCorrelation(binding),
      type: "job.event" as const,
      payload: {
        job_id: current.owner.jobId,
        attempt: 1,
        event_type: "job.failed",
        source: "harness",
        payload: { stage: "failed", summary: "HARNESS_SESSION_LOST" },
      },
    };
    const factory = () => {
      const messageId = randomUUID();
      return {
        messageId,
        sequence: 1,
        expectedReceiptProfile: "job-coordination-v1" as const,
        payload: JSON.stringify({
          protocol_version: "1.0",
          type: proposal.type,
          message_id: messageId,
          sequence: 1,
          correlation_id: proposal.correlationId,
          sent_at: stamp(100),
          expires_at: stamp(60100),
          payload: proposal.payload,
        }),
      };
    };
    expect(f.store.commitTerminal(proposal, token, factory)).toMatchObject({
      kind: "committed",
      winner: {
        status: "failed",
        predecessor: { phase: "prepared", unavailable: "HARNESS_SESSION_LOST" },
      },
    });
    expect(() =>
      f.store.advanceOwnedIntent(current.owner, current.version + 1, {
        unavailable: "HARNESS_SESSION_LOST",
      }),
    ).toThrow();
  });
  it("rejects store recursion while capturing a proposal before entering SQLite", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    let reads = 0;
    const input = {
      ...proposal,
      get correlationId() {
        reads++;
        expect(() => f.store.commitTerminal(proposal, token, factory)).toThrow(
          "OWNED_INTENT_UNAVAILABLE",
        );
        return proposal.correlationId;
      },
    };
    expect(f.store.commitTerminal(input, token, factory).kind).toBe(
      "committed",
    );
    expect(reads).toBe(1);
  });
  it("rejects predecessor mutation during envelope construction instead of overwriting a changed CAS", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const db = (f.store as unknown as { database: Database.Database }).database;
    const before = f.rows();
    expect(() =>
      f.store.commitTerminal(proposal, token, () => {
        db.prepare(
          "UPDATE metadata SET value = json_set(value, '$.version', 99) WHERE key LIKE 'owned-intent-v1:%'",
        ).run();
        return factory();
      }),
    ).toThrow();
    expect(f.rows()).toEqual(before);
  });
  it.each(["intent", "mapping", "marker", "outbox", "profile"])(
    "rolls back the complete joined snapshot after reached %s write",
    async (point) => {
      const f = fixture();
      const { binding, proposal, factory } = cancellationProposal(f);
      const token = await f.ready(
        binding,
        { status: "cancelling", cancel_revision: 4 },
        f.command(),
      );
      const db = (f.store as unknown as { database: Database.Database })
        .database;
      let reached = 0;
      db.function("terminal_failure", () => {
        reached++;
        return 1;
      });
      const target =
        point === "intent"
          ? ["UPDATE", "metadata", "NEW.key LIKE 'owned-intent-v1:%'"]
          : point === "mapping"
            ? ["UPDATE", "job_mappings", "1"]
            : point === "outbox"
              ? [
                  "INSERT",
                  "outbound_events",
                  "json_extract(NEW.payload_json, '$.type') = 'job.cancelled'",
                ]
              : [
                  "INSERT",
                  "metadata",
                  `NEW.key LIKE '${point === "marker" ? "owned-terminal-v1:" : "outbound-receipt-profile:"}%'`,
                ];
      db.exec(
        `CREATE TRIGGER terminal_failure AFTER ${target[0]} ON ${target[1]} WHEN ${target[2]} BEGIN SELECT terminal_failure(); SELECT RAISE(ABORT, 'private failure'); END`,
      );
      const before = f.rows();
      expect(() => f.store.commitTerminal(proposal, token, factory)).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      );
      expect(reached).toBe(1);
      expect(f.rows()).toEqual(before);
    },
  );
  it("rejects nested terminal entry before authority or envelope callbacks", async () => {
    const f = fixture();
    const { binding, proposal, factory } = cancellationProposal(f);
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const db = (f.store as unknown as { database: Database.Database }).database;
    let callbacks = 0;
    f.clock(() => {
      callbacks++;
      return { wallTimeMs: origin + 100, monotonicTimeMs: 10100 };
    });
    const before = f.rows();
    db.transaction(() =>
      expect(() => f.store.commitTerminal(proposal, token, factory)).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      ),
    )();
    expect(callbacks).toBe(0);
    expect(f.rows()).toEqual(before);
  });
  it.each(["intent", "mapping", "marker", "outbox", "profile"])(
    "fails closed on reached zero-row %s CAS",
    async (point) => {
      const f = fixture();
      const { binding, proposal, factory } = cancellationProposal(f);
      const token = await f.ready(
        binding,
        { status: "cancelling", cancel_revision: 4 },
        f.command(),
      );
      const db = (f.store as unknown as { database: Database.Database })
        .database;
      let reached = 0;
      db.function("terminal_ignore", () => {
        reached++;
        return 1;
      });
      const update = point === "intent" || point === "mapping";
      const table =
        point === "mapping"
          ? "job_mappings"
          : point === "outbox"
            ? "outbound_events"
            : "metadata";
      const condition =
        point === "marker"
          ? "NEW.key LIKE 'owned-terminal-v1:%'"
          : point === "profile"
            ? "NEW.key LIKE 'outbound-receipt-profile:%'"
            : "1";
      db.exec(
        `CREATE TRIGGER terminal_ignore BEFORE ${update ? "UPDATE" : "INSERT"} ON ${table} WHEN ${condition} BEGIN SELECT terminal_ignore(); SELECT RAISE(IGNORE); END`,
      );
      const before = f.rows();
      expect(() => f.store.commitTerminal(proposal, token, factory)).toThrow(
        "OWNED_INTENT_UNAVAILABLE",
      );
      expect(reached).toBe(1);
      expect(f.rows()).toEqual(before);
    },
  );
  it.each(["succeeded", "failed", "cancelled", "expired"] as const)(
    "closes remote %s without outbound identity or rows",
    async (status) => {
      const f = fixture();
      const binding = {
        ...f.binding(),
        operation: { kind: "reconcile" as const },
      };
      const token = await f.ready(binding, {
        status,
        expires_at: stamp(-1000),
      });
      expect(f.store.reconcileTerminal(binding, token)).toMatchObject({
        kind: "reconciled",
        record: { kind: "remote", status },
      });
      expect(f.store.maxOutboundSequence()).toBe(0);
      expect(f.raw.prepare("SELECT * FROM outbound_events").all()).toEqual([]);
      const record = f.store.readTerminal(binding.owner);
      expect(record).not.toHaveProperty("outbound");
      expect(record).not.toHaveProperty("correlationId");
      expect(f.store.listNonterminalJobs()).toEqual([]);
      const current = f.store.ownedIntent(binding.owner.jobId, 1);
      if (!current) throw new Error();
      const freshBinding = { ...binding, expectedVersion: current.version };
      const fresh = await f.ready(freshBinding, {
        status,
        expires_at: stamp(-1000),
      });
      const before = f.rows();
      expect(f.store.reconcileTerminal(freshBinding, fresh)).toMatchObject({
        kind: "existing",
        record,
      });
      expect(f.rows()).toEqual(before);
      await failure(
        f.ready({ ...f.binding(), expectedVersion: current.version }),
      );
    },
  );
  it("preserves sequence conflict classification across the outer terminal transaction", async () => {
    const f = fixture();
    const binding = f.binding({ kind: "cancel", cancelRevision: 4 });
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const correlationId = terminalCorrelation(binding as never);
    const payload = {
      job_id: f.record.owner.jobId,
      attempt: 1,
      reason: "Cancelled by owner",
    };
    const event = {
      messageId: randomUUID(),
      sequence: 1,
      expectedReceiptProfile: "job-coordination-v1" as const,
      payload: JSON.stringify({
        protocol_version: "1.0",
        type: "job.cancelled",
        message_id: randomUUID(),
        sequence: 1,
        correlation_id: correlationId,
        sent_at: stamp(100),
        expires_at: stamp(60100),
        payload,
      }),
    };
    const body = JSON.parse(event.payload);
    body.message_id = event.messageId;
    event.payload = JSON.stringify(body);
    f.store.enqueueEvent({
      messageId: randomUUID(),
      sequence: 1,
      payload: "{}",
    });
    const before = f.rows();
    expect(() =>
      f.store.commitTerminal(
        {
          binding: binding as never,
          type: "job.cancelled",
          payload,
          correlationId,
        },
        token,
        () => event,
      ),
    ).toThrow(StoreSequenceError);
    expect(f.rows()).toEqual(before);
  });
  it("atomically joins a local cancellation and arbitrates exact retries without allocation", async () => {
    const f = fixture();
    const binding = f.binding({ kind: "cancel", cancelRevision: 4 });
    const token = await f.ready(
      binding,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const proposal = {
      binding: binding as never,
      correlationId: terminalCorrelation(binding as never),
      type: "job.cancelled" as const,
      payload: {
        job_id: f.record.owner.jobId,
        attempt: 1,
        reason: "Cancelled by owner",
      },
    };
    let allocations = 0;
    const factory = () => {
      allocations++;
      return {
        messageId: randomUUID(),
        sequence: 1,
        expectedReceiptProfile: "job-coordination-v1" as const,
        payload: "",
      };
    };
    const commit = f.store.commitTerminal;
    const result = commit.call(f.store, proposal, token, () => {
      const event = factory();
      return {
        ...event,
        payload: JSON.stringify({
          protocol_version: "1.0",
          message_id: event.messageId,
          sequence: event.sequence,
          correlation_id: proposal.correlationId,
          type: proposal.type,
          payload: proposal.payload,
          sent_at: stamp(100),
          expires_at: stamp(60100),
        }),
      };
    });
    expect(result).toMatchObject({
      kind: "committed",
      winner: { status: "cancelled" },
    });
    expect(f.store.ownedIntent(f.record.owner.jobId, 1)).toMatchObject({
      phase: "terminal",
      version: 4,
    });
    expect(f.store.findJob(f.record.owner.jobId)?.status).toBe("cancelled");
    const before = f.rows();
    expect(commit.call(f.store, proposal, token, factory)).toMatchObject({
      kind: "existing",
      relation: "same",
    });
    expect(allocations).toBe(1);
    expect(f.rows()).toEqual(before);
  });
  it.each(["succeeded", "failed", "cancelled", "expired"] as const)(
    "reconciles fresh remote %s after job expiry, but never beyond snapshot",
    async (status) => {
      const f = fixture();
      const binding = f.binding({ kind: "reconcile" } as TerminalOperation);
      const token = await f.ready(binding, {
        status,
        expires_at: stamp(-1000),
      });
      expect(beginTerminalAuthority(token, binding).state.status).toBe(status);
      f.time(10999);
      expect(assertTerminalAuthority(token, binding).state.status).toBe(status);
      f.time(11000);
      revoked(() => beginTerminalAuthority(token, binding));
      f.time(10100);
      revoked(() => assertTerminalAuthority(token, binding));
    },
  );
  it.each(["normal", "read_only"] as const)(
    "admits %s native completion with expired different dispatch lease and no writes",
    async (mode) => {
      const f = fixture("started", mode);
      const before = f.rows();
      const token = await f.ready();
      const b = f.binding();
      const snapshot = beginTerminalAuthority(token, b);
      expect(snapshot).toEqual({
        binding: b,
        state: expect.objectContaining({ mode, status: "running" }),
      });
      expect(Object.isFrozen(snapshot.binding.owner)).toBe(true);
      expect(Object.isFrozen(snapshot.binding.operation)).toBe(true);
      expect(Object.isFrozen(snapshot.state)).toBe(true);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(token)).toBe(true);
      expect(Object.keys(token)).toEqual([]);
      f.store.close();
      expect(assertTerminalAuthority(token, b)).toBe(snapshot);
      expect(f.rows()).toEqual(before);
      expect(f.connector.requests).toHaveLength(1);
    },
  );
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
  ] as const)(
    "enforces each operation's allowed status: %s",
    async (status) => {
      for (const outcome of ["succeeded", "failed"] as const) {
        const f = fixture();
        const b = f.binding({ kind: "native", outcome, eventSequence: 0 });
        const pending = f.ready(b, { status });
        if (
          status === "running" ||
          status === "cancelling" ||
          (status === "waiting_approval" && outcome === "failed")
        )
          expect(beginTerminalAuthority(await pending, b).state.status).toBe(
            status,
          );
        else await failure(pending);
      }
    },
  );
  it.each(["prepared", "creating", "submitting", "started"] as const)(
    "requires native proof but permits cancel and persisted unavailable in %s",
    async (phase) => {
      const f = fixture(phase);
      const native = f.ready();
      if (phase === "started")
        beginTerminalAuthority(await native, f.binding());
      else await failure(native);
      const cancel = f.binding({ kind: "cancel", cancelRevision: 4 });
      beginTerminalAuthority(
        await f.ready(
          cancel,
          { status: "cancelling", cancel_revision: 4 },
          f.command(),
        ),
        cancel,
      );
      const unavailable = f.binding({
        kind: "unavailable",
        reason: "HARNESS_SESSION_LOST",
      });
      await failure(f.issue(unavailable));
      const latched = f.store.advanceOwnedIntent(
        f.record.owner,
        f.record.version,
        { unavailable: "HARNESS_SESSION_LOST" },
      );
      const b = f.binding(unavailable.operation, latched);
      beginTerminalAuthority(
        await f.ready(b, { status: "waiting_approval" }),
        b,
      );
      await failure(
        f.issue(
          f.binding(
            { kind: "unavailable", reason: "HARNESS_PERSISTENCE_UNAVAILABLE" },
            latched,
          ),
        ),
      );
      await failure(
        f.issue(
          f.binding(
            { kind: "native", outcome: "failed", eventSequence: 0 },
            latched,
          ),
        ),
      );
    },
  );
  it("rejects older native event evidence while permitting sequence zero", async () => {
    const f = fixture("started", "normal", 5);
    await failure(
      f.issue(
        f.binding({ kind: "native", outcome: "failed", eventSequence: 4 }),
      ),
    );
    beginTerminalAuthority(await f.ready(), f.binding());
  });
  it.each(["owner", "version", "mode", "attempt"])(
    "rejects %s mismatch",
    async (kind) => {
      const f = fixture();
      const b = f.binding();
      if (kind === "owner") b.owner = { ...b.owner, sessionId: randomUUID() };
      if (kind === "version") b.expectedVersion++;
      await failure(
        f.ready(
          b,
          kind === "mode"
            ? { mode: "read_only" }
            : kind === "attempt"
              ? { current_attempt: 2 }
              : {},
        ),
      );
    },
  );
  it.each(["phase", "latch", "closed", "corrupt"])(
    "rejects predecessor %s changing during observation",
    async (kind) => {
      const f = fixture(kind === "phase" ? "creating" : "started");
      const b = f.binding({ kind: "cancel", cancelRevision: 4 });
      const pending = f.issue(b, f.command());
      if (kind === "phase")
        f.store.advanceOwnedIntent(f.record.owner, f.record.version, {
          phase: "submitting",
        });
      if (kind === "latch")
        f.store.advanceOwnedIntent(f.record.owner, f.record.version, {
          unavailable: "HARNESS_SESSION_LOST",
        });
      if (kind === "closed") f.store.close();
      if (kind === "corrupt")
        f.raw
          .prepare(
            "UPDATE metadata SET value = '{}' WHERE key LIKE 'owned-intent-v1:%'",
          )
          .run();
      f.respond({ status: "cancelling", cancel_revision: 4 });
      await failure(pending);
    },
  );
  it.each(["missing", "closed", "corrupt"])(
    "never treats %s storage as authority",
    async (kind) => {
      const f = fixture();
      const b = f.binding();
      if (kind === "missing") b.owner = { ...b.owner, jobId: randomUUID() };
      if (kind === "closed") f.store.close();
      if (kind === "corrupt")
        f.raw
          .prepare(
            "UPDATE metadata SET value = '{}' WHERE key LIKE 'owned-intent-v1:%'",
          )
          .run();
      await failure(f.issue(b));
      expect(f.connector.requests).toHaveLength(0);
    },
  );
  it.each([
    "repository_id",
    "request_message_id",
    "request_sequence",
    "nonce",
    "requested_attempt",
    "job_id",
    "correlation",
    "recovered",
    "foreign",
  ])("does not turn %s response mismatch into a grant", async (field) => {
    const f = fixture();
    const pending = f.issue();
    const state = f.connector.state();
    if (field === "repository_id") state.payload.repository_id = "other";
    if (field === "request_message_id")
      state.payload.request_message_id = randomUUID();
    if (field === "request_sequence") state.payload.request_sequence++;
    if (field === "nonce") state.payload.nonce = randomUUID();
    if (field === "requested_attempt") state.payload.requested_attempt++;
    if (field === "job_id") state.payload.job_id = randomUUID();
    if (field === "correlation") state.correlation_id = randomUUID();
    f.connector.deliver(state, {
      epoch:
        field === "foreign"
          ? { signal: new AbortController().signal }
          : f.connector.epoch,
      recovered: field === "recovered",
    });
    const rejected = failure(pending);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    const fresh = f.issue();
    f.respond();
    beginTerminalAuthority(await fresh, f.binding());
    expect(f.connector.requests[0].nonce).not.toBe(
      f.connector.requests[1].nonce,
    );
  });
  it("shares one-job and 32-waiter limits without retrying", async () => {
    const f = fixture();
    const pending = [f.issue()];
    await failure(f.issue());
    for (let i = 1; i < 32; i++)
      pending.push(f.issue(f.binding(undefined, f.prepare())));
    await failure(f.issue(f.binding(undefined, f.prepare())));
    expect(f.connector.requests).toHaveLength(32);
    const rejected = pending.map((p) =>
      failure(p, "TERMINAL_AUTHORITY_REVOKED"),
    );
    f.issuer.dispose();
    await Promise.all(rejected);
    const fresh = f.states.observe({
      jobId: f.record.owner.jobId,
      repositoryId: "example",
      attempt: 1,
    });
    f.respond();
    expect((await fresh).state.payload.job_id).toBe(f.record.owner.jobId);
  });
  it.each([null, 3, 5])(
    "requires exact cancellation provenance %s despite larger job revision",
    async (cancelRevision) => {
      const f = fixture();
      const b = f.binding({ kind: "cancel", cancelRevision: 4 });
      await failure(
        f.ready(
          b,
          { status: "cancelling", cancel_revision: cancelRevision },
          f.command(),
        ),
      );
    },
  );
  it.each([
    "missing",
    "foreign",
    "attempt",
    "revision",
    "expired",
    "invalid-date",
    "wrong-status",
    "missing-provenance",
  ])("rejects %s cancel command/state", async (kind) => {
    const f = fixture();
    const b = f.binding({ kind: "cancel", cancelRevision: 4 });
    const cmd = f.command();
    if (kind === "foreign") cmd.payload.job_id = randomUUID();
    if (kind === "attempt") cmd.payload.attempt++;
    if (kind === "revision") cmd.payload.job_revision++;
    if (kind === "expired") cmd.expires_at = stamp(1100);
    if (kind === "invalid-date") cmd.expires_at = "2026-02-30T00:00:00Z";
    const patch: Partial<JobStatePayload> = {
      status: kind === "wrong-status" ? "running" : "cancelling",
      cancel_revision: 4,
    };
    if (kind === "missing-provenance") delete patch.cancel_revision;
    const pending = f.ready(b, patch, kind === "missing" ? undefined : cmd);
    if (kind === "missing" || kind === "invalid-date")
      await failure(pending, "TERMINAL_AUTHORITY_INVALID");
    else await failure(pending);
  });
  it("captures mutable binding and original command before observing", async () => {
    const f = fixture();
    const b = f.binding({ kind: "cancel", cancelRevision: 4 });
    const saved = structuredClone(b);
    const cmd = f.command();
    const pending = f.issue(b, cmd);
    b.owner = { ...b.owner, jobId: randomUUID() };
    b.operation = { kind: "cancel", cancelRevision: 8 };
    cmd.expires_at = stamp(60000);
    cmd.payload.job_revision = 8;
    f.respond({ status: "cancelling", cancel_revision: 4 });
    const token = await pending;
    beginTerminalAuthority(token, saved);
    f.time(14000);
    revoked(() => assertTerminalAuthority(token, saved));
  });
  it.each(["spread", "serialized", "empty"])(
    "rejects %s forged tokens",
    async (kind) => {
      const f = fixture();
      const token = await f.ready();
      const forged =
        kind === "spread"
          ? { ...token }
          : kind === "serialized"
            ? JSON.parse(JSON.stringify(token))
            : {};
      expect(() => beginTerminalAuthority(forged, f.binding())).toThrow(
        TerminalAuthorityError,
      );
      beginTerminalAuthority(token, f.binding());
    },
  );
  it("assert-before-begin and mismatched bindings permanently revoke", async () => {
    const f = fixture();
    const first = await f.ready();
    revoked(() => assertTerminalAuthority(first, f.binding()));
    revoked(() => beginTerminalAuthority(first, f.binding()));
    const second = await f.ready();
    const wrong = f.binding();
    wrong.expectedVersion++;
    expect(() => beginTerminalAuthority(second, wrong)).toThrow(
      TerminalAuthorityError,
    );
    revoked(() => beginTerminalAuthority(second, f.binding()));
  });
  it("expired snapshot forbids first effect but does not stop an admitted cancellation drain", async () => {
    const f = fixture();
    const b = f.binding({ kind: "cancel", cancelRevision: 4 });
    const token = await f.ready(
      b,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    const unbegun = await f.ready(
      b,
      { status: "cancelling", cancel_revision: 4 },
      f.command(),
    );
    // Second sync was allocated at 10100: its snapshot endpoint is 11100.
    beginTerminalAuthority(token, b);
    f.time(11100);
    assertTerminalAuthority(token, b);
    beginTerminalAuthority(token, b);
    revoked(() => beginTerminalAuthority(unbegun, b));
    f.time(10500);
    revoked(() => beginTerminalAuthority(unbegun, b));
    f.time(13999);
    assertTerminalAuthority(token, b);
    f.time(14000);
    revoked(() => assertTerminalAuthority(token, b));
  });
  it("enforces exact original job deadline after admission", async () => {
    const f = fixture();
    const token = await f.ready();
    beginTerminalAuthority(token, f.binding());
    f.time(18999);
    assertTerminalAuthority(token, f.binding());
    f.time(19000);
    revoked(() => assertTerminalAuthority(token, f.binding()));
  });
  it.each(["rollback", "skew", "regression", "nan", "throw", "thenable"])(
    "latches %s clock failure despite later healthy samples",
    async (kind) => {
      const f = fixture();
      const b = f.binding();
      const token = await f.ready();
      beginTerminalAuthority(token, b);
      f.time(10500);
      assertTerminalAuthority(token, b);
      if (kind === "rollback") f.time(10600, -1000);
      if (kind === "skew") f.time(10600, 1601);
      if (kind === "regression") f.time(10499);
      if (kind === "nan") f.time(NaN);
      if (kind === "throw")
        f.clock(() => {
          throw new Error("private clock");
        });
      if (kind === "thenable")
        f.clock(() => ({
          wallTimeMs: origin + 600,
          monotonicTimeMs: 10600,
          // biome-ignore lint/suspicious/noThenProperty: deliberate thenable clock rejection fixture
          then() {},
        }));
      revoked(() => assertTerminalAuthority(token, b));
      f.clock(() => ({ wallTimeMs: origin + 700, monotonicTimeMs: 10700 }));
      revoked(() => beginTerminalAuthority(token, b));
    },
  );
  it.each(["owner", "parent", "dispose", "epoch"])(
    "revokes %s during observe and after issue without reviving",
    async (kind) => {
      for (const after of [false, true]) {
        const f = fixture();
        const pending = f.issue();
        if (after) f.respond();
        const token = after ? await pending : undefined;
        const rejected = after
          ? undefined
          : failure(
              pending,
              kind === "epoch"
                ? "TERMINAL_AUTHORITY_UNAVAILABLE"
                : "TERMINAL_AUTHORITY_REVOKED",
            );
        if (kind === "owner") f.lifetime.abort();
        if (kind === "parent") f.parent.abort();
        if (kind === "dispose") f.issuer.dispose();
        if (kind === "epoch") {
          f.connector.controller.abort();
          f.connector.epoch = { signal: new AbortController().signal };
        }
        if (token) revoked(() => beginTerminalAuthority(token, f.binding()));
        else await rejected;
        expect(getEventListeners(f.lifetime.signal, "abort")).toHaveLength(0);
      }
    },
  );
  it.each(["owner", "parent", "dispose", "epoch"])(
    "rechecks %s after injected clock getters before the effect",
    async (kind) => {
      const f = fixture();
      const token = await f.ready();
      f.clock(() => ({
        get wallTimeMs() {
          if (kind === "owner") f.lifetime.abort();
          if (kind === "parent") f.parent.abort();
          if (kind === "dispose") f.issuer.dispose();
          if (kind === "epoch") f.connector.controller.abort();
          return origin + 100;
        },
        monotonicTimeMs: 10100,
      }));
      let effects = 0;
      expect(() => {
        beginTerminalAuthority(token, f.binding());
        effects++;
      }).toThrow(TerminalAuthorityError);
      expect(effects).toBe(0);
    },
  );
  it("captures each clock field once and ignores unrelated getters", async () => {
    const f = fixture();
    const token = await f.ready();
    let walls = 0;
    let monos = 0;
    f.clock(() =>
      Object.create({
        get wallTimeMs() {
          return walls++ === 0 ? origin + 100 : NaN;
        },
        get monotonicTimeMs() {
          return monos++ === 0 ? 10100 : NaN;
        },
        get unrelated() {
          throw new Error("private");
        },
      }),
    );
    beginTerminalAuthority(token, f.binding());
    expect([walls, monos]).toEqual([1, 1]);
  });
  it("sanitizes getter failures, strict operations, forbidden commands and unusable constructors", async () => {
    const f = fixture();
    await failure(
      f.issuer.issue({
        ...f.binding(),
        get signal(): AbortSignal {
          throw new Error("private input");
        },
      }),
      "TERMINAL_AUTHORITY_INVALID",
    );
    await failure(
      f.issue(
        f.binding({
          kind: "native",
          outcome: "failed",
          eventSequence: 0,
          extra: true,
        } as never),
      ),
      "TERMINAL_AUTHORITY_INVALID",
    );
    await failure(
      f.issue(f.binding(), f.command()),
      "TERMINAL_AUTHORITY_INVALID",
    );
    for (const input of [
      null,
      {},
      { connector: f.connector, states: f.states, store: f.store, clock: 3 },
      { connector: f.connector, states: f.states, store: f.store, signal: {} },
    ])
      expect(() => new TerminalAuthorityIssuer(input as never)).toThrow(
        TerminalAuthorityError,
      );
  });
  it("sanitizes an invalid signal whose aborted getter throws", async () => {
    const f = fixture();
    await failure(
      f.issuer.issue({
        ...f.binding(),
        signal: {
          get aborted() {
            throw new Error("private signal");
          },
        } as never,
      }),
      "TERMINAL_AUTHORITY_INVALID",
    );
  });
  it("parent termination does not dispatch through a replaceable public dispose method", async () => {
    const f = fixture();
    const token = await f.ready();
    f.issuer.dispose = () => {};
    f.parent.abort();
    revoked(() => beginTerminalAuthority(token, f.binding()));
    expect(getEventListeners(f.parent.signal, "abort")).toHaveLength(0);
  });
  it.each(["mode", "version", "lease", "offer", "proof", "initial"])(
    "compares the complete valid predecessor after %s changes without a normal CAS",
    async (field) => {
      const f = fixture();
      const pending = f.issue();
      const changed = JSON.parse(JSON.stringify(f.record));
      if (field === "mode") changed.mode = "read_only";
      if (field === "version") changed.version++;
      if (field === "lease") changed.leaseId = randomUUID();
      if (field === "offer") changed.offer.correlationId = randomUUID();
      if (field === "proof") changed.startedEvidence.eventSequence++;
      if (field === "initial") {
        changed.initialMessageId = "another-initial";
        changed.startedEvidence.messageId = "another-initial";
      }
      f.raw
        .prepare(
          "UPDATE metadata SET value = ? WHERE key LIKE 'owned-intent-v1:%'",
        )
        .run(JSON.stringify(changed));
      // This remains a readable journal. Refusal must come from the issuer's full comparison.
      expect(f.store.ownedIntent(f.record.owner.jobId, 1)).toEqual(changed);
      f.respond();
      await failure(pending);
    },
  );
  it.each(["sessionId", "messageId", "requestDigest", "absent"])(
    "refuses corrupt started proof %s",
    async (field) => {
      const f = fixture();
      const changed = JSON.parse(JSON.stringify(f.record));
      if (field === "absent") changed.startedEvidence = null;
      else
        changed.startedEvidence[field] =
          field === "sessionId"
            ? randomUUID()
            : field === "messageId"
              ? "other"
              : "0".repeat(64);
      f.raw
        .prepare(
          "UPDATE metadata SET value = ? WHERE key LIKE 'owned-intent-v1:%'",
        )
        .run(JSON.stringify(changed));
      await failure(f.issue());
    },
  );
  it.each([
    "jobId",
    "attempt",
    "repositoryId",
    "sessionId",
    "ownerGeneration",
    "operation",
  ])("rejects and latches post-issue %s mismatch", async (field) => {
    const f = fixture();
    const token = await f.ready();
    const b = f.binding();
    if (field === "operation")
      b.operation = { kind: "native", outcome: "failed", eventSequence: 0 };
    else
      b.owner = {
        ...b.owner,
        [field]:
          field === "attempt"
            ? 2
            : field === "repositoryId"
              ? "other"
              : randomUUID(),
      };
    revoked(() => beginTerminalAuthority(token, b));
    revoked(() => beginTerminalAuthority(token, f.binding()));
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid event sequence and expected version %s",
    async (n) => {
      const f = fixture();
      await failure(
        f.issue(
          f.binding({ kind: "native", outcome: "succeeded", eventSequence: n }),
        ),
        "TERMINAL_AUTHORITY_INVALID",
      );
      await failure(
        f.issue({ ...f.binding(), expectedVersion: n }),
        "TERMINAL_AUTHORITY_INVALID",
      );
    },
  );
  it.each([-1, 0.5, 2147483648, NaN])(
    "rejects invalid cancellation revision %s",
    async (n) => {
      const f = fixture();
      await failure(
        f.issue(f.binding({ kind: "cancel", cancelRevision: n }), f.command()),
        "TERMINAL_AUTHORITY_INVALID",
      );
    },
  );
  it("permits cancellation revision zero with current revision nine", async () => {
    const f = fixture();
    const b = f.binding({ kind: "cancel", cancelRevision: 0 });
    const cmd = f.command();
    cmd.payload.job_revision = 0;
    expect(
      beginTerminalAuthority(
        await f.ready(b, { status: "cancelling", cancel_revision: 0 }, cmd),
        b,
      ).state.job_revision,
    ).toBe(9);
  });
  it.each(["command", "job"])(
    "rejects the exact %s boundary before the first effect",
    async (source) => {
      const f = fixture();
      const b = f.binding({ kind: "cancel", cancelRevision: 4 });
      const cmd = f.command();
      if (source === "command") cmd.expires_at = stamp(1500);
      const token = await f.ready(
        b,
        {
          status: "cancelling",
          cancel_revision: 4,
          ...(source === "job" ? { expires_at: stamp(1500) } : {}),
        },
        cmd,
      );
      f.time(10500);
      revoked(() => beginTerminalAuthority(token, b));
    },
  );
  it.each(["missing-provenance", "invalid-envelope", "silent-epoch-change"])(
    "times out %s without using replay as live state",
    async (kind) => {
      const f = fixture();
      const pending = f.issue();
      const response = f.connector.state();
      if (kind === "missing-provenance")
        Reflect.deleteProperty(response.payload, "cancel_revision");
      if (kind === "invalid-envelope") response.expires_at = "invalid";
      const epoch = f.connector.epoch;
      if (kind === "silent-epoch-change")
        f.connector.epoch = { signal: new AbortController().signal };
      f.connector.deliver(response, { epoch, recovered: false });
      const rejected = failure(pending);
      await vi.advanceTimersByTimeAsync(2000);
      await rejected;
    },
  );
  it("latches a reentrant failed binding check even if its exception is caught by the clock", async () => {
    const f = fixture();
    const b = f.binding();
    const token = await f.ready();
    f.clock(() => {
      try {
        beginTerminalAuthority(token, { ...b, expectedVersion: 999 });
      } catch {}
      return { wallTimeMs: origin + 100, monotonicTimeMs: 10100 };
    });
    revoked(() => beginTerminalAuthority(token, b));
  });
  it("disposal detaches the parent listener and prevents new observations", async () => {
    const f = fixture();
    f.issuer.dispose();
    f.issuer.dispose();
    expect(getEventListeners(f.parent.signal, "abort")).toHaveLength(0);
    await failure(f.issue(), "TERMINAL_AUTHORITY_REVOKED");
    expect(f.connector.requests).toHaveLength(0);
  });
  it("rejects an older outer clock sample after a successful reentrant check", async () => {
    const f = fixture();
    const b = f.binding();
    const token = await f.ready();
    beginTerminalAuthority(token, b);
    let entered = false;
    f.connector.currentEpoch = () => {
      if (!entered) {
        entered = true;
        f.clock(() => ({ wallTimeMs: origin + 800, monotonicTimeMs: 10800 }));
        assertTerminalAuthority(token, b);
      }
      return f.connector.epoch;
    };
    // Reentry occurs after the outer sample, when epoch is checked again.
    entered = true;
    f.clock(() => {
      entered = false;
      return { wallTimeMs: origin + 500, monotonicTimeMs: 10500 };
    });
    revoked(() => assertTerminalAuthority(token, b));
  });
  it.each(["method", "getter"])(
    "permanently revokes after currentEpoch %s throws",
    async (kind) => {
      const f = fixture();
      const token = await f.ready();
      const original = f.connector.currentEpoch;
      if (kind === "method")
        f.connector.currentEpoch = () => {
          throw new Error("private epoch");
        };
      else
        Object.defineProperty(f.connector, "currentEpoch", {
          configurable: true,
          get() {
            throw new Error("private epoch getter");
          },
        });
      revoked(() => beginTerminalAuthority(token, f.binding()));
      Object.defineProperty(f.connector, "currentEpoch", {
        value: original,
        configurable: true,
        writable: true,
      });
      revoked(() => beginTerminalAuthority(token, f.binding()));
    },
  );
  it.each(["owner", "operation", "version"])(
    "latches binding %s getter failure",
    async (field) => {
      const f = fixture();
      const token = await f.ready();
      const b = f.binding();
      Object.defineProperty(
        b,
        field === "version" ? "expectedVersion" : field,
        {
          get() {
            throw new Error("private binding");
          },
        },
      );
      revoked(() => beginTerminalAuthority(token, b));
      revoked(() => beginTerminalAuthority(token, f.binding()));
    },
  );
  it("reads declared binding, operation and command fields once before caller mutation", async () => {
    const f = fixture();
    const b = f.binding({ kind: "cancel", cancelRevision: 4 });
    const cmd = f.command();
    const reads = new Map<string, number>();
    const accessors = (value: object, prefix: string) =>
      Object.fromEntries(
        Object.keys(value).map((key) => [
          key,
          {
            enumerable: true,
            get() {
              const name = `${prefix}.${key}`;
              reads.set(name, (reads.get(name) ?? 0) + 1);
              if (reads.get(name) !== 1) throw new Error("private reread");
              return (value as Record<string, unknown>)[key];
            },
          },
        ]),
      );
    const input = {
      ...b,
      owner: Object.defineProperties({}, accessors(b.owner, "owner")),
      operation: Object.defineProperties(
        {},
        accessors(b.operation, "operation"),
      ),
      signal: f.lifetime.signal,
      command: Object.defineProperties(
        {},
        accessors(
          {
            ...cmd,
            payload: Object.defineProperties(
              {},
              accessors(cmd.payload, "payload"),
            ),
          },
          "command",
        ),
      ),
    };
    const pending = f.issuer.issue(
      Object.defineProperties({}, accessors(input, "input")) as never,
    );
    f.respond({ status: "cancelling", cancel_revision: 4 });
    beginTerminalAuthority(await pending, b);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
  });
  it.each(["clock", "store"])(
    "cannot issue when %s synchronously ends the issuer",
    async (port) => {
      const f = fixture();
      if (port === "clock")
        f.clock(() => {
          f.issuer.dispose();
          return { wallTimeMs: origin + 100, monotonicTimeMs: 10100 };
        });
      else {
        const read = f.store.ownedIntent.bind(f.store);
        let count = 0;
        f.store.ownedIntent = (job, attempt) => {
          const result = read(job, attempt);
          if (++count === 2) f.issuer.dispose();
          return result;
        };
      }
      await failure(f.ready(), "TERMINAL_AUTHORITY_REVOKED");
    },
  );
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
  ] as const)(
    "checks unavailable and cancellation status %s",
    async (status) => {
      const f = fixture("prepared", "read_only");
      const record = f.store.advanceOwnedIntent(
        f.record.owner,
        f.record.version,
        { unavailable: "HARNESS_PERSISTENCE_UNAVAILABLE" },
      );
      const b = f.binding(
        { kind: "unavailable", reason: "HARNESS_PERSISTENCE_UNAVAILABLE" },
        record,
      );
      const pending = f.ready(b, { status });
      if (
        status === "running" ||
        status === "waiting_approval" ||
        status === "cancelling"
      )
        beginTerminalAuthority(await pending, b);
      else await failure(pending);
      const cancel = f.binding({ kind: "cancel", cancelRevision: 4 }, record);
      const cancellation = f.ready(
        cancel,
        { status, cancel_revision: 4 },
        f.command(),
      );
      if (status === "cancelling")
        beginTerminalAuthority(await cancellation, cancel);
      else await failure(cancellation);
    },
  );
});
