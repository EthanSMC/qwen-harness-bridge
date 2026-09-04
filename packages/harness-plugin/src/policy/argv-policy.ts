import { fileURLToPath } from "node:url";
import { CanonicalPathError } from "./canonical-path.js";

type Role = "path" | "data" | "flag" | "number";
export type ParsedArguments = {
  argv: string[];
  paths: string[];
  search: "content" | "names" | undefined;
  destructive: boolean;
};

const unsupported = (): never => {
  throw new CanonicalPathError("UNSUPPORTED_ARGUMENTS");
};
const options = (
  flags: string[],
  paths: string[],
  data: string[] = [],
  numbers: string[] = [],
): Map<string, Role> =>
  new Map([
    ...flags.map((name) => [name, "flag"] as const),
    ...paths.map((name) => [name, "path"] as const),
    ...data.map((name) => [name, "data"] as const),
    ...numbers.map((name) => [name, "number"] as const),
  ]);

const searchOptions = (command: string) =>
  options(
    [
      "-i",
      "-n",
      "-l",
      "-c",
      "-q",
      "-v",
      "-F",
      "-w",
      "-x",
      "-H",
      "-h",
      "--ignore-case",
      "--line-number",
      "--files-with-matches",
      "--count",
      "--quiet",
      "--invert-match",
      "--fixed-strings",
      "--word-regexp",
      "--line-regexp",
      ...(command === "rg"
        ? [
            "--files",
            "--hidden",
            "--no-ignore",
            "--no-config",
            "--no-heading",
            "--heading",
            "--json",
            "--stats",
            "-S",
            "--smart-case",
          ]
        : ["-r", "--recursive", "-E", "--extended-regexp"]),
    ],
    ["-f", "--file"],
    [
      "-e",
      "--regexp",
      ...(command === "rg"
        ? ["-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not"]
        : ["--include", "--exclude", "--exclude-dir"]),
    ],
    [
      "-A",
      "-B",
      "-C",
      "-m",
      "--after-context",
      "--before-context",
      "--context",
      "--max-count",
      ...(command === "rg" ? ["--max-depth"] : []),
    ],
  );

const compilerOptions = options(
  [
    "--noEmit",
    "--incremental",
    "--composite",
    "--declaration",
    "--declarationMap",
    "--sourceMap",
    "--emitDeclarationOnly",
    "--pretty",
    "--strict",
    "--skipLibCheck",
    "--listFiles",
    "--listEmittedFiles",
    "--build",
    "-b",
    "--clean",
    "--force",
    "--verbose",
  ],
  [
    "--outDir",
    "--outFile",
    "--rootDir",
    "--declarationDir",
    "--tsBuildInfoFile",
    "--project",
    "-p",
    "-o",
  ],
  ["--target", "--module", "--moduleResolution", "--lib", "--jsx"],
);
const testOptions = options(
  ["--coverage", "--runInBand", "--passWithNoTests", "--silent", "--no-color"],
  [
    "--coverage.reportsDirectory",
    "--outputFile",
    "--dir",
    "--root",
    "--config",
  ],
  ["--reporter", "--testNamePattern", "-t"],
  ["--maxWorkers", "--minWorkers"],
);

/** Bounded grammars: only operand/option roles authorize path resolution. */
export function parseArguments(
  command: string | undefined,
  tool: string,
  input: readonly string[],
  path: (value: string) => string,
  cwd: string,
): ParsedArguments {
  const result: ParsedArguments = {
    argv: [],
    paths: [],
    search: undefined,
    destructive: false,
  };
  const pathValue = (value: string): string => {
    if (
      value.startsWith("-") ||
      value.length === 0 ||
      /^(?:&&|\|\||[;&|])$/u.test(value)
    )
      return unsupported();
    if (value.startsWith("file://")) value = fileURLToPath(value);
    const canonical = path(value);
    result.paths.push(canonical);
    return canonical;
  };
  if (command === undefined) {
    // Native writes carry source/data in argv, and their paths in touchedPaths.
    const fileOperands =
      /^(read_file|read|file_read|delete_file|remove_file)$/u.test(tool);
    result.argv = input.map((value) =>
      fileOperands ? pathValue(value) : value,
    );
    return result;
  }

  let grammar: Map<string, Role>;
  let start = 0;
  let explicitPattern = false;
  const searchOperands: number[] = [];
  if (command === "rg" || command === "grep") {
    grammar = searchOptions(command);
    result.search = "content";
  } else if (command === "tsc") {
    grammar = compilerOptions;
    result.destructive = input.includes("--clean");
    if (
      result.destructive &&
      !input.some((arg) => arg === "--build" || arg === "-b")
    )
      unsupported();
  } else if (command === "vitest") {
    if (input[0] !== "run") unsupported();
    grammar = testOptions;
    start = 1;
  } else if (["pnpm", "npm", "yarn", "bun"].includes(command)) {
    start = input[0] === "run" || input[0] === "run-script" ? 2 : 1;
    const script = input[start - 1];
    if (script !== "test" && script !== "build") {
      // Explicit administrative commands never gain automatic runner semantics.
      if (
        !/^(install|ci|i|add|remove|rm|update|upgrade|link)$/u.test(
          input[0] ?? "",
        )
      )
        unsupported();
      result.argv = [...input];
      return result;
    }
    grammar = script === "test" ? testOptions : compilerOptions;
  } else {
    // These commands can only reach approval/denial, never automatic execution.
    result.argv = [...input];
    return result;
  }
  result.argv.push(...input.slice(0, start));
  let operandsOnly = false;
  for (let index = start; index < input.length; index++) {
    const argument = input[index] as string;
    if (!operandsOnly && argument === "--") {
      result.argv.push(argument);
      // Package managers forward the separator to their known runner grammar.
      operandsOnly = !["pnpm", "npm", "yarn", "bun"].includes(command);
      continue;
    }
    if (!operandsOnly && argument.startsWith("-")) {
      let name = argument;
      let attached: string | undefined;
      let prefix = "";
      const equals = argument.indexOf("=");
      if (equals >= 0) {
        name = argument.slice(0, equals);
        attached = argument.slice(equals + 1);
        prefix = `${name}=`;
      } else if (!grammar.has(name) && /^-[^-].+/u.test(argument)) {
        name = argument.slice(0, 2);
        attached = argument.slice(2);
        prefix = name;
        if (grammar.get(name) === "flag") {
          if (
            ![...argument.slice(1)].every(
              (flag) => grammar.get(`-${flag}`) === "flag",
            )
          )
            unsupported();
          result.argv.push(argument);
          continue;
        }
      }
      const role = grammar.get(name);
      if (role === undefined || (role === "flag" && attached !== undefined))
        unsupported();
      if (role === "flag") {
        if (name === "--files") result.search = "names";
        result.argv.push(argument);
        continue;
      }
      const value = attached ?? input[++index];
      if (value === undefined || value.length === 0) unsupported();
      if (["-e", "--regexp", "-f", "--file"].includes(name))
        explicitPattern = true;
      if (
        name === "--reporter" &&
        ![
          "default",
          "basic",
          "verbose",
          "dot",
          "json",
          "junit",
          "tap",
          "github-actions",
        ].includes(value)
      )
        unsupported();
      if (role === "number" && !/^\d+$/u.test(value)) {
        if (value === "..") throw new CanonicalPathError("PATH_TRAVERSAL");
        unsupported();
      }
      const canonical = role === "path" ? pathValue(value) : value;
      if (attached === undefined) result.argv.push(name, canonical);
      else result.argv.push(prefix + canonical);
    } else if (result.search !== undefined) {
      searchOperands.push(result.argv.length);
      result.argv.push(argument);
    } else result.argv.push(pathValue(argument));
  }
  if (result.search === "names" && explicitPattern) unsupported();
  if (result.search === "content" && !explicitPattern) {
    if (searchOperands.length === 0) unsupported();
    searchOperands.shift(); // the first positional operand is regex/data
  }
  for (const index of searchOperands)
    result.argv[index] = pathValue(result.argv[index] as string);
  if (
    result.search !== undefined &&
    searchOperands.length === 0 &&
    command === "rg"
  )
    result.paths.push(cwd);
  return result;
}
