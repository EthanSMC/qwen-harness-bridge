import {
  type AudioFrame,
  RtcAudioError,
  type RtcAudioInputFrame,
} from "./types.js";

/** Maximum normalized frame duration handed to the ASR provider. */
export const RTC_AUDIO_MAX_FRAME_MS = 200;
export const RTC_AUDIO_SAMPLE_RATE_HZ = 16_000;
export const RTC_AUDIO_CHANNELS = 1;
export const RTC_AUDIO_MAX_FRAME_BYTES = 6_400;
export const RTC_AUDIO_MAX_BUFFER_MS = 2_000;
const MAX_BUFFER_SAMPLES =
  (RTC_AUDIO_MAX_BUFFER_MS / 1_000) * RTC_AUDIO_SAMPLE_RATE_HZ;
const FRAME_SAMPLES =
  (RTC_AUDIO_MAX_FRAME_MS / 1_000) * RTC_AUDIO_SAMPLE_RATE_HZ;
const SUPPORTED_SAMPLE_RATES = new Set([16_000, 44_100, 48_000]);
const SUPPORTED_CHANNELS = new Set([1, 2]);
/** One missing sequence number is still inside the SDK recovery window. */
const RECOVERY_WINDOW_FRAMES = 1;

export { RtcAudioError };

const readSamples = (pcm16le: Uint8Array): Int16Array => {
  const samples = new Int16Array(pcm16le.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const low = pcm16le[index * 2] ?? 0;
    const high = pcm16le[index * 2 + 1] ?? 0;
    const value = (high << 8) | low;
    samples[index] = value > 32_767 ? value - 65_536 : value;
  }
  return samples;
};

const writeSamples = (samples: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    const value = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >> 8) & 0xff;
  });
  return bytes;
};

const downmix = (samples: Int16Array, channels: number): number[] => {
  if (channels === 1) return [...samples];
  const mono: number[] = [];
  for (let index = 0; index + 1 < samples.length; index += 2) {
    mono.push(((samples[index] ?? 0) + (samples[index + 1] ?? 0)) / 2);
  }
  return mono;
};

const resample = (samples: readonly number[], sourceRate: number): number[] => {
  if (sourceRate === RTC_AUDIO_SAMPLE_RATE_HZ) return [...samples];
  const outputLength = Math.round(
    (samples.length * RTC_AUDIO_SAMPLE_RATE_HZ) / sourceRate,
  );
  const output: number[] = [];
  for (let index = 0; index < outputLength; index += 1) {
    const position = (index * sourceRate) / RTC_AUDIO_SAMPLE_RATE_HZ;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, samples.length - 1);
    const weight = position - lower;
    output.push(
      (samples[lower] ?? 0) * (1 - weight) + (samples[upper] ?? 0) * weight,
    );
  }
  return output;
};

/**
 * Normalizes documented RTC audio formats to 16 kHz mono PCM16LE and emits
 * bounded 200 ms frames with a monotonic output sequence. Only format metadata
 * and counters are surfaced; audio bytes are never logged, emitted or stored.
 */
export class AudioNormalizer {
  private readonly pending: number[] = [];
  private outputSequence = 0;
  private lastInputSequence: number | undefined;

  push(input: RtcAudioInputFrame): AudioFrame[] {
    if (
      !(input.pcm16le instanceof Uint8Array) ||
      input.pcm16le.length === 0 ||
      input.pcm16le.length % 2 !== 0 ||
      !SUPPORTED_SAMPLE_RATES.has(input.sampleRateHz) ||
      !SUPPORTED_CHANNELS.has(input.channels)
    ) {
      throw new RtcAudioError("RTC_AUDIO_FORMAT_UNSUPPORTED");
    }
    const sequence = input.sequence;
    if (
      sequence === undefined ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      throw new RtcAudioError("RTC_AUDIO_SEQUENCE_INVALID");
    }
    if (this.lastInputSequence !== undefined) {
      if (sequence <= this.lastInputSequence) return [];
      if (sequence - this.lastInputSequence - 1 > RECOVERY_WINDOW_FRAMES) {
        throw new RtcAudioError("RTC_AUDIO_GAP");
      }
    }
    this.lastInputSequence = sequence;

    const mono = downmix(readSamples(input.pcm16le), input.channels);
    const normalized = resample(mono, input.sampleRateHz);
    if (normalized.length > MAX_BUFFER_SAMPLES) {
      throw new RtcAudioError("RTC_AUDIO_BUFFER_OVERFLOW");
    }
    this.pending.push(...normalized);
    return this.drain();
  }

  flush(): AudioFrame[] {
    return this.drain(true);
  }

  private drain(final = false): AudioFrame[] {
    const frames: AudioFrame[] = [];
    while (
      this.pending.length >= FRAME_SAMPLES ||
      (final && this.pending.length > 0)
    ) {
      const take = Math.min(FRAME_SAMPLES, this.pending.length);
      const chunk = this.pending.splice(0, take);
      frames.push({
        pcm16le: writeSamples(chunk),
        sampleRateHz: RTC_AUDIO_SAMPLE_RATE_HZ,
        channels: RTC_AUDIO_CHANNELS,
        sequence: this.outputSequence,
      });
      this.outputSequence += 1;
      if (final) break;
    }
    return frames;
  }
}
