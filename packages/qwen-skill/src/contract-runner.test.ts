import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadFixtures,
  runContractSuite,
  validateFixture,
  validateRepositoryConfiguration,
} from "./contract-runner.js";

type LooseStep = Record<string, unknown>;
type LooseTurn = { request_id: string; steps: LooseStep[] };
type LooseFixture = { fixture_id?: string; turns: LooseTurn[] };

const fixturesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
);

const fixtureJson = (name: string): LooseFixture =>
  JSON.parse(
    readFileSync(join(fixturesDirectory, name), "utf8"),
  ) as LooseFixture;

const mutationTools = ["submit_task", "cancel_task", "decide_approval"];

const mutate = (
  name: string,
  apply: (fixture: LooseFixture) => void,
): string => {
  const fixture = fixtureJson(name);
  apply(fixture);
  return JSON.stringify(fixture);
};

const argumentsOf = (step: LooseStep): Record<string, unknown> =>
  step.arguments as Record<string, unknown>;

describe("skill submission contract fixtures", () => {
  it("loads and validates every shipped fixture", () => {
    const suite = runContractSuite(fixturesDirectory);

    expect(suite.violations).toEqual([]);
    expect(suite.fixtureCount).toBe(19);
    expect(suite.turnCount).toBeGreaterThanOrEqual(19);
  });

  it("keeps every turn at zero or one mutation", () => {
    const suite = runContractSuite(fixturesDirectory);

    expect(suite.maxMutationsPerTurn).toBeLessThanOrEqual(1);
    expect(suite.mutationsByFixture).toEqual({
      "approval-ambiguous": 0,
      "approval-confirm": 0,
      "approval-expired": 0,
      "approval-list": 0,
      "approval-stale": 0,
      "cancel-race": 0,
      "cancel-running": 0,
      errors: 1,
      "inspect-offline": 0,
      "inspect-running": 0,
      "list-tasks": 0,
      "repository-ambiguous": 0,
      "result-image": 0,
      "result-text": 0,
      "submit-offline": 1,
      "submit-online": 1,
      "submit-read-only": 1,
      "submit-retry": 1,
      "submit-second-request": 1,
    });
  });

  it("binds each submission UUID to the turn and the client_request_id", () => {
    const fixtures = loadFixtures(fixturesDirectory);
    expect(fixtures.some((entry) => entry.name === "submit-online")).toBe(true);

    const violation = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        argumentsOf(fixture.turns[0].steps[1]).client_request_id =
          "33333333-3333-4333-8333-333333333333";
      }),
    );
    expect(violation.join("\n")).toContain("client_request_id");
    expect(violation.join("\n")).toContain("submit-online");
  });

  it("accepts exactly one byte-identical retry after a temporary failure", () => {
    const suite = runContractSuite(fixturesDirectory);

    expect(suite.retriesByFixture["submit-retry"]).toBe(1);
    expect(suite.violations).toEqual([]);
  });

  it("rejects a retry whose payload changed", () => {
    const violation = validateFixture(
      "submit-retry",
      mutate("submit-retry.json", (fixture) => {
        argumentsOf(fixture.turns[1].steps[0]).request = "运行 lint 并修复";
      }),
    );
    expect(violation.join("\n")).toMatch(/retry payload/i);
  });

  it("rejects a retry after a non-retryable failure", () => {
    const violation = validateFixture(
      "submit-retry",
      mutate("submit-retry.json", (fixture) => {
        fixture.turns[0].steps[2].text =
          "VALIDATION_FAILED: request rejected by the protocol schema";
      }),
    );
    expect(violation.join("\n")).toMatch(/non-retryable/i);
  });

  it("rejects a second mutation in one turn and names the first invalid step", () => {
    const violation = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        fixture.turns[0].steps.splice(2, 0, {
          kind: "mcp_call",
          tool: "cancel_task",
          request_id: fixture.turns[0].request_id,
          arguments: { job_id: "44444444-4444-4444-8444-444444444444" },
        });
      }),
    );
    expect(violation.join("\n")).toContain("submit-online turn 1");
    expect(violation.join("\n")).toMatch(/mutation/i);
  });

  it("requires a matching mcp_result for every call and rejects tool disorder", () => {
    const missingResult = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        fixture.turns[0].steps.splice(2, 1);
      }),
    );
    expect(missingResult.join("\n")).toMatch(/mcp_result/i);

    const disorder = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        const steps = fixture.turns[0].steps;
        steps.splice(1, 0, steps.pop() as LooseStep);
      }),
    );
    expect(disorder.join("\n")).toMatch(/order/i);
  });

  it("keeps an explicit read-only submission in read_only mode", () => {
    const fixture = fixtureJson("submit-read-only.json");
    const submit = fixture.turns[0].steps.find(
      (step) => step.kind === "mcp_call" && step.tool === "submit_task",
    );
    expect(submit).toBeDefined();
    expect(argumentsOf(submit ?? {})).toMatchObject({
      mode: "read_only",
      repository_id: "novelty-web",
    });
    const suite = runContractSuite(fixturesDirectory);
    expect(suite.mutationsByFixture["submit-read-only"]).toBe(1);
  });

  it("executes only the first task request and asks about the second", () => {
    const fixture = fixtureJson("submit-second-request.json");
    const steps = fixture.turns[0].steps;
    const submissions = steps.filter(
      (step) => step.kind === "mcp_call" && step.tool === "submit_task",
    );
    expect(submissions).toHaveLength(1);
    const assistant = steps
      .filter((step) => step.kind === "assistant")
      .map((step) => String(step.text))
      .join(" ");
    expect(assistant).toMatch(/另起|新回合|second/i);
    const suite = runContractSuite(fixturesDirectory);
    expect(suite.mutationsByFixture["submit-second-request"]).toBe(1);
    expect(suite.maxMutationsPerTurn).toBe(1);
  });

  it("requires the client_request_id UUID on every submission", () => {
    const violation = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        delete argumentsOf(fixture.turns[0].steps[1]).client_request_id;
      }),
      { repositoryIds: ["novelty-web", "novelty-api"] },
    );
    expect(violation.join("\n")).toMatch(/client_request_id UUID/);
  });

  it("rejects path-like and unconfigured repository ids", () => {
    const pathLike = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        argumentsOf(fixture.turns[0].steps[1]).repository_id = "novelty/web";
      }),
      { repositoryIds: ["novelty-web", "novelty-api"] },
    );
    expect(pathLike.join("\n")).toMatch(/never a path-like string/);

    const unconfigured = validateFixture(
      "submit-online",
      mutate("submit-online.json", (fixture) => {
        argumentsOf(fixture.turns[0].steps[1]).repository_id = "prod-db";
      }),
      { repositoryIds: ["novelty-web", "novelty-api"] },
    );
    expect(unconfigured.join("\n")).toMatch(
      /not present in the Skill configuration/,
    );
  });

  it("rejects a retry that changes the client_request_id", () => {
    const violation = validateFixture(
      "submit-retry",
      mutate("submit-retry.json", (fixture) => {
        argumentsOf(fixture.turns[1].steps[0]).client_request_id =
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }),
      { repositoryIds: ["novelty-web", "novelty-api"] },
    );
    expect(violation.join("\n")).toMatch(
      /retry payload changed|client_request_id/,
    );
  });

  it("keeps the offline queue on one UUID and does not retry", () => {
    const suite = runContractSuite(fixturesDirectory);
    expect(suite.retriesByFixture["submit-offline"]).toBe(0);
    const fixture = fixtureJson("submit-offline.json");
    const submit = fixture.turns[0].steps.find(
      (step) => step.kind === "mcp_call" && step.tool === "submit_task",
    );
    expect(argumentsOf(submit ?? {}).client_request_id).toBe(
      fixture.turns[0].request_id,
    );
  });

  it("keeps ambiguous repository and path-like turns mutation-free", () => {
    const fixture = fixtureJson("repository-ambiguous.json");
    const mutationCalls = fixture.turns.flatMap((turn) =>
      turn.steps.filter(
        (step) =>
          step.kind === "mcp_call" && mutationTools.includes(String(step.tool)),
      ),
    );
    expect(mutationCalls).toEqual([]);
    expect(fixture.turns.length).toBeGreaterThanOrEqual(2);
  });
});

describe("repository resolution configuration", () => {
  it("stores the alias table as configuration, never as path-like ids", () => {
    const config = JSON.parse(
      readFileSync(
        join(fixturesDirectory, "..", "..", "config", "repositories.json"),
        "utf8",
      ),
    );
    expect(validateRepositoryConfiguration(config)).toEqual([]);
  });

  it("rejects a path-like repository alias", () => {
    const config = {
      schema_version: 1,
      repositories: [
        {
          id: "novelty-web",
          display_name: "Novelty Web",
          aliases: ["Novelty Web", ["", "Users", "alice", "novelty"].join("/")],
        },
      ],
    };

    expect(validateRepositoryConfiguration(config).join("\n")).toMatch(
      /must never look like a local path/,
    );
  });
});

describe("mutation tool scoping", () => {
  const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const jobId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cancelTranscript = {
    fixture_id: "cancel-decide",
    turns: [
      {
        request_id: requestId,
        steps: [
          { kind: "user", text: "取消任务" },
          {
            kind: "mcp_call",
            tool: "cancel_task",
            request_id: requestId,
            arguments: { job_id: jobId, expected_revision: 1 },
          },
          {
            kind: "mcp_result",
            tool: "cancel_task",
            request_id: requestId,
            ok: true,
            text: "已取消",
          },
        ],
      },
      {
        request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        steps: [
          { kind: "user", text: "批准这个审批" },
          {
            kind: "mcp_call",
            tool: "decide_approval",
            request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            arguments: {
              approval_id: jobId,
              decision: "approve",
              expected_job_revision: 1,
            },
          },
          {
            kind: "mcp_result",
            tool: "decide_approval",
            request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            ok: true,
            text: "已批准",
          },
        ],
      },
    ],
  };
  const repositoryIds = ["novelty-web", "novelty-api"];

  it("accepts cancel_task and decide_approval without submission fields", () => {
    const violations = validateFixture(
      "cancel-decide",
      JSON.stringify(cancelTranscript),
      { repositoryIds },
    );
    expect(violations).toEqual([]);
  });

  it("still counts one mutation per cancel or decide turn", () => {
    for (const turn of cancelTranscript.turns) {
      const mutations = turn.steps.filter(
        (step) =>
          step.kind === "mcp_call" && mutationTools.includes(String(step.tool)),
      );
      expect(mutations).toHaveLength(1);
    }
  });

  it("rejects a submit_task that omits the submission fields", () => {
    const transcript = {
      fixture_id: "submit-missing",
      turns: [
        {
          request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          steps: [
            { kind: "user", text: "跑测试" },
            {
              kind: "mcp_call",
              tool: "submit_task",
              request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              arguments: { request: "运行测试", mode: "normal" },
            },
            {
              kind: "mcp_result",
              tool: "submit_task",
              request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              ok: true,
              text: "已受理",
            },
          ],
        },
      ],
    };
    const violations = validateFixture(
      "submit-missing",
      JSON.stringify(transcript),
      { repositoryIds },
    );
    expect(violations.join("\n")).toMatch(/client_request_id UUID/);
    expect(violations.join("\n")).toMatch(/configured repository_id/);
  });
});
