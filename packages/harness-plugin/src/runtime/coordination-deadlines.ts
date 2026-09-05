import {
  type JobStatePayload,
  JobStatePayloadSchema,
  rfc3339InstantKey,
} from "@qhb/protocol";

export type CoordinationClockSample = Readonly<{
  wallTimeMs: number;
  monotonicTimeMs: number;
}>;

const exact = Symbol("coordination timing arithmetic");
export type CoordinationTiming = Readonly<{
  sent: CoordinationClockSample;
  received: CoordinationClockSample;
  snapshotDeadlineMonotonicMs: number;
  jobDeadlineMonotonicMs: number;
  leaseDeadlineMonotonicMs: number | null;
  [exact]: Readonly<{
    scale: bigint;
    remoteJobExpiry: bigint;
    jobEndpoint: bigint;
  }>;
}>;

const finite = (sample: CoordinationClockSample): boolean =>
  Number.isFinite(sample.wallTimeMs) && Number.isFinite(sample.monotonicTimeMs);
const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// Every finite binary64 is an integer multiple of 2^-1074. A decimal
// scale with at least 1074 digits represents it exactly, including subnormals.
// No decimal rendering of Number (which can round) participates in arithmetic.
function clockUnits(value: number, scale: bigint): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction + (1n << 52n);
  const shift = exponent === 0 ? -1074 : exponent - 1075;
  const magnitude =
    shift < 0
      ? (mantissa * scale) / (1n << BigInt(-shift))
      : (mantissa * scale) << BigInt(shift);
  return bits >> 63n ? -magnitude : magnitude;
}

function instantUnits(key: string, digits: number): bigint {
  const [seconds, fraction = ""] = key.split(".");
  // A negative wholeSeconds key still ADDS its nonnegative fraction.
  return (
    (BigInt(seconds) * 10n ** BigInt(digits) +
      BigInt(fraction.padEnd(digits, "0"))) *
    1000n
  );
}

function floorDeadline(units: bigint, scale: bigint): number | undefined {
  const integer =
    units / scale - (units < 0n && units % scale !== 0n ? 1n : 0n);
  if (abs(integer) > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(integer);
}

function stableOffset(
  sent: CoordinationClockSample,
  now: CoordinationClockSample,
  scale: bigint,
): boolean {
  return (
    abs(
      clockUnits(now.wallTimeMs, scale) -
        clockUnits(now.monotonicTimeMs, scale) -
        clockUnits(sent.wallTimeMs, scale) +
        clockUnits(sent.monotonicTimeMs, scale),
    ) <=
    1000n * scale
  );
}

/** Pure timing admission only: request, epoch, owner and action checks belong to
 * the coordinator. Capture sent at original allocation; never reset it on replay.
 * Monotonic values and the internal arithmetic record must never be serialized.
 */
export function admitCoordinationTiming(
  state: JobStatePayload,
  sent: CoordinationClockSample,
  received: CoordinationClockSample,
): CoordinationTiming | undefined {
  const parsed = JobStatePayloadSchema.safeParse(state);
  if (!parsed.success || !finite(sent) || !finite(received)) return undefined;
  const data = parsed.data;
  const keys = [
    data.observed_at,
    data.state_valid_until,
    data.expires_at,
    ...(data.lease_expires_at === null ? [] : [data.lease_expires_at]),
  ].map(rfc3339InstantKey);
  if (keys.some((key) => key === null)) return undefined;
  const validKeys = keys as string[];
  const digits = Math.max(
    1074,
    ...validKeys.map((key) => key.length - key.indexOf(".") - 1),
  );
  const scale = 10n ** BigInt(digits);
  const [observed, snapshot, job, lease] = validKeys.map((key) =>
    instantUnits(key, digits),
  );
  const m0 = clockUnits(sent.monotonicTimeMs, scale);
  const m1 = clockUnits(received.monotonicTimeMs, scale);
  const elapsed = m1 - m0;
  if (
    elapsed < 0n ||
    elapsed >= 2000n * scale ||
    !stableOffset(sent, received, scale) ||
    observed < clockUnits(sent.wallTimeMs, scale) - 1000n * scale ||
    observed > clockUnits(received.wallTimeMs, scale) + 1000n * scale
  )
    return undefined;
  const endpoint = (deadline: bigint) =>
    m1 + deadline - observed - elapsed - 1000n * scale;
  const snapshotEndpoint = endpoint(snapshot);
  const jobEndpoint = endpoint(job);
  if (snapshotEndpoint <= m1 || jobEndpoint <= m1) return undefined;
  const snapshotDeadlineMonotonicMs = floorDeadline(snapshotEndpoint, scale);
  const jobDeadlineMonotonicMs = floorDeadline(jobEndpoint, scale);
  const leaseDeadlineMonotonicMs =
    lease === undefined ? null : floorDeadline(endpoint(lease), scale);
  // Flooring may forfeit <1ms. A budget with no representable future endpoint
  // fails closed; an expired lease remains usable for started recovery only.
  if (
    snapshotDeadlineMonotonicMs === undefined ||
    jobDeadlineMonotonicMs === undefined ||
    leaseDeadlineMonotonicMs === undefined ||
    snapshotDeadlineMonotonicMs <= received.monotonicTimeMs ||
    jobDeadlineMonotonicMs <= received.monotonicTimeMs
  )
    return undefined;
  return Object.freeze({
    sent: Object.freeze({ ...sent }),
    received: Object.freeze({ ...received }),
    snapshotDeadlineMonotonicMs,
    jobDeadlineMonotonicMs,
    leaseDeadlineMonotonicMs,
    [exact]: Object.freeze({ scale, remoteJobExpiry: job, jobEndpoint }),
  });
}

export function approvalCoordinationDeadlines(
  timing: CoordinationTiming,
  approvalTimeoutSeconds: number,
):
  | Readonly<{ wireDeadlineMs: number; monotonicDeadlineMs: number }>
  | undefined {
  if (
    !Number.isInteger(approvalTimeoutSeconds) ||
    approvalTimeoutSeconds < 60 ||
    approvalTimeoutSeconds > 1800
  )
    return undefined;
  const { scale, remoteJobExpiry, jobEndpoint } = timing[exact];
  const lifetime = BigInt(approvalTimeoutSeconds) * 1000n * scale;
  const wireDeadlineMs = floorDeadline(
    min(
      remoteJobExpiry,
      clockUnits(timing.received.wallTimeMs, scale) + lifetime,
    ),
    scale,
  );
  const monotonicDeadlineMs = floorDeadline(
    min(
      jobEndpoint,
      clockUnits(timing.received.monotonicTimeMs, scale) + lifetime,
    ),
    scale,
  );
  if (
    wireDeadlineMs === undefined ||
    monotonicDeadlineMs === undefined ||
    wireDeadlineMs <= timing.received.wallTimeMs ||
    monotonicDeadlineMs <= timing.received.monotonicTimeMs
  )
    return undefined;
  return Object.freeze({ wireDeadlineMs, monotonicDeadlineMs });
}

/** This predicate has no revocation memory. The coordinator MUST monotonically
 * revoke its owned operation after ANY failed check; later good samples cannot
 * revive it. It must independently enforce epoch/owner/action/current-state
 * authority, recheck before effects, and enforce approval's own shorter deadline.
 * Already admitted work uses snapshot:false; new effects require snapshot:true.
 */
export function isCoordinationTimingCurrent(
  timing: CoordinationTiming,
  now: CoordinationClockSample,
  requirements: Readonly<{ snapshot: boolean; lease: boolean }>,
): boolean {
  return (
    finite(now) &&
    now.monotonicTimeMs >= timing.received.monotonicTimeMs &&
    stableOffset(timing.sent, now, timing[exact].scale) &&
    now.monotonicTimeMs < timing.jobDeadlineMonotonicMs &&
    (!requirements.snapshot ||
      now.monotonicTimeMs < timing.snapshotDeadlineMonotonicMs) &&
    (!requirements.lease ||
      (timing.leaseDeadlineMonotonicMs !== null &&
        now.monotonicTimeMs < timing.leaseDeadlineMonotonicMs))
  );
}
