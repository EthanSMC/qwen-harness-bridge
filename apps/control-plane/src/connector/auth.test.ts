import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ConnectorCredentialRecord,
  createConnectorBootstrapAuthenticator,
} from "./auth.js";

const OWNER_ID = "owner-auth-fixture";
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000005";
const CREDENTIAL_ID = "connector-credential-fixture";
const CONNECTOR_BOOTSTRAP_CREDENTIAL = "connector-bootstrap-fixture-only";
const MCP_BEARER = "mcp-bearer-fixture-only";
const STORED_CREDENTIAL_HASH =
  "sha256:0d92d412518874ddc91e3bd73fee370c33358224cc09b69aeaf461bd6ce87ac6";

const credentialRecord: ConnectorCredentialRecord = {
  credentialId: CREDENTIAL_ID,
  credentialHash: STORED_CREDENTIAL_HASH,
  ownerId: OWNER_ID,
  connectorId: CONNECTOR_ID,
  protocolVersion: "1.0",
};

const hashFixtureCredential = (credential: string): string =>
  `sha256:${createHash("sha256").update(credential, "utf8").digest("hex")}`;

const createAuthenticator = () =>
  createConnectorBootstrapAuthenticator({
    credentialStore: {
      async findByCredentialId(credentialId: string) {
        return credentialId === credentialRecord.credentialId
          ? credentialRecord
          : null;
      },
    },
    verifyCredentialHash: async (credential: string, storedHash: string) =>
      hashFixtureCredential(credential) === storedHash,
  });

const safeFailure = {
  code: "UNAUTHENTICATED",
  message: "Authentication failed.",
} as const;

const captureFailure = async (
  operation: () => Promise<unknown>,
): Promise<{ name: string; code: unknown; message: string }> => {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject(safeFailure);
    return {
      name: error instanceof Error ? error.name : typeof error,
      code:
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  throw new Error("expected Connector authentication to fail");
};

describe("Connector bootstrap authentication", () => {
  it("exchanges an enrolled per-Connector credential for its stored identity", async () => {
    const identity = await createAuthenticator().exchange({
      credentialId: CREDENTIAL_ID,
      credentialSecret: CONNECTOR_BOOTSTRAP_CREDENTIAL,
    });

    expect(identity).toEqual({
      ownerId: OWNER_ID,
      connectorId: CONNECTOR_ID,
      protocolVersion: "1.0",
    });
    expect(identity).not.toHaveProperty("credentialHash");
    expect(identity).not.toHaveProperty("credentialSecret");
  });

  it("accepts only a credential secret matching the stored credential hash", async () => {
    const authenticator = createAuthenticator();

    await expect(
      authenticator.exchange({
        credentialId: CREDENTIAL_ID,
        credentialSecret: CONNECTOR_BOOTSTRAP_CREDENTIAL,
      }),
    ).resolves.toMatchObject({ connectorId: CONNECTOR_ID });

    await expect(
      authenticator.exchange({
        credentialId: CREDENTIAL_ID,
        credentialSecret: "wrong-connector-secret-fixture",
      }),
    ).rejects.toMatchObject(safeFailure);
  });

  it.each([
    ["unknown credential ID", MCP_BEARER, CONNECTOR_BOOTSTRAP_CREDENTIAL],
    [
      "wrong credential secret",
      CREDENTIAL_ID,
      "wrong-connector-secret-fixture",
    ],
    ["MCP bearer used as a Connector credential", CREDENTIAL_ID, MCP_BEARER],
  ] as const)(
    "fails closed for %s without revealing credential existence",
    async (_case, credentialId, credentialSecret) => {
      const error = await captureFailure(() =>
        createAuthenticator().exchange({ credentialId, credentialSecret }),
      );

      expect(error.message).toBe(safeFailure.message);
      expect(error.message).not.toContain(credentialId);
      expect(error.message).not.toContain(credentialSecret);
    },
  );

  it("returns the same safe failure shape for unknown and wrong credentials", async () => {
    const authenticator = createAuthenticator();
    const unknownCredentialFailure = await captureFailure(() =>
      authenticator.exchange({
        credentialId: "unknown-credential-fixture",
        credentialSecret: CONNECTOR_BOOTSTRAP_CREDENTIAL,
      }),
    );
    const wrongSecretFailure = await captureFailure(() =>
      authenticator.exchange({
        credentialId: CREDENTIAL_ID,
        credentialSecret: "wrong-connector-secret-fixture",
      }),
    );

    expect(unknownCredentialFailure).toEqual(wrongSecretFailure);
  });
});
