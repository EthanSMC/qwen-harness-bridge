# Control Plane local runtime

This runbook covers the `v0.1.0` loopback-only Docker Compose runtime. It uses TLS on port `8443`; it does not expose the operations endpoints to a public network.

## Prerequisites

- Docker Engine with Compose v2.
- `jq` for machine-readable Compose status checks.
- A local TLS certificate and private key valid for `127.0.0.1`.
- Three distinct random application secrets of at least 32 characters.
- A stable owner identifier.

This repository's current development host does not provide Docker, so authoritative container evidence is produced by the pull-request runtime workflow on a GitHub-hosted runner.

## Local configuration

Create a mode-0600 environment file outside the repository. Do not commit it and do not paste its values into logs, issues, pull requests, or acceptance evidence. Provide:

```text
POSTGRES_PASSWORD=<random local password>
QHB_OWNER_ID=<local owner id>
QHB_MCP_BEARER_TOKEN=<random secret>
QHB_REQUEST_ENCRYPTION_KEY=<different random secret>
QHB_CONNECTOR_SESSION_SIGNING_KEY=<different random secret>
QHB_TLS_CERT_FILE=<absolute path to local certificate>
QHB_TLS_KEY_FILE=<absolute path to local private key>
CONTROL_PLANE_PORT=8443
```

`QHB_TLS_CERT_FILE` and `QHB_TLS_KEY_FILE` are host-side Compose source paths. Compose mounts them as secrets and explicitly sets the container-side `QHB_TLS_CERT_PATH=/run/secrets/qhb_tls_cert` and `QHB_TLS_KEY_PATH=/run/secrets/qhb_tls_key`; users must not set the container-side variables directly.

Load the external file into the current shell without printing its values. Keep this variable for the commands below; the path is quoted at the `source` boundary:

```bash
set +x
runtime_env_file="/absolute/path/to/control-plane.env"
set -a
source "$runtime_env_file"
set +a

case "${POSTGRES_PASSWORD:-}" in
  ""|*[!A-Za-z0-9._~-]*)
    echo "POSTGRES_PASSWORD must be URL-safe for DATABASE_URL interpolation" >&2
    exit 1
    ;;
esac
```

Never run or publish resolved `docker compose config` output because it contains environment values. `docker compose --env-file "$runtime_env_file" config --quiet` is the only configuration-validation command used here.

## Build and start

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm check
pnpm build
docker compose --env-file "$runtime_env_file" config --quiet
docker compose --env-file "$runtime_env_file" build --pull=false control-plane migrate
docker compose --env-file "$runtime_env_file" up -d
docker compose --env-file "$runtime_env_file" ps
```

The `migrate` service must exit successfully before `control-plane` starts. Verify the one-shot exit code and then wait with a bound for the serving service:

```bash
set -euo pipefail
test "$(docker compose --env-file "$runtime_env_file" ps --all --format json migrate | jq -r '.[0].ExitCode')" = "0"
for attempt in $(seq 1 60); do
  test "$(docker compose --env-file "$runtime_env_file" ps --format json postgres | jq -r '.[0].Health')" = "healthy" && break
  test "$attempt" = "60" && exit 1
  sleep 1
done
for attempt in $(seq 1 60); do
  test "$(docker compose --env-file "$runtime_env_file" ps --format json control-plane | jq -r '.[0].Health')" = "healthy" && break
  test "$attempt" = "60" && exit 1
  sleep 1
done
```

PostgreSQL and the Control Plane must both report healthy before endpoint verification.

## Verify health and metrics

Use the configured certificate as the trust anchor. Do not use `-k` for release evidence.

```bash
set -euo pipefail
runtime_url="https://127.0.0.1:${CONTROL_PLANE_PORT:-8443}"
metrics_headers=$(mktemp)
metrics_body=$(mktemp)
trap 'rm -f "$metrics_headers" "$metrics_body"' EXIT
test "$(curl --connect-timeout 2 --max-time 5 --fail --silent --show-error --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/live")" = '{"status":"ok"}'
test "$(curl --connect-timeout 2 --max-time 5 --fail --silent --show-error --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/ready")" = '{"status":"ready"}'
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error --dump-header "$metrics_headers" --output "$metrics_body" --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/metrics"
grep --ignore-case --fixed-strings 'content-type: text/plain; version=0.0.4; charset=utf-8' "$metrics_headers"
grep --fixed-strings 'qhb_mcp_submit_duration_seconds' "$metrics_body"
grep --fixed-strings 'qhb_connector_online' "$metrics_body"
grep --fixed-strings 'qhb_job_queue_age_seconds' "$metrics_body"
```

Expected bounded health bodies:

```json
{ "status": "ok" }
```

```json
{ "status": "ready" }
```

Metrics must include `qhb_mcp_submit_duration_seconds`, `qhb_connector_online`, and `qhb_job_queue_age_seconds`. Labels are limited to the documented status, message-type, and stable error-code allowlists. Metrics must not contain IDs, repository names, prompts, summaries, paths, URLs, secrets, or raw errors.

## Verify failure separation

Stopping PostgreSQL must make readiness return HTTP 503 while liveness remains HTTP 200:

```bash
set -euo pipefail
runtime_url="https://127.0.0.1:${CONTROL_PLANE_PORT:-8443}"
db_loss_cleanup() {
  docker compose --env-file "$runtime_env_file" start postgres >/dev/null 2>&1 ||
    docker compose --env-file "$runtime_env_file" down >/dev/null 2>&1 || true
}
trap db_loss_cleanup EXIT
docker compose --env-file "$runtime_env_file" stop postgres
for attempt in $(seq 1 30); do
  readiness_status=$(curl --connect-timeout 2 --max-time 5 --silent --show-error --output /dev/null --write-out '%{http_code}' --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/ready" || true)
  test "$readiness_status" = "503" && break
  test "$attempt" = "30" && exit 1
  sleep 1
done
readiness_headers=$(mktemp)
readiness_body=$(mktemp)
test "$(curl --connect-timeout 2 --max-time 5 --silent --show-error --dump-header "$readiness_headers" --output "$readiness_body" --write-out '%{http_code}' --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/ready" || true)" = "503"
test "$(curl --connect-timeout 2 --max-time 5 --silent --show-error --output /dev/null --write-out '%{http_code}' --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/live")" = "200"
test "$(curl --connect-timeout 2 --max-time 5 --fail --silent --show-error --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/live")" = '{"status":"ok"}'
test "$(cat "$readiness_body")" = '{"status":"not_ready"}'
grep --ignore-case --fixed-strings 'content-type: application/json; charset=utf-8' "$readiness_headers"
if grep -E -i 'owner[_-]?id|job[_-]?id|repository|prompt|path|https?://|url|secret|error:|stack trace|ECONNREFUSED|SQLSTATE' "$readiness_body"; then exit 1; fi
docker compose --env-file "$runtime_env_file" start postgres
for attempt in $(seq 1 60); do
  readiness_status=$(curl --connect-timeout 2 --max-time 5 --silent --show-error --output /dev/null --write-out '%{http_code}' --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/ready" || true)
  test "$readiness_status" = "200" && break
  test "$attempt" = "60" && exit 1
  sleep 1
done
test "$(curl --connect-timeout 2 --max-time 5 --fail --silent --show-error --cacert "$QHB_TLS_CERT_FILE" "$runtime_url/health/ready")" = '{"status":"ready"}'
rm -f -- "$readiness_headers" "$readiness_body"
trap - EXIT
```

Every loop exits nonzero on timeout. Do not continue unless readiness has recovered.

## Foundation acceptance slice

Run the complete fake-Connector evidence set explicitly:

```bash
set -euo pipefail
pnpm vitest run \
  tests/integration/foundation-e2e.test.ts \
  tests/integration/approval-flow.test.ts \
  tests/integration/cancellation-flow.test.ts \
  tests/integration/result-flow.test.ts
```

This is backend/fake-Connector evidence. It is not proof of real Harness, Qwen glasses, device latency, or RTC behavior.

## Shutdown and cleanup

```bash
set -euo pipefail
docker compose --env-file "$runtime_env_file" down
```

Add `--volumes` only when intentionally deleting the local PostgreSQL data volume. The pull-request workflow always tears down its disposable runtime in an `always()` cleanup step.

## Troubleshooting

- `/health/live` 200 and `/health/ready` 503: inspect PostgreSQL health and migration completion without exposing credentials or SQL error text.
- TLS failure: verify certificate subject/SAN, file paths, file permissions, and the `--cacert` value.
- `migrate` failed: stop; do not start the serving process against a mismatched schema.
- `/metrics` unavailable while liveness is healthy: treat the runtime gate as failed, but do not make liveness depend on metric collection.
