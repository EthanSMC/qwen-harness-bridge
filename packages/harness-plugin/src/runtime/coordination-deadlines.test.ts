import type { JobStatePayload } from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import {
  admitCoordinationTiming,
  approvalCoordinationDeadlines,
  isCoordinationTimingCurrent,
} from "./coordination-deadlines.js";

const id = "11111111-1111-4111-8111-111111111111";
const state: JobStatePayload = {
  job_id: id,
  repository_id: "example",
  mode: "normal",
  requested_attempt: 1,
  current_attempt: 1,
  status: "running",
  job_revision: 1,
  cancel_revision: null,
  lease_id: id,
  lease_expires_at: "1970-01-01T00:00:30Z",
  expires_at: "1970-01-01T01:00:00Z",
  observed_at: "1970-01-01T00:00:00Z",
  state_valid_until: "1970-01-01T00:00:02Z",
  request_message_id: id,
  request_sequence: 1,
  nonce: id,
};
const sent = { wallTimeMs: 0, monotonicTimeMs: 10000 };
const received = { wallTimeMs: 100, monotonicTimeMs: 10100 };
const initial = { snapshot: true, lease: true };
const started = { snapshot: true, lease: false };
const ongoing = { snapshot: false, lease: false };
function admit(patch: Partial<JobStatePayload> = {}) {
  const timing = admitCoordinationTiming(
    { ...state, ...patch },
    sent,
    received,
  );
  expect(timing).toBeDefined();
  if (!timing) throw new Error("Expected admission");
  return timing;
}

describe("coordination deadlines", () => {
  it("floors negative wire and monotonic deadlines toward minus infinity", () => {
    const timing = admitCoordinationTiming(
      {
        ...state,
        observed_at: "1969-12-31T23:59:50Z",
        state_valid_until: "1969-12-31T23:59:52Z",
        expires_at: "1969-12-31T23:59:51.101999999999999999Z",
      },
      { wallTimeMs: -10000, monotonicTimeMs: -10000 },
      { wallTimeMs: -9900, monotonicTimeMs: -9900 },
    );
    if (!timing) throw new Error("Expected admission");
    expect(timing.jobDeadlineMonotonicMs).toBe(-9899);
    expect(approvalCoordinationDeadlines(timing, 60)).toEqual({
      wireDeadlineMs: -8899,
      monotonicDeadlineMs: -9899,
    });
  });
  it("floors configured deadlines for fractional paired clocks", () => {
    const timing = admitCoordinationTiming(
      state,
      { wallTimeMs: 0.25, monotonicTimeMs: 10000.25 },
      { wallTimeMs: 100.75, monotonicTimeMs: 10100.75 },
    );
    if (!timing) throw new Error("Expected admission");
    expect(timing.snapshotDeadlineMonotonicMs).toBe(11000);
    expect(approvalCoordinationDeadlines(timing, 60)).toEqual({
      wireDeadlineMs: 60100,
      monotonicDeadlineMs: 70100,
    });
  });
  it("charges elapsed and skew once, with distinct initial and business lifetimes", () => {
    const timing = admit();
    expect(timing.snapshotDeadlineMonotonicMs).toBe(11000);
    expect(timing.jobDeadlineMonotonicMs).toBe(3609000);
    expect(timing.leaseDeadlineMonotonicMs).toBe(39000);
    expect(isCoordinationTimingCurrent(timing, received, initial)).toBe(true);
    const now = { wallTimeMs: 1000, monotonicTimeMs: 11000 };
    expect(isCoordinationTimingCurrent(timing, now, initial)).toBe(false);
    expect(isCoordinationTimingCurrent(timing, now, ongoing)).toBe(true);
    expect(
      isCoordinationTimingCurrent(
        timing,
        { wallTimeMs: 3599000, monotonicTimeMs: 3609000 },
        ongoing,
      ),
    ).toBe(false);
    expect(timing.snapshotDeadlineMonotonicMs).toBe(11000);
  });

  it.each([-1, 1000, 1999.999, 2000])(
    "rejects elapsed %s (including exhausted snapshot before waiter limit)",
    (elapsed) => {
      expect(
        admitCoordinationTiming(state, sent, {
          wallTimeMs: elapsed,
          monotonicTimeMs: 10000 + elapsed,
        }),
      ).toBeUndefined();
    },
  );
  it.each([0, 999.5])("admits positive snapshot at elapsed %s", (elapsed) => {
    expect(
      admitCoordinationTiming(state, sent, {
        wallTimeMs: elapsed,
        monotonicTimeMs: 10000 + elapsed,
      }),
    ).toBeDefined();
  });
  it.each([-1000, 1000])("includes offset boundary %s", (offset) => {
    expect(
      admitCoordinationTiming(state, sent, {
        ...received,
        wallTimeMs: 100 + offset,
      }),
    ).toBeDefined();
  });
  it.each([-1000.0001, 1000.0001])(
    "excludes offset beyond boundary %s",
    (offset) => {
      expect(
        admitCoordinationTiming(state, sent, {
          ...received,
          wallTimeMs: 100 + offset,
        }),
      ).toBeUndefined();
    },
  );
  it.each([
    ["1969-12-31T23:59:59Z", "1970-01-01T00:00:01Z", true],
    [
      "1969-12-31T23:59:58.999999999999999999Z",
      "1970-01-01T00:00:00.999999999999999999Z",
      false,
    ],
    ["1970-01-01T00:00:01.1Z", "1970-01-01T00:00:03.1Z", true],
    [
      "1970-01-01T00:00:01.100000000000000001Z",
      "1970-01-01T00:00:03.100000000000000001Z",
      false,
    ],
  ])(
    "checks exact inclusive observation %s",
    (observed_at, state_valid_until, accepted) => {
      expect(
        admitCoordinationTiming(
          { ...state, observed_at, state_valid_until },
          sent,
          received,
        ) !== undefined,
      ).toBe(accepted);
    },
  );
  it.each([
    "1970-01-01T00:00:01.1Z",
    "1970-01-01T00:00:01.099999999999999999Z",
    "1970-01-01T00:00:01.100000000000000001Z",
  ])(
    "never grants a zero or unrepresentable positive job budget: %s",
    (expires_at) => {
      expect(
        admitCoordinationTiming({ ...state, expires_at }, sent, received),
      ).toBeUndefined();
    },
  );
  it("floors a fractional job endpoint without extending it", () => {
    const timing = admit({
      expires_at: "1970-01-01T00:00:01.101999999999999999Z",
    });
    expect(timing.jobDeadlineMonotonicMs).toBe(10101);
    expect(approvalCoordinationDeadlines(timing, 60)).toEqual({
      wireDeadlineMs: 1101,
      monotonicDeadlineMs: 10101,
    });
  });
  it.each([null, "1970-01-01T00:00:01.1Z", "1969-12-31T23:59:59.5Z"])(
    "allows started work with absent/expired lease %s",
    (lease_expires_at) => {
      const timing = admit({
        lease_id: lease_expires_at === null ? null : id,
        lease_expires_at,
      });
      expect(isCoordinationTimingCurrent(timing, received, started)).toBe(true);
      expect(isCoordinationTimingCurrent(timing, received, initial)).toBe(
        false,
      );
      expect(approvalCoordinationDeadlines(timing, 60)).toBeDefined();
      expect(timing.leaseDeadlineMonotonicMs).toBe(
        lease_expires_at === null
          ? null
          : lease_expires_at.includes("1969")
            ? 8500
            : 10100,
      );
    },
  );
  it.each([60, 1800])("clamps configured approval lifetime %s", (timeout) => {
    expect(approvalCoordinationDeadlines(admit(), timeout)).toEqual({
      wireDeadlineMs: 100 + timeout * 1000,
      monotonicDeadlineMs: 10100 + timeout * 1000,
    });
  });
  it.each([59, 1801, 60.5, NaN, Infinity])("rejects timeout %s", (timeout) => {
    expect(approvalCoordinationDeadlines(admit(), timeout)).toBeUndefined();
  });
  it("uses remote expiry for a short job and does not renew on wall rollback", () => {
    const timing = admit({ expires_at: "1970-01-01T00:00:20.9999Z" });
    const deadlines = approvalCoordinationDeadlines(timing, 60);
    expect(deadlines).toEqual({
      wireDeadlineMs: 20999,
      monotonicDeadlineMs: 29999,
    });
    expect(
      isCoordinationTimingCurrent(
        timing,
        { wallTimeMs: -800, monotonicTimeMs: 10200 },
        ongoing,
      ),
    ).toBe(true);
    expect(approvalCoordinationDeadlines(timing, 60)).toEqual(deadlines);
    expect(
      isCoordinationTimingCurrent(
        timing,
        { wallTimeMs: 18999, monotonicTimeMs: 29999 },
        ongoing,
      ),
    ).toBe(false);
  });
  it("compares drift to original sent and never mutates the pure snapshot on failure", () => {
    const timing = admitCoordinationTiming(state, sent, {
      ...received,
      wallTimeMs: 1100,
    });
    if (!timing) throw new Error("Expected admission");
    expect(
      isCoordinationTimingCurrent(
        timing,
        { wallTimeMs: 1200, monotonicTimeMs: 10200 },
        ongoing,
      ),
    ).toBe(true);
    expect(
      isCoordinationTimingCurrent(
        timing,
        { wallTimeMs: 1200.001, monotonicTimeMs: 10200 },
        ongoing,
      ),
    ).toBe(false);
    expect(isCoordinationTimingCurrent(timing, received, ongoing)).toBe(true);
    expect(isCoordinationTimingCurrent(timing, sent, ongoing)).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    "fails closed on invalid/unsafe clock arithmetic %s",
    (value) => {
      for (const field of ["wallTimeMs", "monotonicTimeMs"] as const) {
        expect(
          admitCoordinationTiming(state, { ...sent, [field]: value }, received),
        ).toBeUndefined();
        expect(
          admitCoordinationTiming(state, sent, { ...received, [field]: value }),
        ).toBeUndefined();
        expect(
          isCoordinationTimingCurrent(
            admit(),
            { ...received, [field]: value },
            ongoing,
          ),
        ).toBe(false);
      }
    },
  );
  it("validates actual strict state including missing expiry and exact two seconds", () => {
    for (const patch of [
      { expires_at: undefined },
      { unexpected: true },
      { state_valid_until: "1970-01-01T00:00:02.000000000000000001Z" },
    ]) {
      expect(
        admitCoordinationTiming(
          { ...state, ...patch } as JobStatePayload,
          sent,
          received,
        ),
      ).toBeUndefined();
    }
  });
  it("snapshots and freezes caller-owned values and approval results", () => {
    const input = { ...state };
    const send = { ...sent };
    const receive = { ...received };
    const timing = admitCoordinationTiming(input, send, receive);
    if (!timing) throw new Error("Expected admission");
    input.expires_at = "1970-01-01T00:00:00Z";
    send.monotonicTimeMs = 0;
    receive.wallTimeMs = 999;
    expect(timing.sent).toEqual(sent);
    expect(timing.received).toEqual(received);
    for (const value of [
      timing,
      timing.sent,
      timing.received,
      approvalCoordinationDeadlines(timing, 60),
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(approvalCoordinationDeadlines(timing, 60)?.wireDeadlineMs).toBe(
      60100,
    );
  });
  it("preserves negative whole-second positive fractions and equivalent spellings", () => {
    const patch = {
      observed_at: "1969-12-31T23:59:59.5Z",
      state_valid_until: "1970-01-01T00:00:01.5Z",
      expires_at: "1970-01-01T00:00:02.5000Z",
    };
    const timing = admit(patch);
    expect(timing.jobDeadlineMonotonicMs).toBe(12000);
    expect(
      admit({
        ...patch,
        observed_at: "1970-01-01T07:59:59.50000+08:00",
        state_valid_until: "1970-01-01T08:00:01.500+08:00",
      }).jobDeadlineMonotonicMs,
    ).toBe(12000);
  });
  it("handles leap-day observation and long fractions without absolute Number truncation", () => {
    const fraction = `123${"0".repeat(2048)}1`;
    const input = {
      ...state,
      observed_at: `2000-02-29T00:00:00.${fraction}Z`,
      state_valid_until: `2000-02-29T00:00:02.${fraction}Z`,
      expires_at: "2000-02-29T00:00:03.123Z",
    };
    const timing = admitCoordinationTiming(
      input,
      { wallTimeMs: 951782400123, monotonicTimeMs: 10000 },
      { wallTimeMs: 951782400223, monotonicTimeMs: 10100 },
    );
    expect(timing?.jobDeadlineMonotonicMs).toBe(11999);
  });
  it("does not round binary clock arithmetic upward across a millisecond boundary", () => {
    const timing = admitCoordinationTiming(
      state,
      { wallTimeMs: 0, monotonicTimeMs: -Number.MIN_VALUE },
      { wallTimeMs: 0, monotonicTimeMs: 0 },
    );
    expect(timing?.snapshotDeadlineMonotonicMs).toBe(999);
    expect(timing?.jobDeadlineMonotonicMs).toBe(3598999);
  });
  it("fails closed on unsafe derived monotonic endpoints", () => {
    const clock = { wallTimeMs: 0, monotonicTimeMs: Number.MAX_SAFE_INTEGER };
    expect(admitCoordinationTiming(state, clock, clock)).toBeUndefined();
  });
});
