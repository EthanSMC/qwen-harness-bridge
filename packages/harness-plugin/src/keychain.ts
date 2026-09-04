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

export type SpawnImplementation = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export class MacOSKeychainCredentialReader implements CredentialReader {
  readonly #spawn: SpawnImplementation;

  constructor(
    spawnImplementation: SpawnImplementation = spawn as SpawnImplementation,
  ) {
    this.#spawn = spawnImplementation;
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
      let stdoutOverflow = false;
      let stderrBytes = 0;
      let stderrOverflow = false;
      let settled = false;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes <= MAX_CREDENTIAL_BYTES) {
          stdoutChunks.push(buffer);
        } else {
          stdoutOverflow = true;
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) stderrOverflow = true;
        stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes);
      });

      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new CredentialUnavailableError());
      };

      child.once("error", fail);
      child.once("close", (exitCode) => {
        if (settled) return;
        if (exitCode !== 0 || stdoutOverflow || stderrOverflow) {
          fail();
          return;
        }

        const credential = Buffer.concat(stdoutChunks)
          .toString("utf8")
          .replace(/\r?\n$/, "");
        if (credential.length === 0) {
          fail();
          return;
        }
        settled = true;
        resolve(credential);
      });
    });
  }
}
