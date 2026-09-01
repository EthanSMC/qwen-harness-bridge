import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "apps/*",
  {
    test: {
      name: "integration",
      include: ["tests/integration/job-repository.test.ts"],
    },
  },
  {
    test: {
      name: "contract",
      include: [
        "tests/contract/mcp-tools.test.ts",
        "tests/contract/mcp-auth.test.ts",
      ],
    },
  },
]);
