import type { RtcJobEventSource } from "./job-event-subscription.js";
import { JobEventSubscription } from "./job-event-subscription.js";
import type { RtcOutput, RtcProgressPayload } from "./serialized-sse-writer.js";

export type { RtcJobEventSource };

export const PROGRESS_COALESCE_MS = 10_000;

export type RtcProgressEvent = Readonly<{
  kind: "progress";
  jobId: string;
  stage: string;
  status?: string;
  summary?: string;
  atMs: number;
}>;

export type RtcApprovalEvent = Readonly<{
  kind: "approval";
  jobId?: string;
  approvalId: string;
  jobShortId: string;
  jobRevision: number;
  summary: string;
  atMs: number;
}>;

export type RtcTerminalEvent = Readonly<{
  kind: "terminal";
  jobId: string;
  status: string;
  summary: string;
  atMs: number;
}>;

export type RtcJobEvent =
  | RtcProgressEvent
  | RtcApprovalEvent
  | RtcTerminalEvent;

export type ProgressSink = Readonly<
  Pick<RtcOutput, "progress" | "approval" | "terminal">
>;

export type ProgressSchedulerOptions = Readonly<{
  sink: ProgressSink;
  source: RtcJobEventSource;
  now?: () => number;
}>;

export type ProgressScheduler = Readonly<{
  touchJob: (jobId: string) => void;
  handle: (event: RtcJobEvent) => void;
  flush: () => Promise<void>;
  close: () => void;
}>;

const silence = (promise: Promise<unknown>): void => {
  void promise.catch(() => undefined);
};

/**
 * Coalesces ordinary product progress to the newest stage at most once every
 * ten seconds, emits approval and terminal events immediately while clearing
 * stale progress, subscribes only to jobs touched in this RTC session, and
 * unsubscribes on close without affecting the job.
 */
export const createProgressScheduler = (
  options: ProgressSchedulerOptions,
): ProgressScheduler => {
  const pending = new Map<string, RtcProgressPayload & { atMs: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const subscription = new JobEventSubscription(options.source, (event) =>
    handle(event),
  );

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flushPending = async (): Promise<void> => {
    clearTimer();
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    for (const item of batch) {
      try {
        await options.sink.progress({
          jobId: item.jobId,
          stage: item.stage,
          ...(item.status === undefined ? {} : { status: item.status }),
          ...(item.summary === undefined ? {} : { summary: item.summary }),
        });
      } catch {
        // Output failure must never propagate into the job event source.
      }
    }
  };

  const scheduleFlush = (): void => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flushPending();
    }, PROGRESS_COALESCE_MS);
  };

  const handle = (event: RtcJobEvent): void => {
    if (closed) return;
    if (event.kind === "progress") {
      pending.set(event.jobId, {
        jobId: event.jobId,
        stage: event.stage,
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.summary === undefined ? {} : { summary: event.summary }),
        atMs: event.atMs,
      });
      scheduleFlush();
      return;
    }
    const jobId = event.jobId;
    if (jobId !== undefined) {
      pending.delete(jobId);
      if (pending.size === 0) clearTimer();
    } else {
      pending.clear();
      clearTimer();
    }
    if (event.kind === "approval") {
      silence(
        options.sink.approval({
          approvalId: event.approvalId,
          jobShortId: event.jobShortId,
          jobRevision: event.jobRevision,
          summary: event.summary,
        }),
      );
      return;
    }
    silence(
      options.sink.terminal({
        jobId: event.jobId,
        status: event.status,
        summary: event.summary,
      }),
    );
  };

  return {
    touchJob(jobId) {
      if (closed || jobId.length === 0) return;
      subscription.track([jobId]);
    },
    handle,
    async flush() {
      if (closed) return;
      await flushPending();
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimer();
      pending.clear();
      subscription.unsubscribe();
    },
  };
};
