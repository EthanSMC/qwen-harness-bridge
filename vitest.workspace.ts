import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "apps/*",
  {
    test: {
      name: "integration",
      testTimeout: 15_000,
      include: [
        "tests/integration/job-repository.test.ts",
        "tests/integration/connector-outbox.test.ts",
        "tests/integration/connector-gateway.test.ts",
        "tests/integration/foundation-e2e.test.ts",
        "tests/integration/approval-flow.test.ts",
        "tests/integration/cancellation-flow.test.ts",
        "tests/integration/result-flow.test.ts",
        "tests/integration/readiness.test.ts",
      ],
    },
  },
  {
    test: {
      name: "contract",
      include: [
        "tests/contract/mcp-tools.test.ts",
        "tests/contract/mcp-auth.test.ts",
        "tests/contract/health-metrics.test.ts",
        "tests/contract/runtime-build.test.ts",
        "tests/contract/shutdown.test.ts",
        "tests/contract/connector-version-negotiation.test.ts",
      ],
    },
  },
  {
    test: {
      name: "security",
      include: ["tests/security/local-policy.test.ts"],
    },
  },
]);
