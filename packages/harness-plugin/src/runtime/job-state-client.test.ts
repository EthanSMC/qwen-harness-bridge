import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import type { JobSyncPayload } from "@qhb/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectorEpoch,
  CoordinatingConnectorClient,
  PublishedSync,
  ServerEnvelope,
} from "../transport/connector-client.js";
import type { CoordinationClockSample } from "./coordination-deadlines.js";
import { JobStateClient, JobStateExchangeError } from "./job-state-client.js";

type State = Extract<ServerEnvelope, { type: "job.state" }>;
type Handler = Parameters<CoordinatingConnectorClient["onState"]>[0];
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { jobId, repositoryId: "example", attempt: 1 };
const stateFor = (request: PublishedSync): State => ({
  protocol_version: "1.0",
  type: "job.state",
  message_id: randomUUID(),
  sequence: 90,
  correlation_id: request.correlationId,
  sent_at: "2026-09-06T00:00:00Z",
  expires_at: "2026-09-06T00:01:00Z",
  payload: {
    job_id: request.jobId,
    repository_id: "example",
    requested_attempt: request.attempt,
    current_attempt: 0,
    mode: "read_only",
    status: "succeeded",
    job_revision: 7,
    cancel_revision: null,
    lease_id: null,
    lease_expires_at: null,
    expires_at: "2026-09-05T00:00:00Z",
    observed_at: "2026-09-06T00:00:00Z",
    state_valid_until: "2026-09-06T00:00:02Z",
    request_message_id: request.messageId,
    request_sequence: request.sequence,
    nonce: request.nonce,
  },
});

// Controlled synchronous boundary; real persistence/no-allocation evidence is
// separately exercised through the SQLite/TLS/PostgreSQL gateway fixture.
class Connector implements CoordinatingConnectorClient {
  controller = new AbortController();
  epoch: ConnectorEpoch | undefined = { signal: this.controller.signal };
  handlers = new Set<Handler>();
  requests: PublishedSync[] = [];
  beforePersist = () => {};
  afterPersist = (_request: PublishedSync) => {};
  transform = (request: PublishedSync) => request;
  currentEpoch = () => this.epoch;
  async start() {}
  async publish() {}
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
    this.beforePersist();
    if (!this.epoch) throw new Error("private allocation");
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
    expect(registered(this.transform(request))).toBeUndefined();
    this.afterPersist(request);
  }
  deliver(
    state = stateFor(this.requests.at(-1) as PublishedSync),
    delivery = { epoch: this.epoch ?? null, recovered: false },
  ) {
    for (const handler of this.handlers)
      expect(handler(state, delivery)).toBeUndefined();
  }
}

const clients: JobStateClient[] = [];
function fixture(
  options: { signal?: AbortSignal; randomUUID?: () => string } = {},
) {
  vi.useFakeTimers();
  const connector = new Connector();
  let now: CoordinationClockSample = {
    wallTimeMs: 10000,
    monotonicTimeMs: 100,
  };
  const client = new JobStateClient({
    connector,
    clock: () => now,
    ...options,
  });
  clients.push(client);
  return {
    connector,
    client,
    time: (value: CoordinationClockSample) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
const failure = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(JobStateExchangeError);
  expect(error).toMatchObject({ code, message: code });
  expect(String(error)).not.toContain("private");
  expect(error).not.toHaveProperty("cause");
};

describe("bounded live state exchanges", () => {
  it("retains first changing clock scalars across storage and receipt", async () => {
    const { client, connector, time } = fixture();
    const samples = [
      { wallTimeMs: 10000, monotonicTimeMs: 100 },
      { wallTimeMs: 11500, monotonicTimeMs: 1600 },
      { wallTimeMs: 11800, monotonicTimeMs: 1900 },
    ];
    const reads = samples.map(() => [0, 0]);
    const clocks = samples.map((sample, index) =>
      Object.create({
        get wallTimeMs() {
          return reads[index][0]++ === 0 ? sample.wallTimeMs : Infinity;
        },
        get monotonicTimeMs() {
          return reads[index][1]++ === 0 ? sample.monotonicTimeMs : Infinity;
        },
        get unrelated() {
          throw new Error("private metadata");
        },
      }),
    );
    time(clocks[0]);
    connector.beforePersist = () => time(clocks[1]);
    connector.afterPersist = () => {
      time(clocks[2]);
      connector.deliver();
    };
    const result = await client.observe(input);
    expect(result.sent).toEqual({ wallTimeMs: 10000, monotonicTimeMs: 100 });
    expect(result.received).toEqual({
      wallTimeMs: 11800,
      monotonicTimeMs: 1900,
    });
    expect(reads).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    expect(clocks.every((clock) => !Object.isFrozen(clock))).toBe(true);
  });
  it("releases caller-aborted capacity for a fresh observation on the same epoch", async () => {
    const { client, connector } = fixture();
    const caller = new AbortController();
    const pending = client.observe({ ...input, signal: caller.signal });
    const old = connector.requests[0];
    caller.abort("private");
    await failure(pending, "JOB_STATE_ABORTED");
    connector.afterPersist = () => connector.deliver();
    const fresh = await client.observe(input);
    expect(fresh.epoch).toBe(old.epoch);
    expect(fresh.request.nonce).not.toBe(old.nonce);
    expect(old.epoch.signal.aborted).toBe(false);
  });
  it("ignores partial matches between two known requests without releasing either", async () => {
    const { client, connector } = fixture();
    const second = { ...input, jobId: randomUUID() };
    const firstResult = client.observe(input);
    const secondResult = client.observe(second);
    const wrong = stateFor(connector.requests[0]);
    wrong.payload.request_message_id = connector.requests[1].messageId;
    connector.deliver(wrong);
    await failure(client.observe(input), "JOB_STATE_CAPACITY");
    await failure(client.observe(second), "JOB_STATE_CAPACITY");
    connector.deliver(stateFor(connector.requests[0]));
    connector.deliver(stateFor(connector.requests[1]));
    expect((await firstResult).request.messageId).toBe(
      connector.requests[0].messageId,
    );
    expect((await secondResult).request.messageId).toBe(
      connector.requests[1].messageId,
    );
  });
  it("does not allocate after disposal during a captured caller getter", async () => {
    const { client, connector } = fixture();
    await failure(
      client.observe({
        ...input,
        get attempt() {
          client.dispose();
          return 1;
        },
      }),
      "JOB_STATE_DISPOSED",
    );
    expect(connector.requests).toHaveLength(0);
  });
  it("contains abort during clock capture without sending or leaving resources", async () => {
    const parent = new AbortController();
    const { client, connector, time } = fixture({ signal: parent.signal });
    time({
      get wallTimeMs() {
        parent.abort("private");
        return 10000;
      },
      monotonicTimeMs: 100,
    });
    await failure(client.observe(input), "JOB_STATE_ABORTED");
    expect(connector.requests).toHaveLength(0);
    expect(
      getEventListeners(connector.controller.signal, "abort"),
    ).toHaveLength(0);
  });
  it("sanitizes a dependency-thrown exchange error instead of trusting its code", async () => {
    const { client, connector } = fixture();
    connector.beforePersist = () => {
      throw new JobStateExchangeError("JOB_STATE_DISPOSED");
    };
    await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
  });
  it("reports a throwing UUID dependency as unavailable", async () => {
    const { client } = fixture({
      randomUUID: () => {
        throw new Error("private factory");
      },
    });
    await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
  });
  it("ignores ACK/error/offer and malformed throwing state without receipt effects", async () => {
    const { client, connector } = fixture();
    const pending = client.observe(input);
    for (const type of ["ack", "protocol.error", "job.offer"]) {
      connector.deliver({ ...stateFor(connector.requests[0]), type } as State);
    }
    connector.deliver({
      get payload(): State["payload"] {
        throw new Error("private state");
      },
    } as State);
    await failure(client.observe(input), "JOB_STATE_CAPACITY");
    connector.deliver();
    await pending;
  });
  it("sanitizes clock/epoch failures only after exact candidate binding", async () => {
    const { client, connector } = fixture();
    const first = client.observe(input);
    const other = client.observe({ ...input, jobId: randomUUID() });
    const normal = connector.currentEpoch;
    connector.currentEpoch = () => {
      throw new Error("private dependency");
    };
    const wrong = stateFor(connector.requests[0]);
    wrong.payload.nonce = randomUUID();
    connector.deliver(wrong);
    connector.deliver(stateFor(connector.requests[0]));
    await failure(first, "JOB_STATE_UNAVAILABLE");
    connector.currentEpoch = normal;
    connector.deliver(stateFor(connector.requests[1]));
    await other;
  });
  it("returns unavailable before allocation for missing epoch or invalid original pair", async () => {
    const { client, connector, time } = fixture();
    const epoch = connector.epoch;
    connector.epoch = undefined;
    await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
    connector.epoch = epoch;
    time({ wallTimeMs: Infinity, monotonicTimeMs: 1 });
    await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
    expect(connector.requests).toHaveLength(0);
  });
  it("latches an already-aborted parent and refuses an already-aborted caller", async () => {
    const parent = new AbortController();
    parent.abort("private");
    const { client, connector } = fixture({ signal: parent.signal });
    client.dispose();
    await failure(client.observe(input), "JOB_STATE_ABORTED");
    expect(connector.handlers.size).toBe(0);
    const active = fixture();
    await failure(
      active.client.observe({ ...input, signal: parent.signal }),
      "JOB_STATE_ABORTED",
    );
    expect(active.connector.requests).toHaveLength(0);
  });
  it("contains initial subscription failure and removes parent resources", () => {
    vi.useFakeTimers();
    const connector = new Connector();
    connector.onState = () => {
      throw new Error("private subscription");
    };
    const parent = new AbortController();
    expect(
      () => new JobStateClient({ connector, signal: parent.signal }),
    ).toThrow("JOB_STATE_UNAVAILABLE");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it("registers synchronously for immediate observation and freezes detached facts", async () => {
    const { connector, client } = fixture();
    let delivered: State | undefined;
    connector.afterPersist = (request) => {
      delivered = stateFor(request);
      connector.deliver(delivered);
    };
    const result = await client.observe(input);
    expect(result.state.payload).toMatchObject({
      status: "succeeded",
      current_attempt: 0,
    });
    expect(result.epoch).toBe(connector.epoch);
    expect(result.request.epoch).toBe(connector.epoch);
    expect(result.state).not.toBe(delivered);
    for (const record of [
      result,
      result.state,
      result.state.payload,
      result.request,
      result.sent,
      result.received,
    ])
      expect(Object.isFrozen(record)).toBe(true);
    if (delivered) delivered.payload.mode = "normal";
    Object.assign(connector.requests[0], { nonce: randomUUID() });
    expect(result.state.payload.mode).toBe("read_only");
    expect(result.request.nonce).toBe(result.state.payload.nonce);
    expect(
      getEventListeners(connector.controller.signal, "abort"),
    ).toHaveLength(0);
    await client.observe(input);
    expect(connector.requests[1].nonce).not.toBe(result.request.nonce);
    expect(connector.requests[1].correlationId).not.toBe(
      result.request.correlationId,
    );
  });

  it("reserves 32 total and one canonical job across attempts before allocation", async () => {
    const { connector, client } = fixture();
    const pending = [
      client.observe(input),
      ...Array.from({ length: 31 }, () =>
        client.observe({ ...input, jobId: randomUUID() }),
      ),
    ];
    await failure(
      client.observe({ ...input, jobId: jobId.toUpperCase(), attempt: 2 }),
      "JOB_STATE_CAPACITY",
    );
    await failure(
      client.observe({ ...input, jobId: randomUUID() }),
      "JOB_STATE_CAPACITY",
    );
    expect(connector.requests).toHaveLength(32);
    const checks = pending.map((p) => failure(p, "JOB_STATE_DISPOSED"));
    client.dispose();
    await Promise.all(checks);
    expect(
      getEventListeners(connector.controller.signal, "abort"),
    ).toHaveLength(0);
  });

  it.each([
    "request_message_id",
    "request_sequence",
    "job_id",
    "repository_id",
    "requested_attempt",
    "nonce",
    "correlation_id",
    "epoch",
    "currentEpoch",
    "recovered",
    "null-epoch",
    "invalid",
  ])("ignores wrong %s without ending the matching exchange", async (field) => {
    const { connector, client } = fixture();
    const pending = client.observe(input);
    const originalEpoch = connector.epoch;
    const candidate = stateFor(connector.requests[0]);
    if (field === "correlation_id") candidate.correlation_id = randomUUID();
    else if (field === "invalid")
      candidate.payload.state_valid_until = candidate.payload.observed_at;
    else if (
      !["epoch", "currentEpoch", "recovered", "null-epoch"].includes(field)
    )
      Object.assign(candidate.payload, {
        [field]:
          field === "request_sequence" || field === "requested_attempt"
            ? 2
            : field === "repository_id"
              ? "other"
              : randomUUID(),
      });
    if (field === "currentEpoch")
      connector.epoch = { signal: new AbortController().signal };
    connector.deliver(candidate, {
      epoch:
        field === "epoch"
          ? { signal: new AbortController().signal }
          : field === "null-epoch"
            ? null
            : (originalEpoch ?? null),
      recovered: field === "recovered",
    });
    connector.epoch = originalEpoch;
    await failure(client.observe(input), "JOB_STATE_CAPACITY");
    connector.deliver();
    expect((await pending).state.payload.job_id).toBe(jobId);
    connector.deliver();
  });

  it.each([1999.5, 2000, 2001])(
    "rejects store delay %s without renewing the original interval",
    async (elapsed) => {
      const { connector, client, time } = fixture();
      connector.beforePersist = () =>
        time({ wallTimeMs: 10000 + elapsed, monotonicTimeMs: 100 + elapsed });
      await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
      expect(connector.requests).toHaveLength(1);
    },
  );
  it("schedules the original remaining delay after storage and owns timeout rejection", async () => {
    const { connector, client, time } = fixture();
    connector.beforePersist = () =>
      time({ wallTimeMs: 11500, monotonicTimeMs: 1600 });
    const checked = failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(500);
    await checked;
    expect(
      getEventListeners(connector.controller.signal, "abort"),
    ).toHaveLength(0);
    connector.beforePersist = () => {};
    connector.afterPersist = () => connector.deliver();
    await client.observe(input);
  });
  it.each([
    { wallTimeMs: 12000, monotonicTimeMs: 2100 },
    { wallTimeMs: 11102, monotonicTimeMs: 201 },
    { wallTimeMs: 9000, monotonicTimeMs: 101 },
    { wallTimeMs: Number.NaN, monotonicTimeMs: 101 },
  ])(
    "rejects late/drifting receipt without relying on the timer: %j",
    async (now) => {
      const { connector, client, time } = fixture();
      const pending = client.observe(input);
      time(now);
      connector.deliver();
      await failure(pending, "JOB_STATE_UNAVAILABLE");
    },
  );
  it.each(["caller", "parent", "epoch", "dispose"])(
    "settles %s once and removes all listeners",
    async (reason) => {
      const parent = new AbortController();
      const caller = new AbortController();
      const { client, connector } = fixture({ signal: parent.signal });
      const pending = client.observe({ ...input, signal: caller.signal });
      if (reason === "caller") caller.abort("private caller");
      if (reason === "parent") parent.abort("private parent");
      if (reason === "epoch") connector.controller.abort("private epoch");
      if (reason === "dispose") client.dispose();
      await failure(
        pending,
        reason === "dispose"
          ? "JOB_STATE_DISPOSED"
          : reason === "epoch"
            ? "JOB_STATE_UNAVAILABLE"
            : "JOB_STATE_ABORTED",
      );
      connector.deliver();
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(
        getEventListeners(connector.controller.signal, "abort"),
      ).toHaveLength(0);
      client.dispose();
      parent.abort();
      await failure(
        client.observe(input),
        reason === "parent" ? "JOB_STATE_ABORTED" : "JOB_STATE_DISPOSED",
      );
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(connector.handlers.size).toBe(0);
    },
  );
  it("never revives an old request after reconnect or recovered delivery", async () => {
    const { connector, client } = fixture();
    const old = client.observe(input);
    const oldRequest = connector.requests[0];
    connector.controller.abort();
    await failure(old, "JOB_STATE_UNAVAILABLE");
    connector.controller = new AbortController();
    connector.epoch = { signal: connector.controller.signal };
    const fresh = client.observe(input);
    connector.deliver(stateFor(oldRequest));
    connector.deliver(stateFor(oldRequest), { epoch: null, recovered: true });
    await failure(client.observe(input), "JOB_STATE_CAPACITY");
    connector.deliver();
    expect((await fresh).request.nonce).not.toBe(oldRequest.nonce);
  });
  it.each(["jobId", "repositoryId", "attempt"])(
    "rejects invalid captured %s as a Promise",
    async (field) => {
      const { client, connector } = fixture();
      await failure(
        client.observe({ ...input, [field]: "private invalid" }),
        "JOB_STATE_INVALID_REQUEST",
      );
      expect(connector.requests).toHaveLength(0);
    },
  );
  it("sanitizes UUID failures and releases the reservation", async () => {
    let invalid = true;
    const { client, connector } = fixture({
      randomUUID: () => (invalid ? "private uuid" : randomUUID()),
    });
    await failure(client.observe(input), "JOB_STATE_INVALID_REQUEST");
    invalid = false;
    connector.afterPersist = () => connector.deliver();
    await client.observe(input);
  });
  it.each(["throw", "binding", "clock", "currentEpoch"])(
    "sanitizes %s dependency failure and releases memory",
    async (kind) => {
      const { client, connector, time } = fixture();
      if (kind === "throw")
        connector.beforePersist = () => {
          throw new Error("private store");
        };
      if (kind === "binding")
        connector.transform = (r) => ({ ...r, nonce: randomUUID() });
      if (kind === "clock")
        time({
          get wallTimeMs(): number {
            throw new Error("private clock");
          },
          monotonicTimeMs: 100,
        });
      if (kind === "currentEpoch")
        connector.currentEpoch = () => {
          throw new Error("private epoch");
        };
      await failure(client.observe(input), "JOB_STATE_UNAVAILABLE");
      connector.beforePersist = () => {};
      connector.transform = (r) => r;
      connector.currentEpoch = () => connector.epoch;
      time({ wallTimeMs: 10000, monotonicTimeMs: 100 });
      connector.afterPersist = () => connector.deliver();
      await client.observe(input);
    },
  );
  it("captures inherited changing caller and clock scalars once without unrelated getters", async () => {
    const { client, connector, time } = fixture();
    let jobReads = 0;
    let repositoryReads = 0;
    let attemptReads = 0;
    let wallReads = 0;
    let monoReads = 0;
    const request = Object.create({
      get jobId() {
        return jobReads++ === 0 ? jobId.toUpperCase() : "private";
      },
      get repositoryId() {
        return repositoryReads++ === 0 ? "example" : "private";
      },
      get attempt() {
        return attemptReads++ === 0 ? 1 : 0;
      },
      get unrelated() {
        throw new Error("private unrelated");
      },
    });
    const clock = Object.create({
      get wallTimeMs() {
        wallReads++;
        return 10000;
      },
      get monotonicTimeMs() {
        monoReads++;
        return 100;
      },
      get unrelated() {
        throw new Error("private unrelated");
      },
    });
    time(clock);
    connector.afterPersist = () => connector.deliver();
    const result = await client.observe(request);
    expect(jobReads).toBe(1);
    expect(repositoryReads).toBe(1);
    expect(attemptReads).toBe(1);
    expect(wallReads).toBe(3);
    expect(monoReads).toBe(3);
    expect(result.sent).toEqual({ wallTimeMs: 10000, monotonicTimeMs: 100 });
    expect(Object.isFrozen(request)).toBe(false);
    expect(Object.isFrozen(clock)).toBe(false);
  });
});
