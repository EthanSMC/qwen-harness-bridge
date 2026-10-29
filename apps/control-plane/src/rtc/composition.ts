import type { RtcConfig, RtcProviderSettings } from "./config.js";
import { createSerializedSseOutput } from "./output/serialized-sse-writer.js";
import type { RtcOutputKind, RtcProviderComposition } from "./plugin.js";
import {
  type AliyunRtcClient,
  createAliyunRtcConsumer,
} from "./providers/aliyun-rtc-consumer.js";
import {
  createDashScopeAsr,
  type DashScopeAsrClient,
} from "./providers/dashscope-asr.js";
import type {
  AudioFrame,
  RtcConsumer,
  StreamingAsr,
} from "./providers/types.js";
import type { RtcSseWriter } from "./session/rtc-session.js";

/**
 * Provider transport seam. The Aliyun RTC SDK and DashScope streaming client
 * are not bundled with the Control Plane, so a deployment injects the real
 * clients here when they are available. Without them RTC stays disabled rather
 * than mounting routes that cannot serve a session.
 */
export type RtcProviderClients = Readonly<{
  consumer: (settings: RtcProviderSettings) => AliyunRtcClient;
  asr: (settings: RtcProviderSettings) => DashScopeAsrClient;
}>;

export type RtcCompositionUnavailableReason =
  | "disabled"
  | "credentials_missing"
  | "provider_unavailable";

export type RtcProviderCompositionResult =
  | Readonly<{
      available: true;
      composition: RtcProviderComposition;
      settings: RtcProviderSettings;
    }>
  | Readonly<{ available: false; reason: RtcCompositionUnavailableReason }>;

type ComposedSession = {
  readonly controller: AbortController;
  consumer?: RtcConsumer;
  frames?: AsyncIterable<AudioFrame>;
  asr?: StreamingAsr;
  pipeline?: Promise<void>;
};

/**
 * Builds the real per-session provider composition from server configuration.
 * Availability is decided once at startup: a disabled module, missing provider
 * credentials, or a deployment without bundled provider clients yields a
 * bounded reason and mounts nothing; it never throws.
 */
export const createRtcProviderComposition = (options: {
  config: RtcConfig;
  clients?: RtcProviderClients;
}): RtcProviderCompositionResult => {
  if (!options.config.enabled) return { available: false, reason: "disabled" };
  const settings = options.config.providers;
  if (settings === undefined) {
    return { available: false, reason: "credentials_missing" };
  }
  const clients = options.clients;
  if (clients === undefined) {
    return { available: false, reason: "provider_unavailable" };
  }

  const sessions = new Map<string, ComposedSession>();

  const stateFor = (sessionId: string): ComposedSession => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: ComposedSession = { controller: new AbortController() };
    sessions.set(sessionId, created);
    return created;
  };

  /**
   * Frames and ASR arrive through separate factories; the audio is forwarded to
   * the ASR stream only once both are constructed. Final hypotheses are reported
   * through the injected onFinal callback and their text is never retained.
   */
  const startPipeline = (sessionId: string): void => {
    const state = sessions.get(sessionId);
    if (state === undefined) return;
    const { frames, asr } = state;
    if (frames === undefined || asr === undefined) return;
    if (state.pipeline !== undefined) return;
    const signal = state.controller.signal;
    state.pipeline = (async () => {
      try {
        for await (const hypothesis of asr.recognize(frames, signal)) {
          // Partial/final text is not persisted; onFinal already recorded the
          // bounded first-final telemetry for this session.
          if (hypothesis.kind === "partial") continue;
        }
      } catch {
        // The ASR adapter reported failure through onFailure; the plugin maps
        // it to bounded degraded telemetry and keeps stable paths healthy.
      }
    })();
  };

  const composition: RtcProviderComposition = {
    consumer: async (sessionId, input, callbacks) => {
      const state = stateFor(sessionId);
      const consumer = createAliyunRtcConsumer({
        client: clients.consumer(settings),
        onFirstFrame: () => callbacks.onFirstAudio(),
        onDisconnect: (reason: "stream_closed" | "stream_error") => {
          if (reason === "stream_error") state.controller.abort();
        },
      });
      state.consumer = consumer;
      state.frames = await consumer.join(input.start, state.controller.signal);
      startPipeline(sessionId);
      return {
        close: async () => {
          state.controller.abort();
          await consumer.leave();
        },
      };
    },
    asr: (sessionId, _input, callbacks) => {
      const state = stateFor(sessionId);
      state.asr = createDashScopeAsr({
        client: clients.asr(settings),
        apiKey: settings.dashscopeApiKey,
        ...(settings.dashscopeAsrModel === undefined
          ? {}
          : { model: settings.dashscopeAsrModel }),
        onFinal: () => callbacks.onFinal(),
        onFailure: () => callbacks.onFailure(),
      });
      startPipeline(sessionId);
      return undefined;
    },
    output: (_sessionId, writer: RtcSseWriter, _input, callbacks) => {
      const output = createSerializedSseOutput({
        writer,
        onFirstOutput: (kind: string) =>
          callbacks.onFirstOutput(kind as RtcOutputKind),
      });
      return { close: () => output.close() };
    },
  };

  return { available: true, composition, settings };
};
