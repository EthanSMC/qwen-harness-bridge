#!/usr/bin/env node
/**
 * Static checks for the private Qwen Skill package.
 *
 * Task 1 ships the package metadata, the seven-tool MCP import template and the
 * transcript schema. The linter proves that contract without running the Skill:
 * private/stable metadata, synchronized SemVer, exactly the seven approved MCP
 * tools on one remote HTTPS server with a secret reference, existing references,
 * no absolute local paths, no credential literals, no unsupported push claim and
 * no RTC route while rtc_mode is false.
 *
 * Rules for material later plan tasks add (SKILL.md front matter, the Chinese
 * speech contract and the transcript fixtures) are implemented now and reported
 * as "not yet present" while the files are missing, so they activate
 * automatically when Task 2/4 land them instead of being silently disabled.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overrideRoot = process.env.QHB_SKILL_LINT_ROOT;
const packageRoot =
  typeof overrideRoot === "string" && overrideRoot.length > 0
    ? resolve(overrideRoot)
    : scriptRoot;
const failures = [];
const notices = [];
const fail = (message) => failures.push(message);
const notice = (message) => notices.push(message);

const MCP_TOOLS = [
  "submit_task",
  "list_tasks",
  "get_task",
  "cancel_task",
  "list_pending_approvals",
  "decide_approval",
  "get_task_result",
];
const UI_TOOLS = ["UiTool.list", "UiTool.all_text", "UiTool.pic_and_text"];
const REQUIRED_METADATA = {
  name: "qwen-harness-bridge",
  display_name: "眼镜任务台",
  visibility: "private",
  language: "zh-CN",
  stable_mode: true,
  rtc_mode: false,
};

const readJson = (name) => {
  const path = join(packageRoot, name);
  if (!existsSync(path)) {
    fail(`missing ${name}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${name} is not valid JSON`);
    return undefined;
  }
};

const insidePackage = (reference) => {
  if (typeof reference !== "string" || reference.length === 0) return false;
  if (/^(?:[A-Za-z]:[\\/]|\/|~)/u.test(reference)) return false;
  const absolute = resolve(packageRoot, reference);
  return !relative(packageRoot, absolute).startsWith("..");
};

const skill = readJson("skill.json");
const pkg = readJson("package.json");
const mcp = readJson("mcp.import.example.json");

if (skill !== undefined) {
  for (const [key, expected] of Object.entries(REQUIRED_METADATA)) {
    if (skill[key] !== expected) {
      fail(`skill.json ${key} must be ${JSON.stringify(expected)}`);
    }
  }
  if (
    typeof skill.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(skill.version)
  ) {
    fail("skill.json version must be a SemVer string");
  }
  if (pkg !== undefined && pkg.version !== skill.version) {
    fail("skill.json version must match the pnpm package version");
  }
  for (const reference of [skill.mcp_import, skill.transcript_schema]) {
    if (!insidePackage(reference)) {
      fail(
        "skill.json references must stay inside the package and be relative",
      );
    } else if (!existsSync(resolve(packageRoot, reference))) {
      fail(`skill.json reference ${reference} does not exist`);
    }
  }
}

if (pkg !== undefined) {
  if (pkg.name !== "@qhb/qwen-skill")
    fail("package.json name must be @qhb/qwen-skill");
  if (pkg.private !== true) fail("package.json must stay private");
  if (typeof pkg.scripts?.lint !== "string")
    fail("package.json lint script is required");
}

if (mcp !== undefined) {
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  if (servers.length !== 1) fail("mcp import must declare exactly one server");
  for (const server of servers) {
    if (typeof server.url !== "string" || !server.url.startsWith("https://")) {
      fail("mcp server url must use https");
    }
    if (server.auth?.type !== "bearer") fail("mcp server auth must be bearer");
    const reference = server.auth?.token_secret_ref;
    if (
      typeof reference !== "string" ||
      !/^\$\{[A-Z][A-Z0-9_]*\}$/u.test(reference)
    ) {
      fail(
        "mcp server must reference the Bearer token as a secret, never a literal",
      );
    }
    const tools = Array.isArray(server.tools) ? server.tools : [];
    if (new Set(tools).size !== tools.length) fail("mcp tools must not repeat");
    for (const tool of tools) {
      if (!MCP_TOOLS.includes(tool)) fail(`mcp tool ${tool} is not approved`);
    }
    if (tools.length !== MCP_TOOLS.length) {
      fail(
        `mcp import must list exactly the ${MCP_TOOLS.length} approved tools`,
      );
    }
  }
}

const validateSkillFrontMatter = (text) => {
  if (!text.startsWith("---\n")) {
    fail("SKILL.md must start with YAML front matter");
    return;
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    fail("SKILL.md front matter is not closed");
    return;
  }
  const frontMatter = text.slice(4, end);
  for (const key of ["name", "description", "version", "language"]) {
    if (!new RegExp(`^\\s*${key}\\s*:\\s*\\S`, "mu").test(frontMatter)) {
      fail(`SKILL.md front matter is missing ${key}`);
    }
  }
  const version = frontMatter.match(/^\s*version\s*:\s*(\S+)/mu)?.[1];
  if (skill !== undefined && version !== skill.version) {
    fail("SKILL.md front matter version must match skill.json");
  }
  for (const tool of [...MCP_TOOLS, ...UI_TOOLS]) {
    if (!text.includes(tool)) fail(`SKILL.md must reference ${tool}`);
  }
};

const validateSpeechContract = (text) => {
  if (!/zh-CN|中文|普通话/u.test(text)) {
    fail(
      "references/speech-contract.md must declare the zh-CN speech templates",
    );
  }
};

const validateFixtureDirectory = (directory) => {
  const entries = readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  );
  if (entries.length === 0) {
    fail("fixtures/transcripts must contain at least one JSON fixture");
    return;
  }
  for (const name of entries) {
    try {
      const fixture = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!Array.isArray(fixture.turns) || fixture.turns.length === 0) {
        fail(`fixture ${name} must declare at least one turn`);
      }
    } catch {
      fail(`fixture ${name} is not valid JSON`);
    }
  }
};

const PLANNED_REFERENCES = [
  { path: "SKILL.md", milestone: "Task 2", validate: validateSkillFrontMatter },
  {
    path: "references/speech-contract.md",
    milestone: "Task 2/4",
    validate: validateSpeechContract,
  },
  {
    path: "fixtures/transcripts",
    milestone: "Task 4",
    validate: validateFixtureDirectory,
  },
];

for (const reference of PLANNED_REFERENCES) {
  const absolute = join(packageRoot, reference.path);
  if (!existsSync(absolute)) {
    notice(
      `${reference.path} is not yet present (planned by ${reference.milestone}); its rule applies automatically once the file lands.`,
    );
    continue;
  }
  if (statSync(absolute).isDirectory()) reference.validate(absolute);
  else reference.validate(readFileSync(absolute, "utf8"));
}

const walk = (directory) => {
  const entries = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) entries.push(...walk(path));
    else entries.push(path);
  }
  return entries;
};

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".yml",
  ".yaml",
]);
// A path is rejected unless it is preceded by a character that makes it part of
// a URL scheme. This keeps Markdown backticks, CJK punctuation, quotes, brackets
// and prose separators working instead of enumerating them as allowed prefixes.
const ABSOLUTE_PATH_PATTERNS = [
  // Windows drive path with either separator (the scheme letter of https:// is
  // preceded by a letter, so a URL never matches).
  /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s"']+/u,
  // POSIX absolute paths under the documented roots (a double slash keeps a URL
  // host such as https://Users from matching).
  /(?<![A-Za-z0-9/])\/(?:Users|home|root|private|tmp|var|Volumes)\/[^\s"']+/u,
  // Windows UNC share.
  /(?<![A-Za-z0-9\\])\\\\[A-Za-z0-9._$-]+\\[^\s"']+/u,
  // Forward-slash UNC form; a URL scheme is excluded because its "//" follows ":".
  /(?<![A-Za-z0-9:])\/\/[A-Za-z0-9._-]+\/[^\s"']+/u,
  // Local file URLs are absolute by construction.
  /file:\/\/\/[^\s"']+/u,
];
const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/u,
  /Bearer\s+[A-Za-z0-9._-]{8,}/u,
  /"(?:token|secret|password|api_key)"\s*:\s*"(?!\$\{)[^"]{8,}"/u,
];
const PUSH_CLAIM_PATTERN = /push notification|push通知|后台推送|主动推送/iu;
const RTC_ROUTE_PATTERN = /rtc[_"]?(?:url|endpoint|route|server)/iu;

for (const path of walk(packageRoot)) {
  if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) continue;
  // This linter defines the patterns it enforces; scanning its own source would
  // match them literally.
  if (relative(packageRoot, path) === join("scripts", "lint-skill.mjs"))
    continue;
  const text = readFileSync(path, "utf8");
  const label = relative(packageRoot, path);
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    if (pattern.test(text)) fail(`${label} contains an absolute local path`);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) fail(`${label} contains a credential literal`);
  }
  if (PUSH_CLAIM_PATTERN.test(text))
    fail(`${label} claims an unsupported push route`);
  if (RTC_ROUTE_PATTERN.test(text))
    fail(`${label} declares an RTC route while rtc_mode is false`);
}

if (failures.length > 0) {
  console.error("Skill package lint failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  for (const message of notices) console.log(`Skill package lint: ${message}`);
  console.log(
    "Skill package lint passed: private zh-CN stable metadata, synchronized SemVer, seven-tool HTTPS MCP import with a secret reference, no local paths, credential literals, push claim or RTC route.",
  );
}
