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
  stopOutput: () => Promise<void>;
  keepalive: () => Promise<void>;
  close: () => Promise<void>;
  readonly closed: boolean;
}>;

export type RtcOutputOptions = Readonly<{
  writer: RtcSseWriter;
  signal?: AbortSignal;
  onSocketError?: (reason: "socket_error") => void;
}>;

const dataFrame = (event: string, payload: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const bounded = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join("");

/**
 * One serialized SSE writer per RTC session. Every byte goes through the same
 * promise chain, frames are written whole, keepalive is an official SSE comment
 * behind any queued command output, STOP_OUTPUT cancels queued speech without
 * closing the session, and socket errors close only the RTC session.
 */
export const createSerializedSseOutput = (
  options: RtcOutputOptions,
): RtcOutput => {
  const { writer } = options;
  let closed = false;
  let socketFailed = false;
  let ended = false;
  let speechGeneration = 0;
  let tail: Promise<void> = Promise.resolve();

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

  const writeFrame = (frame: string): void => {
    if (isStopped()) return;
    try {
      writer.write(frame);
    } catch {
      socketFailed = true;
      closed = true;
      endWriter();
      options.onSocketError?.("socket_error");
    }
  };

  const enqueue = (
    build: () => string | null,
    isValid: () => boolean = () => true,
  ): Promise<void> => {
    const step = tail.then(() => {
      if (isStopped() || !isValid()) return;
      const frame = build();
      if (frame === null) return;
      writeFrame(frame);
    });
    tail = step.catch(() => undefined);
    return tail;
  };

  const speakFrames = (
    piece: { text: string; highlight?: string },
    generation: number,
  ): Promise<void> =>
    enqueue(
      () =>
        dataFrame("speak", {
          text: piece.text,
          ...(piece.highlight === undefined
            ? {}
            : { highlight: piece.highlight }),
        }),
      () => generation === speechGeneration,
    );

  return {
    get closed() {
      return closed;
    },
    async speak(text, speakOptions = {}) {
      if (isStopped()) return;
      const generation = speechGeneration;
      const fragments = fragmentSpeech(text, {
        ...(speakOptions.highlight === undefined
          ? {}
          : { highlight: speakOptions.highlight }),
      });
      await Promise.all(
        fragments.map((fragment) => speakFrames(fragment, generation)),
      );
    },
    async appendHighlight(summary) {
      await enqueue(() =>
        dataFrame("append_highlight", {
          summary: bounded(summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
        }),
      );
    },
    async progress(event) {
      await enqueue(() =>
        dataFrame("progress", {
          jobId: event.jobId,
          stage: event.stage,
          ...(event.status === undefined ? {} : { status: event.status }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        }),
      );
    },
    async approval(event) {
      await enqueue(() =>
        dataFrame("approval", {
          approvalId: event.approvalId,
          jobShortId: event.jobShortId,
          jobRevision: event.jobRevision,
          summary: bounded(event.summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
        }),
      );
    },
    async terminal(event) {
      await enqueue(() =>
        dataFrame("terminal", {
          jobId: event.jobId,
          status: event.status,
          summary: bounded(event.summary, HIGHLIGHT_SUMMARY_MAX_CHARACTERS),
        }),
      );
    },
    async stopOutput() {
      speechGeneration += 1;
      await enqueue(() => dataFrame("stop_output", { reason: "stop_output" }));
    },
    async keepalive() {
      await enqueue(() => ": keep-alive\n\n");
    },
    async close() {
      closed = true;
      speechGeneration += 1;
      await tail.catch(() => undefined);
      endWriter();
    },
  };
};
