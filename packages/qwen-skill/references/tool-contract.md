# 工具契约

本文件是七个 MCP 工具与三个界面工具的调用契约。字段名与
`packages/protocol` 的输入 schema 一致；服务端返回未知字段时忽略而不是猜测。

## MCP 工具

| 工具 | 用途 | 关键输入 | 关键返回 |
|---|---|---|---|
| `submit_task` | 创建任务 | `client_request_id`（UUID）、`repository_id`、`request`（≤4000 字节）、`mode`（`normal`/`read_only`） | 任务短号、状态、任务 UUID |
| `list_tasks` | 列出任务 | `limit`（≤5 展示） | 任务数组 |
| `get_task` | 读取单个任务 | 任务 UUID 或短号 | 任务详情与状态 |
| `cancel_task` | 取消任务 | 任务 UUID 与当前版本 | 取消后的状态 |
| `list_pending_approvals` | 待审批列表 | `limit` | 审批数组 |
| `decide_approval` | 批准或拒绝 | 审批 UUID、`approve`/`reject`、理由 | 审批结果 |
| `get_task_result` | 读取结果 | 任务 UUID | 结论、产物与摘要 |

## 界面工具

| 工具 | 用途 | 约束 |
|---|---|---|
| `UiTool.list` | 列表展示 | 最多 5 行，每行一条摘要 |
| `UiTool.all_text` | 正文展示 | 最多 600 字符 |
| `UiTool.pic_and_text` | 图文结果 | 图片加不超过 600 字符说明 |

## 仓库解析配置

允许的仓库别名表存放在 `config/repositories.json`，每项包含 `id`、
`display_name` 与 `aliases`。运行时规则：

1. `id` 或 `display_name` 完全一致时直接使用。
2. 唯一模糊候选时先确认再提交。
3. 零个或多个候选时列出候选，不调用 `submit_task`。
4. 含 `/`、`~`、`..` 或盘符前缀的字符串不是仓库标识。

## 幂等与重试

| 情况 | 处理 |
|---|---|
| 传输超时 | 最多重试一次，同一 UUID、同一载荷 |
| `TEMPORARY_UNAVAILABLE` | 最多重试一次，同一 UUID、同一载荷 |
| `CONNECTOR_OFFLINE` | 保留同一 UUID 排队，恢复后提交，不重复创建 |
| `IDEMPOTENCY_CONFLICT` | 不重试，说明请求编号已存在 |
| 协议校验错误 | 不重试，说明字段问题 |
| 策略拒绝 | 不重试，说明需要用户处理的原因 |

重试载荷的 `repository_id`、`request`、`mode` 与 `client_request_id` 必须与首次
调用逐字节一致；任何一个字节变化都视为新任务，必须经过新的用户确认。

## 诚实约束

- 只播报工具真实返回的状态、短号与产物；不推测、不补写。
- 不展示凭据、原始提示、完整日志、私有会话链接或本地绝对路径。
- 不承诺由服务端自行发起通知或常驻监听；实时语音仅在 `rtc_mode` 开启时可用。