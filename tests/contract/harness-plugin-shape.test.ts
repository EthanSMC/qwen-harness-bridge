import { describe, expect, it } from "vitest";
import { inject, name } from "../../packages/harness-plugin/src/index.js";

describe("harness plugin shape", () => {
  it("declares the stable Cordis plugin identity", () => {
    expect(name).toBe("qwen-harness-bridge");
  });

  it("requires the official Harness services before it loads", () => {
    expect([...inject]).toEqual([
      "agents",
      "sessions",
      "sessionPersistence",
      "approval",
    ]);
  });
});
