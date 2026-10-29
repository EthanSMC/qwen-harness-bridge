import {
  type AsrHypothesis,
  type AudioFrame,
  RtcProviderError,
  type StreamingAsr,
} from "./types.js";

export type AsrProviderEvent = Readonly<{
  kind: "partial" | "final";
  text: string;
  startedAtMs: number;
  endedAtMs: number;
  id?: string;
}>;

export type DashScopeAsrStream = Readonly<{
  send: (pcm16le: Uint8Array) => Promise<void>;
  finish: () => Promise<void>;
  abort: () => Promise<void>;
  events: AsyncIterable<AsrProviderEvent>;
}>;

export type DashScopeAsrClient = Readonly<{
  open: (options: {
    model: string;
    apiKey: string;
    signal: AbortSignal;
  }) => Promise<DashScopeAsrStream>;
}>;

export type DashScopeAsrOptions = Readonly<{
  client: DashScopeAsrClient;
  apiKey: string;
  model?: string;
  maxOpenAttempts?: number;
}>;

const DEFAULT_MODEL = "paraformer-realtime-v2";

/**
 * DashScope streaming ASR adapter. One provider stream per RTC session, frames
 * sent with backpressure, partial/final hypotheses forwarded with empty and
 * repeated finals collapsed, and an immediate provider abort on session close.
 * The server credential is never returned, logged or embedded in an error.
 */
export const createDashScopeAsr = (
  options: DashScopeAsrOptions,
): StreamingAsr => {
  const model = options.model ?? DEFAULT_MODEL;
  const maxOpenAttempts = options.maxOpenAttempts ?? 2;

  const openStream = async (
    signal: AbortSignal,
  ): Promise<DashScopeAsrStream> => {
    for (let attempt = 0; attempt < maxOpenAttempts; attempt += 1) {
      if (signal.aborted) throw new RtcProviderError("RTC_ASR_FAILED");
      try {
        return await options.client.open({
          model,
          apiKey: options.apiKey,
          signal,
        });
      } catch {
        // Retry once to absorb a transient connect failure.
      }
    }
    throw new RtcProviderError("RTC_ASR_FAILED");
  };

  return {
    async *recognize(
      frames: AsyncIterable<AudioFrame>,
      signal: AbortSignal,
    ): AsyncGenerator<AsrHypothesis> {
      if (signal.aborted) return;
      const stream = await openStream(signal);
      const pump = (async () => {
        try {
          for await (const frame of frames) {
            if (signal.aborted) break;
            await stream.send(frame.pcm16le);
          }
          if (!signal.aborted) await stream.finish();
        } catch {
          // Send/finish failures are bounded by the stream-close path below.
        }
      })();
      const seenFinalIds = new Set<string>();
      let lastFinalText = "";
      try {
        for await (const event of stream.events) {
          if (signal.aborted) break;
          if (event.kind === "final") {
            const text = event.text.trim();
            if (text === "") continue;
            if (event.id !== undefined) {
              if (seenFinalIds.has(event.id)) continue;
              seenFinalIds.add(event.id);
            } else if (text === lastFinalText) {
              continue;
            }
            lastFinalText = text;
            yield { ...event, text };
          } else {
            yield { ...event };
          }
          if (signal.aborted) break;
        }
        await pump;
      } finally {
        try {
          await stream.abort();
        } catch {
          // Provider abort is best effort; the session is already closing.
        }
      }
    },
  };
};
