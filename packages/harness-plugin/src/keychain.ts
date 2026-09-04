import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { spawn } from "node:child_process";

export interface CredentialReader {
  read(service: string, account: string): Promise<string>;
}

export class CredentialUnavailableError extends Error {
  static readonly code = "CONNECTOR_CREDENTIAL_UNAVAILABLE" as const;
  readonly code = CredentialUnavailableError.code;

  constructor() {
    super(CredentialUnavailableError.code);
    this.name = "CredentialUnavailableError";
  }
}

const MAX_STDERR_BYTES = 1_024;
const MAX_CREDENTIAL_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 100;
const FORCE_CLEANUP_GRACE_MS = 100;

export type SpawnImplementation = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export class MacOSKeychainCredentialReader implements CredentialReader {
  readonly #spawn: SpawnImplementation;
  readonly #timeoutMs: number;

  constructor(
    spawnImplementation: SpawnImplementation = spawn as SpawnImplementation,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new CredentialUnavailableError();
    }
    this.#spawn = spawnImplementation;
    this.#timeoutMs = timeoutMs;
  }

  read(service: string, account: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const options: SpawnOptions = {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        };
        child = this.#spawn(
          "/usr/bin/security",
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          options,
        );
      } catch {
        reject(new CredentialUnavailableError());
        return;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let cleaned = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let escalationTimeout: ReturnType<typeof setTimeout> | undefined;
      let forcedCleanupTimeout: ReturnType<typeof setTimeout> | undefined;

      const signalChild = (signal: NodeJS.Signals): boolean => {
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      };

      const releaseResources = (): void => {
        try {
          child.stdin?.destroy();
        } catch {
          // Preserve the safe credential error.
        }
        try {
          child.stdout.destroy();
        } catch {
          // Preserve the safe credential error.
        }
        try {
          child.stderr.destroy();
        } catch {
          // Preserve the safe credential error.
        }
        try {
          child.unref();
        } catch {
          // Preserve the safe credential error.
        }
      };

      const scrubStdout = (): void => {
        for (const chunk of stdoutChunks) chunk.fill(0);
        stdoutChunks.length = 0;
        stdoutBytes = 0;
      };

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (escalationTimeout !== undefined) clearTimeout(escalationTimeout);
        if (forcedCleanupTimeout !== undefined) {
          clearTimeout(forcedCleanupTimeout);
        }
        child.stdout.removeListener("data", onStdoutData);
        child.stderr.removeListener("data", onStderrData);
        child.removeListener("close", onClose);
        child.removeListener("error", onChildError);
        child.stdout.removeListener("error", onStreamError);
        child.stderr.removeListener("error", onStreamError);
      };

      const terminate = (): void => {
        signalChild("SIGTERM");
        releaseResources();
        if (cleaned) return;
        escalationTimeout = setTimeout(() => {
          if (cleaned) return;
          signalChild("SIGKILL");
          releaseResources();
          if (cleaned) return;
          forcedCleanupTimeout = setTimeout(cleanup, FORCE_CLEANUP_GRACE_MS);
        }, TERMINATION_GRACE_MS);
      };

      const fail = (terminateChild: boolean): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        child.stdout.removeListener("data", onStdoutData);
        child.stderr.removeListener("data", onStderrData);
        scrubStdout();
        if (terminateChild) {
          terminate();
        } else {
          releaseResources();
          cleanup();
        }
        reject(new CredentialUnavailableError());
      };

      const onStdoutData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes <= MAX_CREDENTIAL_BYTES) {
          stdoutChunks.push(buffer);
        } else {
          buffer.fill(0);
          fail(true);
        }
      };

      const onStderrData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) fail(true);
      };

      const onChildError = (): void => fail(true);
      const onStreamError = (): void => fail(true);
      const onClose = (exitCode: number | null): void => {
        if (settled) {
          cleanup();
          return;
        }
        if (exitCode !== 0) {
          fail(false);
          return;
        }

        const credential = Buffer.concat(stdoutChunks)
          .toString("utf8")
          .replace(/\r?\n$/, "");
        if (credential.length === 0) {
          fail(false);
          return;
        }
        settled = true;
        scrubStdout();
        cleanup();
        resolve(credential);
      };

      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("error", onChildError);
      child.stdout.on("error", onStreamError);
      child.stderr.on("error", onStreamError);
      child.once("close", onClose);
      timeout = setTimeout(() => fail(true), this.#timeoutMs);
    });
  }
}
