# AI Agent 操作契约

版本：1.2  
适用范围：GoodJob CRM 站内 AI Agent

配套运行时和评测规范见 `docs/GOODJOB-AGENT-RUNTIME-BENCHMARK.md`。

## 目标

Agent 不依赖模型记住接口，也不允许猜测字段。所有通用业务操作统一执行以下闭环：

```text
理解用户目标
-> 编译并持久化 GoalSpec
-> 检索实时操作契约
-> 生成符合 Schema 的参数
-> 校验当前用户权限与风险
-> 获得对应授权
-> 调用真实 API
-> 核验完成证据
-> 刷新对应页面
-> 继续规划或结束对话
```

搜客、线索、客户、商机、计划、待办、日报、提成、知识、考试、提醒、单据、导入导出、业务员训练和 Agent 知识等业务域使用同一规则。

`GoalSpec` 使用 `goodjob-goal/v1` 协议，至少保存原始目标、主要动作、业务域、复合目标、约束、页面对象、授权范围和完成标准。模型生成的目标理解必须通过服务端安全复核；模型不能把只读目标改成写入、取消外发确认或降低破坏性操作风险。继续对话、改令和恢复任务时重新编译，旧任务缺少 GoalSpec 时按原始目标兼容重建。

自然语言路由必须先判断业务域和查看、否定、分析等语义，再决定创建、修改或发送动作。系统使用 140 条真实业务表达作为意图回归基线；新增同义表达时优先补充语义路由和 Benchmark，不把一次失败直接堆进总提示词。

## 契约结构

每个 Agent 可见操作都生成 `AgentOperationContract`：

| 字段 | 含义 |
| --- | --- |
| `method` / `path` | 真实 HTTP 方法和 OpenAPI 路由模板 |
| `operation` / `entity` | 业务动作和对象 |
| `requestSchema` | Agent 可提交的严格 JSON Schema |
| `risk` | `read`、`write` 或 `external` |
| `authorizationPolicy` | 只读、用户直接创建授权、明确确认或冻结载荷确认 |
| `completionEvidence` | 响应、服务端对象 ID 或删除确认 |
| `refreshView` | 成功后前台应刷新的页面 |
| `schemaSource` | 业务契约注册表或已验证 OpenAPI Schema |
| `executable` | 当前操作是否允许 Agent 执行 |

实现位置：`backend/src/agent-api-contracts.ts`。

## 授权规则

- `read_only`：只读接口自动执行。
- `direct_user_intent`：用户明确要求执行普通站内新增、修改、记录、转换或状态动作时，原始指令就是该次操作授权，不再重复确认。
- `explicit_confirmation`：删除、永久删除、批量修改、客户释放到公池和丢单关闭等高影响动作需二次确认。
- `frozen_payload_confirmation`：真实邮件、Communication 消息、站内消息、外部搜索和其他外部副作用必须冻结完整对象与载荷后确认。

用户说“你编”“编数据”“模拟数据”“随便填”“自行补齐”“自动完善”“你看着来”及同义表达，表示已经委托 Agent 生成站内字段。Agent 应读取 Schema 后补齐所有必填字段，并使用“AI模拟”名称、“未知”“待维护”、空联系方式、默认阶段、零金额、“待确认产品”等安全值。关联 ID 必须查询真实对象；禁止伪造看似真实的联系人、邮箱、电话、WhatsApp、地址、认证、付款或成交事实。

## 永久排除范围

以下控制面不进入 Agent API 目录：

- 登录、会话和账号管理；
- 个人资料及邮箱凭据；
- 模型 API Key；
- 数据源 API Key；
- 个人 Communication 扫码和通道绑定；
- 收件人、人员分配目录；
- Agent 自身计划、执行、会话和任务控制面。

服务端业务接口仍会按当前登录用户执行对象归属、团队、角色和状态校验。Agent 没有越过现有 RBAC 的特殊身份。

## 执行约束

1. 通用 API 动作必须先成功执行 `api.catalog`。
2. 目录匹配真实 `method` 和路由模板，且 `executable=true`。
3. 请求体先通过契约校验；未知字段、缺少必填字段、类型或枚举错误会在发请求前被拒绝。
4. Agent 只能补充 `If-Match` 和 `Idempotency-Key` 两种受控请求头。
5. 实际接口仍执行服务端 Zod 校验和用户权限校验。
6. HTTP 成功后继续核验契约定义的完成证据。
7. 创建操作没有服务端对象 ID、删除没有确认结果时，不允许宣称完成。
8. 成功后按 `refreshView` 通知前台更新，不把所有动作错误地跳回工作台。
9. Agent 调用站内 API 使用服务端 `node:http` 传输，不得改回 WHATWG `fetch`。`4190`、`6000`、`6667`、`10080` 等端口会被 Fetch 标准在发包前以 `bad port` 拒绝，即使 Express、curl 和业务报文完全正常。
10. 内部传输失败必须保留请求方法、站内路径、底层错误码和错误原因；禁止再次把连接拒绝、端口策略、超时或响应中断统一包装成 `fetch failed`。
11. 模型评估是业务完成证据的补充，不是唯一裁判。服务端对象 ID、契约 `completionEvidence`、发送回执或专用 Tool 成功结果已经满足目标时，评估模型返回空内容、格式错误或暂时不可用只能触发确定性降级，不得把已成功业务改判为失败。
12. OpenAI-compatible 模型返回空 `message.content` 时，运行时应兼容 `output_text`、包含 JSON 的 `reasoning_content`，并以兼容消息模式重试一次；仍为空时记录 `finish_reason`，不得只显示“模型返回为空”。
13. 复合目标必须逐项验证，不能因为第一个对象创建成功就提前结束。例如“建客户并记录跟进”必须同时取得 `customer.id` 和 `activity.id`。
14. 瞬时只读错误最多自动重试一次；外部动作结果不明时立即停止并要求人工核验渠道，确认未发送后才允许重新规划且仍需再次审批；普通写入只有携带幂等键时才能自动重试。
15. 更新动作必须核对目标对象、目标字段和用户明确要求的目标值；搜客必须核对终态和目标候选数量，触达序列必须核对实际发送进度。
16. Knowledge 检索必须结合 GoalSpec 业务域、标题/正文权重、完整短语和文档稀有度重排，并返回可解释匹配原因。
17. 调教诊断接口只读取 GoalSpec、Skill、Knowledge 和工具目录，虽使用 `POST` 传递结构化上下文，风险仍固定为 `read_only`，不得产生业务写入。

实现位置：`backend/src/agent-internal-http.ts`。回归测试：`backend/src/agent-internal-http-test.ts`。

## 新增接口流程

新增或修改业务写接口时：

1. 在服务端路由中保留真实参数和权限校验。
2. 优先在 OpenAPI 中提供 `additionalProperties: false` 的准确 Schema。
3. 复杂业务语义在 `agent-api-contracts.ts` 注册显式契约和指导。
4. 明确风险、授权策略、完成证据和刷新页面。
5. 运行 `npm run test --workspace backend`。

`agent-api-contracts-test.ts` 会遍历实时 OpenAPI。任何 Agent 可见操作缺少可执行契约、写接口使用宽泛顶层 Schema、风险不一致或缺少完成证据都会导致测试失败。

## 当前覆盖

基于 2026-07-21 注册路由：

- Agent 可见操作：263；
- 写入或外部操作：184；
- 可执行严格契约：263；
- 未覆盖操作：0；
- 覆盖率：100%。

覆盖数量由运行时目录动态计算；文档数字只记录本次基线。
