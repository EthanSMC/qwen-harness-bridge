const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONVERGENCE_READS = 3;
const API_VERSION = "2022-11-28";

const NATURALLY_IDEMPOTENT_METHODS = new Set(["PATCH", "PUT", "DELETE"]);

export class GitHubApiError extends Error {
  constructor(
    message,
    { method, path, status = null, uncertain = false } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.uncertain = uncertain;
  }
}

const requirePositiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const requireGitObjectId = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
  ) {
    throw new Error(`${label} must be a 40- or 64-character Git object ID`);
  }
  return value;
};

const validatePath = (path) => {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("://") ||
    /(?:^|\/)(?:\.{2}|%2e%2e)(?:\/|$|\?)/iu.test(path) ||
    /[\r\n]/u.test(path)
  ) {
    throw new Error("GitHub API path must be a safe relative REST path");
  }
  return path;
};

const validateResponseIds = (value, seen = new Set(), contextKey = null) => {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Object.hasOwn(value, "id")) {
    if (contextKey === "head_commit") {
      requireGitObjectId(value.id, "GitHub response head commit id");
    } else {
      requirePositiveInteger(value.id, "GitHub response review/object id");
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) validateResponseIds(item, seen, contextKey);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    validateResponseIds(child, seen, key);
  }
};

const validateResponseShape = (value, label) => {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object or array`);
  }
  if (
    Array.isArray(value) &&
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  ) {
    throw new Error(`${label} array items must be objects`);
  }
  validateResponseIds(value);
  return value;
};

const requestError = (message, details) => new GitHubApiError(message, details);

const safeIdempotencyKey = (value) => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new Error("GitHub mutation idempotency key is invalid");
  }
  return value;
};

export const createGitHubClient = ({
  fetchImpl = globalThis.fetch,
  repository,
  token,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  convergenceReads = DEFAULT_CONVERGENCE_READS,
  apiBaseUrl = DEFAULT_API_BASE_URL,
} = {}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("GitHub API fetch implementation is unavailable");
  }
  if (
    typeof repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/u.test(repository)
  ) {
    throw new Error("GitHub repository must use owner/name format");
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("GitHub API token is required");
  }
  requirePositiveInteger(pageSize, "GitHub page size");
  if (pageSize > 100) throw new Error("GitHub page size cannot exceed 100");
  requirePositiveInteger(maxPages, "GitHub maximum page count");
  if (maxPages > 100) {
    throw new Error(
      "GitHub maximum page count cannot exceed the safety cap of 100",
    );
  }
  requirePositiveInteger(timeoutMs, "GitHub request timeout");
  if (timeoutMs > 120_000) {
    throw new Error("GitHub request timeout cannot exceed 120 seconds");
  }
  requirePositiveInteger(convergenceReads, "GitHub convergence read count");
  if (convergenceReads > 5) {
    throw new Error("GitHub convergence read count cannot exceed 5");
  }
  if (typeof apiBaseUrl !== "string" || !/^https:\/\//u.test(apiBaseUrl)) {
    throw new Error("GitHub API base URL must use HTTPS");
  }
  const base = apiBaseUrl.replace(/\/+$/u, "");

  const request = async (
    method,
    path,
    { body, idempotencyKey, includeServerDate = false } = {},
  ) => {
    const normalizedMethod = String(method).toUpperCase();
    const normalizedPath = validatePath(path);
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    safeIdempotencyKey(idempotencyKey);

    let serializedBody;
    if (body !== undefined) {
      try {
        serializedBody = JSON.stringify(body);
      } catch {
        throw new Error("GitHub mutation body must be JSON serializable");
      }
    }

    let response;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      response = await fetchImpl(
        `${base}/repos/${repository}${normalizedPath}`,
        {
          method: normalizedMethod,
          headers,
          signal: abortController.signal,
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
        },
      );
    } catch {
      clearTimeout(timeout);
      throw requestError(
        `GitHub API request failed: ${normalizedMethod} ${normalizedPath} reached a network boundary error`,
        {
          method: normalizedMethod,
          path: normalizedPath,
          uncertain: normalizedMethod !== "GET",
        },
      );
    }

    if (response?.ok !== true) {
      clearTimeout(timeout);
      const status = Number.isInteger(response?.status)
        ? response.status
        : null;
      throw requestError(
        `GitHub API request failed: ${normalizedMethod} ${normalizedPath} returned HTTP ${status ?? "unknown"}`,
        {
          method: normalizedMethod,
          path: normalizedPath,
          status,
          uncertain:
            normalizedMethod !== "GET" && (status === null || status >= 500),
        },
      );
    }
    if (response.status === 204) {
      clearTimeout(timeout);
      return includeServerDate
        ? { value: null, serverDate: response.headers?.get?.("date") ?? null }
        : null;
    }

    let value;
    try {
      value = await response.json();
    } catch {
      clearTimeout(timeout);
      throw requestError(
        `GitHub API ${normalizedMethod} ${normalizedPath} returned invalid JSON`,
        {
          method: normalizedMethod,
          path: normalizedPath,
          status: response.status,
          uncertain: normalizedMethod !== "GET",
        },
      );
    }
    let validated;
    try {
      validated = validateResponseShape(
        value,
        `GitHub API ${normalizedMethod} ${normalizedPath} response`,
      );
    } catch (error) {
      clearTimeout(timeout);
      if (normalizedMethod === "GET") throw error;
      throw requestError(
        `GitHub API ${normalizedMethod} ${normalizedPath} returned an invalid response shape`,
        {
          method: normalizedMethod,
          path: normalizedPath,
          status: response.status,
          uncertain: true,
        },
      );
    }
    clearTimeout(timeout);
    return includeServerDate
      ? {
          value: validated,
          serverDate: response.headers?.get?.("date") ?? null,
        }
      : validated;
  };

  const get = (path) => request("GET", path);
  const post = (path, body, options = {}) =>
    request("POST", path, { ...options, body });
  const patch = (path, body, options = {}) =>
    request("PATCH", path, { ...options, body });
  const put = (path, body, options = {}) =>
    request("PUT", path, { ...options, body });
  const remove = (path, options = {}) => request("DELETE", path, options);
  const serverTime = async () => {
    const { serverDate } = await request(
      "GET",
      "/issues?state=open&per_page=1",
      { includeServerDate: true },
    );
    const timestamp = Date.parse(serverDate ?? "");
    if (Number.isNaN(timestamp)) {
      throw new Error(
        "GitHub API response did not include a valid Date header",
      );
    }
    return new Date(timestamp).toISOString();
  };

  const getAll = async (path, label = "GitHub collection") => {
    const normalizedPath = validatePath(path);
    const separator = normalizedPath.includes("?") ? "&" : "?";
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const pagePath = `${normalizedPath}${separator}per_page=${pageSize}&page=${page}`;
      const pageItems = await get(pagePath);
      if (!Array.isArray(pageItems)) {
        throw new Error(`${label} page ${page} must be an array`);
      }
      if (pageItems.length > pageSize) {
        throw new Error(
          `${label} page ${page} exceeded the requested page size`,
        );
      }
      items.push(...pageItems);
      if (pageItems.length < pageSize) return items;
    }
    throw new Error(
      `${label} pagination reached the ${maxPages}-page safety cap without a short page`,
    );
  };

  const mutateAndVerify = async ({ mutation, read, verify }) => {
    if (!mutation || typeof mutation !== "object") {
      throw new Error("GitHub mutation description is required");
    }
    if (typeof read !== "function" || typeof verify !== "function") {
      throw new Error("GitHub mutation requires read and verify functions");
    }
    const method = String(mutation.method ?? "").toUpperCase();
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      throw new Error("GitHub mutation method is unsupported");
    }
    const idempotencyKey = safeIdempotencyKey(mutation.idempotencyKey);
    const retryable = NATURALLY_IDEMPOTENT_METHODS.has(method);
    const apply = () =>
      request(method, mutation.path, {
        body: mutation.body,
        idempotencyKey,
      });

    let mutationResult = null;
    let uncertain = false;
    try {
      mutationResult = await apply();
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !error.uncertain) throw error;
      uncertain = true;
    }

    const verifyConvergence = async () => {
      let value;
      for (let attempt = 0; attempt < convergenceReads; attempt += 1) {
        value = await read();
        if (await verify(value)) return { verified: true, value };
      }
      return { verified: false, value };
    };

    const firstVerification = await verifyConvergence();
    if (firstVerification.verified) {
      return {
        verified: true,
        value: firstVerification.value,
        mutationResult,
        reconciled: uncertain,
        retried: false,
      };
    }
    if (!retryable) {
      throw new Error(
        `GitHub ${method} ${validatePath(mutation.path)} cannot safely replay after bounded verification`,
      );
    }

    mutationResult = await apply();
    const finalVerification = await verifyConvergence();
    if (!finalVerification.verified) {
      throw new Error(
        `GitHub ${method} ${validatePath(mutation.path)} failed postcondition verification`,
      );
    }
    return {
      verified: true,
      value: finalVerification.value,
      mutationResult,
      reconciled: uncertain,
      retried: true,
    };
  };

  return Object.freeze({
    get,
    getAll,
    post,
    patch,
    put,
    delete: remove,
    serverTime,
    mutateAndVerify,
  });
};
