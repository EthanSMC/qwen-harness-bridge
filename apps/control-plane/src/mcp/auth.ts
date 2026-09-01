import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export type AuthorizationHeader = string | readonly string[] | undefined;

export type McpOwnerContext = Readonly<{
  id: string;
}>;

export type TimingSafeEqual = (left: Buffer, right: Buffer) => boolean;

export class McpAuthenticationError extends Error {
  readonly code = "UNAUTHENTICATED" as const;

  constructor() {
    super("Authentication failed.");
    this.name = "McpAuthenticationError";
  }
}

type AuthenticatorOptions = Readonly<{
  expectedToken: string;
  ownerId: string;
  timingSafeEqual?: TimingSafeEqual;
}>;

type HeaderSource = Readonly<{
  authorization?: AuthorizationHeader;
}>;

const bearerPattern = /^Bearer ([^\s]+)$/;

export function createMcpAuthenticator(options: AuthenticatorOptions): {
  authenticate(headers: HeaderSource): McpOwnerContext;
} {
  const expected = Buffer.from(options.expectedToken, "utf8");
  const compare = options.timingSafeEqual ?? nodeTimingSafeEqual;

  return {
    authenticate(headers) {
      const header = headers.authorization;
      if (header === undefined || header === null) {
        throw new McpAuthenticationError();
      }

      const value = Array.isArray(header)
        ? header.length === 1
          ? header[0]
          : undefined
        : header;
      const match =
        typeof value === "string" ? value.match(bearerPattern) : null;
      if (match === null || match[1] === undefined) {
        throw new McpAuthenticationError();
      }

      const presented = Buffer.from(match[1], "utf8");
      if (presented.length !== expected.length) {
        throw new McpAuthenticationError();
      }

      let equal = false;
      try {
        equal = compare(presented, expected);
      } catch {
        throw new McpAuthenticationError();
      }
      if (!equal) {
        throw new McpAuthenticationError();
      }

      return { id: options.ownerId };
    },
  };
}
