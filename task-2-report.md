# Task 2 Fix Round 1

基线：`b3e80a1`，分支：`feat/2-connector-envelope-job-state`。

## 改动

- 保留并完善 `pnpm-lock.yaml` 的 `apps/control-plane` importer，链接 `@qhb/protocol` workspace package。
- 修复 `approval.requested` 的 Zod discriminated union 构造：所有 option 保持普通 `ZodObject`，union 构造完成后再用 `superRefine` 校验 nested `payload.expires_at > sent_at`。
- 收紧 `JobEventPayloadSchema`：只接受 bounded JSON-safe plain object，并限制深度、字段数、数组项、单字符串和总 JSON 字节数；拒绝 cycle、accessor、非 JSON 值、原始日志、凭据、环境变量、私有路径和敏感 token 模式。
- 增加有状态 `SequenceCursor`：严格递增，精确重复返回 `duplicate`，倒退抛出 `INVALID_SEQUENCE_ORDER`。
- 将 approval fingerprints 限制为 `sha256:<64 lowercase hex>`。
- 增加 UUID、RFC3339/timezone、approval expiry、unsafe payload 和边界负向测试。

## 验证

- `./node_modules/.bin/vitest run packages/protocol/src/connector.test.ts apps/control-plane/src/domain/job-state.test.ts`：15/15 passed。
- `./node_modules/.bin/vitest run`：30/30 passed。
- `./node_modules/.bin/tsc -p packages/protocol/tsconfig.json --noEmit`：passed。
- `./node_modules/.bin/tsc -p apps/control-plane/tsconfig.json --noEmit`：passed。
- changed-file `./node_modules/.bin/biome check`：passed。

仓库级 Biome 检查仍受基线 `scripts/github/*.mjs` 格式问题和 Biome schema 2.5.11/CLI 2.2.2 不匹配影响；本轮未修改无关文件。

提交：本报告随 Task 2 Fix Round 1 commit 一并提交。
