import type { RtcSseWriter } from "../session/rtc-session.js";
import {
  fragmentSpeech,
  HIGHLIGHT_SUMMARY_MAX_CHARACTERS,
  SPEAK_FRAGMENT_MAX_CHARACTERS,
} from "./speech-fragmenter.js";

export { HIGHLIGHT_SUMMARY_MAX_CHARACTERS, SPEAK_FRAGMENT_MAX_CHARACTERS };

export type RtcOutputPriority = "normal" | "urgent";

export type SpeakOptions = Readonly<{
  highlight?: string;
  priority?: RtcOutputPriority;
}>;

export type RtcProgressPayload = Readonly<{
  jobId: string;
  stage: string;
  status?: string;
  summary?: string;
}>;

export type RtcApprovalPayload = Readonly<{
  approvalId: string;
  jobShortId: string;
  jobRevision: number;
  summary: string;
}>;

export type RtcTerminalPayload = Readonly<{
  jobId: string;
  status: string;
  summary: string;
}>;

export type RtcOutput = Readonly<{
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  appendHighlight: (summary: string) => Promise<void>;
  progress: (event: RtcProgressPayload) => Promise<void>;
  approval: (event: RtcApprovalPayload) => Promise<void>;
  terminal: (event: RtcTerminalPayload) => Promise<void>;
  /** Drop progress frames that are queued but not yet written. */
  cancelPendingProgress: () => void;
  stopOutput: () => Promise<void>;
  keepalive: () => Promise<void>;
  close: () => Promise<void>;
  readonly closed: boolean;
}>;

export type RtcOutputOptions = Readonly<{
  writer: RtcSseWriter;
  signal?: AbortSignal;
  onSocketError?: (reason: "socket_error") => void;
  /** Real call site for Task 6 first-output telemetry. */
  onFirstOutput?: (kind: string) => void;
}>;

const dataFrame = (event: string, payload: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const bounded = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join("");

type QueueKind =
  | "speak"
  | "append_highlight"
  | "progress"
  | "approval"
  | "terminal"
  | "stop_output"
  | "keepalive";

type QueueItem = {
  kind: QueueKind;
  urgent: boolean;
  frame: () => string | null;
  valid: () => boolean;
  resolve: () => void;
};

/**
 * One serialized SSE writer per RTC session. Every byte goes through the same
 * queue, frames are written whole, urgent approval/terminal frames preempt
 * queued progress, keepalive is an official SSE comment behind command output,
 * STOP_OUTPUT cancels queued speech without closing the session, and socket
 * errors close only the RTC session.
 */
export const createSerializedSseOutput = (
  options: RtcOutputOptions,
): RtcOutput => {
  const { writer } = options;
  const queue: QueueItem[] = [];
  let closed = false;
  let socketFailed = false;
  let ended = false;
  let speechGeneration = 0;
  let drainScheduled = false;
  let firstOutputNotified = false;

  const isStopped = (): boolean =>
    closed || socketFailed || options.signal?.aborted === true;

  const endWriter = (): void => {
    if (ended) return;
    ended = true;
    try {
      writer.end();
    } catch {
      // The socket is already gone; the RTC session close path is independent.
    }
  };

  const dropQueue = (): void => {
    while (queue.length > 0) queue.shift()?.resolve();
  };

  const writeFrame = (frame: string): void => {
    if (isStopped()) return;
    try {
      writer.write(frame);
    } catch {
      socketFailed = true;
      closed = true;
      dropQueue();
      endWriter();
      options.onSocketError?.("socket_error");
    }
  };

  const drain = async (): Promise<void> => {
    drainScheduled = false;
    while (queue.length > 0) {
      if (isStopped()) {
        dropQueue();
        return;
      }
      const urgentIndex = queue.findIndex((item) => item.urgent);
      const item =
        urgentIndex >= 0 ? queue.splice(urgentIndex, 1)[0] : queue.shift();
      if (item === undefined) return;
      try {
        if (!isStopped() && item.valid()) {
          const frame = item.frame();
          if (frame !== null) {
            if (!firstOutputNotified) {
              firstOutputNotified = true;
              options.onFirstOutput?.(item.kind);
            }
            writeFrame(frame);
          }
        }
      } finally {
        item.resolve();
      }
      await Promise.resolve();
    }
  };

  const scheduleDrain = (): void => {
    if (drainScheduled) return;
    drainScheduled = true;
    void Promise.resolve().then(drain);
  };

  const enqueue = (
    kind: QueueKind,
    frame: () => string | null,
    overrides: { urgent?: boolean; valid?: () => boolean } = {},
  ): Promise<void> => {
    if (isStopped()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      queue.push({
        kind,
        urgent: overrides.urgent === true,
        frame,
        valid: overrides.valid ?? (() => true),
        resolve,
      });
      scheduleDrain();
    });
  };

  const speakFrame = (piece: { text: string; highlight?: string }): string =>
    dataFrame("speak", {
      text: piece.text,
      ...(piece.highlight === undefined ? {} : { highlight: piece.highlight }),
    });

  return {
    get closed() {
      return closed;
    },
    async speak(text, speakOptions = {}) {
      if (isStopped()) return;
      const generation = speechGeneration;
      const urgent = speakOptions.priority === "urgent";
      const fragments = fragmentSpeech(text, {
        ...(speakOptions.highlight === undefined
          ? {}
          : { highlight: speakOptions.highlight }),
      });
      const steps = fragments.map((fragment) =>
        enqueue("speak", () => speakFrame(fragment), {
          urgent,
          valid: () => generation === speechGeneration,
        }),
      );
      if (speakOptions.highlight !== undefined) {
        steps.push(
          enqueue(
            "append_highlight",
            () =>
              dataFrame("append_highlight", {
                summary: bounded(
                  speakOptions.highlight ?? "",
                  HIGHLIGHT_SUMMARY_MAX_CHARACTERS,
                ),
              }),
            { urgent, valid: () => generation === speechGeneration },
          ),
        );
      }
      await Promise.all(steps);
    },
    async appendHighlight(summary) {
      await enqueue("append_highlight", () =>
        dataFrame("append_highlight", {
          summary: bounded(summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
        }),
      );
    },
    async progress(event) {
      await enqueue("progress", () =>
        dataFrame("progress", {
          jobId: event.jobId,
          stage: event.stage,
          ...(event.status === undefined ? {} : { status: event.status }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        }),
      );
    },
    async approval(event) {
      await enqueue(
        "approval",
        () =>
          dataFrame("approval", {
            approvalId: event.approvalId,
            jobShortId: event.jobShortId,
            jobRevision: event.jobRevision,
            summary: bounded(event.summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
          }),
        { urgent: true },
      );
    },
    async terminal(event) {
      await enqueue(
        "terminal",
        () =>
          dataFrame("terminal", {
            jobId: event.jobId,
            status: event.status,
            summary: bounded(event.summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
          }),
        { urgent: true },
      );
    },
    cancelPendingProgress() {
      for (const item of queue) {
        if (item.kind === "progress") item.valid = () => false;
      }
    },
    async stopOutput() {
      speechGeneration += 1;
      await enqueue("stop_output", () =>
        dataFrame("stop_output", { reason: "stop_output" }),
      );
    },
    async keepalive() {
      await enqueue("keepalive", () => ": keep-alive\n\n");
    },
    async close() {
      closed = true;
      speechGeneration += 1;
      dropQueue();
      endWriter();
    },
  };
};
