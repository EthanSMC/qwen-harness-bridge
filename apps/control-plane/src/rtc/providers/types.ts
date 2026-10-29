import type { RtcProviderResources } from "../session/rtc-session.js";
import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";

/** Normalized audio handed to the ASR provider; 16 kHz, mono, PCM16LE. */
export type AudioFrame = Readonly<{
  pcm16le: Uint8Array;
  sampleRateHz: 16_000;
  channels: 1;
  sequence: number;
}>;

/** Audio as delivered by the selected RTC SDK before normalization. */
export type RtcAudioInputFrame = Readonly<{
  pcm16le: Uint8Array;
  sampleRateHz: number;
  channels: number;
  sequence?: number;
}>;

export type RtcConsumer = Readonly<{
  join: (
    input: NormalizedRtcStart,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<AudioFrame>>;
  leave: () => Promise<void>;
}>;

export type AsrHypothesis = Readonly<{
  kind: "partial" | "final";
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Provider hypothesis id used to collapse repeated finals. */
  id?: string;
}>;

export type StreamingAsr = Readonly<{
  recognize: (
    frames: AsyncIterable<AudioFrame>,
    signal: AbortSignal,
  ) => AsyncIterable<AsrHypothesis>;
}>;

export type RtcProviderErrorCode =
  | "RTC_TOKEN_EXPIRED"
  | "RTC_PUBLISHER_REJECTED"
  | "RTC_CONSUMER_FAILED"
  | "RTC_ASR_FAILED";

/** Bounded provider error; messages never carry tokens or audio bytes. */
export class RtcProviderError extends Error {
  readonly code: RtcProviderErrorCode;

  constructor(code: RtcProviderErrorCode) {
    super(code);
    this.name = "RtcProviderError";
    this.code = code;
  }
}

export type RtcAudioErrorCode =
  | "RTC_AUDIO_FORMAT_UNSUPPORTED"
  | "RTC_AUDIO_SEQUENCE_INVALID"
  | "RTC_AUDIO_GAP"
  | "RTC_AUDIO_BUFFER_OVERFLOW";

/** Bounded audio error; never includes frame bytes. */
export class RtcAudioError extends Error {
  readonly code: RtcAudioErrorCode;

  constructor(code: RtcAudioErrorCode) {
    super(code);
    this.name = "RtcAudioError";
    this.code = code;
  }
}

/**
 * Maps provider shutdown onto the Task 2 session resource contract. Both
 * operations are idempotent and must be safe after a session close.
 */
export const createProviderResources = (options: {
  consumer: RtcConsumer;
  asr: Readonly<{ abort: () => Promise<void> }>;
}): RtcProviderResources => {
  let stopOutput: Promise<void> | undefined;
  let closeProviderStreams: Promise<void> | undefined;
  return {
    stopOutput: () => {
      stopOutput ??= options.asr.abort();
      return stopOutput;
    },
    closeProviderStreams: () => {
      closeProviderStreams ??= options.consumer.leave();
      return closeProviderStreams;
    },
  };
};
