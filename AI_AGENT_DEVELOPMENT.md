# GoodJob CRM AI Agent 开发文档

## 1. 首期交付范围

首期实现 Agent 控制台和最小闭环：

1. 新增“AI Agent”导航入口。
2. 展示模型状态、当前用户权限范围和最近 Agent 活动。
3. 用户输入自然语言目标后，生成结构化行动计划。
4. 只读动作自动执行；写动作展示确认卡片。
5. 确认后调用服务端白名单工具，并将结果写回 CRM。
6. 事件流展示每一步状态，支持失败重试和回到相关页面。

## 2. API 契约

### `POST /api/agent/plan`

请求：

```json
{
  "goal": "整理本周高风险客户并为每个客户创建明天的跟进待办",
  "context": {
    "page": "customers",
    "customerIds": []
  }
}
```

响应：

```json
{
  "run": {
    "id": "agr_<uuid>",
    "status": "awaiting_confirmation",
    "summary": "整理高风险客户并创建跟进待办",
    "createdAt": "...",
    "expiresAt": "..."
  },
  "steps": [
    {
      "id": "step_<uuid>",
      "tool": "crm.list_pending_todos",
      "risk": "read",
      "status": "ready",
      "title": "读取当前账号可见的待办",
      "input": {}
    },
    {
      "id": "step_<uuid>",
      "tool": "crm.create_todo",
      "risk": "write",
      "status": "needs_confirmation",
      "title": "为 3 个客户创建跟进待办",
      "input": {}
    }
  ]
}
```

### `POST /api/agent/execute`

请求只接受服务端签发的 `runId`、`stepId`、`signature` 和可编辑字段。服务端重新校验步骤内容、当前用户权限和对象版本，不信任浏览器回传的工具名或权限字段。

```json
{
  "runId": "agr_<uuid>",
  "stepId": "step_<uuid>",
  "signature": "...",
  "approved": true
}
```

### `GET /api/agent/runs/:id`

返回当前 Agent 运行、步骤状态、事件和执行结果。敏感模型响应只保存摘要，不返回 API Key、完整提示词或不必要的原始客户隐私。

## 3. 前端控制台

页面分为三栏：

- 左栏：目标输入、快捷任务和模型状态。
- 中栏：当前计划、步骤风险、确认按钮和执行结果。
- 右栏：实时事件流、权限边界和最近动作。

视觉使用现有 CRM 的深色侧栏、浅色内容区、紧凑 8px 圆角和蓝/青状态色。高风险操作使用琥珀色提示，失败使用红色，成功使用绿色；不使用大面积渐变或装饰性卡片。

## 4. 数据与安全

首期计划签名使用服务端 `AGENT_JOB_ENCRYPTION_KEY` 派生 HMAC，过期时间 10 分钟。写动作必须有幂等键，服务端按当前账号的团队范围查询对象。

二期增加 MySQL 表：

```text
agent_runs
agent_run_steps
agent_run_events
```

表采用 append-only 事件和 `team_id + owner_id` 复合索引；写动作记录 `actor_id`、`tool`、`input_hash`、`result_hash`、`approval_at` 和 `created_at`。

## 5. 测试计划

- 后端单元：工具参数校验、风险分级、签名过期、幂等、权限隔离。
- API：无模型、模型返回非法 JSON、模型超时、拒绝跨团队客户、取消确认。
- 前端：输入目标、显示计划、确认写动作、失败状态、跳转客户/搜客页面。
- 浏览器：1280px 和 1440px 视口；登录后打开 Agent、创建只读计划、确认创建待办。
- 回归：客户、线索、搜客、开发信和 WhatsApp 页面不受影响。

## 6. 本轮实现与验收记录

本轮已完成首期可用闭环：

- 后端注册并实现客户查询、线索查询、商机管道快照、待办读取、跟进记录、客户概览、客户资料更新和开发信草稿工具。
- `crm.create_todo`、`crm.record_customer_followup`、`crm.update_customer_profile` 均在服务端执行前校验签名、用户身份、团队范围和对象归属；未确认的写动作不会执行。
- 前端新增独立 AI Agent 工作台：目标输入、快捷目标、模型状态、计划步骤、风险徽标、确认执行和事件流。
- 读取与草稿步骤在计划生成后自动执行；写入和外部动作保持“待确认”。失败步骤提供重试入口。
- 计划有效期为 10 分钟，步骤签名由服务端生成，前端不持有模型密钥和任意接口权限。

验收结果：

- `npm run build --workspace backend` 通过。
- `npm run build --workspace frontend` 通过。
- `npm run test --workspace backend` 通过。
- `npm run test --workspace frontend` 通过（68 项自检）。
- 接口实测：只读步骤自动完成；未确认写入被拒绝；确认后待办成功落库。
- 浏览器实测：登录后打开 Agent、生成计划、确认创建待办、事件流完整记录；1280px 和 1440px 视口 `scrollWidth === clientWidth`，无横向溢出。

## 7. 第二阶段持久化与审计

第二阶段已经完成：

- 新增 `agent_runs`、`agent_run_steps`、`agent_run_events` 三张 MySQL 表。
- 运行、步骤、结构化结果和事件流可在后端重启后恢复。
- 步骤表记录工具名、风险级别、输入哈希、结果哈希、确认时间和步骤签名。
- 计划过期后仍保留历史记录，但服务端拒绝继续执行，必须重新生成计划。
- 新增 `GET /api/agent/runs?limit=20`，只返回当前账号自己的 Agent 历史。
- Agent 工作台新增“最近运行”，可点击恢复行动计划、结果和事件流。
- 已完成跨进程恢复实测：后端关闭并重新启动后，同一运行 ID 仍能读取完整数据。
- 新增 `ai-agent-test.ts`，覆盖写入确认、重复执行幂等、计划过期和账号隔离。

下一阶段重点是外部触达二次确认：邮件、WhatsApp 和付费数据源需要独立确认内容、目标、成本和账号绑定状态，并形成可筛选的审计报表。
