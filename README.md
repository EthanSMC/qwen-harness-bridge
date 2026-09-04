# Qwen Harness Bridge

Qwen Harness Bridge（眼镜任务台）让单一所有者通过千问 AI 眼镜向 Mac 上的 DeepSeek Harness 布置软件开发任务，并在眼镜上查看进度、处理审批、取消任务和读取结果。

当前仓库处于“设计与实施规划完成”阶段，尚未开始产品代码开发。稳定路径是 Skill + MCP 的异步任务模式；RTC 实时语音是独立 feature flag 下的实验能力，不影响稳定版发布。

## Product boundary

- Private Qwen Skill; V1 does not require a standalone glasses app.
- Seven bounded MCP tools return quickly while work continues asynchronously.
- A cloud Control Plane persists product state.
- A DeepSeek Harness plugin maintains an outbound-only Mac Connector.
- Local repository policy is authoritative; approvals cannot override denied actions.
- No public Harness HTTP endpoint, arbitrary shell endpoint, or offline-push promise.

## Authoritative documents

- [Approved product and system Spec](docs/superpowers/specs/2026-09-01-qwen-harness-bridge-design.md)
- [Implementation roadmap](docs/superpowers/plans/2026-09-01-qwen-harness-bridge-roadmap.md)
- [Foundation and Control Plane plan](docs/superpowers/plans/2026-09-01-foundation-control-plane.md)
- [Harness Plugin and Connector plan](docs/superpowers/plans/2026-09-01-harness-plugin-connector.md)
- [Qwen Skill and Device UX plan](docs/superpowers/plans/2026-09-01-qwen-skill-device-ux.md)
- [Reliability, Security, and Operations plan](docs/superpowers/plans/2026-09-01-reliability-operations.md)
- [Experimental RTC plan](docs/superpowers/plans/2026-09-01-experimental-rtc.md)
- [AI-assisted Issue collaboration design](docs/superpowers/specs/2026-09-04-ai-issue-collaboration-design.md)
- [AI-assisted Issue collaboration implementation plan](docs/superpowers/plans/2026-09-04-ai-issue-collaboration.md)

## Release roadmap

| Milestone | Version | Outcome |
|---|---:|---|
| M0 | `v0.1.0` | Protocol, database, state machine, MCP, fake Connector |
| M1 | `v0.2.0` | Real Harness plugin and durable Mac Connector |
| M2 | `v0.3.0` | Private Skill, native UI, approvals, device acceptance |
| M3 | `v0.4.0` | Replay, security, backup, observability, rollback |
| M4 | `v0.5.0` | Experimental RTC behind a disabled-by-default flag |
| M5 | `v1.0.0` | Stable private beta; RTC remains optional |

## Development workflow

Implementation is issue-driven. Each numbered task in the five plans maps to one GitHub issue and one milestone. Work starts at Plan 1 Task 1, follows test-first steps in the issue, and merges through a short-lived pull request with a focused Conventional Commit.

Every eligible contributor may use an AI agent. The human Issue assignee remains accountable, and repository automation serializes claims, records bounded receipts, enforces independent review and current-head CI, and verifies closure. AI agents must read [AGENTS.md](AGENTS.md); contributors should follow [AI-assisted Issue collaboration](docs/github/ai-collaboration.md).

Repository governance is defined in [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [.github/](.github/). `node scripts/github/verify-planning.mjs` validates the planning baseline; `node scripts/github/sync-management.mjs` synchronizes labels, milestones, implementation issues, and main-branch protection for the public GitHub repository.

The current remote-management snapshot, including that branch protection is enabled on `main`, is recorded in [docs/github/repository-status.md](docs/github/repository-status.md).

## Current status

- Product/system Spec: approved.
- Five implementation plans: complete.
- Runtime implementation: not started.
- Stable public availability: none; target is a single-owner private beta.
