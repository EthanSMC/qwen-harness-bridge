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

const yamlMappingBlock = (
  source: string,
  name: string,
  indentation: number,
): string => {
  const lines = source.split("\n");
  const prefix = " ".repeat(indentation);
  const start = lines.indexOf(`${prefix}${name}:`);
  expect(start, `missing YAML mapping ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.trim().length > 0 &&
      !line.trimStart().startsWith("#") &&
      line.length - line.trimStart().length <= indentation,
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
};

const workflowStep = (workflow: string, name: string): string => {
  const lines = workflow.split("\n");
  const marker = `      - name: ${name}`;
  const occurrences = lines
    .map((line, index) => (line === marker ? index : -1))
    .filter((index) => index !== -1);
  expect(occurrences, `workflow step ${name} must be unique`).toHaveLength(1);
  const start = occurrences[0] ?? -1;
  expect(start, `missing workflow step ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      (line.startsWith("      - ") ||
        (line.trim().length > 0 && line.length - line.trimStart().length < 6)),
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
  const stages = dockerfile
    .split(/(?=^FROM\s+)/im)
    .filter((stage) => /^FROM\s+/i.test(stage));
  expect(stages.length).toBeGreaterThanOrEqual(2);
  for (const stage of stages) {
    expect(stage.split("\n")[0]).toMatch(/@sha256:[0-9a-f]{64}(?:\s|$)/i);
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
  stage.match(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/i)?.[1]?.toLowerCase();

const dockerStageWorkdir = (stage: string): string => {
  const workdir = dockerfileInstructions(stage)
    .filter((instruction) => /^WORKDIR\s+/i.test(instruction))
    .at(-1)
    ?.match(/^WORKDIR\s+(\S+)/i)?.[1];
  expect(
    workdir,
    "every build/runtime stage must declare WORKDIR",
  ).toBeDefined();
  return normalizeDockerPath(workdir ?? "/");
};

const dockerCopyOperands = (
  instruction: string,
): { from: string; sources: string[]; destination: string } => {
  const tokens = instruction
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
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
    `COPY must have one source and one destination: ${instruction}`,
  ).toBe(2);
  return {
    from: (from ?? "--from=").slice("--from=".length).toLowerCase(),
    sources: operands.slice(0, -1),
    destination: operands.at(-1) ?? "",
  };
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
  });

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

    const finalCopies = instructions.filter((line) => /^COPY\s+/i.test(line));
    const stages = dockerStageBlocks(dockerfile);
    const stagesByName = new Map(
      stages
        .map((stage) => [dockerStageName(stage), stage] as const)
        .filter((entry): entry is [string, string] => entry[0] !== undefined),
    );
    const finalWorkdir = dockerStageWorkdir(finalStage);
    const expectedCopies = new Map([
      ["node_modules", "node_modules"],
      ["package.json", "package.json"],
      ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
      ["pnpm-lock.yaml", "pnpm-lock.yaml"],
      ["apps/control-plane/package.json", "apps/control-plane/package.json"],
      ["apps/control-plane/dist", "apps/control-plane/dist"],
      ["packages/protocol/package.json", "packages/protocol/package.json"],
      ["packages/protocol/dist", "packages/protocol/dist"],
    ]);
    const observedCopies = new Map<string, string>();
    expect(finalCopies.length).toBe(expectedCopies.size);
    for (const copy of finalCopies) {
      const { from, sources, destination } = dockerCopyOperands(copy);
      const sourceStage =
        from.match(/^\d+$/)?.[0] !== undefined
          ? stages[Number(from)]
          : stagesByName.get(from);
      expect(
        sourceStage,
        `COPY source stage must exist: ${from}`,
      ).toBeDefined();
      const sourceWorkdir = dockerStageWorkdir(sourceStage ?? "");
      const sourcePath = normalizeDockerPath(sources[0] ?? "");
      const sourcePrefix = sourceWorkdir === "/" ? "/" : `${sourceWorkdir}/`;
      expect(sourcePath.startsWith(sourcePrefix)).toBe(true);
      const sourceKey = sourcePath.slice(sourcePrefix.length);
      expect(
        expectedCopies.has(sourceKey),
        `disallowed final-stage COPY source: ${sourceKey}`,
      ).toBe(true);
      const destinationPath = destination.startsWith("/")
        ? normalizeDockerPath(destination)
        : normalizeDockerPath(`${finalWorkdir}/${destination}`);
      const expectedDestination = normalizeDockerPath(
        `${finalWorkdir}/${expectedCopies.get(sourceKey) ?? ""}`,
      );
      expect(
        destinationPath,
        `final-stage COPY destination must be exact for ${sourceKey}`,
      ).toBe(expectedDestination);
      expect(
        observedCopies.has(sourceKey),
        `duplicate final-stage COPY source: ${sourceKey}`,
      ).toBe(false);
      observedCopies.set(sourceKey, destinationPath);
    }
    expect([...observedCopies.keys()].sort()).toEqual(
      [...expectedCopies.keys()].sort(),
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
    const postgres = yamlMappingBlock(compose, "postgres", 2);
    const migrate = yamlMappingBlock(compose, "migrate", 2);
    const controlPlane = yamlMappingBlock(compose, "control-plane", 2);

    expect(postgres).toMatch(/image:\s*postgres:16-alpine@sha256:[0-9a-f]{64}/);
    expect(migrate).toMatch(/restart:\s*(?:["']?no["']?|false)/);
    expect(migrate).toMatch(
      /(?:command:|entrypoint:)[\s\S]*dist\/db\/migrate\.js/,
    );
    const migrationDependencies = yamlMappingBlock(migrate, "depends_on", 4);
    const migrationPostgres = yamlMappingBlock(
      migrationDependencies,
      "postgres",
      6,
    );
    expect(migrationPostgres).toContain("condition: service_healthy");
    const controlDependencies = yamlMappingBlock(controlPlane, "depends_on", 4);
    const controlMigration = yamlMappingBlock(
      controlDependencies,
      "migrate",
      6,
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

  it("pins readiness to the exact expected migration and a safe probe", () => {
    const health = read("apps/control-plane/src/db/health.ts");

    expect(health).toContain("0002_result_acknowledgement");
    expect(health).toContain("1788244364352");
    expect(health).toContain(
      "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
    );
    expect(health).toMatch(/CREATE\s+TEMP(?:ORARY)?\s+TABLE/i);
    expect(health).toMatch(/ON\s+COMMIT\s+DROP/i);
    expect(health).toMatch(/statement_timeout/i);
    expect(health).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:jobs|connectors|approvals)\b/i,
    );
    expect(read("vitest.workspace.ts")).toContain(
      "tests/integration/readiness.test.ts",
    );
    expect(read("vitest.workspace.ts")).toContain(
      "tests/contract/health-metrics.test.ts",
    );
    expect(read("vitest.workspace.ts")).toContain(
      "tests/contract/runtime-build.test.ts",
    );
  });

  it("has an executable PR Docker gate with evidence and unconditional cleanup", () => {
    const workflow = read(".github/workflows/runtime.yml");
    const runtimeJob = yamlMappingBlock(workflow, "runtime", 2);
    expect(runtimeJob).not.toMatch(/^ {6}- (?!name:)/m);
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
    expect(material).toMatch(/chmod\s+600\b/);
    expect(material).toMatch(/openssl\s+req[\s\S]*-keyout[\s\S]*-out/);
    expect(material).toMatch(/openssl[^\n]*(?:>|--out\s+)\S+/);
    expect(material).not.toMatch(/echo[^\n]*\$\([^\n]*openssl/);
    for (const name of [
      "POSTGRES_PASSWORD",
      "QHB_OWNER_ID",
      "QHB_MCP_BEARER_TOKEN",
      "QHB_REQUEST_ENCRYPTION_KEY",
      "QHB_CONNECTOR_SESSION_SIGNING_KEY",
    ]) {
      expect(material).toMatch(
        new RegExp(`(?:^|\\n)\\s*${name}=.*\\$\\(openssl\\s+rand\\b`),
      );
      expect(material).toMatch(new RegExp(`${name}=\\$\\{?${name}\\}?`));
    }
    expect(material).toContain("QHB_TLS_CERT_FILE");
    expect(material).toContain("QHB_TLS_KEY_FILE");
    expect(material).toMatch(/QHB_TLS_CERT_FILE=.*(?:\.crt|cert)/i);
    expect(material).toMatch(/QHB_TLS_KEY_FILE=.*(?:\.key|key)/i);
    expect(material).toMatch(/RUNTIME_ENV_FILE=.*runtime[._-]env/);
    expect(material).toMatch(/(?:GITHUB_ENV|GITHUB_OUTPUT|runtime[._-]env)/);
    expect(material).toMatch(/sort\s+-u/);
    expect(material).toMatch(/wc\s+-l/);
    expect(material).toMatch(/(?:-eq|==)\s+5\b/);
    expect(start).toContain("set -euo pipefail");
    expect(start).toMatch(/pnpm\s+(?:--[^\n]+\s+)?build/);
    expect(start).toMatch(/docker compose config --quiet/);
    expect(start).toMatch(/docker compose build/);
    expect(start).toMatch(/docker compose up -d/);

    const composeCommands = normalizedWorkflowCommands(workflow);
    expect(composeCommands.length).toBeGreaterThan(0);
    for (const command of composeCommands) {
      expect(
        command,
        `Compose command must use the generated env file: ${command}`,
      ).toMatch(/--env-file\s+\S+/);
    }

    expect(image).toContain("set -euo pipefail");
    expect(image).toMatch(/docker\s+create\b/);
    expect(image).toMatch(/docker\s+export\b/);
    expect(image).toMatch(/tar\s+(?:-t[fF]|tf\b|--list)/);
    expect(image).toMatch(/docker\s+rm\b/);
    for (const forbidden of [
      "src/",
      "tests/",
      ".git/",
      ".env",
      ".key",
      ".pem",
      ".crt",
      ".cert",
      ".p12",
      ".local",
      ".npmrc",
      ".pnpm-store",
      ".DS_Store",
      "coverage",
      "*.log",
    ]) {
      expect(image).toContain(forbidden);
    }
    expect(image).toMatch(/grep\s+(?:-[^\n]*E|--extended-regexp)/);
    expect(image).toMatch(/if[\s\S]*grep[\s\S]*then[\s\S]*exit\s+1/);

    expect(healthy).toContain("set -euo pipefail");
    expect(healthy).toMatch(
      /runtime_url\s*=\s*["']https:\/\/127\.0\.0\.1:8443["']/,
    );
    for (const endpoint of ["/health/live", "/health/ready", "/metrics"]) {
      expect(healthy).toMatch(
        new RegExp(
          `curl[^\\n]*--cacert[^\\n]*\\$runtime_url${endpoint.replaceAll("/", "\\/")}`,
        ),
      );
    }
    expect(healthy).toMatch(/live_body\s*=\s*["']?\$\(curl/);
    expect(healthy).toMatch(/ready_body\s*=\s*["']?\$\(curl/);
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
      expect(healthy).toMatch(new RegExp(`grep[^\\n]*${token}`, "i"));
    }
    expect(healthy).toMatch(
      /grep[^\n]*(?:owner|job|repository|prompt|path|https\?:\/\/|url|secret|error:)[\s\S]*then[\s\S]*exit\s+1/i,
    );
    expectBoundedPolling(healthy);

    expect(databaseLoss).toContain("set -euo pipefail");
    expect(databaseLoss).toMatch(/docker compose stop postgres/);
    expect(databaseLoss).toMatch(
      /runtime_url\s*=\s*["']https:\/\/127\.0\.0\.1:8443["']/,
    );
    const recoveryMarker = databaseLoss.indexOf(
      "docker compose start postgres",
    );
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
    expectBoundedPolling(afterRecovery);
    expect(
      (databaseLoss.match(/for\s+attempt\s+in\s+\$\(seq\s+1\s+/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);

    expect(evidence).toContain("set -euo pipefail");
    expect(evidence).toMatch(/__drizzle_migrations/);
    for (const [name, value] of [
      ["migration_tag", "0002_result_acknowledgement"],
      ["migration_when", "1788244364352"],
      [
        "migration_sha256",
        "2e4a1f323453e6f4a7ec7319250f474ce7552c536ed3a55af4b5fe52c5a9cb89",
      ],
    ]) {
      expect(evidence).toContain(`${name}=${value}`);
      expect(evidence).toMatch(
        new RegExp(`test\\s+["']?\\$${name}["']?\\s*=\\s*["']${value}["']`),
      );
    }
    expect(evidence).toMatch(
      /image_digest\s*=\s*["']?\$\(docker\s+(?:image\s+)?inspect/,
    );
    expect(evidence).toMatch(
      /config_digest\s*=\s*["']?\$\(docker\s+(?:image\s+)?inspect/,
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
    expect(evidence).toMatch(/runtime[-_]evidence/);
    expect(upload).toMatch(/uses:\s*actions\/upload-artifact@/);
    expect(cleanup).toMatch(/if:\s*always\(\)/);
    expect(cleanup).toMatch(/docker compose[^\n]*down/);
    expect(cleanup).toMatch(
      /if\s+\[[^\n]*-n[^\n]*RUNTIME_DIR[^\n]*\][\s\S]*-d[^\n]*RUNTIME_DIR[\s\S]*rm\s+-rf\s+--[^\n]*RUNTIME_DIR/,
    );
    expect(workflow).not.toMatch(/curl[^\n]*(?:\s-k(?:\s|$)|--insecure)/);
  });
});
