import { describe, expect, it } from "vitest";
import { createMcpAuthenticator } from "../mcp/auth.js";
import { createConnectorSessionService } from "./session.js";

const OWNER_ID = "owner-session-fixture";
const OTHER_OWNER_ID = "owner-attacker-fixture";
const CONNECTOR_ID = "00000000-0000-4000-8000-0000000000a6";
const FIXED_NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");
const SESSION_SIGNING_KEY = "connector-session-signing-key-fixture-only";
const MCP_BEARER = "mcp-bearer-fixture-only";

const connectorIdentity = {
  ownerId: OWNER_ID,
  connectorId: CONNECTOR_ID,
  protocolVersion: "1.0" as const,
};

const createService = (clock: () => Date) =>
  createConnectorSessionService({
    signingKey: SESSION_SIGNING_KEY,
    now: clock,
  });

const captureFailure = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Authentication failed.",
    });
    return error;
  }

  throw new Error("expected Connector session authentication to fail");
};

const tamperOwnerClaim = (token: string): string => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new Error("expected a compact signed session token");
  }

  const claims = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  claims.owner_id = OTHER_OWNER_ID;
  parts[1] = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return parts.join(".");
};

describe("Connector session tokens", () => {
  it("issues a signed 15-minute token with the required owner and Connector claims", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    const token = service.issue(connectorIdentity);

    expect(service.verify(token)).toEqual({
      owner_id: OWNER_ID,
      connector_id: CONNECTOR_ID,
      protocol_version: "1.0",
      iat: FIXED_NOW_MS / 1000,
      exp: FIXED_NOW_MS / 1000 + 15 * 60,
    });
  });

  it("rejects a token whose signed claims were tampered with", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    const token = service.issue(connectorIdentity);

    captureFailure(() => service.verify(tamperOwnerClaim(token)));
  });

  it("expires a token at its 15-minute boundary without waiting in real time", () => {
    let nowMs = FIXED_NOW_MS;
    const service = createService(() => new Date(nowMs));
    const token = service.issue(connectorIdentity);

    nowMs = FIXED_NOW_MS + 15 * 60 * 1000 - 1;
    expect(service.verify(token)).toMatchObject({ owner_id: OWNER_ID });

    nowMs = FIXED_NOW_MS + 15 * 60 * 1000;
    captureFailure(() => service.verify(token));
  });

  it.each([
    ["missing Authorization", {}],
    ["malformed Authorization", { authorization: "Bearer" }],
    ["empty bearer value", { authorization: "Bearer " }],
    ["wrong Authorization scheme", { authorization: "Basic fixture" }],
    [
      "duplicate Authorization values",
      { authorization: ["Bearer fixture-one", "Bearer fixture-two"] },
    ],
  ] as const)("fails closed for %s", (_case, headers) => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    captureFailure(() => service.authenticate(headers));
  });

  it("accepts exactly one valid Connector bearer and returns its verified claims", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    const token = service.issue(connectorIdentity);

    expect(service.authenticate({ authorization: `Bearer ${token}` })).toEqual({
      owner_id: OWNER_ID,
      connector_id: CONNECTOR_ID,
      protocol_version: "1.0",
      iat: FIXED_NOW_MS / 1000,
      exp: FIXED_NOW_MS / 1000 + 15 * 60,
    });
  });

  it("canonicalizes connector UUIDs in issued and verified session claims", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    const token = service.issue({
      ...connectorIdentity,
      connectorId: CONNECTOR_ID.toUpperCase(),
    });

    expect(service.verify(token).connector_id).toBe(CONNECTOR_ID);
  });

  it("fails closed for a malformed connector UUID claim", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    expect(() =>
      service.issue({
        ...connectorIdentity,
        connectorId: "not-a-connector-uuid",
      }),
    ).toThrow();
  });

  it("keeps MCP bearer credentials and Connector session tokens in separate trust domains", () => {
    const service = createService(() => new Date(FIXED_NOW_MS));
    const connectorToken = service.issue(connectorIdentity);
    const mcpAuthenticator = createMcpAuthenticator({
      expectedToken: MCP_BEARER,
      ownerId: OWNER_ID,
    });

    expect(() =>
      mcpAuthenticator.authenticate({
        authorization: `Bearer ${connectorToken}`,
      }),
    ).toThrow();
    captureFailure(() =>
      service.authenticate({ authorization: `Bearer ${MCP_BEARER}` }),
    );
  });
});
