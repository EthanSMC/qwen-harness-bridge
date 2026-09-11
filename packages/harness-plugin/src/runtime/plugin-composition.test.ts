import { describe, expect, it, vi } from "vitest";
import { createPluginComposition } from "./plugin-composition.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const build = (
  options: { failApprovals?: boolean; failDriver?: boolean } = {},
) => {
  const order: string[] = [];
  const unregister = vi.fn(() => order.push("intake"));
  const onCommand = vi.fn(() => unregister);
  const transport = deferred();
  const start = vi.fn(async (signal: AbortSignal) => {
    order.push("transport-start");
    signal.addEventListener("abort", () => {
      order.push("transport");
      transport.resolve();
    });
    await transport.promise;
  });
  const report = vi.fn();
  const composition = createPluginComposition({
    coordinator: { handle: vi.fn(async () => {}) },
    connector: { onCommand, start },
    approvals: {
      dispose: () => {
        order.push("approvals");
        if (options.failApprovals) throw new Error("approval teardown");
      },
    },
    driver: {
      dispose: async () => {
        order.push("driver");
        if (options.failDriver) throw new Error("driver teardown");
      },
    },
    store: { close: () => order.push("store") },
    report,
  });
  return {
    composition,
    order,
    report,
    transport,
    onCommand,
    unregister,
    start,
  };
};

describe("plugin composition teardown", () => {
  it("registers intake before connecting and disposes in the required order", async () => {
    const harness = build();
    harness.composition.connect();
    expect(harness.onCommand).toHaveBeenCalledTimes(1);
    await harness.composition.dispose();
    expect(harness.order).toEqual([
      "transport-start",
      "intake",
      "approvals",
      "driver",
      "transport",
      "store",
    ]);
  });

  it("contains a failing teardown stage and still closes the store", async () => {
    const harness = build({ failApprovals: true, failDriver: true });
    harness.composition.connect();
    await harness.composition.dispose();
    expect(harness.order).toEqual([
      "transport-start",
      "intake",
      "approvals",
      "driver",
      "transport",
      "store",
    ]);
    expect(harness.report).toHaveBeenCalledTimes(2);
  });

  it("is idempotent and never throws", async () => {
    const harness = build();
    harness.composition.connect();
    await harness.composition.dispose();
    const settled = harness.order.slice();
    await harness.composition.dispose();
    expect(harness.order).toEqual(settled);
  });
});
