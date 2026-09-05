import type { JobStatePayload } from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import {
  admitCoordinationTiming,
  approvalCoordinationDeadlines,
  coordinationWaiterRemainingMs,
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

describe("coordination waiter remaining time", () => {
  const pair = (monotonicTimeMs: number, wallTimeMs = monotonicTimeMs) => ({
    wallTimeMs,
    monotonicTimeMs,
  });

  it.each([
    [0, 2000],
    [1, 1999],
    [1999, 1],
    [0.25, 1999],
    [1.75, 1998],
    [1999.5, undefined],
    [2000, undefined],
    [2000 + 2 ** -42, undefined],
    [-Number.MIN_VALUE, undefined],
    [-1, undefined],
  ])("bounds and floors elapsed %s to %s", (elapsed, expected) => {
    expect(coordinationWaiterRemainingMs(pair(0), pair(elapsed))).toBe(
      expected,
    );
  });

  it.each([
    [0, 2000],
    [1000, 2000],
    [-1000, 2000],
    [1000 + 2 ** -43, undefined],
    [-1000 - 2 ** -43, undefined],
    [5000, undefined],
    [-5000, undefined],
  ])("checks original offset drift %s", (wall, expected) => {
    expect(coordinationWaiterRemainingMs(pair(0), pair(0, wall))).toBe(
      expected,
    );
  });

  it("measures drift from the original pair without remembering failure", () => {
    const original = pair(100, 500);
    expect(coordinationWaiterRemainingMs(original, pair(200, 1600))).toBe(1900);
    expect(
      coordinationWaiterRemainingMs(original, pair(300, 1700.25)),
    ).toBeUndefined();
    expect(coordinationWaiterRemainingMs(original, pair(300, 700))).toBe(1800);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects every nonfinite field: %s",
    (value) => {
      for (const field of ["wallTimeMs", "monotonicTimeMs"] as const) {
        expect(
          coordinationWaiterRemainingMs(
            { ...pair(0), [field]: value },
            pair(0),
          ),
        ).toBeUndefined();
        expect(
          coordinationWaiterRemainingMs(pair(0), {
            ...pair(0),
            [field]: value,
          }),
        ).toBeUndefined();
      }
    },
  );

  it("returns a duration for huge finite origins without overflow", () => {
    for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(coordinationWaiterRemainingMs(pair(value), pair(value))).toBe(
        2000,
      );
      expect(
        coordinationWaiterRemainingMs(pair(value, -value), pair(value, -value)),
      ).toBe(2000);
    }
    expect(
      coordinationWaiterRemainingMs(
        pair(Number.MAX_VALUE / 2),
        pair(Number.MAX_VALUE),
      ),
    ).toBeUndefined();
    expect(
      coordinationWaiterRemainingMs(
        pair(Number.MAX_VALUE),
        pair(Number.MAX_VALUE / 2),
      ),
    ).toBeUndefined();
    expect(
      coordinationWaiterRemainingMs(
        pair(0, Number.MAX_VALUE),
        pair(0, Number.MAX_VALUE / 2),
      ),
    ).toBeUndefined();
  });

  it("accepts negative and fractional origins without flooring absolute time", () => {
    expect(coordinationWaiterRemainingMs(pair(-3000), pair(-1001))).toBe(1);
    expect(coordinationWaiterRemainingMs(pair(-0.25), pair(0.25))).toBe(1999);
  });

  it("preserves subnormal elapsed across integer remainder boundaries", () => {
    expect(coordinationWaiterRemainingMs(pair(0), pair(Number.MIN_VALUE))).toBe(
      1999,
    );
    expect(
      coordinationWaiterRemainingMs(pair(-Number.MIN_VALUE), pair(1999)),
    ).toBeUndefined();
    expect(
      coordinationWaiterRemainingMs(pair(Number.MIN_VALUE), pair(1999)),
    ).toBe(1);
    expect(
      coordinationWaiterRemainingMs(pair(0), pair(2000 - 2 ** -42)),
    ).toBeUndefined();
  });

  it.each([-1, 1])(
    "preserves subnormal offset excess in direction %s",
    (sign) => {
      expect(
        coordinationWaiterRemainingMs(
          pair(0, -sign * Number.MIN_VALUE),
          pair(0, sign * 1000),
        ),
      ).toBeUndefined();
      expect(
        coordinationWaiterRemainingMs(
          pair(0, sign * Number.MIN_VALUE),
          pair(0, sign * 1000),
        ),
      ).toBe(2000);
    },
  );

  it.each(["prototype", "non-enumerable"])(
    "captures %s clock fields",
    (kind) => {
      const sample = (value: number) => {
        const fields = {
          get wallTimeMs() {
            return value;
          },
          get monotonicTimeMs() {
            return value;
          },
        };
        return kind === "prototype"
          ? Object.create(fields)
          : Object.defineProperties(
              {},
              {
                wallTimeMs: { value },
                monotonicTimeMs: { value },
              },
            );
      };
      expect(coordinationWaiterRemainingMs(sample(0), sample(1))).toBe(1999);
    },
  );

  it.each([true, false])(
    "captures all four scalars once even when valid is %s",
    (valid) => {
      const counts = [0, 0, 0, 0];
      const metadata = { value: 1 };
      const sample = (index: number, value: number) => ({
        get wallTimeMs() {
          return ++counts[index] === 1 && (valid || index !== 0) ? value : NaN;
        },
        get monotonicTimeMs() {
          return ++counts[index + 1] === 1 ? value : Infinity;
        },
        metadata,
        get unrelated() {
          throw new Error("Must not read unrelated getter");
        },
      });
      const original = sample(0, 0);
      const now = sample(2, 1);
      const before = [original, now].map(Object.getOwnPropertyDescriptors);
      expect(coordinationWaiterRemainingMs(original, now)).toBe(
        valid ? 1999 : undefined,
      );
      expect(counts).toEqual([1, 1, 1, 1]);
      expect([original, now].map(Object.getOwnPropertyDescriptors)).toEqual(
        before,
      );
      for (const input of [original, now, metadata])
        expect(Object.isFrozen(input)).toBe(false);
      metadata.value = 2;
      expect(metadata.value).toBe(2);
    },
  );
});

describe("coordination deadlines", () => {
  it.each(["prototype", "non-enumerable"])(
    "retains explicit scalar snapshots for %s samples",
    (kind) => {
      const sample = (values: typeof sent) => {
        const fields = {
          get wallTimeMs() {
            return values.wallTimeMs;
          },
          get monotonicTimeMs() {
            return values.monotonicTimeMs;
          },
        };
        return kind === "prototype"
          ? Object.create(fields)
          : Object.defineProperties(
              {},
              {
                wallTimeMs: { value: values.wallTimeMs },
                monotonicTimeMs: { value: values.monotonicTimeMs },
              },
            );
      };
      const timing = admitCoordinationTiming(
        state,
        sample(sent),
        sample(received),
      );
      if (!timing) throw new Error("Expected admission");
      expect(approvalCoordinationDeadlines(timing, 60)).toEqual({
        wireDeadlineMs: 60100,
        monotonicDeadlineMs: 70100,
      });
      expect(isCoordinationTimingCurrent(timing, received, initial)).toBe(true);
      for (const [snapshot, values] of [
        [timing.sent, sent],
        [timing.received, received],
      ]) {
        expect(snapshot).toEqual(values);
        expect(Reflect.ownKeys(snapshot)).toEqual([
          "wallTimeMs",
          "monotonicTimeMs",
        ]);
        expect(Object.isFrozen(snapshot)).toBe(true);
      }
    },
  );
  it("omits unrelated properties without reading or freezing caller metadata", () => {
    const metadata = { value: 1 };
    let extraReads = 0;
    const enrich = (values: typeof sent) => ({
      ...values,
      metadata,
      get unrelated() {
        extraReads++;
        return metadata;
      },
    });
    const send = enrich(sent);
    const receive = enrich(received);
    const timing = admitCoordinationTiming(state, send, receive);
    if (!timing) throw new Error("Expected admission");
    expect(extraReads).toBe(0);
    expect(Reflect.ownKeys(timing.sent)).toEqual([
      "wallTimeMs",
      "monotonicTimeMs",
    ]);
    expect(Reflect.ownKeys(timing.received)).toEqual([
      "wallTimeMs",
      "monotonicTimeMs",
    ]);
    expect(Object.isFrozen(send)).toBe(false);
    expect(Object.isFrozen(receive)).toBe(false);
    expect(Object.isFrozen(metadata)).toBe(false);
    metadata.value = 2;
    expect(approvalCoordinationDeadlines(timing, 60)?.wireDeadlineMs).toBe(
      60100,
    );
  });
  it("reads each admission scalar once and retains that validated pair", () => {
    const counts = [0, 0, 0, 0];
    const sample = (values: typeof sent, index: number) => ({
      get wallTimeMs() {
        return ++counts[index] === 1 ? values.wallTimeMs : NaN;
      },
      get monotonicTimeMs() {
        return ++counts[index + 1] === 1 ? values.monotonicTimeMs : NaN;
      },
    });
    const timing = admitCoordinationTiming(
      state,
      sample(sent, 0),
      sample(received, 2),
    );
    expect(counts).toEqual([1, 1, 1, 1]);
    if (!timing) throw new Error("Expected admission");
    expect(timing.sent).toEqual(sent);
    expect(timing.received).toEqual(received);
    expect(timing.snapshotDeadlineMonotonicMs).toBe(11000);
    expect(approvalCoordinationDeadlines(timing, 60)).toEqual({
      wireDeadlineMs: 60100,
      monotonicDeadlineMs: 70100,
    });
  });
  it.each([true, false])(
    "uses one currentness pair with finite first values: %s",
    (valid) => {
      let wallReads = 0;
      let monotonicReads = 0;
      const now = {
        get wallTimeMs() {
          return ++wallReads === 1 ? (valid ? 100 : NaN) : 100;
        },
        get monotonicTimeMs() {
          return ++monotonicReads === 1 ? 10100 : Infinity;
        },
        get unrelated() {
          throw new Error("Must not read unrelated getter");
        },
      };
      expect(isCoordinationTimingCurrent(admit(), now, initial)).toBe(valid);
      expect([wallReads, monotonicReads]).toEqual([1, 1]);
    },
  );
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
