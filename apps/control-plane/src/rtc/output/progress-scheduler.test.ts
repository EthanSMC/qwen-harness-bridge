import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProgressScheduler,
  PROGRESS_COALESCE_MS,
  type ProgressSink,
  type RtcJobEvent,
  type RtcJobEventSource,
} from "./progress-scheduler.js";

type Recorded = {
  kind: "progress" | "approval" | "terminal";
  atMs: number;
  payload: Record<string, unknown>;
};

const createHarness = () => {
  let current = 0;
  const subscribeCalls: string[][] = [];
  let unsubscribeCount = 0;
  let listener: ((event: RtcJobEvent) => void) | undefined;
  const source: RtcJobEventSource = {
    subscribe(jobIds, next) {
      subscribeCalls.push([...jobIds]);
      listener = next;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };
  const records: Recorded[] = [];
  const sink: ProgressSink = {
    async progress(event) {
      records.push({ kind: "progress", atMs: current, payload: { ...event } });
    },
    async approval(event) {
      records.push({ kind: "approval", atMs: current, payload: { ...event } });
    },
    async terminal(event) {
      records.push({ kind: "terminal", atMs: current, payload: { ...event } });
    },
  };
  const scheduler = createProgressScheduler({
    sink,
    source,
    now: () => current,
  });
  const advance = (ms: number): void => {
    current += ms;
    vi.advanceTimersByTime(ms);
  };
  return {
    scheduler,
    source,
    sink,
    records,
    subscribeCalls,
    unsubscribe: () => unsubscribeCount,
    emit: (event: RtcJobEvent) => listener?.(event),
    now: () => current,
    advance,
  };
};

const progressEvent = (
  jobId: string,
  stage: string,
  atMs: number,
): RtcJobEvent => ({
  kind: "progress",
  jobId,
  stage,
  status: "running",
  atMs,
});

describe("progress scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes only to the jobs touched by this session", () => {
    const h = createHarness();
    h.scheduler.touchJob("job-a");
    expect(h.subscribeCalls).toEqual([["job-a"]]);
    h.scheduler.touchJob("job-b");
    expect(h.subscribeCalls.at(-1)).toEqual(["job-a", "job-b"]);
    const beforeClose = h.unsubscribe();
    h.scheduler.close();
    expect(h.unsubscribe()).toBe(beforeClose + 1);
  });

  it("coalesces ordinary progress to the newest stage every ten seconds", () => {
    const h = createHarness();
    h.scheduler.touchJob("job-a");
    h.emit(progressEvent("job-a", "queued", 0));
    h.advance(4_000);
    h.emit(progressEvent("job-a", "editing", 4_000));
    h.advance(PROGRESS_COALESCE_MS - 5_000);
    expect(h.records).toHaveLength(0);

    h.advance(1_000);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ kind: "progress" });
    expect(h.records[0]?.payload.stage).toBe("editing");

    h.emit(progressEvent("job-a", "testing", h.now()));
    expect(h.records).toHaveLength(1);
    h.advance(PROGRESS_COALESCE_MS);
    expect(h.records.at(-1)?.payload.stage).toBe("testing");
  });

  it("emits approval immediately and clears the stale progress", () => {
    const h = createHarness();
    h.scheduler.touchJob("job-a");
    h.emit(progressEvent("job-a", "editing", 0));
    h.emit({
      kind: "approval",
      jobId: "job-a",
      approvalId: "approval-1",
      jobShortId: "QH-AAA1",
      jobRevision: 2,
      summary: "修改两个文件",
      atMs: 0,
    });

    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.kind).toBe("approval");
    expect(vi.getTimerCount()).toBe(0);
    h.advance(PROGRESS_COALESCE_MS);
    expect(h.records).toHaveLength(1);
  });

  it("asks the output to cancel queued progress before emitting approval", () => {
    const h = createHarness();
    const order: string[] = [];
    const sink: ProgressSink = {
      async progress() {
        order.push("progress");
      },
      async approval() {
        order.push("approval");
      },
      async terminal() {
        order.push("terminal");
      },
      cancelPendingProgress() {
        order.push("cancel");
      },
    };
    const scheduler = createProgressScheduler({
      sink,
      source: h.source,
      now: () => h.now(),
    });
    scheduler.touchJob("job-a");
    scheduler.handle(progressEvent("job-a", "editing", 0));
    scheduler.handle({
      kind: "approval",
      jobId: "job-a",
      approvalId: "approval-1",
      jobShortId: "QH-AAA1",
      jobRevision: 2,
      summary: "修改两个文件",
      atMs: 0,
    });

    expect(order).toEqual(["cancel", "approval"]);
  });

  it("emits terminal immediately and drops the queued progress", () => {
    const h = createHarness();
    h.scheduler.touchJob("job-a");
    h.emit(progressEvent("job-a", "testing", 0));
    h.emit({
      kind: "terminal",
      jobId: "job-a",
      status: "succeeded",
      summary: "测试已通过",
      atMs: 0,
    });

    expect(h.records.map((record) => record.kind)).toEqual(["terminal"]);
    h.advance(PROGRESS_COALESCE_MS);
    expect(h.records.map((record) => record.kind)).toEqual(["terminal"]);
  });

  it("unsubscribes and stops emitting after close", () => {
    const h = createHarness();
    h.scheduler.touchJob("job-a");
    h.emit(progressEvent("job-a", "editing", 0));
    const beforeClose = h.unsubscribe();
    h.scheduler.close();
    expect(h.unsubscribe()).toBe(beforeClose + 1);
    expect(vi.getTimerCount()).toBe(0);
    h.emit(progressEvent("job-a", "testing", 0));
    h.advance(PROGRESS_COALESCE_MS);
    expect(h.records).toHaveLength(0);
  });

  it("does not throw into the job event source when the sink rejects", async () => {
    const h = createHarness();
    const failing: ProgressSink = {
      async progress() {
        throw new Error("sink unavailable");
      },
      async approval() {
        throw new Error("sink unavailable");
      },
      async terminal() {
        throw new Error("sink unavailable");
      },
    };
    const scheduler = createProgressScheduler({
      sink: failing,
      source: h.source,
      now: () => 0,
    });
    scheduler.touchJob("job-a");
    expect(() =>
      scheduler.handle({
        kind: "approval",
        jobId: "job-a",
        approvalId: "a",
        jobShortId: "QH-AAA1",
        jobRevision: 1,
        summary: "s",
        atMs: 0,
      }),
    ).not.toThrow();
    await expect(scheduler.flush()).resolves.toBeUndefined();
  });

  it("keeps invariants over 100 seeded randomized schedules", () => {
    const mulberry32 = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let seed = 1; seed <= 100; seed += 1) {
      vi.clearAllTimers();
      const h = createHarness();
      const random = mulberry32(seed);
      const events: RtcJobEvent[] = [];
      h.scheduler.touchJob("job-a");
      h.scheduler.touchJob("job-b");
      for (let step = 0; step < 100; step += 1) {
        const choice = random();
        const jobId = random() > 0.5 ? "job-a" : "job-b";
        if (choice < 0.7) {
          const event = progressEvent(jobId, `stage-${step}`, h.now());
          events.push(event);
          h.emit(event);
        } else if (choice < 0.85) {
          const event: RtcJobEvent = {
            kind: "approval",
            jobId,
            approvalId: `approval-${step}`,
            jobShortId: "QH-AAA1",
            jobRevision: step,
            summary: "审批",
            atMs: h.now(),
          };
          events.push(event);
          h.emit(event);
        } else {
          const event: RtcJobEvent = {
            kind: "terminal",
            jobId,
            status: "succeeded",
            summary: "完成",
            atMs: h.now(),
          };
          events.push(event);
          h.emit(event);
        }
        h.advance(Math.floor(random() * 15_000));
      }
      const beforeClose = h.unsubscribe();
      h.scheduler.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.unsubscribe()).toBe(beforeClose + 1);
      const afterClose = h.records.length;
      h.emit(progressEvent("job-a", "late", h.now()));
      h.advance(PROGRESS_COALESCE_MS);
      expect(h.records.length).toBe(afterClose);
      for (let index = 1; index < h.records.length; index += 1) {
        const previous = h.records[index - 1];
        const current = h.records[index];
        if (previous?.kind === "progress") {
          expect(current?.atMs ?? 0).toBeGreaterThanOrEqual(previous.atMs);
        }
      }
      const progressByJob = new Map<string, number[]>();
      for (const record of h.records) {
        if (record.kind !== "progress") continue;
        const jobId = String(record.payload.jobId ?? "");
        const times = progressByJob.get(jobId) ?? [];
        times.push(record.atMs);
        progressByJob.set(jobId, times);
      }
      for (const times of progressByJob.values()) {
        for (let index = 1; index < times.length; index += 1) {
          expect(
            (times[index] ?? 0) - (times[index - 1] ?? 0),
          ).toBeGreaterThanOrEqual(PROGRESS_COALESCE_MS);
        }
      }
    }
  });
});
