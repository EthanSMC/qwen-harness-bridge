import type { NormalizedRtcStart } from "../wire/qwen-rtc-schema.js";
import { AudioNormalizer } from "./audio-normalizer.js";
import {
  type AudioFrame,
  RtcAudioError,
  type RtcAudioInputFrame,
  type RtcConsumer,
  RtcProviderError,
} from "./types.js";

export type AliyunRtcJoinRequest = Readonly<{
  channelId: string;
  userId: string;
  token: string;
  expiresAt: string;
}>;

export type AliyunRtcSubscription = Readonly<{
  publisherUserId: string;
  frames: AsyncIterable<RtcAudioInputFrame>;
  close: () => Promise<void>;
}>;

export type AliyunRtcClient = Readonly<{
  join: (request: AliyunRtcJoinRequest) => Promise<AliyunRtcSubscription>;
}>;

export type AliyunRtcConsumerOptions = Readonly<{
  client: AliyunRtcClient;
  now?: () => number;
  onFirstFrame?: (frame: AudioFrame) => void;
  onDisconnect?: (reason: "stream_closed" | "stream_error") => void;
}>;

const nextWithAbort = <T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ done: true, value: undefined });
      return;
    }
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      void iterator.return?.().catch(() => undefined);
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        cleanup();
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
          return;
        }
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        if (signal.aborted) resolve({ done: true, value: undefined });
        else reject(error);
      },
    );
  });

/**
 * Aliyun RTC consumer adapter. Joins with the session's short-lived token,
 * subscribes only to the owner audio track, rejects any other publisher, and
 * exposes bounded first-frame/disconnect telemetry. Frame bytes and the provider
 * token never appear in an error, event or log.
 */
export const createAliyunRtcConsumer = (
  options: AliyunRtcConsumerOptions,
): RtcConsumer => {
  const now = options.now ?? (() => Date.now());
  let subscription: AliyunRtcSubscription | undefined;
  let closePromise: Promise<void> | undefined;

  const closeSubscription = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      try {
        await subscription?.close();
      } catch {
        // A provider close failure is already bounded by the session lifecycle.
      }
    })();
    return closePromise;
  };

  const leave = (): Promise<void> => closeSubscription();

  return {
    async join(input: NormalizedRtcStart, signal: AbortSignal) {
      const expiresAt = Date.parse(input.rtcTokenExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        throw new RtcProviderError("RTC_TOKEN_EXPIRED");
      }
      if (signal.aborted) throw new RtcProviderError("RTC_CONSUMER_FAILED");

      let joined: AliyunRtcSubscription;
      try {
        joined = await options.client.join({
          channelId: input.roomId,
          userId: input.rtcUserId,
          token: input.rtcToken,
          expiresAt: input.rtcTokenExpiresAt,
        });
      } catch {
        throw new RtcProviderError("RTC_CONSUMER_FAILED");
      }
      subscription = joined;
      if (joined.publisherUserId !== input.rtcUserId) {
        await closeSubscription();
        throw new RtcProviderError("RTC_PUBLISHER_REJECTED");
      }

      return (async function* stream(): AsyncGenerator<AudioFrame> {
        const normalizer = new AudioNormalizer();
        const iterator = joined.frames[Symbol.asyncIterator]();
        let completed = false;
        let firstFrameSent = false;
        try {
          for (;;) {
            const result = await nextWithAbort(iterator, signal);
            if (result.done) {
              completed = !signal.aborted;
              break;
            }
            const normalized = normalizer.push(result.value);
            for (const frame of normalized) {
              if (signal.aborted) return;
              if (!firstFrameSent) {
                firstFrameSent = true;
                options.onFirstFrame?.(frame);
              }
              yield frame;
            }
          }
        } catch (error) {
          if (error instanceof RtcAudioError) {
            if (!signal.aborted) options.onDisconnect?.("stream_error");
            throw error;
          }
          if (!signal.aborted) {
            options.onDisconnect?.("stream_error");
            throw new RtcProviderError("RTC_CONSUMER_FAILED");
          }
          return;
        } finally {
          await closeSubscription();
          if (completed) options.onDisconnect?.("stream_closed");
        }
      })();
    },
    leave,
  };
};
