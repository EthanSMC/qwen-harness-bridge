// Cordis plugin identity. The `apply(ctx)` composition is added once the
// integration seams recorded on Issue #13 are confirmed.
export const name = "qwen-harness-bridge";
export const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
  "approval",
] as const;

export * from "./config.js";
export {
  AgentAdapter,
  HarnessAgentAdapterImpl,
} from "./harness/agent-adapter.js";
export type { NormalizationOptions } from "./harness/event-normalizer.js";
export {
  MAX_SUMMARY_LENGTH,
  normalizeSessionEvent,
  normalizeTerminalEvent,
} from "./harness/event-normalizer.js";
export { registerSessionListener } from "./harness/register-session-listener.js";
export type {
  HarnessAdapterOptions,
  HarnessAgent,
  HarnessAgentAdapter,
  HarnessAgentRegistry,
  HarnessContext,
  HarnessMappingStore,
  HarnessSessionEventHandler,
  NormalizedHarnessEvent,
  OwnedSession,
} from "./harness/types.js";
export * from "./keychain.js";
export * from "./store/plugin-store.js";
