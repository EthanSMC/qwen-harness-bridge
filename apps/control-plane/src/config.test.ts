import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_ENV = {
  DATABASE_URL: "postgresql://qhb:qhb@localhost:5432/qhb",
  QHB_OWNER_ID: "owner-config",
  QHB_MCP_BEARER_TOKEN: "qhb-config-token-with-enough-entropy",
  QHB_REQUEST_ENCRYPTION_KEY: "qhb-request-encryption-key-with-enough-entropy",
  QHB_CONNECTOR_SESSION_SIGNING_KEY:
    "qhb-connector-session-signing-key-with-enough-entropy",
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
      connectorSessionSigningKey:
        "qhb-connector-session-signing-key-with-enough-entropy",
      tlsCertPath: "/run/secrets/qhb.crt",
      tlsKeyPath: "/run/secrets/qhb.key",
    });
  });
});

describe("control-plane secret domain separation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [
      "QHB_MCP_BEARER_TOKEN and QHB_REQUEST_ENCRYPTION_KEY",
      {
        ...BASE_ENV,
        QHB_REQUEST_ENCRYPTION_KEY: BASE_ENV.QHB_MCP_BEARER_TOKEN,
      },
    ],
    [
      "QHB_MCP_BEARER_TOKEN and QHB_CONNECTOR_SESSION_SIGNING_KEY",
      {
        ...BASE_ENV,
        QHB_CONNECTOR_SESSION_SIGNING_KEY: BASE_ENV.QHB_MCP_BEARER_TOKEN,
      },
    ],
    [
      "QHB_REQUEST_ENCRYPTION_KEY and QHB_CONNECTOR_SESSION_SIGNING_KEY",
      {
        ...BASE_ENV,
        QHB_CONNECTOR_SESSION_SIGNING_KEY: BASE_ENV.QHB_REQUEST_ENCRYPTION_KEY,
      },
    ],
  ] as const)("rejects equal %s", async (_case, environment) => {
    const { loadConfig } = await loadConfigModule();
    expect(() => loadConfig(environment)).toThrow();
  });

  it("loads distinct runtime secrets", async () => {
    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(BASE_ENV)).toMatchObject({
      mcpBearerToken: BASE_ENV.QHB_MCP_BEARER_TOKEN,
      requestEncryptionKey: BASE_ENV.QHB_REQUEST_ENCRYPTION_KEY,
      connectorSessionSigningKey: BASE_ENV.QHB_CONNECTOR_SESSION_SIGNING_KEY,
    });
  });
});
