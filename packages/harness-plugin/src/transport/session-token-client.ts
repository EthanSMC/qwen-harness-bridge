import { request as httpsRequest, type RequestOptions } from "node:https";
import { z } from "zod";

export interface SessionTokenClient {
  exchange(
    input: {
      connectorId: string;
      bootstrapCredential: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    token: string;
    expiresAt: string;
  }>;
}

export type SessionTokenHttpRequest = (
  options: RequestOptions,
  body: string,
  signal?: AbortSignal,
) => Promise<{ statusCode: number; body: string }>;

export class SessionTokenExchangeError extends Error {
  readonly code = "CONNECTOR_SESSION_EXCHANGE_FAILED" as const;

  constructor() {
    super("CONNECTOR_SESSION_EXCHANGE_FAILED");
    this.name = "SessionTokenExchangeError";
  }
}

const SessionResponseSchema = z
  .object({
    token: z.string().min(1),
    expires_at: z.string().min(1),
  })
  .strict();

const defaultRequest: SessionTokenHttpRequest = (options, body, signal) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error: Error | undefined,
      result?: { statusCode: number; body: string },
    ): void => {
      if (settled) return;
      settled = true;
      if (error === undefined)
        resolve(result as { statusCode: number; body: string });
      else reject(error);
    };

    const request = httpsRequest({ ...options, signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("end", () =>
        finish(undefined, {
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.once("error", (error) => finish(error));
    });
    request.once("error", (error) => finish(error));
    request.end(body);
  });

const endpointFor = (input: string | URL): URL => {
  let endpoint: URL;
  try {
    endpoint = new URL(input.toString());
  } catch {
    throw new SessionTokenExchangeError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new SessionTokenExchangeError();
  }
  return endpoint;
};

export type HttpsSessionTokenClientOptions = Readonly<{
  endpoint: string | URL;
  credentialId: string;
  request?: SessionTokenHttpRequest;
}>;

export class HttpsSessionTokenClient implements SessionTokenClient {
  readonly #endpoint: URL;
  readonly #credentialId: string;
  readonly #request: SessionTokenHttpRequest;

  constructor(options: HttpsSessionTokenClientOptions) {
    this.#endpoint = endpointFor(options.endpoint);
    if (
      typeof options.credentialId !== "string" ||
      options.credentialId.length === 0
    ) {
      throw new SessionTokenExchangeError();
    }
    this.#credentialId = options.credentialId;
    this.#request = options.request ?? defaultRequest;
  }

  async exchange(
    input: {
      connectorId: string;
      bootstrapCredential: string;
    },
    signal?: AbortSignal,
  ): Promise<{ token: string; expiresAt: string }> {
    if (
      typeof input?.connectorId !== "string" ||
      typeof input.bootstrapCredential !== "string" ||
      input.connectorId.length === 0 ||
      input.bootstrapCredential.length === 0
    ) {
      throw new SessionTokenExchangeError();
    }

    const endpoint = new URL(this.#endpoint);
    endpoint.pathname = endpoint.pathname.endsWith("/session")
      ? endpoint.pathname
      : `${endpoint.pathname.replace(/\/$/u, "")}/session`;
    endpoint.search = "";
    const body = JSON.stringify({
      connector_id: input.connectorId,
      credential_id: this.#credentialId,
      credential_secret: input.bootstrapCredential,
    });
    let response: { statusCode: number; body: string };
    try {
      response = await this.#request(
        {
          protocol: "https:",
          hostname: endpoint.hostname,
          port: endpoint.port === "" ? 443 : Number(endpoint.port),
          path: `${endpoint.pathname}${endpoint.search}`,
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        body,
        signal,
      );
    } catch {
      throw new SessionTokenExchangeError();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new SessionTokenExchangeError();
    }
    try {
      const parsed = SessionResponseSchema.parse(JSON.parse(response.body));
      if (Number.isNaN(Date.parse(parsed.expires_at))) {
        throw new Error("invalid expiry");
      }
      return { token: parsed.token, expiresAt: parsed.expires_at };
    } catch {
      throw new SessionTokenExchangeError();
    }
  }
}

export const createSessionTokenClient = (
  options: HttpsSessionTokenClientOptions,
): HttpsSessionTokenClient => new HttpsSessionTokenClient(options);
