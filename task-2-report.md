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

# Task 2 Fix Round 2

## Reviewer P2 closure

- 已关闭 reviewer P2：`SafeEventPayloadSchema` 递归检查所有对象和数组的自有属性名，包含 non-enumerable `toJSON`；因此 `JSON.stringify` 无法通过自定义序列化器把未审查字段带入云端。
- 未在 discriminated union option 上引入 `ZodEffects`；现有合法 JSON payload 和 union 构造保持不变。

## 改动

- 在 `packages/protocol/src/connector.ts` 增加自有 `toJSON` 安全边界检查。
- 在 `packages/protocol/src/connector.test.ts` 增加普通对象和数组上的 non-enumerable `toJSON` 拒绝回归测试。

## 验证

- `./node_modules/.bin/vitest run packages/protocol/src/connector.test.ts`：12/12 passed。
- `./node_modules/.bin/vitest run`：31/31 passed。
- `./node_modules/.bin/tsc -p packages/protocol/tsconfig.json --noEmit`：passed。
- `./node_modules/.bin/tsc -p apps/control-plane/tsconfig.json --noEmit`：passed。
- changed-file `./node_modules/.bin/biome check packages/protocol/src/connector.ts packages/protocol/src/connector.test.ts`：passed。

# Task 2 Fix Round 3

## 改动

- 将 `PositiveIntegerSchema` 和 `NonNegativeIntegerSchema` 的上界收紧为 `Number.MAX_SAFE_INTEGER`，使 envelope/message/job/attempt/sequence 等字段与 `SequenceCursor` 使用同一 safe-integer 边界。
- 保留 RFC3339 任意长度 fractional seconds 合法性；approval expiry 改为解析完整日期、时区 offset 和 fraction 后进行精确 instant 比较，不再依赖 `Date.parse` 的毫秒精度。
- 增加 `MAX_SAFE_INTEGER` 通过、`MAX_SAFE_INTEGER + 1` 拒绝、任意长度小数精度、Z/offset、日期换日、等值/逆序 envelope expiry，以及 `approval.requested` nested expiry 回归测试。
- 保留现有安全 payload、sha256 fingerprint、SequenceCursor/state machine 和 governance merge 改动。

## 验证

- `./node_modules/.bin/vitest run`：32/32 passed。
- `./node_modules/.bin/tsc -p packages/protocol/tsconfig.json --noEmit`：passed。
- `./node_modules/.bin/tsc -p apps/control-plane/tsconfig.json --noEmit`：passed。
- `node --test scripts/github/verify-pr-review-state.test.mjs scripts/github/verify-pr-review-evidence.test.mjs`：37/37 passed。
- `node scripts/github/verify-planning.mjs`：passed，verified 17 files / 34 implementation tasks。
- `for file in scripts/github/*.mjs; do node --check "$file"; done`：passed。
- `git diff --check`：passed。

注：`pnpm typecheck` 在本机被 pnpm 10.15.1 registry signature 校验拦截，未进入编译；已使用同一仓库本地 `tsc` 对两个 strict tsconfig 完成验证。

# Task 2 Fix Round 4

基于：`c5d19caa3438c44711caf1c9c59dd2361d0564be`。

## 改动

- `packages/protocol/src/mcp.ts` 抽出 safe non-negative integer schema，令 `RevisionSchema` 的 `expected_revision` 与 `expected_job_revision` 接受 `Number.MAX_SAFE_INTEGER`、拒绝 `MAX_SAFE_INTEGER + 1`。
- 审计 `packages/protocol/src` 全部 `z.number().int()`：connector 的 Positive/NonNegative schema 与 mcp 的 Revision/BoundedListLimit 均有 safe-integer 上界；列表 `limit` 另有合理业务上限 `5`，因此不适用 MAX_SAFE boundary 通过，但 unsafe 值仍被拒绝。
- 增加 CancelTask/DecideApproval 修订字段的 safe boundary 与 unsafe 拒绝测试，并覆盖列表 limit 的 unsafe 拒绝；保留现有安全 payload、sha256 fingerprint、精确 expiry、SequenceCursor/state machine 和 governance merge 改动。

## 验证

- `./node_modules/.bin/vitest run`：33/33 passed。
- `./node_modules/.bin/tsc -p packages/protocol/tsconfig.json --noEmit`：passed。
- `./node_modules/.bin/tsc -p apps/control-plane/tsconfig.json --noEmit`：passed。
- `node --test scripts/github/verify-pr-review-state.test.mjs scripts/github/verify-pr-review-evidence.test.mjs`：37/37 passed。
- `node scripts/github/verify-planning.mjs`：passed，verified 17 files / 34 implementation tasks。
- `for file in scripts/github/*.mjs; do node --check "$file"; done`：passed。
- `git diff --check`：passed。
