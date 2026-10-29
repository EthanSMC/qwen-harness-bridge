import type { RtcConfig } from "./config.js";
import type { RtcMedia } from "./wire/qwen-rtc-schema.js";

/**
 * The experimental RTC module is created only when the owner enables it. A
 * disabled deployment keeps zero provider clients and mounts zero RTC routes,
 * so the stable MCP path never depends on RTC availability.
 */
export type RtcModule = Readonly<{
  ownerSubject: string;
  signingSecret: string;
  callbackUrl: string;
  allowedMedia: readonly RtcMedia[];
  provider: "ALIYUN_RTC";
}>;

export const createRtcModule = (config: RtcConfig): RtcModule | null =>
  config.enabled
    ? {
        ownerSubject: config.ownerSubject,
        signingSecret: config.signingSecret,
        callbackUrl: config.callbackUrl,
        allowedMedia: config.allowedMedia,
        provider: config.provider,
      }
    : null;
