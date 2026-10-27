/** Parsing and validation for the optional operator-supplied model route.
 *
 * The rehearsal script writes these values into the profile's patch document,
 * so every field is validated before it can reach YAML. The credential VALUE is
 * never handled here: only the name of the credential-store variable travels.
 */
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
/** No whitespace, quotes or backslashes: a newline here would rewrite the patch. */
const BASE_URL_PATTERN = /^https?:\/\/[^\s"'\\]{1,500}$/u;

export const parseModelRoute = ({
  provider = "",
  model = "",
  apiKeyEnv = "",
  baseUrl = "",
} = {}) => {
  const requested = [provider, model, apiKeyEnv, baseUrl].some(
    (value) => value.length > 0,
  );
  if (!requested) return { requested: false };
  if (provider.length === 0 || model.length === 0 || apiKeyEnv.length === 0) {
    throw new Error(
      "--model-provider, --model and --model-api-key-env must be given together",
    );
  }
  if (!PROVIDER_PATTERN.test(provider))
    throw new Error("--model-provider must be a plain provider id");
  if (!MODEL_PATTERN.test(model))
    throw new Error("--model must be a plain model id");
  if (!ENV_PATTERN.test(apiKeyEnv))
    throw new Error("--model-api-key-env must be an environment variable name");
  if (baseUrl.length > 0 && !BASE_URL_PATTERN.test(baseUrl)) {
    throw new Error(
      "--model-base-url must be a plain http(s) URL without whitespace or quotes",
    );
  }
  return { requested: true, provider, model, apiKeyEnv, baseUrl };
};

/** The provider and the default model both have to be declared for an owned
 * attempt to reach an endpoint at all. */
export const modelRoutePatchLines = (route) => {
  if (route.requested !== true) return [];
  const lines = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    `      ${route.provider}:`,
    `        apiKeyEnv: ${route.apiKeyEnv}`,
    "        displayName: Live rehearsal route",
    "        api: openai-completions",
  ];
  if (route.baseUrl.length > 0) lines.push(`        baseURL: ${route.baseUrl}`);
  lines.push(
    "        models:",
    `          - id: ${route.model}`,
    `            name: ${route.model}`,
    "- id: agent-default-model",
    "  config:",
    `    provider: ${route.provider}`,
    `    model: ${route.model}`,
  );
  return lines;
};

/** The connector's own route field, indented for its config block. */
export const harnessModelLines = (route) =>
  route.requested === true
    ? [
        "    harnessModel:",
        `      provider: ${route.provider}`,
        `      model: ${route.model}`,
      ]
    : [];
