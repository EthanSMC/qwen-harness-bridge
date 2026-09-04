import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  SESSION_FORMAT_VERSION,
  Session,
  type SessionEvent,
  SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessAdapterOptions as PublicHarnessAdapterOptions,
  HarnessAgentAdapter as PublicHarnessAgentAdapter,
  NormalizedHarnessEvent as PublicNormalizedHarnessEvent,
} from "../index.js";
import * as publicApi from "../index.js";
import { SqlitePluginStore } from "../store/plugin-store.js";
import {
  AgentAdapter,
  type HarnessContext,
  type HarnessMappingStore,
} from "./agent-adapter.js";
import { normalizeSessionEvent } from "./event-normalizer.js";
import { registerSessionListener } from "./register-session-listener.js";
import type { NormalizedHarnessEvent } from "./types.js";

type SessionListener = (session: Session, event: SessionEvent) => void;

const temporaryDirectories = new Set<string>();

const makeDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "qhb-harness-adapter-"));
  temporaryDirectories.add(directory);
  return join(directory, "plugin.sqlite");
};

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

const restoredSession = (
  sessionId: string,
  events: readonly SessionEvent[],
): Session => {
  const id = SessionId(sessionId);
  return Session.fromRestore(
    id,
    [...events],
    {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1_725_000_000_000,
      isSeeded: false,
    },
    SessionLogOffset(0),
  );
};

const withoutStartupRecovery = (
  store: SqlitePluginStore,
): HarnessMappingStore => ({
  mapJob: (input) => store.mapJob(input),
  findJob: (jobId) => store.findJob(jobId),
  listNonterminalJobs: () => [],
});

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
    restored?: Session,
  ) {
    const followup = vi.fn((_message: unknown) => this.calls.push("followup"));
    const cancel = vi.fn(() => this.calls.push("cancel"));
    const agent = {
      id: SessionId(sessionId),
      status: "running",
      ctx: {} as Context,
      session: restored ?? { ownEvents: vi.fn(() => history) },
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
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
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

  it("marks the persisted attempt failed before rethrowing a followup failure", async () => {
    const databasePath = makeDatabasePath();
    const store = new SqlitePluginStore(databasePath);
    const fake = new FakeHarness();
    const events: NormalizedHarnessEvent[] = [];
    const { handle, followup } = fake.makeAgent("followup-failure-session");
    const privateFailure = new Error("private followup failure body");
    followup.mockImplementation(() => {
      throw privateFailure;
    });
    fake.create.mockResolvedValue(handle);
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store,
      onEvent: (event) => {
        events.push(event);
      },
    });
    let reopened: SqlitePluginStore | undefined;

    try {
      await expect(
        adapter.create({
          jobId: "followup-failure-job",
          repositoryPath: "/repo",
          request: "go",
        }),
      ).rejects.toBe(privateFailure);

      expect(handle.dispose).toHaveBeenCalledOnce();
      expect(events).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(privateFailure.message);
      expect(store.findJob("followup-failure-job")).toEqual({
        jobId: "followup-failure-job",
        attempt: 1,
        sessionId: "followup-failure-session",
        status: "failed",
      });
      expect(store.listNonterminalJobs()).toEqual([]);

      await adapter.dispose();
      store.close();
      reopened = new SqlitePluginStore(databasePath);
      expect(reopened.findJob("followup-failure-job")?.status).toBe("failed");
      expect(reopened.listNonterminalJobs()).toEqual([]);
    } finally {
      await adapter.dispose();
      store.close();
      reopened?.close();
    }
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

  it.each([
    ["startup", "queued"],
    ["startup", "dispatched"],
    ["startup", "running"],
    ["startup", "waiting_approval"],
    ["startup", "cancelling"],
    ["explicit", "queued"],
    ["explicit", "dispatched"],
    ["explicit", "running"],
    ["explicit", "waiting_approval"],
    ["explicit", "cancelling"],
  ] as const)(
    "preserves the canonical %s resume status %s",
    async (mode, status) => {
      const fake = new FakeHarness();
      const store = new FakeStore();
      const mapping = {
        jobId: `${mode}-${status}-job`,
        attempt: 2,
        sessionId: `${mode}-${status}-session`,
        status,
      };
      if (mode === "startup") {
        store.recovered.push(mapping);
      } else {
        store.mappings.set(mapping.jobId, mapping);
      }
      const { handle } = fake.makeAgent(mapping.sessionId);
      fake.resume.mockResolvedValue(handle);
      const adapter = createAdapter(fake, store);

      await adapter.ready;
      if (mode === "explicit") {
        await adapter.resume({
          jobId: mapping.jobId,
          sessionId: mapping.sessionId,
        });
      }

      expect(store.mappings.get(mapping.jobId)?.status).toBe(status);
      await adapter.dispose();
    },
  );

  it("keeps a terminal latest attempt immutable on explicit resume", async () => {
    const databasePath = makeDatabasePath();
    const canonicalStore = new SqlitePluginStore(databasePath);
    canonicalStore.mapJob({
      jobId: "terminal-resume-job",
      attempt: 1,
      sessionId: "terminal-resume-session-1",
      status: "failed",
    });
    canonicalStore.mapJob({
      jobId: "terminal-resume-job",
      attempt: 2,
      sessionId: "terminal-resume-session-2",
      status: "succeeded",
    });
    const fake = new FakeHarness();
    const events: NormalizedHarnessEvent[] = [];
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: withoutStartupRecovery(canonicalStore),
      onEvent: (event) => {
        events.push(event);
      },
    });

    try {
      await adapter.resume({
        jobId: "terminal-resume-job",
        sessionId: "terminal-resume-session-2",
      });

      expect(fake.resume).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(canonicalStore.findJob("terminal-resume-job")?.status).toBe(
        "succeeded",
      );
    } finally {
      await adapter.dispose();
      canonicalStore.close();
    }
  });

  it("does not poison the current attempt when a wrong session is resumed", async () => {
    const databasePath = makeDatabasePath();
    const canonicalStore = new SqlitePluginStore(databasePath);
    canonicalStore.mapJob({
      jobId: "mismatched-resume-job",
      attempt: 1,
      sessionId: "mismatched-resume-session-1",
      status: "failed",
    });
    canonicalStore.mapJob({
      jobId: "mismatched-resume-job",
      attempt: 2,
      sessionId: "mismatched-resume-session-2",
      status: "waiting_approval",
    });
    const fake = new FakeHarness();
    const { handle } = fake.makeAgent("mismatched-resume-session-2");
    fake.resume.mockResolvedValue(handle);
    const events: NormalizedHarnessEvent[] = [];
    const adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: withoutStartupRecovery(canonicalStore),
      onEvent: (event) => {
        events.push(event);
      },
    });

    try {
      await adapter.resume({
        jobId: "mismatched-resume-job",
        sessionId: "wrong-requested-session",
      });
      await adapter.resume({
        jobId: "mismatched-resume-job",
        sessionId: "wrong-requested-session",
      });
      await adapter.resume({
        jobId: "mismatched-resume-job",
        sessionId: "mismatched-resume-session-2",
      });

      expect(events).toEqual([
        expect.objectContaining({
          jobId: "mismatched-resume-job",
          summary: "HARNESS_SESSION_LOST",
        }),
      ]);
      expect(fake.resume).toHaveBeenCalledOnce();
      expect(canonicalStore.findJob("mismatched-resume-job")).toEqual({
        jobId: "mismatched-resume-job",
        attempt: 2,
        sessionId: "mismatched-resume-session-2",
        status: "waiting_approval",
      });
    } finally {
      await adapter.dispose();
      canonicalStore.close();
    }
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

  it("fails closed after idle for an unknown committed turn-end reason", async () => {
    const fake = new FakeHarness();
    const idle = deferred<void>();
    const events: NormalizedHarnessEvent[] = [];
    const { handle } = fake.makeAgent("unknown-terminal-session", idle.promise);
    fake.create.mockResolvedValue(handle);
    const adapter = createAdapter(fake, new FakeStore(), events);
    await adapter.create({
      jobId: "unknown-terminal-job",
      repositoryPath: "/repo",
      request: "go",
    });

    fake.emit(
      "unknown-terminal-session",
      sessionEvent("turn/end", {
        turn: 1,
        reason: { kind: "plugin-terminal-reason", private: "do not export" },
      }),
    );
    idle.resolve();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([
      expect.objectContaining({
        jobId: "unknown-terminal-job",
        type: "job.failed",
        stage: "failed",
        summary: "HARNESS_TURN_FAILED",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("do not export");
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

  it.each([
    [
      "completed",
      { kind: "completed" },
      "job.succeeded",
      "Harness task completed",
    ],
    [
      "error",
      {
        kind: "error",
        error: { code: "E_RESTORED", message: "private restored error" },
      },
      "job.failed",
      "E_RESTORED",
    ],
  ] as const)(
    "recovers a restored %s turn before the official end-seed marker",
    async (_reasonName, reason, expectedType, expectedSummary) => {
      const fake = new FakeHarness();
      const store = new FakeStore();
      const sessionId = `restored-${reason.kind}-session`;
      store.recovered.push({
        jobId: `restored-${reason.kind}-job`,
        attempt: 1,
        sessionId,
        status: "running",
      });
      const restored = restoredSession(sessionId, [
        sessionEvent("turn/start", { turn: 1 }, 0),
        sessionEvent("turn/end", { turn: 1, reason }, 1),
      ]);
      expect(restored.ownEvents().at(-1)?.type).toBe("session/end-seed");
      const { handle } = fake.makeAgent(
        sessionId,
        Promise.resolve(),
        [],
        restored,
      );
      fake.resume.mockResolvedValue(handle);
      const events: NormalizedHarnessEvent[] = [];
      const adapter = createAdapter(fake, store, events);

      await adapter.ready;
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events).toEqual([
        expect.objectContaining({
          jobId: `restored-${reason.kind}-job`,
          type: expectedType,
          summary: expectedSummary,
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("private restored error");
      await adapter.dispose();
    },
  );

  it("does not reuse an older restored terminal after a newer turn starts", async () => {
    const fake = new FakeHarness();
    const store = new FakeStore();
    store.recovered.push({
      jobId: "restored-active-job",
      attempt: 1,
      sessionId: "restored-active-session",
      status: "running",
    });
    const restored = restoredSession("restored-active-session", [
      sessionEvent("turn/start", { turn: 1 }, 0),
      sessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 1),
      sessionEvent("turn/start", { turn: 2 }, 2),
    ]);
    expect(restored.ownEvents().at(-1)?.type).toBe("session/end-seed");
    const { handle } = fake.makeAgent(
      "restored-active-session",
      Promise.resolve(),
      [],
      restored,
    );
    fake.resume.mockResolvedValue(handle);
    const events: NormalizedHarnessEvent[] = [];
    const adapter = createAdapter(fake, store, events);

    await adapter.ready;
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(store.mappings.get("restored-active-job")?.status).toBe("running");
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

  it("allows an event sink to return reentrant disposal", async () => {
    const fake = new FakeHarness();
    const { handle } = fake.makeAgent("return-dispose-session");
    fake.create.mockResolvedValue(handle);
    let adapter!: AgentAdapter;
    adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: new FakeStore(),
      onEvent: () => adapter.dispose(),
    });
    await adapter.create({
      jobId: "return-dispose-job",
      repositoryPath: "/repo",
      request: "go",
    });

    fake.emit(
      "return-dispose-session",
      sessionEvent("step/start", { turn: 1, step: 1 }),
    );

    expect(fake.listeners).toHaveLength(0);
    await expect(adapter.dispose()).resolves.toBeUndefined();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("allows an awaited reentrant disposal after an event sink yields", async () => {
    const fake = new FakeHarness();
    const { handle } = fake.makeAgent("await-dispose-session");
    fake.create.mockResolvedValue(handle);
    let adapter!: AgentAdapter;
    adapter = new AgentAdapter({
      ctx: fake.ctx,
      store: new FakeStore(),
      onEvent: async () => {
        await Promise.resolve();
        await adapter.dispose();
      },
    });
    await adapter.create({
      jobId: "await-dispose-job",
      repositoryPath: "/repo",
      request: "go",
    });

    fake.emit(
      "await-dispose-session",
      sessionEvent("step/end", { turn: 1, step: 1 }),
    );
    const disposal = adapter.dispose();

    expect(fake.listeners).toHaveLength(0);
    await expect(disposal).resolves.toBeUndefined();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
});
