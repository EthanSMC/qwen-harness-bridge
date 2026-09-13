import { describe, expect, it } from "vitest";
import { executableCandidates, executableName } from "./action-classifier.js";
import type { CanonicalAction } from "./types.js";

const named = (executable: string): CanonicalAction =>
  ({ executable }) as unknown as CanonicalAction;

describe("executableName", () => {
  it.each([
    ["C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe", "git"],
    ["C:\\\\bin\\\\pnpm.cmd", "pnpm"],
    ["/usr/local/bin/git", "git"],
    ["/usr/local/bin/tsc.js", "tsc"],
  ])("normalizes %s to %s", (executable, expected) => {
    expect(executableName(named(executable))).toBe(expected);
  });
});

describe("executableCandidates", () => {
  it("returns the bare name on POSIX", () => {
    const candidates = executableCandidates(
      "/usr/bin",
      "git",
      "linux",
      undefined,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.endsWith("git")).toBe(true);
  });

  it("tries every PATHEXT extension on Windows", () => {
    const candidates = executableCandidates(
      "C:\\bin",
      "git",
      "win32",
      ".COM;.EXE;.BAT;.CMD",
    );
    expect(candidates[0]?.endsWith("git")).toBe(true);
    expect(candidates.some((candidate) => candidate.endsWith("git.EXE"))).toBe(
      true,
    );
    expect(candidates.some((candidate) => candidate.endsWith("git.CMD"))).toBe(
      true,
    );
  });

  it("falls back to the standard Windows extensions without PATHEXT", () => {
    expect(
      executableCandidates("C:\\bin", "git", "win32", undefined).some(
        (candidate) => candidate.endsWith("git.EXE"),
      ),
    ).toBe(true);
  });

  it("keeps an executable that already carries its extension", () => {
    expect(
      executableCandidates("C:\\bin", "git.exe", "win32", ".EXE").some(
        (candidate) => candidate.endsWith("git.exe"),
      ),
    ).toBe(true);
  });
});
