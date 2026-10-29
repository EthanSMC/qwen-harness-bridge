import type { RtcActivityKind, RtcClock } from "./rtc-session.js";

/** SSE comment keepalive cadence. */
export const RTC_KEEPALIVE_MS = 30_000;

/** Inactivity budget after the last valid activity. */
export const RTC_INACTIVITY_MS = 90_000;

const VALID_ACTIVITY = new Set<string>(["audio", "control", "output"]);

export type InactivityWatchdogOptions = Readonly<{
  clock: RtcClock;
  writeKeepalive: () => void;
  onInactive: () => void;
  keepaliveMs?: number;
  inactivityMs?: number;
}>;

/**
 * Owns the two RTC timers. Keepalive writes an SSE comment every 30 seconds.
 * Inactivity is reset only by audio, control or successful output activity and
 * closes the session at exactly 90 seconds. The clock is injected so tests can
 * advance time deterministically.
 */
export class InactivityWatchdog {
  private readonly clock: RtcClock;
  private readonly writeKeepalive: () => void;
  private readonly onInactive: () => void;
  private readonly keepaliveMs: number;
  private readonly inactivityMs: number;
  private keepaliveHandle: unknown;
  private inactivityHandle: unknown;
  private running = false;
  private lastActivityAtMs = 0;

  constructor(options: InactivityWatchdogOptions) {
    this.clock = options.clock;
    this.writeKeepalive = options.writeKeepalive;
    this.onInactive = options.onInactive;
    this.keepaliveMs = options.keepaliveMs ?? RTC_KEEPALIVE_MS;
    this.inactivityMs = options.inactivityMs ?? RTC_INACTIVITY_MS;
  }

  get lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAtMs = this.clock.now();
    this.scheduleKeepalive();
    this.resetInactivity();
  }

  touch(kind: RtcActivityKind): void {
    if (!this.running || !VALID_ACTIVITY.has(kind)) return;
    this.lastActivityAtMs = this.clock.now();
    this.resetInactivity();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.keepaliveHandle !== undefined) {
      this.clock.clearTimeout(this.keepaliveHandle);
      this.keepaliveHandle = undefined;
    }
    if (this.inactivityHandle !== undefined) {
      this.clock.clearTimeout(this.inactivityHandle);
      this.inactivityHandle = undefined;
    }
  }

  private scheduleKeepalive(): void {
    this.keepaliveHandle = this.clock.setTimeout(() => {
      if (!this.running) return;
      this.writeKeepalive();
      this.scheduleKeepalive();
    }, this.keepaliveMs);
  }

  private resetInactivity(): void {
    if (this.inactivityHandle !== undefined) {
      this.clock.clearTimeout(this.inactivityHandle);
    }
    this.inactivityHandle = this.clock.setTimeout(() => {
      this.inactivityHandle = undefined;
      if (!this.running) return;
      this.stop();
      this.onInactive();
    }, this.inactivityMs);
  }
}
