import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  MUTATION_TOOL_NAMES,
  type TranscriptFixture,
  TranscriptFixtureSchema,
} from "./transcript-schema.js";

export type LoadedFixture = {
  name: string;
  fixture: TranscriptFixture;
};

export type ContractSuiteResult = {
  fixtureCount: number;
  turnCount: number;
  violations: string[];
  mutationsByFixture: Record<string, number>;
  maxMutationsPerTurn: number;
  retriesByFixture: Record<string, number>;
};

const STEP_RANK: Record<string, number> = {
  user: 0,
  mcp_call: 1,
  mcp_result: 2,
  ui_call: 3,
  assistant: 3,
  tts: 4,
};

const RETRYABLE_FAILURE = /^(?:TRANSPORT_TIMEOUT|TEMPORARY_UNAVAILABLE)\b/u;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9-]{1,49}$/u;
const PATH_LIKE = /[/~]|\.\.|[A-Za-z]:/u;

type MutationRecord = {
  tool: string;
  payload: string;
  retryableFailure: boolean;
  retries: number;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const submissionPayload = (step: {
  arguments: Record<string, unknown>;
}): string =>
  stableJson({
    repository_id: step.arguments.repository_id,
    request: step.arguments.request,
    mode: step.arguments.mode ?? "normal",
  });

const issueLocation = (
  name: string,
  path: readonly (string | number)[] | undefined,
): string => {
  const turnIndex = typeof path?.[1] === "number" ? path[1] + 1 : 1;
  return `${name} turn ${turnIndex}`;
};

export const validateRepositoryConfiguration = (value: unknown): string[] => {
  const violations: string[] = [];
  const fail = (message: string) =>
    violations.push(`repositories.json: ${message}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("configuration must be an object");
    return violations;
  }
  const document = value as {
    schema_version?: unknown;
    repositories?: unknown;
  };
  if (document.schema_version !== 1) fail("schema_version must be 1");
  if (
    !Array.isArray(document.repositories) ||
    document.repositories.length === 0
  ) {
    fail("repositories must be a non-empty array");
    return violations;
  }
  const ids = new Set<string>();
  for (const [index, entry] of document.repositories.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`repository ${index + 1} must be an object`);
      continue;
    }
    const record = entry as {
      id?: unknown;
      display_name?: unknown;
      aliases?: unknown;
    };
    if (typeof record.id !== "string" || !REPOSITORY_ID.test(record.id)) {
      fail(
        `repository ${index + 1} id must be a lowercase repository id, never a path`,
      );
      continue;
    }
    if (ids.has(record.id)) fail(`repository id ${record.id} is duplicated`);
    ids.add(record.id);
    if (
      typeof record.display_name !== "string" ||
      record.display_name.trim() === ""
    ) {
      fail(`repository ${record.id} display_name must not be empty`);
    }
    if (!Array.isArray(record.aliases)) {
      fail(`repository ${record.id} aliases must be an array`);
      continue;
    }
    for (const alias of record.aliases) {
      if (typeof alias !== "string" || alias.trim() === "") {
        fail(`repository ${record.id} alias must be a non-empty string`);
      } else if (PATH_LIKE.test(alias)) {
        fail(`repository ${record.id} alias must never look like a local path`);
      }
    }
  }
  return violations;
};

const parseFixtureValue = (
  name: string,
  value: unknown,
): { fixture?: TranscriptFixture; violations: string[] } => {
  const parsed = TranscriptFixtureSchema.safeParse(value);
  if (!parsed.success) {
    return {
      violations: parsed.error.issues.map(
        (issue) =>
          `${issueLocation(name, issue.path)} step ${
            typeof issue.path?.[3] === "number" ? issue.path[3] + 1 : 1
          }: ${issue.message}`,
      ),
    };
  }
  return { fixture: parsed.data, violations: [] };
};

export const validateFixture = (
  name: string,
  input: unknown,
  { repositoryIds }: { repositoryIds?: readonly string[] } = {},
): string[] => {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [`${name} turn 1 step 1: fixture is not valid JSON`];
    }
  }
  const { fixture, violations } = parseFixtureValue(name, value);
  if (!fixture) return violations;

  if (fixture.fixture_id !== name) {
    violations.push(
      `${name} turn 1 step 1: fixture_id ${fixture.fixture_id} must match the file name`,
    );
  }

  const mutations = new Map<string, MutationRecord>();
  let submissions = 0;
  for (const [turnIndex, turn] of fixture.turns.entries()) {
    const turnLabel = `${name} turn ${turnIndex + 1}`;
    let lowestRank = -1;
    const expectedResults = new Map<string, number>();
    const resultKeys = new Map<string, number>();
    for (const [stepIndex, step] of turn.steps.entries()) {
      const where = `${turnLabel} step ${stepIndex + 1}`;
      const rank = STEP_RANK[step.kind] ?? 0;
      if (rank < lowestRank) {
        violations.push(
          `${where}: ${step.kind} breaks the expected tool order`,
        );
      }
      lowestRank = Math.max(lowestRank, rank);
      if (step.kind === "mcp_call") {
        const key = `${step.tool}|${step.request_id}`;
        expectedResults.set(key, (expectedResults.get(key) ?? 0) + 1);
        if (!MUTATION_TOOL_NAMES.has(step.tool)) continue;
        const clientRequestId = step.arguments.client_request_id;
        if (typeof clientRequestId !== "string") {
          violations.push(
            `${where}: submit_task must carry the client_request_id UUID`,
          );
        } else if (clientRequestId !== step.request_id) {
          violations.push(
            `${where}: client_request_id must match the turn request_id`,
          );
        }
        const repositoryId = step.arguments.repository_id;
        if (typeof repositoryId !== "string" || repositoryId.trim() === "") {
          violations.push(
            `${where}: submit_task must carry a configured repository_id`,
          );
        } else if (
          !REPOSITORY_ID.test(repositoryId) ||
          PATH_LIKE.test(repositoryId)
        ) {
          violations.push(
            `${where}: repository_id must be a repository id, never a path-like string`,
          );
        } else if (
          repositoryIds !== undefined &&
          !repositoryIds.includes(repositoryId)
        ) {
          violations.push(
            `${where}: repository_id ${repositoryId} is not present in the Skill configuration`,
          );
        }
        const payload = submissionPayload(step);
        const previous = mutations.get(step.request_id);
        if (!previous) {
          const userRequested = turn.steps
            .slice(0, stepIndex)
            .some((item) => item.kind === "user");
          if (!userRequested) {
            violations.push(
              `${where}: mutation ${step.tool} is not preceded by a user request`,
            );
          }
          submissions += 1;
          mutations.set(step.request_id, {
            tool: step.tool,
            payload,
            retryableFailure: false,
            retries: 0,
          });
          continue;
        }
        if (previous.tool !== step.tool) {
          violations.push(
            `${where}: request ${step.request_id} retried with a different tool`,
          );
        }
        if (previous.payload !== payload) {
          violations.push(
            `${where}: retry payload changed for request ${step.request_id}`,
          );
        }
        if (!previous.retryableFailure) {
          violations.push(
            `${where}: retry is not allowed after a non-retryable failure`,
          );
        }
        if (previous.retries >= 1) {
          violations.push(
            `${where}: request ${step.request_id} retried more than once`,
          );
        }
        previous.retries += 1;
      }
      if (step.kind === "mcp_result") {
        const key = `${step.tool}|${step.request_id}`;
        resultKeys.set(key, (resultKeys.get(key) ?? 0) + 1);
        if (step.ok === false) {
          const record = mutations.get(step.request_id);
          if (record && MUTATION_TOOL_NAMES.has(step.tool)) {
            record.retryableFailure = RETRYABLE_FAILURE.test(step.text ?? "");
          }
        }
      }
    }
    for (const [key, count] of expectedResults.entries()) {
      if ((resultKeys.get(key) ?? 0) !== count) {
        violations.push(
          `${turnLabel}: mcp_call ${key} has no matching mcp_result in the same turn`,
        );
      }
    }
  }

  // Every fixture models one user task per conversation. A follow-up task in the
  // same conversation belongs to a separate fixture with its own turn, so more
  // than one distinct submission in one fixture is a contract violation rather
  // than a legitimate multi-task dialogue.
  if (submissions > 1) {
    violations.push(
      `${name}: expected zero or one submitted task, found ${submissions}`,
    );
  }
  return violations;
};

export const loadFixtures = (directory: string): LoadedFixture[] =>
  readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      const name = basename(entry, ".json");
      const value = JSON.parse(readFileSync(join(directory, entry), "utf8"));
      const { fixture, violations } = parseFixtureValue(name, value);
      if (!fixture) throw new Error(violations.join("; "));
      return { name, fixture };
    });

export const runContractSuite = (directory: string): ContractSuiteResult => {
  const violations: string[] = [];
  const mutationsByFixture: Record<string, number> = {};
  const retriesByFixture: Record<string, number> = {};
  let maxMutationsPerTurn = 0;
  let turnCount = 0;

  const configuration = JSON.parse(
    readFileSync(
      join(directory, "..", "..", "config", "repositories.json"),
      "utf8",
    ),
  );
  violations.push(...validateRepositoryConfiguration(configuration));
  const configurationRepositories = (
    configuration as { repositories?: { id?: unknown }[] }
  ).repositories;
  const repositoryIds = Array.isArray(configurationRepositories)
    ? configurationRepositories
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string")
    : [];

  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  for (const entry of entries) {
    const name = basename(entry, ".json");
    const value = JSON.parse(readFileSync(join(directory, entry), "utf8"));
    const fixtureViolations = validateFixture(name, value, { repositoryIds });
    violations.push(...fixtureViolations);
    const { fixture } = parseFixtureValue(name, value);
    if (!fixture) continue;
    turnCount += fixture.turns.length;
    let submissions = 0;
    let retries = 0;
    const seen = new Set<string>();
    for (const turn of fixture.turns) {
      let mutationsInTurn = 0;
      for (const step of turn.steps) {
        if (step.kind !== "mcp_call") continue;
        if (!MUTATION_TOOL_NAMES.has(step.tool)) continue;
        mutationsInTurn += 1;
        if (seen.has(step.request_id)) retries += 1;
        else {
          seen.add(step.request_id);
          submissions += 1;
        }
      }
      maxMutationsPerTurn = Math.max(maxMutationsPerTurn, mutationsInTurn);
    }
    mutationsByFixture[name] = submissions;
    retriesByFixture[name] = retries;
  }

  return {
    fixtureCount: entries.length,
    turnCount,
    violations,
    mutationsByFixture,
    maxMutationsPerTurn,
    retriesByFixture,
  };
};
