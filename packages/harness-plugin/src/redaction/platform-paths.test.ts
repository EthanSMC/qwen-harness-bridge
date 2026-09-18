import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { redactEvent } from "./redact-event.js";

/** The redaction contract accepts platform-native absolute roots: POSIX
 * (`/...`) and Windows (`X:\...`). This suite runs on every platform and
 * asserts the host's own spelling, because the connector must start wherever
 * the Harness runtime boots. */
it("accepts the host absolute roots and redacts paths beneath them", () => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "qhb-redact-")),
  );
  const repository = join(directory, "repo");
  const home = join(directory, "home");
  mkdirSync(repository, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    const output = redactEvent(
      {
        summary: `changed ${join(repository, "src", "index.ts")} and ${join(home, "private.txt")}`,
      },
      { repositoryRoot: repository, homeDirectory: home },
    );
    expect(output.summary).toBeDefined();
    expect(output.summary).not.toContain(directory);
    expect(output.summary).toContain("index.ts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
