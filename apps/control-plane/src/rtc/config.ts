import { z } from "zod";
import { RTC_MEDIA, type RtcMedia } from "./wire/qwen-rtc-schema.js";

type Environment = Readonly<Record<string, string | undefined>>;

const enabledConfigSchema = z
  .object({
    ownerSubject: z.string().trim().min(1, "QHB_RTC_OWNER_SUBJECT is required"),
    signingSecret: z
      .string()
      .trim()
      .min(32, "QHB_RTC_SIGNING_SECRET must be at least 32 characters"),
    callbackUrl: z
      .string()
      .trim()
      .url("QHB_RTC_CALLBACK_URL must be an absolute URL")
      .refine(
        (value) => new URL(value).protocol === "https:",
        "QHB_RTC_CALLBACK_URL must use HTTPS",
      ),
    allowedMedia: z
      .array(z.enum(RTC_MEDIA))
      .min(1, "QHB_RTC_ALLOWED_MEDIA must list at least one media"),
    provider: z.literal("ALIYUN_RTC", {
      errorMap: () => ({
        message: "QHB_RTC_PROVIDER must be ALIYUN_RTC",
      }),
    }),
  })
  .strict();

/**
 * Server-side provider credentials. They are read from the environment and are
 * never returned to Qwen, logged, or embedded in an error or telemetry label.
 */
export type RtcProviderSettings = Readonly<{
  aliyunAppId: string;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  dashscopeApiKey: string;
  dashscopeAsrModel?: string;
}>;

export type RtcConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      ownerSubject: string;
      signingSecret: string;
      callbackUrl: string;
      allowedMedia: readonly RtcMedia[];
      provider: "ALIYUN_RTC";
      /** Present only when every provider credential is configured. */
      providers?: RtcProviderSettings;
    }>;

export type RtcRuntime = Readonly<{
  ownerSubject: string;
  signingSecret: string;
  callbackUrl: string;
  allowedMedia: readonly RtcMedia[];
  provider: "ALIYUN_RTC";
}>;

const parseMedia = (value: string | undefined): RtcMedia[] =>
  (value ?? "audio")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (!RTC_MEDIA.includes(entry as RtcMedia)) {
        throw new Error("QHB_RTC_ALLOWED_MEDIA contains an unsupported media");
      }
      return entry as RtcMedia;
    });

const optional = (
  environment: Environment,
  name: string,
): string | undefined => {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Provider credentials are optional as a group: a deployment either configures
 * all of them (real provider composition) or none (bounded, disabled module).
 */
const loadProviderSettings = (
  environment: Environment,
): RtcProviderSettings | undefined => {
  const aliyunAppId = optional(environment, "QHB_RTC_ALIYUN_APP_ID");
  const aliyunAccessKeyId = optional(
    environment,
    "QHB_RTC_ALIYUN_ACCESS_KEY_ID",
  );
  const aliyunAccessKeySecret = optional(
    environment,
    "QHB_RTC_ALIYUN_ACCESS_KEY_SECRET",
  );
  const dashscopeApiKey = optional(environment, "QHB_RTC_DASHSCOPE_API_KEY");
  if (
    aliyunAppId === undefined ||
    aliyunAccessKeyId === undefined ||
    aliyunAccessKeySecret === undefined ||
    dashscopeApiKey === undefined
  ) {
    return undefined;
  }
  const dashscopeAsrModel = optional(
    environment,
    "QHB_RTC_DASHSCOPE_ASR_MODEL",
  );
  return {
    aliyunAppId,
    aliyunAccessKeyId,
    aliyunAccessKeySecret,
    dashscopeApiKey,
    ...(dashscopeAsrModel === undefined ? {} : { dashscopeAsrModel }),
  };
};

export const loadRtcConfig = (environment: Environment): RtcConfig => {
  if (environment.QHB_RTC_ENABLED !== "true") {
    return { enabled: false };
  }
  const parsed = enabledConfigSchema.safeParse({
    ownerSubject: environment.QHB_RTC_OWNER_SUBJECT,
    signingSecret: environment.QHB_RTC_SIGNING_SECRET,
    callbackUrl: environment.QHB_RTC_CALLBACK_URL,
    allowedMedia: parseMedia(environment.QHB_RTC_ALLOWED_MEDIA),
    provider: environment.QHB_RTC_PROVIDER,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`QHB_RTC_ configuration is invalid: ${details}`);
  }
  const providers = loadProviderSettings(environment);
  return {
    enabled: true,
    ownerSubject: parsed.data.ownerSubject,
    signingSecret: parsed.data.signingSecret,
    callbackUrl: parsed.data.callbackUrl,
    allowedMedia: parsed.data.allowedMedia,
    provider: parsed.data.provider,
    ...(providers === undefined ? {} : { providers }),
  };
};

export const createRtcRuntime = (config: RtcConfig): RtcRuntime | null =>
  config.enabled
    ? {
        ownerSubject: config.ownerSubject,
        signingSecret: config.signingSecret,
        callbackUrl: config.callbackUrl,
        allowedMedia: config.allowedMedia,
        provider: config.provider,
      }
    : null;
