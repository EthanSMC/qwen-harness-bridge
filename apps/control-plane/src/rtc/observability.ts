export const RTC_TELEMETRY_START_OUTCOMES = [
  "started",
  "rejected",
  "failed",
] as const;

export const RTC_TELEMETRY_COMMAND_TYPES = [
  "speak",
  "stop_output",
  "approval",
  "terminal",
  "progress",
  "keepalive",
  "append_highlight",
] as const;

export const RTC_TELEMETRY_CLOSE_REASONS = [
  "platform_close",
  "user_exit",
  "inactive",
  "token_expired",
  "provider_error",
  "server_shutdown",
  "provider_disconnect",
  "sse_disconnect",
] as const;

export const RTC_TELEMETRY_REJECT_REASONS = [
  "registry_full",
  "concurrency_limit",
  "circuit_open",
] as const;

const DURATION_BUCKETS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000] as const;

export type RtcTelemetrySnapshot = Readonly<{
  enabled: boolean;
  active_sessions: number;
  starts: Readonly<Record<string, number>>;
  rejects: Readonly<Record<string, number>>;
  disconnects: Readonly<Record<string, number>>;
  output_commands: Readonly<Record<string, number>>;
  first_audio_bucket_ms: Readonly<Record<string, number>>;
  first_asr_final_bucket_ms: Readonly<Record<string, number>>;
  first_output_bucket_ms: Readonly<Record<string, number>>;
  asr_failures: number;
}>;

const zeroed = (values: readonly string[]): Record<string, number> =>
  Object.fromEntries(values.map((value) => [value, 0]));

const bucketLabel = (ms: number): string => {
  for (const bucket of DURATION_BUCKETS_MS) {
    if (ms <= bucket) return String(bucket);
  }
  return "over";
};

const bucketCounts = (): Record<string, number> => ({
  ...Object.fromEntries(
    DURATION_BUCKETS_MS.map((bucket) => [String(bucket), 0]),
  ),
  over: 0,
});

/**
 * Bounded RTC telemetry. Label values come only from fixed allowlists and
 * duration buckets; audio, transcripts, tokens, room ids, user ids and output
 * text are never recorded.
 */
export class RtcTelemetry {
  #enabled = false;
  #active = 0;
  #asrFailures = 0;
  readonly #starts = zeroed(RTC_TELEMETRY_START_OUTCOMES);
  readonly #rejects = zeroed(RTC_TELEMETRY_REJECT_REASONS);
  readonly #disconnects = zeroed(RTC_TELEMETRY_CLOSE_REASONS);
  readonly #commands = zeroed(RTC_TELEMETRY_COMMAND_TYPES);
  readonly #firstAudio = bucketCounts();
  readonly #firstAsrFinal = bucketCounts();
  readonly #firstOutput = bucketCounts();

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  start(outcome: (typeof RTC_TELEMETRY_START_OUTCOMES)[number]): void {
    this.#starts[outcome] += 1;
    if (outcome === "started") this.#active += 1;
  }

  reject(reason: (typeof RTC_TELEMETRY_REJECT_REASONS)[number]): void {
    this.#rejects[reason] += 1;
    this.#starts.rejected += 1;
  }

  endSession(): void {
    this.#active = Math.max(0, this.#active - 1);
  }

  disconnect(reason: (typeof RTC_TELEMETRY_CLOSE_REASONS)[number]): void {
    this.#disconnects[reason] += 1;
  }

  resetActive(): void {
    this.#active = 0;
  }

  firstAudio(ms: number): void {
    this.#firstAudio[bucketLabel(ms)] += 1;
  }

  firstAsrFinal(ms: number): void {
    this.#firstAsrFinal[bucketLabel(ms)] += 1;
  }

  firstOutput(ms: number): void {
    this.#firstOutput[bucketLabel(ms)] += 1;
  }

  outputCommand(kind: (typeof RTC_TELEMETRY_COMMAND_TYPES)[number]): void {
    this.#commands[kind] += 1;
  }

  asrFailure(): void {
    this.#asrFailures += 1;
  }

  snapshot(): RtcTelemetrySnapshot {
    return {
      enabled: this.#enabled,
      active_sessions: this.#active,
      starts: { ...this.#starts },
      rejects: { ...this.#rejects },
      disconnects: { ...this.#disconnects },
      output_commands: { ...this.#commands },
      first_audio_bucket_ms: { ...this.#firstAudio },
      first_asr_final_bucket_ms: { ...this.#firstAsrFinal },
      first_output_bucket_ms: { ...this.#firstOutput },
      asr_failures: this.#asrFailures,
    };
  }
}
