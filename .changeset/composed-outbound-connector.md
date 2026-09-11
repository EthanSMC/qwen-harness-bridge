---
"@qhb/harness-plugin": minor
---

Compose the durable outbound Connector as a Cordis plugin: `name`, `inject` and
`apply(ctx)` validate configuration before any effect, register the command
coordinator and approval answerer, start transport under one abort controller,
and tear down in the fixed order (stop intake, abort approvals, cancel/await
owned Agents, stop transport, close SQLite). Add the trusted execution adapter
that maps the explicit declared tool set to canonical actions, the live-state
revision registry with deterministic capture, and the approval reservation
provider used by the broker.
