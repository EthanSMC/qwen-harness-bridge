import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const syncManagement = resolve(root, "scripts/github/sync-management.mjs");

test("management sync selects formal mode when an eligible collaborator is on page two", async (t) => {
  const fakeBin = await mkdtemp(join(tmpdir(), "qhb-sync-management-"));
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  const fakeGh = join(fakeBin, "gh");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const owner = {
  login: "EthanSMC",
  role_name: "admin",
  permissions: { admin: true, maintain: true, push: true, pull: true, triage: true },
};
const pageOne = [
  owner,
  ...Array.from({ length: 99 }, (_, index) => ({
    login: \`read-only-\${index + 1}\`,
    role_name: "pull",
    permissions: { admin: false, maintain: false, push: false, pull: true, triage: false },
  })),
];
const pageTwo = [{
  login: "eligible-reviewer",
  role_name: "push",
  permissions: { admin: false, maintain: false, push: true, pull: true, triage: false },
}];

let response = {};
if (args[0] === "repo" && args[1] === "view") {
  response = { nameWithOwner: "EthanSMC/qwen-harness-bridge" };
} else if (args[0] === "api" && args[1].includes("/collaborators?")) {
  response = args.includes("--paginate") && args.includes("--slurp")
    ? [pageOne, pageTwo]
    : pageOne;
} else if (args[0] === "api" && args[1].includes("/milestones?") && args.includes("GET")) {
  response = [];
} else if (args[0] === "api" && args[1].includes("/issues?") && args.includes("GET")) {
  response = [];
} else if (args[0] === "api" && args[1].includes("/milestones") && args.includes("POST")) {
  response = { number: 1 };
}
process.stdout.write(JSON.stringify(response));
`,
    "utf8",
  );
  await chmod(fakeGh, 0o755);

  const output = execFileSync(process.execPath, [syncManagement], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.match(output, /Review mode selected: formal;.*eligible-reviewer/);
});
