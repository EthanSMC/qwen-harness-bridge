# Local Harness model route

The local plugin configuration accepts an optional `harnessModel` object. This
JSON fragment uses placeholders; replace both with your host Harness route:

```json
{
  "harnessModel": {
    "provider": "<provider-identifier>",
    "model": "<model-identifier>"
  }
}
```

`provider` identifies the host Harness provider adapter; `model` identifies the
model on that route. These are the actual `AgentOptions` field names. There is
no implicit default, discovery, fallback, environment expansion, provider
allowlist, or network validation. Identifiers are opaque strings, not URLs or
shell commands; case, slashes, colons, and ordinary printable Unicode are retained.

Both fields are required when `harnessModel` is present. Boundary whitespace is
trimmed; each resulting string must contain 1–256 UTF-16 code units. Embedded
C0/C1 controls, DEL, and Unicode line/paragraph separators are rejected. Null,
arrays, non-string identifiers, partial objects, and unknown fields are rejected
with `INVALID_PLUGIN_CONFIG`, without echoing input or getter diagnostics. The
parsed configuration is detached and deeply frozen; caller objects are not frozen.

Omitting the object preserves legacy standalone configuration, with no added
route field. The forthcoming composed execution entry must require this route
before creating an Agent or starting outbound transport and pass exactly
`provider` and `model` as local `AgentOptions`. That consumer is still pending;
acceptance by this parser does not grant execution permission.

Do not store credentials here: `apiKey`, `token`, `credentialId`, `baseUrl`, and
`reasoningEffort` are not accepted route fields. Provider adapters and secrets
remain owned by the host Harness. Selecting a route does not establish provider
registration, availability, native execution readiness, or release readiness.
