import { describe, expect, it, vi } from "vitest";
import { closeRuntimeResources } from "../../apps/control-plane/src/http/shutdown.js";

describe("bounded runtime shutdown", () => {
  it("closes the database after a stalled HTTP close and preserves the primary failure", async () => {
    vi.useFakeTimers();
    try {
      const databaseClosed = vi.fn<() => Promise<void>>(async () => undefined);
      const observed = closeRuntimeResources(
        () => new Promise<void>(() => {}),
        databaseClosed,
        25,
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      await expect(observed).resolves.toMatchObject({
        message: "Runtime shutdown deadline exceeded",
      });
      expect(databaseClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
