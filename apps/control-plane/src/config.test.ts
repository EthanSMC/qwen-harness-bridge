import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_ENV = {
  DATABASE_URL: "postgresql://qhb:qhb@localhost:5432/qhb",
  QHB_OWNER_ID: "owner-config",
  QHB_MCP_BEARER_TOKEN: "qhb-config-token-with-enough-entropy",
  QHB_REQUEST_ENCRYPTION_KEY: "qhb-request-encryption-key-with-enough-entropy",
};

async function loadConfigModule() {
  vi.stubEnv("DATABASE_URL", BASE_ENV.DATABASE_URL);
  return import("./config.js");
}

describe("control-plane TLS configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["missing certificate path", { QHB_TLS_KEY_PATH: "/run/secrets/qhb.key" }],
    ["missing key path", { QHB_TLS_CERT_PATH: "/run/secrets/qhb.crt" }],
  ] as const)("rejects %s", async (_case, tlsEnvironment) => {
    const { loadConfig } = await loadConfigModule();
    expect(() => loadConfig({ ...BASE_ENV, ...tlsEnvironment })).toThrow();
  });

  it("loads a complete certificate and key path pair", async () => {
    const { loadConfig } = await loadConfigModule();
    expect(
      loadConfig({
        ...BASE_ENV,
        QHB_TLS_CERT_PATH: "/run/secrets/qhb.crt",
        QHB_TLS_KEY_PATH: "/run/secrets/qhb.key",
      }),
    ).toMatchObject({
      tlsCertPath: "/run/secrets/qhb.crt",
      tlsKeyPath: "/run/secrets/qhb.key",
    });
  });
});
