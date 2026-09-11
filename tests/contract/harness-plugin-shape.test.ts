import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  apply,
  inject,
  name,
} from "../../packages/harness-plugin/src/index.js";

// The transport requires a canonical POSIX repository root for outbound
// redaction, so the full composition path runs on the Linux required-CI runner.
const POSIX_REDACTION_SUPPORTED = process.platform !== "win32";

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
      "tools",
    ]);
  });

  it("fails closed before any effect on invalid configuration", () => {
    const ctx = {} as unknown as Context;
    expect(() => apply(ctx, {})).toThrow();
    expect(() => apply(ctx, "not json")).toThrow();
  });

  it.skipIf(!POSIX_REDACTION_SUPPORTED)(
    "composes and tears down the outbound connector under the fiber",
    { timeout: 20_000 },
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "qhb-shape-")));
      const repository = join(root, "repository");
      mkdirSync(repository);
      const effects: Array<() => unknown> = [];
      const ctx = {
        effect: (callback: () => unknown) => {
          const dispose = callback();
          effects.push(dispose as () => unknown);
          return dispose;
        },
        agents: {
          create: async () => {
            throw new Error("unused");
          },
        },
        sessions: { flush: async () => true },
        on: () => () => undefined,
      } as unknown as Context;
      try {
        apply(ctx, {
          connectorId: randomUUID(),
          controlPlaneUrl: "wss://127.0.0.1:1/connector/v1",
          keychainService: "qhb-shape",
          keychainAccount: "qhb-shape-account",
          databasePath: join(root, "store.sqlite"),
          repositories: [
            {
              id: "example",
              displayName: "Example",
              canonicalPath: repository,
              approvalTimeoutSeconds: 120,
            },
          ],
        });
        expect(effects).toHaveLength(1);
        await effects[0]();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});