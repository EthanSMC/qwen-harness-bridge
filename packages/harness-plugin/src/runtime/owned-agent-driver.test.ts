import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { ConnectorServerMessageSchema } from "@qhb/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePluginStore } from "../store/plugin-store.js";
import type { JobOfferMessage } from "./job-command-coordinator.js";
import {
  OwnedAgentDriver,
  type OwnedAgentDriverOptions,
} from "./owned-agent-driver.js";

const roots: string[] = [];
const stores: SqlitePluginStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const offerOf = (overrides: Record<string, unknown> = {}) =>
  ConnectorServerMessageSchema.parse({
    protocol_version: "1.0",
    type: "job.offer",
    message_id: randomUUID(),
    sequence: 1,
    correlation_id: randomUUID(),
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    payload: {
      job_id: randomUUID(),
      attempt: 1,
      repository_id: "example",
      lease_id: randomUUID(),
      request: "fixture request",
      ...overrides,
    },
  }) as JobOfferMessage;

type Harness = {
  driver: OwnedAgentDriver;
  store: SqlitePluginStore;
  create: ReturnType<typeof vi.fn>;
  publishClaim: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  followup: ReturnType<typeof vi.fn>;
  stateOverrides: Record<string, unknown>;
  sessionHandler: () =>
    | ((sessionId: string, event: unknown) => void)
    | undefined;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const build = (
  offer: JobOfferMessage,
  options: {
    store?: SqlitePluginStore;
    flushResult?: boolean;
    stateOverrides?: Record<string, unknown>;
    onAttemptEnded?: (agent: { id: unknown }) => void;
    setupFactory?: (
      sessionId: string,
      context: {
        jobId: string;
        attempt: number;
        repositoryId: string;
        repositoryPath: string;
      },
    ) => unknown;
  } = {},
): Harness => {
  const store =
    options.store ??
    (() => {
      const root = mkdtempSync(join(tmpdir(), "qhb-driver-"));
      roots.push(root);
      const created = new SqlitePluginStore(join(root, "store.sqlite"));
      stores.push(created);
      created.recordInbound(
        offer.message_id,
        offer.sequence,
        JSON.stringify(offer),
      );
      return created;
    })();
  const epoch = { signal: new AbortController().signal };
  let captured: unknown;
  const followup = vi.fn();
  const create = vi.fn(
    async (input: {
      sessionId: unknown;
      setup?: unknown;
    }): Promise<AgentHandle> => {
      const session = {
        ownEvents: () =>
          captured === undefined
            ? []
            : [
                {
                  type: "user/message",
                  seq: 7,
                  time: Date.now(),
                  data: captured,
                },
              ],
      } as unknown as Session;
      const agent = {
        id: String(input.sessionId),
        session,
        followup: (message: unknown) => {
          captured = message;
          followup(message);
        },
        status: "running",
        whenIdle: async () => {},
        cancel: () => {},
      };
      return { agent, dispose: async () => {} } as unknown as AgentHandle;
    },
  );
  const publishClaim = vi.fn(async () => {});
  let sessionHandler: ((sessionId: string, event: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const flush = vi.fn(async () => options.flushResult ?? true);
  const stateOverrides = options.stateOverrides ?? {};
  const observe = vi.fn(async () => {
    const now = Date.now();
    const request = {
      messageId: randomUUID(),
      sequence: 9,
      correlationId: randomUUID(),
      jobId: offer.payload.job_id,
      attempt: offer.payload.attempt,
      nonce: randomUUID(),
      epoch,
    };
    const state = {
      job_id: offer.payload.job_id,
      repository_id: "example",
      mode: "normal",
      requested_attempt: offer.payload.attempt,
      current_attempt: offer.payload.attempt,
      status: "running",
      job_revision: 3,
      cancel_revision: null,
      lease_id: offer.payload.lease_id,
      lease_expires_at: new Date(now + 30_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      observed_at: new Date(now).toISOString(),
      state_valid_until: new Date(now + 2_000).toISOString(),
      request_message_id: request.messageId,
      request_sequence: request.sequence,
      nonce: request.nonce,
      ...stateOverrides,
    };
    return {
      state: {
        type: "job.state",
        correlation_id: request.correlationId,
        payload: state,
      },
      request,
      epoch,
      sent: { wallTimeMs: now, monotonicTimeMs: 1_000 },
      received: { wallTimeMs: now, monotonicTimeMs: 1_010 },
    };
  });
  const driver = new OwnedAgentDriver({
    agents: { create },
    store,
    states: { observe },
    authority: {
      issue: vi.fn(),
    } as unknown as OwnedAgentDriverOptions["authority"],
    terminal: {} as unknown as OwnedAgentDriverOptions["terminal"],
    epoch: () => epoch,
    repositories: {
      resolve: (id) => (id === "example" ? "/repo/example" : undefined),
    },
    publishClaim,
    flush,
    onSessionEvent: (handler) => {
      sessionHandler = handler as unknown as (
        sessionId: string,
        event: unknown,
      ) => void;
      return unsubscribe;
    },
    ...(options.onAttemptEnded === undefined
      ? {}
      : {
          onAttemptEnded:
            options.onAttemptEnded as unknown as OwnedAgentDriverOptions["onAttemptEnded"],
        }),
    ...(options.setupFactory === undefined
      ? {}
      : {
          setupFactory: options.setupFactory as unknown as (
            sessionId: string,
          ) => never,
        }),
  });
  return {
    driver,
    store,
    create,
    publishClaim,
    flush,
    followup,
    stateOverrides,
    sessionHandler: () => sessionHandler,
    unsubscribe,
  };
};

describe("OwnedAgentDriver.start", () => {
  it("drives one prepared offer through creating, submitting and started", async () => {
    const offer = offerOf();
    const harness = build(offer);
    await harness.driver.start(offer);

    const intent = harness.store.ownedIntent(
      offer.payload.job_id,
      offer.payload.attempt,
    );
    expect(intent?.phase).toBe("started");
    expect(intent?.mode).toBe("normal");
    expect(intent?.initialMessageId).toBeDefined();
    expect(intent?.startedEvidence?.eventSequence).toBe(7);
    expect(intent?.startedEvidence?.messageId).toBe(intent?.initialMessageId);
    expect(harness.publishClaim).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create.mock.calls[0][0].sessionId).toBe(
      intent?.owner.sessionId,
    );
    expect(harness.followup).toHaveBeenCalledTimes(1);
    expect(harness.flush).toHaveBeenCalledTimes(1);
  });

  it("derives a per-Agent policy setup from the preallocated session id", async () => {
    const offer = offerOf();
    const setupMarker = { kind: "policy-setup" };
    const setupFactory = vi.fn(() => setupMarker);
    const harness = build(offer, { setupFactory });
    await harness.driver.start(offer);
    const intent = harness.store.ownedIntent(
      offer.payload.job_id,
      offer.payload.attempt,
    );
    expect(setupFactory).toHaveBeenCalledWith(intent?.owner.sessionId, {
      jobId: offer.payload.job_id,
      attempt: offer.payload.attempt,
      repositoryId: offer.payload.repository_id,
      repositoryPath: "/repo/example",
    });
    expect(harness.create.mock.calls[0][0].setup).toBe(setupMarker);
  });

  it("revokes the per-Agent projection when the driver disposes", async () => {
    const offer = offerOf();
    const ended: unknown[] = [];
    const harness = build(offer, {
      onAttemptEnded: (agent) => ended.push(agent),
    });
    await harness.driver.start(offer);
    await harness.driver.dispose();
    expect(ended).toHaveLength(1);
    expect(String((ended[0] as { id: unknown }).id)).toBe(
      harness.store.findJob(offer.payload.job_id)?.sessionId,
    );
  });

  it("subscribes to owned session events and releases them on dispose", async () => {
    const offer = offerOf();
    const harness = build(offer);
    await harness.driver.start(offer);
    const handler = harness.sessionHandler();
    expect(typeof handler).toBe("function");
    expect(() =>
      handler?.("unrelated-session", {
        type: "step/start",
        seq: 1,
        data: undefined,
      }),
    ).not.toThrow();
    await harness.driver.dispose();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not start a second attempt after a restart on the same store", async () => {
    const offer = offerOf();
    const first = build(offer);
    await first.driver.start(offer);
    expect(first.create).toHaveBeenCalledTimes(1);
    const restarted = build(offer, { store: first.store });
    await restarted.driver.start(offer);
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it("never creates a second Agent for a duplicate offer", async () => {
    const offer = offerOf();
    const harness = build(offer);
    await harness.driver.start(offer);
    await harness.driver.start(offer);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.publishClaim).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a started transition when the persistence flush fails", async () => {
    const offer = offerOf();
    const harness = build(offer, { flushResult: false });
    await expect(harness.driver.start(offer)).rejects.toThrow(
      "HARNESS_PERSISTENCE_UNAVAILABLE",
    );
    const intent = harness.store.ownedIntent(
      offer.payload.job_id,
      offer.payload.attempt,
    );
    expect(intent?.phase).toBe("submitting");
    expect(intent?.startedEvidence).toBeNull();
  });

  it("does not create an Agent when the fresh state is not running", async () => {
    const offer = offerOf();
    const harness = build(offer, {
      stateOverrides: { status: "waiting_approval" },
    });
    await harness.driver.start(offer);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.followup).not.toHaveBeenCalled();
    expect(
      harness.store.ownedIntent(offer.payload.job_id, offer.payload.attempt)
        ?.phase,
    ).toBe("prepared");
  });

  it("ignores an unknown repository alias without claiming or creating", async () => {
    const offer = offerOf({ repository_id: "missing" });
    const harness = build(offer);
    await harness.driver.start(offer);
    expect(harness.publishClaim).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("ignores an expired offer", async () => {
    const offer = offerOf();
    const harness = build(offer);
    const expired = {
      ...offer,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    } as JobOfferMessage;
    await harness.driver.start(expired);
    expect(harness.create).not.toHaveBeenCalled();
  });
});
