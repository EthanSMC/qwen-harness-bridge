import { expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  harnessModelLines,
  modelRoutePatchLines,
  parseModelRoute,
} from "../scripts/rehearsal-options.mjs";

const complete = {
  provider: "mock",
  model: "mock-model",
  apiKeyEnv: "MOCK_API_KEY",
};

it("reports no route when no model flag is present", () => {
  expect(parseModelRoute()).toEqual({ requested: false });
  expect(parseModelRoute({})).toEqual({ requested: false });
  expect(
    parseModelRoute({ provider: "", model: "", apiKeyEnv: "", baseUrl: "" }),
  ).toEqual({ requested: false });
  expect(modelRoutePatchLines({ requested: false })).toEqual([]);
  expect(harnessModelLines({ requested: false })).toEqual([]);
});

it("emits a parseable patch for a complete route", () => {
  const route = parseModelRoute({
    ...complete,
    baseUrl: "http://127.0.0.1:1/v1",
  });
  if (route.requested !== true) throw new Error("route should be requested");
  const lines = modelRoutePatchLines(route);
  const parsed = parseYaml(lines.join("\n")) as { id?: string }[];
  expect(parsed.map((entry) => entry.id)).toEqual([
    "llm-pi-ai",
    "agent-default-model",
  ]);
  expect(lines).toContain("        baseURL: http://127.0.0.1:1/v1");
  expect(lines).toContain("          - id: mock-model");
  expect(harnessModelLines(route)).toEqual([
    "    harnessModel:",
    "      provider: mock",
    "      model: mock-model",
  ]);
});

it("omits the base URL line when the route has none", () => {
  const route = parseModelRoute(complete);
  if (route.requested !== true) throw new Error("route should be requested");
  const lines = modelRoutePatchLines(route);
  expect(lines.some((line) => line.includes("baseURL:"))).toBe(false);
  expect(parseYaml(lines.join("\n"))).toHaveLength(2);
});

it("refuses an incomplete route", () => {
  expect(() => parseModelRoute({ provider: "mock" })).toThrow(
    /must be given together/u,
  );
  expect(() =>
    parseModelRoute({ provider: "mock", model: "mock-model" }),
  ).toThrow(/must be given together/u);
  expect(() =>
    parseModelRoute({ model: "mock-model", apiKeyEnv: "MOCK_API_KEY" }),
  ).toThrow(/must be given together/u);
  expect(() => parseModelRoute({ ...complete, baseUrl: "" })).not.toThrow();
});

it("refuses values that could rewrite the patch document", () => {
  expect(() =>
    parseModelRoute({ ...complete, baseUrl: "http://host/v1\n- id: evil" }),
  ).toThrow(/model-base-url/u);
  expect(() =>
    parseModelRoute({ ...complete, baseUrl: "http://host/v1 - id: evil" }),
  ).toThrow(/model-base-url/u);
  expect(() =>
    parseModelRoute({ ...complete, baseUrl: 'http://host/"v1"' }),
  ).toThrow(/model-base-url/u);
  expect(() =>
    parseModelRoute({ ...complete, baseUrl: "file:///etc/passwd" }),
  ).toThrow(/model-base-url/u);
  expect(() =>
    parseModelRoute({ ...complete, provider: "mock\n- id: evil" }),
  ).toThrow(/model-provider/u);
  expect(() => parseModelRoute({ ...complete, model: "mock model" })).toThrow(
    /model id/u,
  );
  expect(() => parseModelRoute({ ...complete, apiKeyEnv: "MOCK KEY" })).toThrow(
    /environment variable name/u,
  );
  expect(() => parseModelRoute({ ...complete, apiKeyEnv: "1MOCK" })).toThrow(
    /environment variable name/u,
  );
});
