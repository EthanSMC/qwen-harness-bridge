import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildArtifact } from "./package.mjs";

/**
 * Live rehearsal of the packaged connector against a real Control Plane.
 *
 * Connection details come from the out-of-band JSON file named by
 * `QHB_ACCEPTANCE_ENV` (or `--env`). Nothing read from that file — no
 * credential value, no resolved path — is written into the report, the
 * repository, the Issue or the artifact. The report records the source kind,
 * the environment, exact steps, timestamps and observed statuses only.
 *
 * The operator supplies the DSH launcher explicitly:
 *   --dsh-bin <harness executable>   (or DSH_BIN)
 *   --dsh-cli <app.asar/lib/desktop-cli.js>   (or DSH_CLI)
 * `--dsh-home` defaults to the current user's DSH home so the boot can reuse
 * the operator's own agent credentials; the rehearsal profile is removed
 * afterwards.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repositoryRoot = resolve(packageRoot, "../..");

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const required = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${label}`);
  }
  return value;
};

const envPath = resolve(
  required(flag("env", process.env.QHB_ACCEPTANCE_ENV), "QHB_ACCEPTANCE_ENV"),
);
const acceptance = JSON.parse(readFileSync(envPath, "utf8"));
const dshBin = required(flag("dsh-bin", process.env.DSH_BIN), "DSH_BIN");
const dshCli = required(flag("dsh-cli", process.env.DSH_CLI), "DSH_CLI");
const profile = flag("profile", "qhb-live-rehearsal");
const dshHome = resolve(flag("dsh-home", join(homedir(), ".dsh")));
const budgetMs = Number(flag("budget-ms", "360000"));
const outFile = flag("out", undefined);
const task = flag(
  "task",
  "Read the file job-marker.txt in this repository and reply with its single line of text.",
);

const steps = [];
const record = (name, status, detail) => {
  steps.push({ name, status, detail });
};
const report = {
  environment: {
    platform: platform(),
    osRelease: release(),
    node: process.version,
    startedAt: new Date().toISOString(),
    credentialSourceKind: "file",
  },
  steps,
  status: "PASS",
};

const dshEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: dshHome };
const dsh = (args) =>
  execFileSync(dshBin, ["--expose-internals", dshCli, ...args], {
    env: dshEnv,
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const connect = async () => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`https://${acceptance.HOST}:${acceptance.PORT}/mcp`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${acceptance.QHB_MCP_BEARER_TOKEN}`,
        },
      },
    },
  );
  const client = new Client({ name: "qhb-live-rehearsal", version: "0.1.0" });
  await client.connect(transport);
  return client;
};
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : part.type))
      .join(" ")
      .slice(0, 200);
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent ?? {};
};

const work = mkdtempSync(join(repositoryRoot, ".live-rehearsal-"));
const profileDir = join(dshHome, "profiles", profile);
let client;
let boot;
try {
  if (existsSync(profileDir))
    rmSync(profileDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
  const artifact = buildArtifact({ outFile: join(work, "qhb-live.tar") });
  record("pack", "PASS", {
    entries: artifact.entries.length,
    sha256: artifact.sha256,
    vendoredDependencies: artifact.vendoredDependencies.length,
    hostInstalledDependencies: artifact.hostInstalledDependencies.length,
  });

  dsh(["--from-default-profile", "headless", "--profile", profile, "--help"]);
  dsh(["plugin", "--profile", profile, "add", artifact.outFile]);
  record("install", "PASS", {
    artifactBytes: statSync(artifact.outFile).size,
  });

  const stateDirectory = join(work, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const credentialFile = join(work, "bootstrap.secret");
  writeFileSync(credentialFile, acceptance.QHB_CONNECTOR_BOOTSTRAP_CREDENTIAL, {
    mode: 0o600,
  });
  writeFileSync(
    join(profileDir, "cordis.patch.yml"),
    [
      "- id: qwen-harness-bridge",
      "  config:",
      `    connectorId: ${acceptance.QHB_CONNECTOR_ID}`,
      `    controlPlaneUrl: wss://${acceptance.HOST}:${acceptance.PORT}/connector/v1`,
      "    keychainService: qhb-connector-live",
      `    keychainAccount: ${acceptance.QHB_CONNECTOR_CREDENTIAL_ID}`,
      `    databasePath: ${join(stateDirectory, "connector.sqlite")}`,
      "    credentialSource:",
      "      kind: file",
      `      path: ${credentialFile}`,
      "    repositories:",
      `      - id: ${acceptance.QHB_REPOSITORY_ID}`,
      "        displayName: Live rehearsal repository",
      `        canonicalPath: ${acceptance.QHB_REPOSITORY_ROOT}`,
      "        approvalTimeoutSeconds: 300",
      "",
    ].join("\n"),
  );
  record("configure", "PASS", { sourceKind: "file" });

  boot = spawn(
    dshBin,
    ["--expose-internals", dshCli, "--profile", profile, task],
    { env: dshEnv, cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let bootOutput = "";
  boot.stdout.on("data", (chunk) => {
    bootOutput += String(chunk);
  });
  boot.stderr.on("data", (chunk) => {
    bootOutput += String(chunk);
  });
  record("boot", "PASS", { task: "configured-request" });

  client = await connect();
  const submitted = await call(client, "submit_task", {
    client_request_id: randomUUID(),
    repository_id: acceptance.QHB_REPOSITORY_ID,
    request: task,
  });
  const jobId = submitted.job_id;
  record("submit", "PASS", { jobIdPresent: typeof jobId === "string" });
  if (typeof jobId !== "string")
    throw new Error("submit_task returned no job id");

  const deadline = Date.now() + budgetMs;
  const observed = { statuses: [], approvals: 0, terminal: undefined };
  while (Date.now() < deadline) {
    const pending = await call(client, "list_pending_approvals", {});
    for (const approval of Array.isArray(pending.approvals)
      ? pending.approvals
      : []) {
      await call(client, "decide_approval", {
        approval_id: approval.approval_id,
        decision: "approve",
        expected_job_revision: approval.job_revision,
      });
      observed.approvals += 1;
    }
    const current = await call(client, "get_task", { job_id: jobId });
    const status = current.task?.status ?? current.status;
    if (typeof status === "string" && observed.statuses.at(-1) !== status) {
      observed.statuses.push(status);
    }
    if (["succeeded", "failed", "cancelled"].includes(status)) {
      observed.terminal = status;
      break;
    }
    await sleep(2_000);
  }
  record(
    "lifecycle",
    observed.terminal === undefined ? "PARTIAL" : "PASS",
    observed,
  );
  if (observed.terminal === "succeeded") {
    const result = await call(client, "get_task_result", { job_id: jobId });
    record("result", "PASS", { bytes: JSON.stringify(result).length });
  }
  const mask = (value) =>
    value
      .replace(/[A-Za-z]:\\[^\s"']+/gu, "<path>")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, "<host>")
      .replace(/[A-Za-z0-9_+/=-]{32,}/gu, "<token>");
  const bootLines = bootOutput
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  report.bootDiagnostics = {
    sawMissingCredential: bootOutput.includes("MISSING_CREDENTIAL"),
    sawConnectorFailure: /CONNECTOR_[A-Z_]+/u.test(bootOutput),
    tail: bootLines.slice(-12).map((line) => mask(line).slice(0, 200)),
  };
} catch (error) {
  record("rehearsal", "FAIL", { message: error?.message ?? String(error) });
  report.status = "FAIL";
} finally {
  if (client !== undefined) await client.close().catch(() => undefined);
  if (boot !== undefined) {
    boot.kill();
    await Promise.race([
      new Promise((done) => boot.once("exit", done)),
      sleep(5_000),
    ]);
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  report.environment.finishedAt = new Date().toISOString();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (outFile !== undefined) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(resolve(outFile), text);
  }
}
