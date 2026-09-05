import { relative } from "node:path";
import { JobEventPayloadSchema } from "@qhb/protocol";
import {
  canonicalizePath,
  canonicalizeRepositoryRoot,
} from "../policy/canonical-path.js";

export type RedactionOptions = Readonly<{
  repositoryRoot: string;
  homeDirectory: string;
  secrets?: readonly string[];
}>;
export type RedactedEventPayload = Readonly<{
  summary: string;
  stage?: string;
  changed_files?: string[];
  tests?: { passed: number; failed: number; total?: number };
  artifacts?: Array<{ name: string; media_type: string; url: string }>;
}>;
export class RedactionError extends Error {
  readonly code = "CONNECTOR_EVENT_REJECTED";
  constructor() {
    super("CONNECTOR_EVENT_REJECTED");
    this.name = "RedactionError";
  }
}
const reject = (): never => {
  throw new RedactionError();
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const controls = /\p{Cc}/u;
const credentials =
  /\b(?:bearer|basic)\s+\S+|(?:access[_-]?tokens?|api[_-]?keys?|authorization|client[_-]?secrets?|cookies?|credentials?|passwords?|passwd|secrets?|tokens?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi;
const privateText =
  /[\r\n\u2028\u2029]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:const|let|var|function|class|interface|import|def|return|throw)\s+\w+|#include\s*<|=>|\w\s*\([^\n]*\)\s*;|\b(?:tool\s*)?arguments?\s*[:=]|\b[A-Z][A-Z0-9_]{1,}\s*=|\b(?:home|node_env|path|pwd|shell|temp|tmp|tmpdir|user)\s*=|^\s*[[{]/i;

function record(
  value: unknown,
  keys: readonly string[],
  exact: boolean,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return reject();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return reject();
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.hasOwn(value, "toJSON")
  )
    return reject();
  if (
    exact &&
    Object.getOwnPropertyNames(value).some((key) => !keys.includes(key))
  )
    return reject();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined
    )
      return reject();
    output[key] = descriptor.value;
  }
  return output;
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    return reject();
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  )
    return reject();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined
    )
      return reject();
    result.push(descriptor.value);
  }
  return result;
}
function truncate(value: string): string {
  let result = "";
  let length = 0;
  for (const point of value) {
    length += bytes(point);
    if (length > 500) break;
    result += point;
  }
  return result.trim() || "[redacted]";
}

export function redactEvent(
  input: unknown,
  options: RedactionOptions,
): RedactedEventPayload {
  try {
    const root = canonicalizeRepositoryRoot(options.repositoryRoot);
    if (
      typeof options.homeDirectory !== "string" ||
      !options.homeDirectory.startsWith("/") ||
      controls.test(options.homeDirectory)
    )
      return reject();
    const secrets =
      options.secrets === undefined ? [] : array(options.secrets, 64);
    if (
      secrets.some(
        (secret) =>
          typeof secret !== "string" || !secret.length || bytes(secret) > 4096,
      )
    )
      return reject();
    const orderedSecrets = (secrets as string[]).sort(
      (a, b) => b.length - a.length,
    );
    let inspected = 0;
    const text = (value: unknown): string => {
      if (typeof value !== "string") return reject();
      const size = bytes(value);
      inspected += size;
      if (size > 65536 || inspected > 2 * 1024 * 1024) return reject();
      return value;
    };
    const explicit = (value: string): string => {
      for (const secret of orderedSecrets)
        value = value.split(secret).join("[redacted]");
      return value;
    };
    const safeUrl = (value: string): string => {
      if (controls.test(value) || !/^https?:\/\/[^\s]+$/i.test(value))
        return reject();
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      const normalized = url.toString();
      const decoded = decodeURIComponent(normalized);
      if (
        bytes(normalized) > 500 ||
        controls.test(decoded) ||
        privateText.test(decoded) ||
        explicit(decoded) !== decoded ||
        decoded.replace(credentials, "[redacted]") !== decoded ||
        /(?:\/Users\/|\/home\/|~\/)/i.test(decoded)
      )
        return reject();
      return normalized;
    };
    const file = (value: string): string => {
      if (
        !value ||
        controls.test(value) ||
        /[\u2028\u2029\\]|^[A-Za-z]:|^~|^file:/u.test(value) ||
        explicit(value) !== value ||
        value.replace(credentials, "[redacted]") !== value
      )
        return reject();
      const path = relative(
        root,
        canonicalizePath(root, value, { basePath: root }),
      ).replaceAll("\\", "/");
      if (
        !path ||
        bytes(path) > 500 ||
        controls.test(path) ||
        explicit(path) !== path
      )
        return reject();
      if (
        !JobEventPayloadSchema.shape.payload.safeParse({
          changed_files: [path],
        }).success
      )
        return reject();
      return path;
    };
    const human = (raw: string): string => {
      let value = explicit(raw);
      if (privateText.test(value)) return "[redacted]";
      value = value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
        try {
          return safeUrl(url);
        } catch {
          return "[redacted]";
        }
      });
      value = value.replace(credentials, "[redacted]");
      value = value.replace(
        /https?:\/\/[^\s<>"']+|(?<![\w/])(?:file:\/\/|~\/|[A-Za-z]:[\\/]|\\\\|\/)[^\s<>"']*/g,
        (path) => {
          // URL paths were already normalized above.
          if (/^https?:\/\//.test(path)) return path;
          if (
            path === options.homeDirectory ||
            path.startsWith(`${options.homeDirectory}/`) ||
            path.startsWith("~/")
          )
            return "[home]";
          if (path.startsWith(`${root}/`)) {
            try {
              return file(path);
            } catch {
              return "[redacted]";
            }
          }
          return "[redacted]";
        },
      );
      value = value.replace(/\p{Cc}/gu, " ");
      return truncate(value);
    };
    const fields = record(
      input,
      ["summary", "stage", "changed_files", "tests", "artifacts"],
      false,
    );
    const output: {
      summary: string;
      stage?: string;
      changed_files?: string[];
      tests?: { passed: number; failed: number; total?: number };
      artifacts?: Array<{ name: string; media_type: string; url: string }>;
    } = { summary: human(text(fields.summary)) };
    if (Object.hasOwn(fields, "stage")) {
      const stage = text(fields.stage);
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(stage) || explicit(stage) !== stage)
        return reject();
      output.stage = stage;
    }
    if (Object.hasOwn(fields, "changed_files")) {
      const paths = array(fields.changed_files, 10000).map(text);
      output.changed_files = paths.map(file).slice(0, 50);
    }
    if (Object.hasOwn(fields, "tests")) {
      const counters = record(
        fields.tests,
        ["passed", "failed", "total"],
        true,
      );
      const counter = (value: unknown): number => {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0
        )
          return reject();
        return value;
      };
      const passed = counter(counters.passed),
        failed = counter(counters.failed);
      if (!Number.isSafeInteger(passed + failed)) return reject();
      output.tests = { passed, failed };
      if (Object.hasOwn(counters, "total")) {
        const total = counter(counters.total);
        if (passed + failed > total) return reject();
        output.tests.total = total;
      }
    }
    if (Object.hasOwn(fields, "artifacts")) {
      output.artifacts = array(fields.artifacts, 32).map((entry) => {
        const artifact = record(entry, ["name", "media_type", "url"], true);
        const name = human(text(artifact.name));
        const media_type = text(artifact.media_type);
        if (
          bytes(media_type) > 127 ||
          !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
            media_type,
          ) ||
          explicit(media_type) !== media_type
        )
          return reject();
        return { name, media_type, url: safeUrl(text(artifact.url)) };
      });
    }
    if (!JobEventPayloadSchema.shape.payload.safeParse(output).success)
      return reject();
    return output;
  } catch {
    throw new RedactionError();
  }
}
