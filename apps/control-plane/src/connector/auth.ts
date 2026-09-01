import {
  timingSafeEqual as nodeTimingSafeEqual,
  randomBytes,
  scrypt,
} from "node:crypto";

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SCRYPT_HASH_PATTERN =
  /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

const DUMMY_SCRYPT_HASH =
  "scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const safeAuthenticationMessage = "Authentication failed.";

export type ConnectorCredentialRecord = Readonly<{
  credentialId: string;
  credentialHash: string;
  ownerId: string;
  connectorId: string;
  protocolVersion: string;
}>;

export type ConnectorCredentialStore = Readonly<{
  findByCredentialId(
    credentialId: string,
  ): Promise<ConnectorCredentialRecord | null>;
}>;

export type ConnectorIdentity = Readonly<{
  ownerId: string;
  connectorId: string;
  protocolVersion: string;
}>;

export type CredentialHashVerifier = (
  credential: string,
  storedHash: string,
) => Promise<boolean> | boolean;

export type ConnectorCredentialHashOptions = Readonly<{
  salt?: Uint8Array;
}>;

export class ConnectorAuthenticationError extends Error {
  readonly code = "UNAUTHENTICATED" as const;

  constructor() {
    super(safeAuthenticationMessage);
    this.name = "ConnectorAuthenticationError";
  }
}

const encodeBase64Url = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64url");

const decodeBase64Url = (value: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
};

const deriveScryptKey = async (
  credential: string,
  salt: Uint8Array,
  parameters: Readonly<{
    N: number;
    r: number;
    p: number;
  }>,
): Promise<Buffer> => {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      credential,
      Buffer.from(salt),
      SCRYPT_KEY_LENGTH,
      {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derived) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derived);
      },
    );
  });
};

type ParsedCredentialHash = Readonly<{
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}>;

const parseCredentialHash = (
  storedHash: string,
): ParsedCredentialHash | null => {
  const match = storedHash.match(SCRYPT_HASH_PATTERN);
  if (match === null) {
    return null;
  }

  const [, nText, rText, pText, saltText, expectedText] = match;
  if (
    nText === undefined ||
    rText === undefined ||
    pText === undefined ||
    saltText === undefined ||
    expectedText === undefined
  ) {
    return null;
  }

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    return null;
  }

  const salt = decodeBase64Url(saltText);
  const expected = decodeBase64Url(expectedText);
  if (
    salt === null ||
    expected === null ||
    salt.length !== SCRYPT_SALT_LENGTH ||
    expected.length !== SCRYPT_KEY_LENGTH
  ) {
    return null;
  }

  return { N, r, p, salt, expected };
};

const dummyCredentialHash = (): ParsedCredentialHash => {
  const parsed = parseCredentialHash(DUMMY_SCRYPT_HASH);
  if (parsed === null) {
    throw new Error("Connector credential verifier is misconfigured");
  }
  return parsed;
};

export async function hashConnectorCredential(
  credential: string,
  options: ConnectorCredentialHashOptions = {},
): Promise<string> {
  if (typeof credential !== "string") {
    throw new TypeError("Connector credential must be text");
  }

  const salt =
    options.salt === undefined
      ? randomBytes(SCRYPT_SALT_LENGTH)
      : Buffer.from(options.salt);
  if (salt.length !== SCRYPT_SALT_LENGTH) {
    throw new TypeError("Connector credential salt has an invalid length");
  }

  const derived = await deriveScryptKey(credential, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  try {
    return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
  } finally {
    derived.fill(0);
  }
}

export async function verifyConnectorCredentialHash(
  credential: string,
  storedHash: string,
): Promise<boolean> {
  const parsed =
    typeof storedHash === "string" ? parseCredentialHash(storedHash) : null;
  const comparison = parsed ?? dummyCredentialHash();
  let derived: Buffer;

  try {
    derived = await deriveScryptKey(
      typeof credential === "string" ? credential : "",
      comparison.salt,
      comparison,
    );
  } catch {
    return false;
  }

  try {
    const equal = nodeTimingSafeEqual(derived, comparison.expected);
    return parsed !== null && equal;
  } catch {
    return false;
  } finally {
    derived.fill(0);
    comparison.salt.fill(0);
    comparison.expected.fill(0);
  }
}

export const createConnectorCredentialHash = hashConnectorCredential;
export const verifyCredentialHash = verifyConnectorCredentialHash;

const isUsableCredentialRecord = (
  record: ConnectorCredentialRecord | null,
): record is ConnectorCredentialRecord =>
  record !== null &&
  typeof record === "object" &&
  typeof record.credentialId === "string" &&
  typeof record.credentialHash === "string" &&
  typeof record.ownerId === "string" &&
  record.ownerId.length > 0 &&
  typeof record.connectorId === "string" &&
  record.connectorId.length > 0 &&
  record.protocolVersion === "1.0";

type ConnectorBootstrapAuthenticatorOptions = Readonly<{
  credentialStore: ConnectorCredentialStore;
  verifyCredentialHash?: CredentialHashVerifier;
}>;

export function createConnectorBootstrapAuthenticator(
  options: ConnectorBootstrapAuthenticatorOptions,
): {
  exchange(input: {
    credentialId: string;
    credentialSecret: string;
  }): Promise<ConnectorIdentity>;
} {
  const verifier =
    options.verifyCredentialHash ?? verifyConnectorCredentialHash;

  return {
    async exchange(input) {
      const credentialId =
        typeof input?.credentialId === "string" ? input.credentialId : "";
      const credentialSecret =
        typeof input?.credentialSecret === "string"
          ? input.credentialSecret
          : "";
      let record: ConnectorCredentialRecord | null = null;

      try {
        record = await options.credentialStore.findByCredentialId(credentialId);
      } catch {
        record = null;
      }

      const candidateHash = isUsableCredentialRecord(record)
        ? record.credentialHash
        : DUMMY_SCRYPT_HASH;
      let valid = false;
      try {
        valid = await verifier(credentialSecret, candidateHash);
      } catch {
        valid = false;
      }

      if (!isUsableCredentialRecord(record) || !valid) {
        throw new ConnectorAuthenticationError();
      }

      return {
        ownerId: record.ownerId,
        connectorId: record.connectorId,
        protocolVersion: record.protocolVersion,
      };
    },
  };
}
