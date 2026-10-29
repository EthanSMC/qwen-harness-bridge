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
  /** Real call sites for Task 6 bounded telemetry. */
  onFinal?: () => void;
  onFailure?: () => void;
}>;

const DEFAULT_MODEL = "paraformer-realtime-v2";
const MAX_TRACKED_FINAL_IDS = 256;

const abortableNext = <T>(
  iterator: AsyncIterator<T>,
  signals: readonly AbortSignal[],
): Promise<IteratorResult<T>> =>
  new Promise((resolve, reject) => {
    const aborted = (): boolean => signals.some((signal) => signal.aborted);
    if (aborted()) {
      resolve({ done: true, value: undefined });
      return;
    }
    const cleanup = (): void => {
      for (const signal of signals)
        signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      void iterator.return?.().catch(() => undefined);
      resolve({ done: true, value: undefined });
    };
    for (const signal of signals)
      signal.addEventListener("abort", onAbort, {
        once: true,
      });
    iterator.next().then(
      (result) => {
        cleanup();
        if (aborted()) resolve({ done: true, value: undefined });
        else resolve(result);
      },
      (error: unknown) => {
        cleanup();
        if (aborted()) resolve({ done: true, value: undefined });
        else reject(error);
      },
    );
  });

/**
 * DashScope streaming ASR adapter. One provider stream per RTC session, frames
 * sent with backpressure, partial/final hypotheses forwarded with empty and
 * repeated finals collapsed, and an immediate provider abort on session close
 * even when the provider has not produced another event. Send/finish/event
 * failures fail closed with a bounded RTC_ASR_FAILED; the server credential is
 * never returned, logged or embedded in an error.
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
      let stream: DashScopeAsrStream;
      try {
        stream = await openStream(signal);
      } catch (error) {
        options.onFailure?.();
        throw error;
      }
      const failure = new AbortController();
      let pumpFailure: unknown;
      const pump = (async () => {
        try {
          for await (const frame of frames) {
            if (signal.aborted || failure.signal.aborted) break;
            await stream.send(frame.pcm16le);
          }
          if (!signal.aborted && !failure.signal.aborted) {
            await stream.finish();
          }
        } catch (error) {
          pumpFailure = error;
          failure.abort();
        }
      })();
      const seenFinalIds = new Set<string>();
      let lastFinalText = "";
      const rememberFinalId = (id: string): void => {
        if (seenFinalIds.size >= MAX_TRACKED_FINAL_IDS) {
          const oldest = seenFinalIds.values().next().value;
          if (oldest !== undefined) seenFinalIds.delete(oldest);
        }
        seenFinalIds.add(id);
      };
      try {
        const events = stream.events[Symbol.asyncIterator]();
        for (;;) {
          const result = await abortableNext(events, [signal, failure.signal]);
          if (result.done) break;
          if (signal.aborted || failure.signal.aborted) break;
          const event = result.value;
          if (event.kind === "final") {
            const text = event.text.trim();
            if (text === "") continue;
            if (event.id !== undefined) {
              if (seenFinalIds.has(event.id)) continue;
              rememberFinalId(event.id);
            } else if (text === lastFinalText) {
              continue;
            }
            lastFinalText = text;
            options.onFinal?.();
            yield { ...event, text };
          } else {
            yield { ...event };
          }
          if (signal.aborted || failure.signal.aborted) break;
        }
        if (signal.aborted) return;
        await pump;
        if (pumpFailure !== undefined) {
          throw new RtcProviderError("RTC_ASR_FAILED");
        }
      } catch (error) {
        if (error instanceof RtcProviderError) {
          options.onFailure?.();
          throw error;
        }
        options.onFailure?.();
        throw new RtcProviderError("RTC_ASR_FAILED");
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
