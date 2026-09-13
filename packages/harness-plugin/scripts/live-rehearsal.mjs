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
 *
 * --serve creates the profile from the shipped web template and boots it
 * resident (dsh --profile <name> --port 0 --no-open) so the connector stays
 * connected while the job is submitted and observed; the host is killed when
 * the run ends. Without --serve and without --task the booted profile answers
 * nothing and exits immediately, so no connection can be observed.
 *
 * --state-dir <path> (or QHB_REHEARSAL_STATE_DIR) keeps the connector
 * journal in a caller-owned directory instead of a per-run temporary one. The
 * Control Plane keeps per-connector durable sequence state and a connector
 * birth is one-time, so a first run against a connector consumes it; a later
 * run must present the same journal to resume from its durable client
 * sequence. Without --state-dir every run starts a fresh journal and is
 * therefore only valid for a connector whose birth has not been consumed.
 * The directory is never deleted and no absolute path is written into the
 * report.
 *
 * Before booting, the runner waits for the Control Plane's public
 * qhb_connector_online gauge to read 0, because that gauge counts every
 * connector: only against a cleared baseline does a later 1 prove that this
 * run's connector connected. --warmup-wait-ms bounds that wait; if the
 * baseline never clears, the online step is recorded as PARTIAL.
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
/** The Control Plane job drives the Harness agent; a boot-time task would make
 * the local agent answer it directly instead, so the default is no task. */
const task = flag("task", "");
const submitRequest = flag(
  "request",
  "Read README.md in this repository and reply with its first line.",
);
const onlineWaitMs = Number(flag("online-wait-ms", "120000"));
/** The Control Plane marks a connector stale after 20s, so this bounds the wait
 * for the previous generation's gauge sample to clear. */
const warmupWaitMs = Number(flag("warmup-wait-ms", "120000"));
/** A resident web host is the only boot mode that keeps the connector up. */
const serve = process.argv.includes("--serve");
const stateDirFlag = flag("state-dir", process.env.QHB_REHEARSAL_STATE_DIR);
/** Resolved once so the report and the profile config agree. */
const stateDirectory =
  typeof stateDirFlag === "string" && stateDirFlag.length > 0
    ? resolve(stateDirFlag)
    : undefined;
const persistentState = stateDirectory !== undefined;

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
    stateDirectoryKind: persistentState ? "persistent" : "ephemeral",
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

/** The Control Plane's public connector gauge: whether *any* connector is
 * fresh. It is not per-run, so it is only meaningful against a known baseline.
 * `null` means the sample itself failed (unreachable or certificate). */
const gaugeOnline = async () => {
  try {
    const response = await fetch(
      `https://${acceptance.HOST}:${acceptance.PORT}/metrics`,
    );
    const text = response.ok ? await response.text() : "";
    return /^qhb_connector_online 1$/mu.test(text);
  } catch {
    return null;
  }
};
const waitForGauge = async (expected, windowMs) => {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if ((await gaugeOnline()) === expected) return true;
    if (Date.now() >= deadline) return false;
    await sleep(3_000);
  }
};

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
let bootOutput = "";
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

  const template = serve ? "web" : "headless";
  dsh(["--from-default-profile", template, "--profile", profile, "--help"]);
  dsh(["plugin", "--profile", profile, "add", artifact.outFile]);
  record("install", "PASS", {
    artifactBytes: statSync(artifact.outFile).size,
  });

  const journalDirectory = stateDirectory ?? join(work, "state");
  mkdirSync(journalDirectory, { recursive: true });
  record("state", "PASS", {
    kind: persistentState ? "persistent" : "ephemeral",
  });
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
      `    databasePath: ${join(journalDirectory, "connector.sqlite")}`,
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
  record("configure", "PASS", {
    sourceKind: "file",
    profileTemplate: template,
  });

  // The gauge counts every connector, so wait for the previous generation to
  // expire first: only then does a later online sample prove that *this* run's
  // connector connected. A baseline that never clears is recorded as PARTIAL
  // and weakens the online step below instead of quietly reinforcing it.
  const idleBaseline = await waitForGauge(false, warmupWaitMs);
  record("gauge-idle", idleBaseline ? "PASS" : "PARTIAL", {
    waitedMs: warmupWaitMs,
  });

  const bootArgs = ["--expose-internals", dshCli, "--profile", profile];
  let bootMode = "none";
  if (serve) {
    // The web app's own flags follow the launcher flags; a resident host is
    // what keeps the connector connected until the run ends.
    bootArgs.push("--port", "0", "--no-open");
    bootMode = "serve";
  } else if (task.length > 0) {
    bootArgs.push(task);
    bootMode = "cli-task";
  }
  boot = spawn(dshBin, bootArgs, {
    env: dshEnv,
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  boot.stdout.on("data", (chunk) => {
    bootOutput += String(chunk);
  });
  boot.stderr.on("data", (chunk) => {
    bootOutput += String(chunk);
  });
  record("boot", "PASS", { mode: bootMode });

  client = await connect();
  // The Control Plane only dispatches to an online connector; wait for the
  // public gauge instead of guessing from job state.
  const connectorOnline = await waitForGauge(true, onlineWaitMs);
  record("connector-online", connectorOnline ? "PASS" : "PARTIAL", {
    waitedMs: onlineWaitMs,
    baselineCleared: idleBaseline,
  });
  if (!connectorOnline) {
    throw new Error(
      "connector did not report online before the job was submitted",
    );
  }
  const submitted = await call(client, "submit_task", {
    client_request_id: randomUUID(),
    repository_id: acceptance.QHB_REPOSITORY_ID,
    request: submitRequest,
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
  const mask = (value) =>
    value
      .replace(/[A-Za-z]:\\[^\s"']+/gu, "<path>")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, "<host>")
      .replace(/[A-Za-z0-9_+/=-]{32,}/gu, "<token>");
  // Recorded on every run so a failed boot still explains itself.
  report.bootDiagnostics = {
    sawMissingCredential: bootOutput.includes("MISSING_CREDENTIAL"),
    sawConnectorFailure: /CONNECTOR_[A-Z_]+/u.test(bootOutput),
    tail: bootOutput
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .slice(-12)
      .map((line) => mask(line).slice(0, 200)),
  };
  report.environment.finishedAt = new Date().toISOString();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (outFile !== undefined) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(resolve(outFile), text);
  }
}
