const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const JITTER_RATIO = 0.2;

export const reconnectDelayMs = (
  attempt: number,
  random = Math.random(),
): number => {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("CONNECTOR_BACKOFF_ATTEMPT_INVALID");
  }
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new Error("CONNECTOR_BACKOFF_RANDOM_INVALID");
  }
  const base =
    BACKOFF_DELAYS_MS[Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)] ??
    30_000;
  const jitter = (random * 2 - 1) * JITTER_RATIO;
  return Math.round(base * (1 + jitter));
};

export const CONNECTOR_BACKOFF_DELAYS_MS = BACKOFF_DELAYS_MS;
