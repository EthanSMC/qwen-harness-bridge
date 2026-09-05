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
  /\b(?:bearer|basic)\s+\S+|["']?(?:access[_-]?tokens?|api[_-]?keys?|authorization|client[_-]?secrets?|cookies?|credentials?|passwords?|passwd|secrets?|tokens?)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi;
const privateText =
  /[\r\n\u2028\u2029]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:const|let|var|function|class|interface|import|def|return|throw)\s+\w+|#include\s*<|=>|\w\s*\([^\n]*\)\s*;|\b(?:tool\s*)?arguments?\s*[:=]|^\s*[[{]/i;
const environmentAssignment =
  /(?<![\w])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;'"\\])*/g;
const structuredBody =
  /\{\s*(?:["'}]|[\w-]+\s*:)|\[\s*(?:["'[\]{}]|-?\d|true\b|false\b|null\b)/u;
const invalidFilename = /[\u2028\u2029\\]|^[A-Za-z]:|^~|^file:/u;
type Replacement = { start: number; end: number; value: string };

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
function render(raw: string, replacements: Replacement[]): string {
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Replacement[] = [];
  for (const next of replacements) {
    const previous = merged.at(-1);
    if (previous && next.start < previous.end) {
      previous.end = Math.max(previous.end, next.end);
      previous.value = "[redacted]";
    } else merged.push({ ...next });
  }
  // Inspection is complete. Only rendering is truncated; generated values are
  // never fed back to any detector or secret matcher.
  let result = "";
  let length = 0;
  const append = (value: string): void => {
    for (const point of value) {
      const safe = controls.test(point) ? " " : point;
      length += bytes(safe);
      if (length > 500) break;
      result += safe;
    }
  };
  let cursor = 0;
  for (const replacement of merged) {
    if (length > 500) break;
    append(raw.slice(cursor, replacement.start));
    if (length <= 500) append(replacement.value);
    cursor = replacement.end;
  }
  if (length <= 500) append(raw.slice(cursor));
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
    const orderedSecrets = [...new Set(secrets as string[])].sort(
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
    // Lookahead visits starts inside earlier matches too. Capture only the
    // longest literal at each original position; rendering unions overlaps.
    // At most 64 alternatives / 262144 literal bytes; no nested quantifiers.
    const secretPattern = orderedSecrets.length
      ? new RegExp(
          `(?=(${orderedSecrets
            .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")}))`,
          "g",
        )
      : null;
    const hasSecret = (value: string): boolean =>
      orderedSecrets.some((secret) => value.includes(secret));
    const safeUrl = (value: string): string => {
      if (controls.test(value) || !/^https?:\/\/[^\s]+$/i.test(value))
        return reject();
      // Preserve original authority/path spelling before URL lowercases hosts,
      // removes dot segments, or otherwise canonicalizes retained components.
      const original = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(value);
      if (!original || value.includes("\\")) return reject();
      const retained = `${original[1].slice(original[1].lastIndexOf("@") + 1)}${original[2]}`;
      if (hasSecret(retained) || hasSecret(decodeURIComponent(retained)))
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
        decoded.search(environmentAssignment) !== -1 ||
        structuredBody.test(decoded) ||
        hasSecret(normalized) ||
        hasSecret(decoded) ||
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
        invalidFilename.test(value) ||
        hasSecret(value) ||
        value.replace(credentials, "[redacted]") !== value
      )
        return reject();
      const path = relative(
        root,
        canonicalizePath(root, value, { basePath: root }),
      );
      if (
        !path ||
        bytes(path) > 500 ||
        controls.test(path) ||
        invalidFilename.test(path) ||
        hasSecret(path) ||
        path.replace(credentials, "[redacted]") !== path
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
      if (privateText.test(raw) || structuredBody.test(raw))
        return "[redacted]";
      const replacements: Replacement[] = [];
      const urls: Replacement[] = [];
      const tokens =
        /https?:\/\/[^\s<>"']+|(?<![\w/])(?:file:\/\/|~\/|[A-Za-z]:[\\/]|\\\\|\/)[^\s<>"']*/gi;
      for (const match of raw.matchAll(tokens)) {
        const token = match[0];
        const replacement = {
          start: match.index,
          end: match.index + token.length,
          value: "[redacted]",
        };
        if (/^https?:\/\//i.test(token)) {
          try {
            replacement.value = safeUrl(token);
          } catch {
            /* fixed marker */
          }
          urls.push(replacement);
        } else {
          // Try canonical containment before the broader home prefix.
          try {
            replacement.value = file(token);
          } catch {
            if (
              token === options.homeDirectory ||
              token.startsWith(`${options.homeDirectory}/`) ||
              token.startsWith("~/")
            )
              replacement.value = "[home]";
          }
        }
        replacements.push(replacement);
      }
      // A secret solely inside stripped URL components must not invalidate the
      // safe URL. Retained components were checked above in all spellings.
      const insideUrl = (start: number, end: number): boolean => {
        let low = 0,
          high = urls.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (urls[middle].start <= start) low = middle + 1;
          else high = middle;
        }
        return low > 0 && end <= urls[low - 1].end;
      };
      for (const pattern of [
        credentials,
        environmentAssignment,
        secretPattern,
      ]) {
        if (!pattern) continue;
        for (const match of raw.matchAll(pattern)) {
          const end =
            match.index +
            (pattern === secretPattern ? match[1] : match[0]).length;
          if (!insideUrl(match.index, end))
            replacements.push({ start: match.index, end, value: "[redacted]" });
        }
      }
      return render(raw, replacements);
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
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(stage) || hasSecret(stage))
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
          hasSecret(media_type)
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
