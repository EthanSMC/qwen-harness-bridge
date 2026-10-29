---
name: qwen-harness-bridge
description: 当用户要通过眼镜给 DeepSeek Harness 布置、查看、取消、审批或读取软件开发任务时使用。
version: 0.3.0
language: zh-CN
---

# 眼镜任务台 Skill

本 Skill 让眼镜端用户用一句中文把工作交给 DeepSeek Harness，并在当前回合内拿到
回执、短号与连接器状态。它只使用私有 MCP 服务暴露的七个工具与三个界面工具，不
直接访问仓库、数据库或任何本地路径。

## 单意图路由

每个回合只执行一个变更意图。路由名称：`create`、`list`、`inspect`、`cancel`、
`list_approvals`、`decide_approval`、`result`，以及受特性开关控制的 `rtc`。

| 路由 | 触发示例 | 工具 |
|---|---|---|
| create | 让 DeepSeek 在 Novelty Web 跑测试 | `submit_task` |
| list | 我有哪些任务 | `list_tasks` + `UiTool.list` |
| inspect | 看一下 QH-9F3C | `get_task` + `UiTool.all_text` |
| cancel | 取消 QH-9F3C | `cancel_task` |
| list_approvals | 有哪些待审批 | `list_pending_approvals` + `UiTool.list` |
| decide_approval | 批准第一个 | `decide_approval` |
| result | 读出 QH-9F3C 的结果 | `get_task_result` + `UiTool.pic_and_text` |
| rtc | 实时语音通话 | 关闭时不提供，见下方诚实约束 |

一句话里可以带参数（仓库、模式、短号），但只允许一个变更意图。若用户在同一回合
要求两个变更，先执行第一个明确请求，再问是否在新回合执行第二个；绝不合并成一次
调用或静默丢弃。读取（list/inspect/result）不算变更。

## 仓库解析

允许的仓库别名表存放在 Skill 配置 `config/repositories.json`，不在示例散文中。
解析顺序：

1. 与配置中的 `id` 或 `display_name` 完全一致时直接使用，不询问。
2. 只有一个模糊候选时，先向用户确认再提交。
3. 零个或多个候选时，列出候选并等待确认；此时不得调用 `submit_task`。
4. 含 `/`、`~`、`..` 或盘符前缀的字符串永远不是仓库标识，必须拒绝并请用户
   提供配置中的名称或编号。

## 幂等提交

提交序列固定为：

```text
utterance
  -> resolve exact configured repository ID
  -> generate one UUID client_request_id
  -> call submit_task once
  -> render receipt
  -> speak short ID and connector state
```

- 第一次调用前生成一个 UUID，并在本回合内保持不变；`submit_task` 的
  `client_request_id` 与该 `request_id` 必须一致。
- 只有在传输超时或 `TEMPORARY_UNAVAILABLE` 时才允许重试，且最多一次；重试的
  `repository_id`、`request`、`mode` 必须与首次逐字节相同（含同一个 UUID）。
- `IDEMPOTENCY_CONFLICT`、协议校验错误与策略拒绝一律不重试，直接向用户说明。
- 连接器离线（`CONNECTOR_OFFLINE`）时保留同一个 UUID 排队，恢复后再提交。

## 工具

七个 MCP 工具：`submit_task`（创建任务）、`list_tasks`（列出任务）、`get_task`
（读取单个任务）、`cancel_task`（取消任务）、`list_pending_approvals`（待审批列
表）、`decide_approval`（批准或拒绝）、`get_task_result`（读取结果与产物）。

三个界面工具：`UiTool.list`（最多五行列表）、`UiTool.all_text`（正文详情）、
`UiTool.pic_and_text`（图文结果）。

工具输入输出、错误码与重试矩阵见 `references/tool-contract.md`；意图与路由细则见
`references/intents.md`；列表、详情、结果与产物布局见 `references/ui-contract.md`；
语音模板见 `references/speech-contract.md`；错误文案与恢复步骤见
`references/errors.md`。

## 显示与语音

- 界面正文最多 600 字符，单条语音最多 120 字符，列表最多 5 行。
- 语音使用中文普通话，先报短号，再报连接器状态；不朗读原始日志、堆栈或长 ID。
- 任务状态只按工具返回的真实状态播报，不推测进度。

## 诚实与隐私

- 不虚构任务短号、状态或产物；工具失败时如实说明失败码与下一步。
- 不朗读或展示凭据、原始提示、完整日志、私有会话链接或本地绝对路径。
- 不承诺由服务端自行发起通知或常驻监听；只有用户问起时才查询。
- 实时语音（`rtc`）在 `rtc_mode` 关闭时不提供，也不暗示可用。