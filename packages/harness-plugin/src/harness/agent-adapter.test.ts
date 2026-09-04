import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  type Session,
  type SessionEvent,
  SessionId,
} from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessAdapterOptions as PublicHarnessAdapterOptions,
  HarnessAgentAdapter as PublicHarnessAgentAdapter,
  NormalizedHarnessEvent as PublicNormalizedHarnessEvent,
} from "../index.js";
import * as publicApi from "../index.js";
import {
  AgentAdapter,
  type HarnessContext,
  type HarnessMappingStore,
} from "./agent-adapter.js";
import { normalizeSessionEvent } from "./event-normalizer.js";
import { registerSessionListener } from "./register-session-listener.js";
import type { NormalizedHarnessEvent } from "./types.js";

type SessionListener = (session: Session, event: SessionEvent) => void;

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const sessionEvent = (
  type: SessionEvent["type"],
  data: unknown,
  seq = 0,
): SessionEvent =>
  ({
    type,
    seq,
    time: 1_725_000_000_000,
    data,
  }) as SessionEvent;

class FakeStore implements HarnessMappingStore {
  readonly mappings = new Map<
    string,
    { jobId: string; attempt: number; sessionId: string; status: string }
  >();
  readonly calls: string[] = [];
  readonly recovered: Array<{
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }> = [];
  failReads = false;
  failListing = false;
  listCalls = 0;

  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void {
    this.calls.push(`map:${input.jobId}`);
    this.mappings.set(input.jobId, { ...input });
  }

  findJob(jobId: string) {
    if (this.failReads) throw new Error("store unavailable");
    return this.mappings.get(jobId);
  }

  listNonterminalJobs() {
    this.listCalls += 1;
    if (this.failListing) throw new Error("store unavailable");
    return this.recovered;
  }
}

class FakeHarness {
  readonly create = vi.fn();
  readonly resume = vi.fn();
  readonly agents = { create: this.create, resume: this.resume };
  readonly listeners = new Set<SessionListener>();
  readonly ctx: HarnessContext;
  readonly calls: string[] = [];

  constructor() {
    this.ctx = {
      agents: this.agents,
      on: vi.fn((_name: "session/event", listener: SessionListener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }),
    };
  }

  makeAgent(
    sessionId: string,
    idle = Promise.resolve(),
    history: readonly SessionEvent[] = [],
  ) {
    const followup = vi.fn((_message: unknown) => this.calls.push("followup"));
    const cancel = vi.fn(() => this.calls.push("cancel"));
    const agent = {
      id: SessionId(sessionId),
      status: "running",
      ctx: {} as Context,
      session: { ownEvents: vi.fn(() => history) },
      followup,
      whenIdle: vi.fn(() => idle),
      cancel,
    } as unknown as Agent;
    const handle: AgentHandle = {
      agent,
      dispose: vi.fn(async () => {
        this.calls.push("dispose");
      }),
    };
    return { agent, handle, followup, cancel };
  }

  emit(sessionId: string, event: SessionEvent) {
    const session = { id: SessionId(sessionId) } as Session;
    for (const listener of this.listeners) listener(session, event);
  }
}

const createAdapter = (
  fake: FakeHarness,
  store = new FakeStore(),
  events: NormalizedHarnessEvent[] = [],
) =>
  new AgentAdapter({
    ctx: fake.ctx,
    store,
    onEvent: (event) => {
      events.push(event);
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Harness Agent adapter", () => {
  it("exports the Harness contracts and implementation from the package entrypoint", () => {
    const publicConstructor: new (
      options: PublicHarnessAdapterOptions,
    ) => PublicHarnessAgentAdapter = publicApi.AgentAdapter;
    const publicNormalizer: (
      jobId: string,
      event: SessionEvent,
    ) => PublicNormalizedHarnessEvent | undefined =
      publicApi.normalizeSessionEvent;

    expect(publicConstructor).toBe(AgentAdapter);
    expect(publicNormalizer).toBe(normalizeSessionEvent);
    expect(publicApi.registerSessionListener).toBe(registerSessionListener);
  });

  it("creates an owned official Agent, persists before followup, and waits for idle", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    const events: NormalizedHarnessEvent[] = [];
    const setup = vi.fn();
    const { handle, followup } = fake.makeAgent("session-created");
    fake.create.mockImplementation(async (options) => {
      fake.calls.push("create");
      expect(options.sessionId).toEqual(expect.any(String));
      expect(options.meta).toEqual({ cwd: "/repo" });
      expect(options.setup).toBe(setup);
      return handle;
    });

    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store,
      setup,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const result = await adapter.create({
      jobId: "job-1",
      repositoryPath: "/repo",
      request: "Fix the test",
    });

    expect(result).toEqual({ sessionId: "session-created" });
    expect(followup).toHaveBeenCalledOnce();
    expect(followup.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Fix the test" }],
      source: { kind: "user" },
    });
    expect(fake.calls).toEqual(["create", "followup"]);
    expect(store.calls).toEqual(["map:job-1"]);
    expect(events).toEqual([]);
    await adapter.dispose();
  });

  it("resumes a persisted session with the official resume identity and setup", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.mappings.set("job-2", {
      jobId: "job-2",
      attempt: 3,
      sessionId: "persisted-session",
      status: "running",
    });
    const setup = vi.fn();
    const { handle } = fake.makeAgent("persisted-session");
    fake.resume.mockImplementation(async (options) => {
      expect(options.resumeSessionId).toBe(SessionId("persisted-session"));
      expect(options.setup).toBe(setup);
      return handle;
    });

    const adapter = new AgentAdapter({ ctx: fake.ctx, store, setup });
    await adapter.resume({ jobId: "job-2", sessionId: "persisted-session" });

    expect(fake.resume).toHaveBeenCalledOnce();
    expect(fake.create).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("isolates session events to sessions owned by this adapter", async () => {
    const fake = new FakeHarness();
    const events: NormalizedHarnessEvent[] = [];
    const { handle } = fake.makeAgent("owned-session");
    fake.create.mockResolvedValue(handle);
    const adapter = createAdapter(fake, new FakeStore(), events);
    await adapter.create({
      jobId: "owned-job",
      repositoryPath: "/repo",
      request: "go",
    });

    fake.emit(
      "unrelated-session",
      sessionEvent("tool/call", {
        turn: 1,
        step: 1,
        callId: "call-unrelated",
        name: "secret",
        arguments: '{"password":"do-not-export"}',
      }),
    );
    fake.emit(
      "owned-session",
      sessionEvent("tool/call", {
        turn: 1,
        step: 1,
        callId: "call-owned",
        name: "search",
        arguments: "{}",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      jobId: "owned-job",
      type: "tool.started",
    });
    await adapter.dispose();
  });

  it("emits success only after a committed terminal turn and idle", async () => {
    const fake = new FakeHarness();
    const idle = deferred<void>();
    const events: NormalizedHarnessEvent[] = [];
    const { handle } = fake.makeAgent("terminal-session", idle.promise);
    fake.create.mockResolvedValue(handle);
    const adapter = createAdapter(fake, new FakeStore(), events);
    await adapter.create({
      jobId: "terminal-job",
      repositoryPath: "/repo",
      request: "go",
    });

    fake.emit(
      "terminal-session",
      sessionEvent(
        "turn/end",
        {
          turn: 1,
          reason: { kind: "completed" },
        },
        4,
      ),
    );
    await Promise.resolve();
    expect(events).toEqual([]);

    idle.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: "job.succeeded",
      stage: "completed",
    });
    await adapter.dispose();
  });

  it("recovers each persisted live mapping once and reports one session-loss failure", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.recovered.push({
      jobId: "lost-job",
      attempt: 2,
      sessionId: "lost-session",
      status: "running",
    });
    fake.resume.mockRejectedValue(new Error("session unavailable"));
    const events: NormalizedHarnessEvent[] = [];
    const adapter = createAdapter(fake, store, events);

    await adapter.ready;
    await adapter.resume({ jobId: "lost-job", sessionId: "lost-session" });

    expect(fake.resume).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        jobId: "lost-job",
        type: "job.failed",
        summary: "HARNESS_SESSION_LOST",
      }),
    ]);
    await adapter.dispose();
  });

  it("fails closed with one loss event per known mapping when startup listing fails", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.failListing = true;
    const knownMappings = [
      {
        jobId: "known-job-1",
        attempt: 1,
        sessionId: "known-session-1",
        status: "running",
      },
      {
        jobId: "known-job-2",
        attempt: 3,
        sessionId: "known-session-2",
        status: "waiting_approval",
      },
      {
        jobId: "expired-job",
        attempt: 1,
        sessionId: "expired-session",
        status: "expired",
      },
    ] as const;
    const events: NormalizedHarnessEvent[] = [];
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store,
      recoverMappings: knownMappings,
      onEvent: (event) => {
        events.push(event);
      },
    });

    await adapter.ready;

    expect(store.listCalls).toBe(1);
    expect(fake.resume).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        jobId: "known-job-1",
        summary: "HARNESS_SESSION_LOST",
      }),
      expect.objectContaining({
        jobId: "known-job-2",
        summary: "HARNESS_SESSION_LOST",
      }),
    ]);
    await expect(
      adapter.create({
        jobId: "new-job",
        repositoryPath: "/repo",
        request: "must not start",
      }),
    ).rejects.toThrow("HARNESS_MAPPING_UNAVAILABLE");
    await adapter.dispose();
  });

  it("queries the durable store before awaiting supplemental recovery input", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    const supplemental = deferred<readonly []>();
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store,
      recoverMappings: () => supplemental.promise,
    });

    const listCallsBeforeSupplemental = store.listCalls;
    supplemental.resolve([]);
    await adapter.ready;
    await adapter.dispose();

    expect(listCallsBeforeSupplemental).toBe(1);
  });

  it("deduplicates startup attempt loss and explicit resume loss during an outage", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.recovered.push({
      jobId: "outage-job",
      attempt: 2,
      sessionId: "outage-session",
      status: "running",
    });
    fake.resume.mockRejectedValue(new Error("session unavailable"));
    const events: NormalizedHarnessEvent[] = [];
    const adapter = createAdapter(fake, store, events);

    await adapter.ready;
    store.failReads = true;
    await adapter.resume({
      jobId: "outage-job",
      sessionId: "outage-session",
    });

    expect(events).toEqual([
      expect.objectContaining({
        jobId: "outage-job",
        summary: "HARNESS_SESSION_LOST",
      }),
    ]);
    await adapter.dispose();
  });

  it("settles a committed terminal event recovered from session history after idle", async () => {
    const fake = new FakeHarness();
    const idle = deferred<void>();
    const store = new FakeStore();
    store.recovered.push({
      jobId: "history-job",
      attempt: 1,
      sessionId: "history-session",
      status: "running",
    });
    const { handle } = fake.makeAgent("history-session", idle.promise, [
      sessionEvent("turn/end", {
        turn: 1,
        reason: { kind: "completed" },
      }),
    ]);
    fake.resume.mockResolvedValue(handle);
    const events: NormalizedHarnessEvent[] = [];
    const adapter = createAdapter(fake, store, events);

    await adapter.ready;
    expect(events).toEqual([]);
    idle.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      jobId: "history-job",
      type: "job.succeeded",
    });
    await adapter.dispose();
  });

  it("does not create a second Agent for the same live job mapping", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    const { handle } = fake.makeAgent("same-session");
    fake.create.mockResolvedValue(handle);
    const adapter = createAdapter(fake, store);

    const first = await adapter.create({
      jobId: "same-job",
      repositoryPath: "/repo",
      request: "one",
    });
    const second = await adapter.create({
      jobId: "same-job",
      repositoryPath: "/repo",
      request: "two",
    });

    expect(first).toEqual(second);
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.resume).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("serializes concurrent creates for one job before minting an Agent", async () => {
    const fake = new FakeHarness();
    const creation = deferred<AgentHandle>();
    const { handle, followup } = fake.makeAgent("concurrent-session");
    fake.create.mockReturnValue(creation.promise);
    const adapter = createAdapter(fake);

    const first = adapter.create({
      jobId: "concurrent-job",
      repositoryPath: "/repo",
      request: "one",
    });
    const second = adapter.create({
      jobId: "concurrent-job",
      repositoryPath: "/repo",
      request: "two",
    });
    await vi.waitFor(() => expect(fake.create).toHaveBeenCalledOnce());

    creation.resolve(handle);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "concurrent-session" },
      { sessionId: "concurrent-session" },
    ]);
    expect(followup).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("does not resume the same persisted attempt twice concurrently", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.mappings.set("racing-job", {
      jobId: "racing-job",
      attempt: 4,
      sessionId: "racing-session",
      status: "running",
    });
    const resumption = deferred<AgentHandle>();
    const { handle } = fake.makeAgent("racing-session");
    fake.resume.mockReturnValue(resumption.promise);
    const adapter = createAdapter(fake, store);

    const resume = adapter.resume({
      jobId: "racing-job",
      sessionId: "racing-session",
    });
    const create = adapter.create({
      jobId: "racing-job",
      repositoryPath: "/repo",
      request: "continue",
    });
    await vi.waitFor(() => expect(fake.resume).toHaveBeenCalledOnce());

    resumption.resolve(handle);
    await expect(resume).resolves.toBeUndefined();
    await expect(create).resolves.toEqual({ sessionId: "racing-session" });
    expect(fake.resume).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("disposes a newly created handle when its session is already owned", async () => {
    const fake = new FakeHarness();
    const first = fake.makeAgent("duplicate-session");
    const second = fake.makeAgent("duplicate-session");
    fake.create
      .mockResolvedValueOnce(first.handle)
      .mockResolvedValueOnce(second.handle);
    const adapter = createAdapter(fake);

    await adapter.create({
      jobId: "first-job",
      repositoryPath: "/repo",
      request: "one",
    });
    await expect(
      adapter.create({
        jobId: "second-job",
        repositoryPath: "/repo",
        request: "two",
      }),
    ).rejects.toThrow("HARNESS_SESSION_OWNERSHIP_CONFLICT");

    expect(second.handle.dispose).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("cancels to quiescence and disposes the owned handle and listener", async () => {
    const fake = new FakeHarness();
    const idle = deferred<void>();
    const { agent, handle } = fake.makeAgent("cancel-session", idle.promise);
    fake.create.mockResolvedValue(handle);
    const adapter = createAdapter(fake);
    await adapter.create({
      jobId: "cancel-job",
      repositoryPath: "/repo",
      request: "go",
    });

    const cancellation = adapter.cancel("cancel-job");
    await Promise.resolve();
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    idle.resolve();
    await expect(cancellation).resolves.toBe("requested");

    await adapter.dispose();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(fake.listeners).toHaveLength(0);
  });

  it("returns unknown when Harness rejects cancellation", async () => {
    const fake = new FakeHarness();
    const { handle, cancel } = fake.makeAgent("cancel-error-session");
    fake.create.mockResolvedValue(handle);
    cancel.mockImplementation(() => {
      throw new Error("already disposed");
    });
    const adapter = createAdapter(fake);
    await adapter.create({
      jobId: "cancel-error-job",
      repositoryPath: "/repo",
      request: "go",
    });

    await expect(adapter.cancel("cancel-error-job")).resolves.toBe("unknown");
    await adapter.dispose();
  });

  it("waits for an in-flight resume before disposal resolves", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.mappings.set("resume-job", {
      jobId: "resume-job",
      attempt: 1,
      sessionId: "resume-session",
      status: "running",
    });
    const resumption = deferred<AgentHandle>();
    fake.resume.mockReturnValue(resumption.promise);
    const adapter = createAdapter(fake, store);

    const resume = adapter.resume({
      jobId: "resume-job",
      sessionId: "resume-session",
    });
    await vi.waitFor(() => expect(fake.resume).toHaveBeenCalledOnce());

    let disposalResolved = false;
    const disposal = adapter.dispose().then(() => {
      disposalResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposalResolved).toBe(false);

    const { handle } = fake.makeAgent("resume-session");
    resumption.resolve(handle);
    await expect(resume).resolves.toBeUndefined();
    await expect(disposal).resolves.toBeUndefined();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("waits for a pending event sink before disposal resolves", async () => {
    const fake = new FakeHarness();
    const sink = deferred<void>();
    const { handle } = fake.makeAgent("pending-sink-session");
    fake.create.mockResolvedValue(handle);
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: new FakeStore(),
      onEvent: () => sink.promise,
    });
    await adapter.create({
      jobId: "pending-sink-job",
      repositoryPath: "/repo",
      request: "go",
    });
    fake.emit(
      "pending-sink-session",
      sessionEvent("step/start", { turn: 1, step: 1 }),
    );

    let disposalResolved = false;
    const disposal = adapter.dispose().then(() => {
      disposalResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposalResolved).toBe(false);

    sink.resolve();
    await expect(disposal).resolves.toBeUndefined();
  });

  it("waits for and contains a rejecting event sink during disposal", async () => {
    const fake = new FakeHarness();
    const sink = deferred<void>();
    const { handle } = fake.makeAgent("rejecting-sink-session");
    fake.create.mockResolvedValue(handle);
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: new FakeStore(),
      onEvent: () => sink.promise,
    });
    await adapter.create({
      jobId: "rejecting-sink-job",
      repositoryPath: "/repo",
      request: "go",
    });
    fake.emit(
      "rejecting-sink-session",
      sessionEvent("step/end", { turn: 1, step: 1 }),
    );

    let disposalResolved = false;
    const disposal = adapter.dispose().then(() => {
      disposalResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposalResolved).toBe(false);

    sink.reject(new Error("sink unavailable"));
    await expect(disposal).resolves.toBeUndefined();
  });
});
