import { describe, expect, it } from "vitest";
import {
  AudioNormalizer,
  RTC_AUDIO_MAX_FRAME_BYTES,
  RTC_AUDIO_MAX_FRAME_MS,
  RtcAudioError,
} from "./audio-normalizer.js";
import type { RtcAudioInputFrame } from "./types.js";

const pcm16 = (samples: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    const value = Math.max(-32768, Math.min(32767, Math.round(sample)));
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >> 8) & 0xff;
  });
  return bytes;
};

const frame = (
  samples: readonly number[],
  overrides: Partial<RtcAudioInputFrame> = {},
): RtcAudioInputFrame => ({
  pcm16le: pcm16(samples),
  sampleRateHz: 16_000,
  channels: 1,
  sequence: 0,
  ...overrides,
});

const tones = (count: number, sampleRateHz: number): number[] =>
  Array.from({ length: count }, (_, index) =>
    Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / sampleRateHz)),
  );

const expectCode = (action: () => unknown, code: string): void => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RtcAudioError);
    expect((error as RtcAudioError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("audio normalizer format support", () => {
  it("passes 16 kHz mono PCM16LE through unchanged", () => {
    const normalizer = new AudioNormalizer();
    const input = frame(tones(3_200, 16_000), { sequence: 0 });
    const output = normalizer.push(input);

    expect(output).toHaveLength(1);
    expect(output[0]?.pcm16le).toEqual(input.pcm16le);
    expect(output[0]?.sampleRateHz).toBe(16_000);
    expect(output[0]?.channels).toBe(1);
    expect(output[0]?.sequence).toBe(0);
    expect(output[0]?.pcm16le.length).toBeLessThanOrEqual(
      RTC_AUDIO_MAX_FRAME_BYTES,
    );
  });

  it("downmixes 48 kHz stereo to 16 kHz mono PCM16LE", () => {
    const normalizer = new AudioNormalizer();
    const interleaved = tones(9_600, 48_000).flatMap((sample) => [
      sample,
      sample,
    ]);
    const output = normalizer.push(
      frame(interleaved, { sampleRateHz: 48_000, channels: 2 }),
    );

    expect(output.length).toBeGreaterThan(0);
    for (const normalized of output) {
      expect(normalized.sampleRateHz).toBe(16_000);
      expect(normalized.channels).toBe(1);
      expect(normalized.pcm16le.length % 2).toBe(0);
      expect(normalized.pcm16le.length).toBeLessThanOrEqual(
        RTC_AUDIO_MAX_FRAME_BYTES,
      );
    }
  });

  it("resamples 44.1 kHz mono to 16 kHz and bounds every frame", () => {
    const normalizer = new AudioNormalizer();
    const output = normalizer.push(
      frame(tones(8_820, 44_100), { sampleRateHz: 44_100 }),
    );

    expect(output.length).toBeGreaterThan(0);
    for (const normalized of output) {
      const durationMs = (normalized.pcm16le.length / 2 / 16_000) * 1_000;
      expect(durationMs).toBeLessThanOrEqual(RTC_AUDIO_MAX_FRAME_MS);
    }
  });

  it("rejects an undocumented sample rate or channel count", () => {
    const normalizer = new AudioNormalizer();
    expectCode(
      () => normalizer.push(frame(tones(160, 8_000), { sampleRateHz: 8_000 })),
      "RTC_AUDIO_FORMAT_UNSUPPORTED",
    );
    expectCode(
      () => normalizer.push(frame(tones(480, 16_000), { channels: 3 })),
      "RTC_AUDIO_FORMAT_UNSUPPORTED",
    );
  });

  it("splits an oversized supported frame into bounded frames", () => {
    const normalizer = new AudioNormalizer();
    const output = normalizer.push(frame(tones(16_000, 16_000)));

    expect(output).toHaveLength(5);
    expect(output.every((item) => item.pcm16le.length <= 6400)).toBe(true);
    expect(output.map((item) => item.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("fails closed when one pushed frame would exceed the two second buffer", () => {
    const normalizer = new AudioNormalizer();
    expectCode(
      () => normalizer.push(frame(tones(48_000, 16_000))),
      "RTC_AUDIO_BUFFER_OVERFLOW",
    );
  });

  it("passes silence through without dropping it", () => {
    const normalizer = new AudioNormalizer();
    const output = normalizer.push(frame(new Array(3_200).fill(0)));
    expect(output).toHaveLength(1);
    expect([...(output[0]?.pcm16le ?? [])]).toEqual(new Array(6_400).fill(0));
  });
});

describe("audio normalizer sequencing", () => {
  it("drops duplicate and stale frames but accepts a one-frame gap", () => {
    const normalizer = new AudioNormalizer();
    expect(
      normalizer.push(frame(tones(3_200, 16_000), { sequence: 0 })),
    ).toHaveLength(1);
    expect(
      normalizer.push(frame(tones(3_200, 16_000), { sequence: 0 })),
    ).toHaveLength(0);
    expect(
      normalizer.push(frame(tones(3_200, 16_000), { sequence: 1 })),
    ).toHaveLength(1);
    expect(
      normalizer.push(frame(tones(3_200, 16_000), { sequence: 3 })),
    ).toHaveLength(1);
  });

  it("closes with RTC_AUDIO_GAP when the gap exceeds the recovery window", () => {
    const normalizer = new AudioNormalizer();
    normalizer.push(frame(tones(3_200, 16_000), { sequence: 0 }));
    normalizer.push(frame(tones(3_200, 16_000), { sequence: 1 }));
    expectCode(
      () => normalizer.push(frame(tones(3_200, 16_000), { sequence: 4 })),
      "RTC_AUDIO_GAP",
    );
  });

  it("rejects a frame without a valid sequence number", () => {
    const normalizer = new AudioNormalizer();
    expectCode(
      () =>
        normalizer.push({
          ...frame(tones(3_200, 16_000)),
          sequence: undefined as never,
        }),
      "RTC_AUDIO_SEQUENCE_INVALID",
    );
    expectCode(
      () => normalizer.push(frame(tones(3_200, 16_000), { sequence: -1 })),
      "RTC_AUDIO_SEQUENCE_INVALID",
    );
  });

  it("emits a monotonic output sequence across push and flush", () => {
    const normalizer = new AudioNormalizer();
    const sequences: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      sequences.push(
        ...normalizer
          .push(frame(tones(1_600, 16_000), { sequence: index }))
          .map((item) => item.sequence),
      );
    }
    sequences.push(...normalizer.flush().map((item) => item.sequence));

    expect(sequences.length).toBeGreaterThan(1);
    expect(sequences).toEqual(
      [...sequences].sort((left, right) => left - right),
    );
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});
