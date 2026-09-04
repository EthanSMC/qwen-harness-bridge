import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CanonicalPathError } from "./canonical-path.js";

type Role = "path" | "data" | "flag" | "number";
export type ParsedArguments = {
  argv: string[];
  paths: string[];
  search: "content" | "names" | undefined;
  searchOperands: string[];
  selection: string[];
  noConfig: boolean;
  destructive: boolean;
  administrative: "install" | "push" | "deploy" | undefined;
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

const installOptions = (command: string) =>
  options(
    [
      "--ignore-scripts",
      "--offline",
      "--prefer-offline",
      "--save-dev",
      "--save-exact",
      "--no-save",
      ...(command === "npm"
        ? ["--package-lock-only"]
        : ["--frozen-lockfile", "--lockfile-only"]),
    ],
    [
      "--userconfig",
      "--globalconfig",
      "--cache",
      ...(command === "npm" ? ["--prefix"] : ["--dir", "-C"]),
    ],
  );
const deploymentOptions = options(
  ["--prod", "--prebuilt", "--force", "--yes"],
  ["--cwd", "--local-config"],
);
const pushOptions = options(
  [
    "--force",
    "--force-with-lease",
    "--dry-run",
    "--delete",
    "--tags",
    "--all",
    "--set-upstream",
    "-u",
  ],
  [],
);
const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Bounded grammars: only operand/option roles authorize path resolution. */
export function parseArguments(
  command: string | undefined,
  tool: string,
  input: readonly string[],
  path: (value: string, base?: string) => string,
  cwd: string,
): ParsedArguments {
  const result: ParsedArguments = {
    argv: [],
    paths: [],
    search: undefined,
    searchOperands: [],
    selection: [],
    noConfig: false,
    destructive: false,
    administrative: undefined,
  };
  let commandCwd = cwd;
  const pathValue = (value: string): string => {
    if (
      value.startsWith("-") ||
      value.length === 0 ||
      /^(?:&&|\|\||[;&|])$/u.test(value)
    )
      return unsupported();
    if (value.startsWith("file://")) value = fileURLToPath(value);
    const canonical = path(value, commandCwd);
    result.paths.push(canonical);
    return canonical;
  };
  if (command === undefined) {
    if (
      ["package_install", "git_push", "deploy"].includes(tool) &&
      input.length !== 0
    )
      unsupported();
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
  let administrative: "install" | "push" | "deploy" | undefined;
  let prefixChanged = false;
  let operandCount = 0;
  let compilerBuild = false;
  let explicitPattern = false;
  const searchOperands: number[] = [];
  if (command === "rg" || command === "grep") {
    grammar = searchOptions(command);
    result.search = "content";
  } else if (command === "tsc") {
    grammar = compilerOptions;
  } else if (command === "vitest") {
    if (input[0] !== "run") unsupported();
    grammar = testOptions;
    start = 1;
  } else if (["pnpm", "npm", "yarn", "bun"].includes(command)) {
    start = input[0] === "run" || input[0] === "run-script" ? 2 : 1;
    const script = input[start - 1];
    if (script !== "test" && script !== "build") {
      const installCommands =
        command === "npm"
          ? ["install", "ci", "i"]
          : command === "pnpm"
            ? ["install", "i", "add"]
            : [];
      if (!installCommands.includes(input[0] ?? "")) unsupported();
      administrative = "install";
      start = 1;
      grammar = installOptions(command);
    } else {
      grammar = script === "test" ? testOptions : compilerOptions;
    }
  } else if (command === "git") {
    if (input[0] === "-C" || input[0]?.startsWith("-C")) {
      const attached = input[0] !== "-C";
      const value = attached ? input[0].slice(2) : input[1];
      if (!value) unsupported();
      commandCwd = pathValue(value);
      result.argv.push(
        ...(attached ? [`-C${commandCwd}`] : ["-C", commandCwd]),
      );
      start = attached ? 1 : 2;
    }
    if (input[start] !== "push") unsupported();
    result.argv.push("push");
    start++;
    administrative = "push";
    grammar = pushOptions;
  } else if (command === "vercel" || command === "npx") {
    start = command === "npx" ? 2 : 1;
    if (
      input[start - 1] !== "deploy" ||
      (command === "npx" && input[0] !== "vercel")
    )
      unsupported();
    administrative = "deploy";
    grammar = deploymentOptions;
  } else {
    return unsupported();
  }
  result.administrative = administrative;
  if (command !== "git") result.argv.push(...input.slice(0, start));
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
      if (
        equals >= 0 &&
        (argument.startsWith("--") || (command === "rg" && equals === 2))
      ) {
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
        if (grammar === compilerOptions) {
          if (name === "--clean") result.destructive = true;
          if (name === "--build" || name === "-b") compilerBuild = true;
        }
        if (name === "--files") result.search = "names";
        if (name === "--no-config") result.noConfig = true;
        if (["--hidden", "--no-ignore"].includes(name))
          result.selection.push(name);
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
      if (
        command === "rg" &&
        [
          "-g",
          "--glob",
          "--iglob",
          "-t",
          "--type",
          "-T",
          "--type-not",
          "--max-depth",
        ].includes(name)
      )
        result.selection.push(name, value);
      if (
        administrative &&
        ["--prefix", "--dir", "-C", "--cwd"].includes(name)
      ) {
        if (prefixChanged || operandCount !== 0 || result.paths.length !== 1)
          unsupported();
        prefixChanged = true;
        // Mixed context-changing options and additional relative resources are unsupported.
      } else if (
        administrative &&
        prefixChanged &&
        role === "path" &&
        !isAbsolute(value)
      )
        unsupported();
      if (attached === undefined) result.argv.push(name, canonical);
      else result.argv.push(prefix + canonical);
    } else if (result.search !== undefined) {
      searchOperands.push(result.argv.length);
      result.argv.push(argument);
    } else if (administrative === "install") {
      operandCount++;
      if (argument.startsWith("file:")) {
        if (prefixChanged) unsupported();
        result.argv.push(`file:${pathValue(argument.slice(5))}`);
      } else if (
        isAbsolute(argument) ||
        /^\.{1,2}(?:[/\\]|$)/u.test(argument) ||
        exists(resolve(commandCwd, argument))
      ) {
        if (prefixChanged) unsupported();
        result.argv.push(pathValue(argument));
      } else if (
        /^(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+(?:@[-a-zA-Z0-9.*^~+]+)?$/u.test(
          argument,
        ) ||
        /^https:\/\/[^\s]+$/u.test(argument)
      )
        result.argv.push(argument);
      else unsupported();
    } else if (administrative === "push") {
      operandCount++;
      if (operandCount === 1) {
        if (isAbsolute(argument) || /^\.{1,2}(?:[/\\]|$)/u.test(argument))
          result.argv.push(pathValue(argument));
        else if (
          /^(?:https|ssh):\/\/[^\s]+$/u.test(argument) ||
          /^git@[^\s:]+:[^\s]+$/u.test(argument)
        )
          result.argv.push(argument);
        else if (
          /^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(argument) &&
          !exists(resolve(commandCwd, argument))
        )
          result.argv.push(argument);
        else unsupported();
      } else if (
        /^\+?(?:[A-Za-z0-9_*][A-Za-z0-9_*/.-]*)?(?::[A-Za-z0-9_*][A-Za-z0-9_*/.-]*)?$/u.test(
          argument,
        ) &&
        !argument.includes("..")
      )
        result.argv.push(argument);
      else unsupported();
    } else if (administrative === "deploy") {
      if (operandCount++ !== 0 || prefixChanged) unsupported();
      result.argv.push(pathValue(argument));
    } else result.argv.push(pathValue(argument));
  }
  if (result.destructive && !compilerBuild) unsupported();
  if (result.search === "names" && explicitPattern) unsupported();
  if (result.search === "content" && !explicitPattern) {
    if (searchOperands.length === 0) unsupported();
    searchOperands.shift(); // the first positional operand is regex/data
  }
  for (const index of searchOperands) {
    // rg glob matching depends on the original explicit operand spelling.
    // Validate it now, but only canonicalize selected filenames after enumeration.
    result.searchOperands.push(result.argv[index] as string);
    result.argv[index] = pathValue(result.argv[index] as string);
  }
  // grep's implicit stdin/recursive-cwd modes vary across implementations.
  if (command === "grep" && searchOperands.length === 0) unsupported();
  if (
    result.search !== undefined &&
    searchOperands.length === 0 &&
    command === "rg"
  )
    result.paths.push(cwd);
  return result;
}
