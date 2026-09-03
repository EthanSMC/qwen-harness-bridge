import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const absolute = (path: string): string => join(repositoryRoot, path);
const read = (path: string): string => readFileSync(absolute(path), "utf8");
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const yamlMappingBlock = (
  source: string,
  parentName: string,
  childName: string,
): string => {
  const lines = source.split("\n");
  const mappingLine = (name: string): RegExp =>
    new RegExp(
      `^(\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:\\s*(?:#.*)?$`,
    );
  const parentMatch = lines
    .map((line, index) => ({
      index,
      match: line.match(mappingLine(parentName)),
    }))
    .find(({ match }) => match !== null);
  expect(parentMatch, `missing YAML mapping ${parentName}`).toBeDefined();
  const parentIndex = parentMatch?.index ?? -1;
  const parentIndent = parentMatch?.match?.[1].length ?? -1;
  const start = lines.findIndex((line, index) => {
    if (
      index <= parentIndex ||
      line.trim().length === 0 ||
      line.trimStart().startsWith("#")
    ) {
      return false;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) return false;
    return mappingLine(childName).test(line);
  });
  expect(
    start,
    `missing YAML mapping ${childName} under ${parentName}`,
  ).toBeGreaterThan(-1);
  const childIndent =
    (lines[start]?.length ?? 0) - (lines[start]?.trimStart().length ?? 0);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.trim().length > 0 &&
      !line.trimStart().startsWith("#") &&
      line.length - line.trimStart().length <= childIndent,
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
};

const workflowStepIndex = (workflow: string, name: string): number => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`^(\\s*)-\\s+name:\\s*${escapedName}\\s*$`);
  const lines = workflow.split("\n");
  const occurrences = lines
    .map((line, index) => (marker.test(line) ? index : -1))
    .filter((index) => index !== -1);
  expect(occurrences, `workflow step ${name} must be unique`).toHaveLength(1);
  const start = occurrences[0] ?? -1;
  expect(start, `missing workflow step ${name}`).toBeGreaterThan(-1);
  return start;
};

const workflowStep = (workflow: string, name: string): string => {
  const lines = workflow.split("\n");
  const start = workflowStepIndex(workflow, name);
  const stepIndent = lines[start]?.length ?? 0;
  const stepPrefixLength = lines[start]?.trimStart().length ?? 0;
  const indentation = stepIndent - stepPrefixLength;
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.trim().length > 0 &&
      !line.trimStart().startsWith("#") &&
      line.length - line.trimStart().length <= indentation &&
      /^\s*(?:-|[A-Za-z_][A-Za-z0-9_-]*:)/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
};

const copyWorkingTree = (): string => {
  const target = mkdtempSync(join(tmpdir(), "qhb-runtime-build-"));
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (path) =>
        path.length > 0 &&
        !path.startsWith(".superpowers/") &&
        !path.includes("/dist/"),
    );
  for (const path of files) {
    const destination = join(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(absolute(path), destination);
  }
  return target;
};

const buildEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const finalDockerStage = (dockerfile: string): string => {
  const stages = dockerStageBlocks(dockerfile);
  expect(stages.length).toBeGreaterThanOrEqual(2);
  for (const stage of stages) {
    expect(stage.split("\n")[0]).toMatch(
      /^FROM\s+(?:--\S+\s+)*\S+@sha256:[0-9a-f]{64}(?:\s|$)/i,
    );
  }
  const finalStage = stages.at(-1);
  expect(finalStage).toBeDefined();
  return finalStage ?? "";
};

const dockerfileInstructions = (stage: string): string[] => {
  const instructions: string[] = [];
  let pending = "";
  for (const line of stage.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    pending = `${pending} ${trimmed}`.trim();
    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1).trim();
      continue;
    }
    instructions.push(pending);
    pending = "";
  }
  if (pending.length > 0) instructions.push(pending);
  return instructions;
};

const normalizeDockerPath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

const dockerStageBlocks = (dockerfile: string): string[] =>
  dockerfile.split(/(?=^FROM\s+)/im).filter((stage) => /^FROM\s+/i.test(stage));

const dockerStageName = (stage: string): string | undefined =>
  stage
    .split("\n")[0]
    ?.match(/^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?/i)?.[1]
    ?.toLowerCase();

const dockerStageWorkdir = (stage: string): string | undefined => {
  const workdir = dockerfileInstructions(stage)
    .filter((instruction) => /^WORKDIR\s+/i.test(instruction))
    .at(-1)
    ?.match(/^WORKDIR\s+(\S+)/i)?.[1];
  return workdir === undefined ? undefined : normalizeDockerPath(workdir);
};

const dockerCopyOperands = (
  instruction: string,
): { from: string; sources: string[]; destination: string } => {
  const tokens = instruction
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((token) => token.replace(/^[\x5b"']+|[\x5d"',]+$/g, ""))
    .filter((token) => token.length > 0);
  const options: string[] = [];
  const operands: string[] = [];
  for (const token of tokens) {
    if (operands.length === 0 && token.startsWith("--")) {
      options.push(token);
    } else {
      operands.push(token);
    }
  }
  const from = options.find((option) => option.startsWith("--from="));
  expect(
    from,
    `final-stage COPY must use --from: ${instruction}`,
  ).toBeDefined();
  expect(
    operands.length,
    `COPY must have at least one source and one destination: ${instruction}`,
  ).toBeGreaterThanOrEqual(2);
  return {
    from: (from ?? "--from=").slice("--from=".length).toLowerCase(),
    sources: operands.slice(0, -1),
    destination: operands.at(-1) ?? "",
  };
};

const runtimeCopyAllowlist = new Set([
  "node_modules",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/control-plane/package.json",
  "apps/control-plane/dist",
  "packages/protocol/package.json",
  "packages/protocol/dist",
]);

const runtimeCopyKey = (source: string): string | undefined => {
  const normalized = normalizeDockerPath(source);
  return [...runtimeCopyAllowlist]
    .sort((left, right) => right.length - left.length)
    .find((key) => {
      const path = `/${key}`;
      return (
        normalized === path ||
        normalized.startsWith(`${path}/`) ||
        normalized.endsWith(path)
      );
    });
};

const expectBoundedPolling = (step: string): void => {
  expect(step).toMatch(/for\s+attempt\s+in\s+\$\(seq\s+1\s+[1-9][0-9]*\)/);
  expect(step).toMatch(
    /(?:test|\[|\(\()[\s\S]*\$attempt[\s\S]*(?:[1-9][0-9]*|\$[A-Z_]+)[\s\S]*\bexit\s+1/,
  );
  expect(step).toContain("sleep 1");
};

const normalizedWorkflowCommands = (workflow: string): string[] =>
  workflow.replace(/\\\r?\n\s*/g, " ").match(/\bdocker compose\b[^\n]*/g) ?? [];

describe("release runtime build contract", () => {
  it("freshly builds non-empty executable artifacts and exact migrations", () => {
    const buildRoot = copyWorkingTree();
    const built = (path: string): string => join(buildRoot, path);
    const readBuilt = (path: string): string =>
      readFileSync(built(path), "utf8");
    try {
      for (const path of [
        "packages/protocol/dist",
        "apps/control-plane/dist",
      ]) {
        expect(existsSync(built(path))).toBe(false);
      }
      const environment = buildEnvironment();
      execFileSync(
        "pnpm",
        ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
        {
          cwd: buildRoot,
          env: environment,
          stdio: "pipe",
        },
      );
      execFileSync("pnpm", ["build"], {
        cwd: buildRoot,
        env: environment,
        stdio: "pipe",
      });

      const javascript = [
        "packages/protocol/dist/index.js",
        "apps/control-plane/dist/main.js",
        "apps/control-plane/dist/db/migrate.js",
      ];
      const assets = [
        ...javascript,
        "packages/protocol/dist/index.d.ts",
        "apps/control-plane/dist/db/migrations/meta/_journal.json",
        "apps/control-plane/dist/db/migrations/0002_result_acknowledgement.sql",
      ];
      for (const path of assets) {
        expect(existsSync(built(path)), path).toBe(true);
        expect(
          statSync(built(path)).size,
          `${path} must not be empty`,
        ).toBeGreaterThan(0);
      }
      for (const path of javascript) {
        execFileSync(process.execPath, ["--check", built(path)], {
          stdio: "pipe",
        });
      }
      const compiledTests = execFileSync(
        "find",
        [
          built("packages/protocol/dist"),
          built("apps/control-plane/dist"),
          "-type",
          "f",
          "(",
          "-name",
          "*.test.js",
          "-o",
          "-name",
          "*.test.d.ts",
          ")",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      expect(compiledTests).toBe("");
      expect(readBuilt("packages/protocol/dist/index.d.ts")).toMatch(
        /\bexport\b/,
      );
      const journal = JSON.parse(
        readBuilt("apps/control-plane/dist/db/migrations/meta/_journal.json"),
      ) as { entries?: Array<{ tag?: string; when?: number }> };
      expect(journal.entries?.at(-1)).toMatchObject({
        tag: "0002_result_acknowledgement",
        when: 1788244364352,
      });
      expect(
        createHash("sha256")
          .update(
            readBuilt(
              "apps/control-plane/dist/db/migrations/0002_result_acknowledgement.sql",
            ),
          )
          .digest("hex"),
      ).toBe(
        "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
      );

      const protocol = JSON.parse(
        readBuilt("packages/protocol/package.json"),
      ) as {
        exports?: { "."?: { types?: string; default?: string } };
        scripts?: { build?: string };
      };
      const controlPlane = JSON.parse(
        readBuilt("apps/control-plane/package.json"),
      ) as {
        scripts?: { build?: string; migrate?: string; start?: string };
      };
      expect(protocol.scripts?.build).toMatch(/\btsc\b/);
      expect(protocol.exports?.["."]?.types).toBe("./dist/index.d.ts");
      expect(protocol.exports?.["."]?.default).toBe("./dist/index.js");
      expect(controlPlane.scripts?.build).toMatch(/\btsc\b/);
      expect(controlPlane.scripts?.build).toMatch(/migration/i);
      expect(controlPlane.scripts?.migrate).toMatch(/dist\/db\/migrate\.js/);
      expect(controlPlane.scripts?.start).toMatch(/dist\/main\.js/);
    } finally {
      rmSync(buildRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses a pinned multi-stage image whose final stage is non-root", () => {
    const dockerfile = read("apps/control-plane/Dockerfile");
    const dockerignore = read(".dockerignore");
    const finalStage = finalDockerStage(dockerfile);
    const instructions = dockerfileInstructions(finalStage);
    const user = instructions.filter((line) => /^USER\s+/i.test(line)).at(-1);
    const command = instructions.filter((line) => /^CMD\s+/i.test(line)).at(-1);

    expect(user).toMatch(/^USER\s+(?!root(?:\s|$)|0(?:\s|$))\S+/i);
    expect(command).toMatch(
      /^CMD\s+\[\s*"node"\s*,\s*"apps\/control-plane\/dist\/main\.js"\s*\]$/i,
    );
    expect(finalStage).not.toMatch(/\b(tsx|ts-node)\b/i);
    expect(finalStage).not.toMatch(
      /(?:^|[/\s])(?:src|tests|\.git|\.env)(?:[/\s]|$)/m,
    );
    expect(instructions.filter((line) => /^ADD\s+/i.test(line))).toHaveLength(
      0,
    );
    expect(instructions.filter((line) => /^RUN\s+/i.test(line))).toHaveLength(
      0,
    );

    const finalCopies = instructions.filter((line) => /^COPY\s+/i.test(line));
    const stages = dockerStageBlocks(dockerfile);
    const stagesByName = new Map(
      stages
        .map((stage, index) => [dockerStageName(stage), index] as const)
        .filter((entry): entry is [string, number] => entry[0] !== undefined),
    );
    const finalWorkdir = dockerStageWorkdir(finalStage);
    expect(finalWorkdir).toBeDefined();
    const observedCopies = new Set<string>();
    for (const copy of finalCopies) {
      const { from, sources, destination } = dockerCopyOperands(copy);
      const sourceStageIndex =
        from.match(/^\d+$/)?.[0] !== undefined
          ? Number(from)
          : stagesByName.get(from);
      expect(
        sourceStageIndex,
        `COPY source stage must exist: ${from}`,
      ).toBeDefined();
      expect(sourceStageIndex ?? -1).toBeLessThan(stages.length - 1);
      const destinationPath = destination.startsWith("/")
        ? normalizeDockerPath(destination)
        : normalizeDockerPath(`${finalWorkdir ?? "/"}/${destination}`);
      expect(
        destinationPath === finalWorkdir ||
          destinationPath.startsWith(`${finalWorkdir}/`),
        `final-stage COPY must stay under ${finalWorkdir}: ${copy}`,
      ).toBe(true);
      for (const source of sources) {
        const sourceKey = runtimeCopyKey(source);
        expect(
          sourceKey,
          `disallowed final-stage COPY source: ${source}`,
        ).toBeDefined();
        const target =
          sources.length === 1
            ? destinationPath
            : normalizeDockerPath(
                `${destinationPath}/${source.split("/").at(-1) ?? ""}`,
              );
        const expectedTarget = `${finalWorkdir}/${sourceKey ?? ""}`;
        expect(
          target,
          `disallowed final-stage COPY destination: ${target}`,
        ).toBe(expectedTarget);
        expect(
          observedCopies.has(sourceKey ?? ""),
          `duplicate final-stage COPY source: ${sourceKey}`,
        ).toBe(false);
        observedCopies.add(sourceKey ?? "");
      }
    }
    expect([...observedCopies].sort()).toEqual(
      [...runtimeCopyAllowlist].sort(),
    );

    const ignored = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(
      ignored.filter((entry) => entry.startsWith("!")),
      ".dockerignore must not re-include any path",
    ).toHaveLength(0);
    for (const entry of [
      ".git",
      ".env",
      ".env.*",
      "node_modules",
      "tests",
      ".superpowers",
      ".pnpm-store",
      "coverage",
      "dist",
      "*.log",
      "**/*.key",
      "**/*.pem",
      "**/*.crt",
      "**/*.cert",
      "**/*.p12",
    ]) {
      expect(ignored).toContain(entry);
    }
  });

  it("scopes migration and readiness wiring to the correct Compose services", () => {
    const compose = read("docker-compose.yml");
    const postgres = yamlMappingBlock(compose, "services", "postgres");
    const migrate = yamlMappingBlock(compose, "services", "migrate");
    const controlPlane = yamlMappingBlock(compose, "services", "control-plane");

    expect(postgres).toMatch(/image:\s*postgres:16-alpine@sha256:[0-9a-f]{64}/);
    expect(migrate).toMatch(/restart:\s*(?:["']?no["']?|false)/);
    expect(migrate).toMatch(
      /(?:command:|entrypoint:)[\s\S]*dist\/db\/migrate\.js/,
    );
    const migrationDependencies = yamlMappingBlock(
      migrate,
      "depends_on",
      "postgres",
    );
    expect(migrationDependencies).toMatch(/condition:\s*service_healthy/);
    const controlMigration = yamlMappingBlock(
      controlPlane,
      "depends_on",
      "migrate",
    );
    expect(controlMigration).toContain(
      "condition: service_completed_successfully",
    );
    expect(controlPlane).toContain("/health/ready");
    expect(controlPlane).toContain(
      "127.0.0.1:$" + "{CONTROL_PLANE_PORT:-8443}:8443",
    );
    expect(controlPlane).toMatch(/secrets:[\s\S]*qhb_tls_cert/);
    expect(controlPlane).toMatch(/secrets:[\s\S]*qhb_tls_key/);
    expect(controlPlane).toContain(
      "QHB_TLS_CERT_PATH: /run/secrets/qhb_tls_cert",
    );
    expect(controlPlane).toContain(
      "QHB_TLS_KEY_PATH: /run/secrets/qhb_tls_key",
    );
    expect(controlPlane).not.toMatch(/QHB_TLS_(?:CERT|KEY)\s*:/);
  });

  it("has an executable PR Docker gate with evidence and unconditional cleanup", () => {
    const workflow = read(".github/workflows/runtime.yml");
    const runtimeJob = yamlMappingBlock(workflow, "jobs", "runtime");
    const orderedSteps = [
      "Generate ephemeral runtime material",
      "Build and start runtime",
      "Verify healthy runtime",
      "Inspect effective runtime image",
      "Verify database failure separation",
      "Capture runtime evidence",
      "Upload runtime evidence",
      "Cleanup runtime",
    ];
    const stepIndexes = orderedSteps.map((name) =>
      workflowStepIndex(runtimeJob, name),
    );
    expect(stepIndexes).toEqual(
      [...stepIndexes].sort((left, right) => left - right),
    );
    const material = workflowStep(
      runtimeJob,
      "Generate ephemeral runtime material",
    );
    const start = workflowStep(runtimeJob, "Build and start runtime");
    const healthy = workflowStep(runtimeJob, "Verify healthy runtime");
    const image = workflowStep(runtimeJob, "Inspect effective runtime image");
    const databaseLoss = workflowStep(
      runtimeJob,
      "Verify database failure separation",
    );
    const evidence = workflowStep(runtimeJob, "Capture runtime evidence");
    const upload = workflowStep(runtimeJob, "Upload runtime evidence");
    const cleanup = workflowStep(runtimeJob, "Cleanup runtime");

    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(material).toContain("set -euo pipefail");
    expect(material).toMatch(
      /(?:runtime_dir|RUNTIME_DIR)\s*=\s*["']?\$\(mktemp\s+-d/,
    );
    expect(material).toContain("umask 077");
    expect(material).toMatch(/chmod\s+700\b/);
    expect(material).toMatch(/chmod\s+600[^\n]*RUNTIME_ENV_FILE/i);
    expect(material).toMatch(/chmod\s+600[^\n]*(?:cert|key)/i);
    expect(material).toMatch(/openssl\s+req[\s\S]*-x509/i);
    expect(material).toMatch(
      /openssl\s+req[\s\S]*-keyout[\s\S]*-out[\s\S]*127\.0\.0\.1/i,
    );
    expect(material).toMatch(
      /openssl\s+req[\s\S]*-keyout\s+["']?\$QHB_TLS_KEY_FILE["']?/i,
    );
    expect(material).toMatch(
      /openssl\s+req[\s\S]*-out\s+["']?\$QHB_TLS_CERT_FILE["']?/i,
    );
    expect(material).toMatch(/subjectAltName\s*=\s*IP:127\.0\.0\.1/i);
    expect(material).not.toMatch(/echo[^\n]*\$\([^\n]*openssl/);
    const randomNames = [
      "POSTGRES_PASSWORD",
      "QHB_OWNER_ID",
      "QHB_MCP_BEARER_TOKEN",
      "QHB_REQUEST_ENCRYPTION_KEY",
      "QHB_CONNECTOR_SESSION_SIGNING_KEY",
    ];
    for (const name of randomNames) {
      const randomAssignment = material.match(
        new RegExp(
          `${name}\\s*=\\s*\\$\\(openssl\\s+rand\\b(?:\\s+--?[A-Za-z0-9_-]+)*\\s+(\\d+)\\b`,
        ),
      );
      expect(randomAssignment, `${name} must use openssl rand`).not.toBeNull();
      expect(Number(randomAssignment?.[1])).toBeGreaterThanOrEqual(32);
    }
    const uniquenessOffset = material.indexOf("sort -u");
    expect(uniquenessOffset).toBeGreaterThan(-1);
    const uniquenessWindow = material.slice(
      Math.max(0, uniquenessOffset - 700),
      uniquenessOffset + 300,
    );
    for (const name of randomNames) {
      expect(uniquenessWindow).toMatch(new RegExp(`\\$\\{?${name}\\}?`));
    }
    expect(material).toMatch(/sort\s+-u[\s\S]*wc\s+-l[\s\S]*(?:-eq|==)\s+5\b/);
    expect(material).toContain("QHB_TLS_CERT_FILE");
    expect(material).toContain("QHB_TLS_KEY_FILE");
    expect(material).toMatch(
      /(?:QHB_TLS_CERT_FILE|[A-Za-z_]*CERT_FILE)[^\n]*\.(?:crt|cert)/i,
    );
    expect(material).toMatch(
      /(?:QHB_TLS_KEY_FILE|[A-Za-z_]*KEY_FILE)[^\n]*\.(?:key)/i,
    );
    expect(material).toMatch(
      /openssl\s+x509\b[\s\S]*-in\s+[^\n]*(?:cert|CERT)/i,
    );
    expect(material).toMatch(
      /openssl\s+x509\b[\s\S]*-in\s+["']?\$QHB_TLS_CERT_FILE["']?/i,
    );
    expect(material).toMatch(/openssl\s+x509\b[\s\S]*-noout\b/i);
    expect(material).toMatch(/(?:grep|test)[^\n]*127\.0\.0\.1/);
    expect(material).toMatch(/RUNTIME_ENV_FILE=.*runtime[._-]env/);
    expect(material).toMatch(/(?:GITHUB_ENV|GITHUB_OUTPUT)/);
    expect(material).toMatch(
      /RUNTIME_ENV_FILE[\s\S]*\}[^\n]*(?:>>|tee\s+-a|>)[^\n]*(?:GITHUB_ENV|GITHUB_OUTPUT)/,
    );
    expect(start).toContain("set -euo pipefail");
    expect(start).toMatch(/pnpm\s+(?:--[^\n]+\s+)?build/);
    expect(start).toMatch(
      /docker compose[^\n]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[^\n]*config\s+--quiet/,
    );
    expect(start).toMatch(
      /docker compose[^\n]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[^\n]*build/,
    );
    expect(start).toMatch(
      /docker compose[^\n]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[^\n]*up\s+-d/,
    );

    const composeCommands = normalizedWorkflowCommands(workflow);
    expect(composeCommands.length).toBeGreaterThan(0);
    for (const command of composeCommands) {
      expect(
        command,
        `Compose command must use the generated env file: ${command}`,
      ).toMatch(/--env-file\s+["']?\$RUNTIME_ENV_FILE["']?(?:\s|$)/);
      if (/\bconfig\b/.test(command)) {
        expect(command).toMatch(/\b(?:--quiet|--hash)\b/);
      }
    }

    expect(image).toContain("set -euo pipefail");
    expect(image).toMatch(
      /(?:container_id|RUNTIME_CONTAINER_ID)\s*=\s*\$\([\s\S]*docker compose[\s\S]*ps\s+-q\s+control-plane/,
    );
    expect(image).toMatch(
      /docker\s+inspect[\s\S]*(?:Config\.Image|container_id|RUNTIME_CONTAINER_ID)/i,
    );
    expect(image).toMatch(
      /(?:image_ref|RUNTIME_IMAGE_REF)[\s\S]*docker\s+inspect[\s\S]*(?:container_id|RUNTIME_CONTAINER_ID)/i,
    );
    expect(image).toMatch(
      /docker\s+image\s+inspect[^\n]*(?:image_ref|RUNTIME_IMAGE_REF)/i,
    );
    expect(image).toMatch(
      /docker\s+export[^\n]*(?:container_id|RUNTIME_CONTAINER_ID)/i,
    );
    expect(image).toMatch(/tar\s+(?:-t[fF]|tf\b|--list)/);
    expect(image).toMatch(/(?:archive|RUNTIME_ARCHIVE)/i);
    const runtimeWorkdir = dockerStageWorkdir(
      finalDockerStage(read("apps/control-plane/Dockerfile")),
    );
    expect(runtimeWorkdir).toBeDefined();
    expect(image).toContain(runtimeWorkdir ?? "");
    for (const allowed of [
      "node_modules",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "apps/control-plane/package.json",
      "apps/control-plane/dist",
      "packages/protocol/package.json",
      "packages/protocol/dist",
    ]) {
      expect(image).toContain(allowed);
    }
    expect(image).toMatch(/grep\s+-E/);
    expect(image).toContain("\\.test\\.(js|d\\.ts)");
    expect(image).toMatch(/while[\s\S]*read[\s\S]*case[\s\S]*exit\s+1/);
    expect(image).toMatch(
      new RegExp(
        `(?:runtime_workdir_name|${escapeRegExp(runtimeWorkdir ?? "")})[\\s\\S]*node_modules[\\s\\S]*(?:apps/control-plane/dist|packages/protocol/dist)`,
        "i",
      ),
    );

    expect(healthy).toContain("set -euo pipefail");
    expect(healthy).toMatch(
      /runtime_url\s*=\s*["']https:\/\/127\.0\.0\.1:8443["']/,
    );
    for (const [statusName, endpoint] of [
      ["live_status", "/health/live"],
      ["ready_status", "/health/ready"],
      ["metrics_status", "/metrics"],
    ]) {
      expect(healthy).toMatch(
        new RegExp(
          `${statusName}\\s*=\\s*["']?\\$\\(curl[\\s\\S]*%\\{http_code\\}[\\s\\S]*${endpoint.replaceAll("/", "\\/")}`,
        ),
      );
      expect(healthy).toMatch(
        new RegExp(`test\\s+["']?\\$${statusName}["']?\\s*=\\s*["']200["']`),
      );
    }
    expect(healthy).toMatch(/live_body\s*=\s*["']?\$\(curl/);
    expect(healthy).toMatch(/ready_body\s*=\s*["']?\$\(curl/);
    expect(healthy).toMatch(/metrics_body/);
    expect(healthy).toMatch(
      /test\s+["']?\$live_body["']?\s*=\s*['"]\{"status":"ok"\}['"]/,
    );
    expect(healthy).toMatch(
      /test\s+["']?\$ready_body["']?\s*=\s*['"]\{"status":"ready"\}['"]/,
    );
    expect(healthy).toContain("text/plain; version=0.0.4; charset=utf-8");
    expect(healthy).toMatch(
      /(?:grep[^\n]*text\/plain; version=0\.0\.4; charset=utf-8|text\/plain; version=0\.0\.4; charset=utf-8[^\n]*grep)/i,
    );
    expect(healthy).toMatch(/grep[^\n]*(?:--fixed-strings|-F)/);
    for (const metric of [
      "qhb_mcp_submit_duration_seconds",
      "qhb_connector_online",
      "qhb_job_queue_age_seconds",
    ]) {
      expect(healthy).toContain(metric);
      expect(healthy).toMatch(
        new RegExp(`(?:grep[^\\n]*${metric}|${metric}[^\\n]*grep)`),
      );
    }
    const privacyTokens = [
      "owner[_-]?id",
      "job[_-]?id",
      "repository",
      "prompt",
      "path",
      "https?://",
      "url",
      "secret",
      "error:",
      "stack trace",
      "ECONNREFUSED",
      "SQLSTATE",
    ];
    for (const token of privacyTokens) {
      expect(healthy).toContain(token);
    }
    expect(healthy).toMatch(
      /grep[^\n]*(?:owner|job|repository|prompt|path|https\?:\/\/|url|secret|error:)[\s\S]*then[\s\S]*exit\s+1/i,
    );
    expectBoundedPolling(healthy);

    expect(databaseLoss).toContain("set -euo pipefail");
    expect(databaseLoss).toMatch(
      /docker compose[^\n]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[^\n]*stop\s+postgres/,
    );
    expect(databaseLoss).toMatch(
      /runtime_url\s*=\s*["']https:\/\/127\.0\.0\.1:8443["']/,
    );
    const recoveryMarker = databaseLoss.indexOf("start postgres");
    expect(recoveryMarker).toBeGreaterThan(-1);
    const whileStopped = databaseLoss.slice(0, recoveryMarker);
    const afterRecovery = databaseLoss.slice(recoveryMarker);
    expect(whileStopped).toMatch(
      /test\s+["']?\$readiness_status["']?\s*=\s*["']503["']/,
    );
    expect(whileStopped).toMatch(
      /readiness_status\s*=\s*["']?\$\(curl[^\n]*%\{http_code\}/,
    );
    expect(whileStopped).toMatch(
      /live_status\s*=\s*["']?\$\(curl[^\n]*%\{http_code\}/,
    );
    expect(whileStopped).toMatch(
      /test\s+["']?\$live_status["']?\s*=\s*["']200["']/,
    );
    expect(whileStopped).toMatch(
      /test\s+["']?\$live_body["']?\s*=\s*['"]\{"status":"ok"\}['"]/,
    );
    expect(whileStopped).toMatch(
      /live_body\s*=\s*["']?\$\(curl[^\n]*--cacert[^\n]*\/health\/live/,
    );
    expectBoundedPolling(whileStopped);
    expect(afterRecovery).toMatch(
      /test\s+["']?\$readiness_status["']?\s*=\s*["']200["']/,
    );
    expect(afterRecovery).toMatch(
      /readiness_status\s*=\s*["']?\$\(curl[^\n]*%\{http_code\}/,
    );
    expect(afterRecovery).toMatch(/curl[^\n]*--cacert[^\n]*\/health\/ready/);
    expect(afterRecovery).toMatch(/ready_body\s*=\s*["']?\$\(curl/);
    expect(afterRecovery).toMatch(
      /test\s+["']?\$ready_body["']?\s*=\s*['"]\{"status":"ready"\}['"]/,
    );
    expectBoundedPolling(afterRecovery);
    expect(
      (databaseLoss.match(/for\s+attempt\s+in\s+\$\(seq\s+1\s+/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);

    expect(evidence).toContain("set -euo pipefail");
    expect(evidence).toMatch(
      /(?:>|>>|tee\s+(?:-a\s+)?)[^\n]*\$RUNTIME_EVIDENCE_FILE/,
    );
    for (const observation of [
      "live_status",
      "live_body",
      "ready_status",
      "ready_body",
      "metrics_status",
      "metrics_body",
      "text/plain; version=0.0.4; charset=utf-8",
      "qhb_mcp_submit_duration_seconds",
      "qhb_connector_online",
      "qhb_job_queue_age_seconds",
      "privacy",
      "image_digest",
      "config_digest",
    ]) {
      expect(evidence, `evidence must record ${observation}`).toContain(
        observation,
      );
    }
    expect(evidence).toContain("printf 'live_status=%s\\n' \"$live_status\"");
    expect(evidence).toContain("printf 'ready_status=%s\\n' \"$ready_status\"");
    expect(evidence).toContain("printf 'metrics_status=%s\\n' \"$metrics_status\"");
    expect(evidence).toMatch(/(?:cat|source)[^\n]*RUNTIME_[A-Z_]*OBSERV/i);
    expect(evidence).toMatch(/live_body/);
    expect(evidence).toMatch(/ready_body/);
    expect(evidence).toMatch(/metrics_body/);
    expect(evidence).not.toMatch(
      /(?:printf|echo|tee)[^\n]*\{"status":"(?:ok|ready)"\}/,
    );
    expect(evidence).toMatch(/(?:readiness|ready)[^\n]*\$readiness_status/i);
    expect(evidence).toMatch(/(?:db[-_ ]loss|postgres[-_ ]stop)/i);
    expect(evidence).toMatch(/recovery[^\n]*\$recovery_readiness_status/i);
    expect(evidence).toMatch(/__drizzle_migrations/);
    for (const [name, value] of [
      ["migration_tag", "0002_result_acknowledgement"],
      ["migration_when", "1788244364352"],
      [
        "migration_sha256",
        "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
      ],
    ]) {
      expect(evidence).toMatch(
        new RegExp(`test\\s+["']?\\$${name}["']?\\s*=\\s*["']${value}["']`),
      );
      expect(evidence).toMatch(
        new RegExp(`printf\\s+'${name}=%s\\\\n'\\s+["']?\\$${name}["']?`),
      );
      if (name === "migration_tag") {
        expect(evidence).toContain(`${name}=${value}`);
      }
    }
    expect(evidence).toMatch(
      /image_digest\s*=\s*["']?\$\(docker\s+image\s+inspect[\s\S]*--format\s+["']?\{\{\.Id\}\}/i,
    );
    expect(evidence).toMatch(
      /image_digest[\s\S]*docker\s+image\s+inspect[\s\S]*(?:image_ref|RUNTIME_IMAGE_REF)/i,
    );
    expect(evidence).toMatch(/config_digest\s*=\s*["']?sha256:/i);
    expect(evidence).toMatch(
      /docker compose[\s\S]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[\s\S]*config\s+--hash\s+control-plane/,
    );
    expect(evidence).toMatch(
      /(?:=~|grep[^\n]*-E)[\s\S]*\^sha256:\[0-9a-f\]\{64\}\$/i,
    );
    expect(evidence).toMatch(/image_digest[\s\S]*sha256:\[0-9a-f\]\{64\}/i);
    expect(evidence).toMatch(/config_digest[\s\S]*sha256:\[0-9a-f\]\{64\}/i);
    expect(evidence).toContain("image_digest=");
    expect(evidence).toContain("config_digest=");
    expect(evidence).toMatch(
      /(?:printf|echo|tee)[^\n]*(?:image_digest|config_digest)/,
    );
    expect(evidence).toMatch(
      /(?:>>|tee\s+-a|>)[^\n]*(?:runtime-evidence|evidence_file|RUNTIME_EVIDENCE)/,
    );
    expect(evidence).toMatch(/runtime[-_]evidence|RUNTIME_EVIDENCE_FILE/);
    expect(upload).toMatch(/uses:\s*actions\/upload-artifact@/);
    expect(upload).toMatch(
      /path:\s*["']?\$\{\{\s*env\.RUNTIME_EVIDENCE_FILE\s*\}\}/,
    );
    expect(upload).toMatch(
      /name:\s*[^\n]*(?:runtime[-_]evidence|RUNTIME_EVIDENCE_FILE)/i,
    );
    expect(cleanup).toMatch(/if:\s*always\(\)/);
    expect(cleanup).toMatch(
      /docker compose[^\n]*--env-file\s+["']?\$RUNTIME_ENV_FILE["']?[^\n]*down/,
    );
    expect(cleanup).toMatch(
      /docker\s+rm[^\n]*(?:RUNTIME_CONTAINER_ID|container_id)/i,
    );
    expect(cleanup).toMatch(
      /docker\s+(?:image\s+rm|rmi)[^\n]*(?:RUNTIME_IMAGE_REF|image_ref)/i,
    );
    expect(cleanup).toMatch(/rm\s+-f\s+--[^\n]*(?:RUNTIME_ARCHIVE|archive)/i);
    expect(cleanup).toMatch(
      /rm\s+-f\s+--[^\n]*(?:RUNTIME_EVIDENCE_FILE|evidence)/i,
    );
    expect(cleanup).toMatch(
      /if\s+(?:\[\[?|\[)[\s\S]*-n[\s\S]*RUNTIME_DIR[\s\S]*-d[\s\S]*RUNTIME_DIR[\s\S]*(?:\/tmp\/|RUNTIME_DIR\s*==)[\s\S]*rm\s+-rf\s+--[\s\S]*RUNTIME_DIR/,
    );
    expect(workflow).not.toMatch(/curl[^\n]*(?:\s-k(?:\s|$)|--insecure)/);
  });
});
