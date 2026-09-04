import childProcess from "node:child_process";
import { statSync } from "node:fs";
import { CanonicalPathError } from "./canonical-path.js";

/** Only the caller's registration-verified rg identity may reach this helper. */
export function ripgrepCandidates(
  executable: string,
  cwd: string,
  selection: readonly string[],
  operands: readonly string[],
  canonicalize: (path: string) => string,
): string[] {
  const fail = (): never => {
    throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
  };
  const started = performance.now();
  const maxBytes = 2 * 1024 * 1024;
  const result = childProcess.spawnSync(
    executable,
    [
      "--files",
      "--null",
      "--no-config",
      ...selection,
      "--",
      ...(operands.length ? operands : ["."]),
    ],
    {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
      killSignal: "SIGKILL",
      maxBuffer: maxBytes,
    },
  );
  // Do not include filenames, stderr, or OS error details in a policy decision.
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    performance.now() - started > 2000 ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length > maxBytes ||
    result.stderr.length > maxBytes
  )
    fail();
  const output = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(result.stdout);
  if (output === "") return [];
  if (!output.endsWith("\0")) fail();
  const names = output.slice(0, -1).split("\0");
  if (names.length > 10000 || names.some((name) => name === "")) fail();
  const candidates = names.map((name) => {
    if (performance.now() - started > 2000) fail();
    const path = canonicalize(name);
    if (!statSync(path).isFile()) fail();
    return path;
  });
  if (performance.now() - started > 2000) fail();
  return [...new Set(candidates)].sort();
}
