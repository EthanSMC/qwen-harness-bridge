import {
  createHmac,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

export const CONNECTOR_SESSION_TTL_SECONDS = 900;
export const CONNECTOR_SESSION_SIGNING_DOMAIN = "qhb.connector.session.v1";

const CONNECTOR_SESSION_HEADER = Object.freeze({
  alg: "HS256",
  typ: "connector-session",
  version: 1,
});
const CONNECTOR_PROTOCOL_VERSION = "1.0";
const MAX_SESSION_TOKEN_BYTES = 4096;
const bearerPattern = /^Bearer ([^\s]+)$/;

export type ConnectorSessionClaims = Readonly<{
  owner_id: string;
  connector_id: string;
  protocol_version: string;
  iat: number;
  exp: number;
}>;

export type ConnectorSessionIdentity = Readonly<{
  ownerId: string;
  connectorId: string;
  protocolVersion: string;
}>;

export type ConnectorAuthorizationHeader =
  | string
  | readonly string[]
  | undefined;

export class ConnectorSessionAuthenticationError extends Error {
  readonly code = "UNAUTHENTICATED" as const;

  constructor() {
    super("Authentication failed.");
    this.name = "ConnectorSessionAuthenticationError";
  }
}

const authenticationFailure = (): ConnectorSessionAuthenticationError =>
  new ConnectorSessionAuthenticationError();

const encodeJson = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeBase64Url = (value: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
};

const parseJson = (value: Buffer): unknown => {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
};

const isProtectedHeader = (
  value: unknown,
): value is typeof CONNECTOR_SESSION_HEADER =>
  isRecord(value) &&
  hasExactKeys(value, ["alg", "typ", "version"]) &&
  value.alg === CONNECTOR_SESSION_HEADER.alg &&
  value.typ === CONNECTOR_SESSION_HEADER.typ &&
  value.version === CONNECTOR_SESSION_HEADER.version;

const isSessionClaims = (value: unknown): value is ConnectorSessionClaims => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "owner_id",
      "connector_id",
      "protocol_version",
      "iat",
      "exp",
    ]) ||
    typeof value.owner_id !== "string" ||
    value.owner_id.length === 0 ||
    typeof value.connector_id !== "string" ||
    value.connector_id.length === 0 ||
    value.protocol_version !== CONNECTOR_PROTOCOL_VERSION
  ) {
    return false;
  }

  const { iat, exp } = value;
  return (
    typeof iat === "number" &&
    Number.isSafeInteger(iat) &&
    iat >= 0 &&
    typeof exp === "number" &&
    Number.isSafeInteger(exp) &&
    exp === iat + CONNECTOR_SESSION_TTL_SECONDS
  );
};

const signingInput = (header: string, claims: string): Buffer =>
  Buffer.from(
    `${CONNECTOR_SESSION_SIGNING_DOMAIN}.${header}.${claims}`,
    "ascii",
  );

const sign = (signingKey: Buffer, header: string, claims: string): Buffer =>
  createHmac("sha256", signingKey)
    .update(signingInput(header, claims))
    .digest();

const readIssuedAt = (now: () => Date): number => {
  const time = now();
  const milliseconds = time.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("Connector session clock is invalid");
  }
  const issuedAt = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(issuedAt)) {
    throw new Error("Connector session clock is invalid");
  }
  return issuedAt;
};

const readAuthorizationValue = (
  header: ConnectorAuthorizationHeader,
): string | null => {
  if (header === undefined || header === null) {
    return null;
  }
  const value = Array.isArray(header)
    ? header.length === 1
      ? header[0]
      : undefined
    : header;
  const match = typeof value === "string" ? value.match(bearerPattern) : null;
  return match?.[1] ?? null;
};

export function createConnectorSessionService(options: {
  signingKey: string | Uint8Array;
  now: () => Date;
}): {
  issue(identity: ConnectorSessionIdentity): string;
  verify(token: string): ConnectorSessionClaims;
  authenticate(headers: {
    authorization?: ConnectorAuthorizationHeader;
  }): ConnectorSessionClaims;
} {
  const signingKey =
    typeof options.signingKey === "string"
      ? Buffer.from(options.signingKey, "utf8")
      : Buffer.from(options.signingKey);
  if (signingKey.length < 32) {
    throw new Error("Connector session signing key must contain 32 bytes");
  }

  const issue = (identity: ConnectorSessionIdentity): string => {
    if (
      identity.protocolVersion !== CONNECTOR_PROTOCOL_VERSION ||
      identity.ownerId.length === 0 ||
      identity.connectorId.length === 0
    ) {
      throw new Error("Connector session identity is invalid");
    }

    const iat = readIssuedAt(options.now);
    const exp = iat + CONNECTOR_SESSION_TTL_SECONDS;
    const headerSegment = encodeJson(CONNECTOR_SESSION_HEADER);
    const claimsSegment = encodeJson({
      owner_id: identity.ownerId,
      connector_id: identity.connectorId,
      protocol_version: identity.protocolVersion,
      iat,
      exp,
    });
    const signatureSegment = sign(
      signingKey,
      headerSegment,
      claimsSegment,
    ).toString("base64url");
    return `${headerSegment}.${claimsSegment}.${signatureSegment}`;
  };

  const verify = (token: string): ConnectorSessionClaims => {
    try {
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        Buffer.byteLength(token, "utf8") > MAX_SESSION_TOKEN_BYTES
      ) {
        throw authenticationFailure();
      }

      const parts = token.split(".");
      if (parts.length !== 3) {
        throw authenticationFailure();
      }
      const [headerSegment, claimsSegment, signatureSegment] = parts;
      if (
        headerSegment === undefined ||
        claimsSegment === undefined ||
        signatureSegment === undefined
      ) {
        throw authenticationFailure();
      }

      const encodedHeader = decodeBase64Url(headerSegment);
      const encodedClaims = decodeBase64Url(claimsSegment);
      const presentedSignature = decodeBase64Url(signatureSegment);
      if (
        encodedHeader === null ||
        encodedClaims === null ||
        presentedSignature === null
      ) {
        throw authenticationFailure();
      }

      const header = parseJson(encodedHeader);
      const claims = parseJson(encodedClaims);
      if (!isProtectedHeader(header) || !isSessionClaims(claims)) {
        throw authenticationFailure();
      }

      const expectedSignature = sign(signingKey, headerSegment, claimsSegment);
      const normalizedSignature = Buffer.alloc(expectedSignature.length);
      presentedSignature.copy(
        normalizedSignature,
        0,
        0,
        expectedSignature.length,
      );
      const signatureMatches = nodeTimingSafeEqual(
        normalizedSignature,
        expectedSignature,
      );
      normalizedSignature.fill(0);
      expectedSignature.fill(0);
      if (!signatureMatches || presentedSignature.length !== 32) {
        throw authenticationFailure();
      }

      const nowSeconds = readIssuedAt(options.now);
      if (nowSeconds < claims.iat || nowSeconds >= claims.exp) {
        throw authenticationFailure();
      }
      return claims;
    } catch (error) {
      if (error instanceof ConnectorSessionAuthenticationError) {
        throw error;
      }
      throw authenticationFailure();
    }
  };

  return {
    issue,
    verify,
    authenticate(headers) {
      const token = readAuthorizationValue(headers?.authorization);
      if (token === null) {
        throw authenticationFailure();
      }
      return verify(token);
    },
  };
}
