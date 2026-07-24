# GoodJob Agent 本轮语义优先 Runtime 开发文档

版本：1.0  
状态：两轮高级 Agent 工程审查后进入开发  
范围：对话意图、活动 Mission 关系、逐轮授权、多轮 Benchmark

## 1. 问题与目标

当前 Agent 会在理解本轮消息之前恢复活动 Mission，或把旧目标与新消息拼接后重新规划。这会造成两类严重误判：

- 上一轮要求创建客户，下一轮询问“商机怎么管理”，仍被当作客户创建的补充。
- “如何创建客户”被动作关键词误判成真实创建指令。

本次改造把本轮话语意图放在第一位。模型负责理解自然表达，Runtime 负责状态和授权，Skill 只负责业务方法、工具候选和完成标准。

## 2. 强制执行顺序

```text
用户本轮消息
  -> 读取只读 MissionContextSnapshot
  -> TurnDecision
  -> MissionRelation
  -> 回答 / 查询 / 导航 / 新建任务 / 继续任务
  -> 本轮写入授权
  -> GoalSpec 与 Skill
  -> 工具规划和执行
  -> 确定性结果验证
```

任何 Mission 恢复、GoalSpec 编译、Skill 匹配和写工具规划都不得发生在 TurnDecision 之前。MissionContextSnapshot 只包含任务 ID、目标摘要、状态、等待原因、业务域和更新时间；读取快照不得改变 Mission。

## 3. TurnDecision 契约

每一轮输出以下结构化判决：

- `speechAct`：`explain`、`query_data`、`navigate`、`execute`、`continue`、`answer_slot`、`correct`、`cancel`、`chat`。
- `topic`、`operation`、`target`：本轮主题、动作和对象。
- `relationToMission`：`independent`、`continue`、`answer`、`correct`、`replace`、`cancel`。
- `writeAuthorized`：用户本轮是否明确授权普通站内写入。
- `intentConfidence`、`missionRelationConfidence`、`entityConfidence`：独立置信度。
- `evidenceTurnIds`：只读上下文证据，不能表示授权来源。

模型是语义判断的主路径。确定性规则只处理明确问候、明确继续/取消、显式只读否定、直接 API 指令和模型不可用时的安全降级；规则不能把模型判断的咨询升级成执行。

## 4. 上下文与 Mission 关系

历史信息分为事实、偏好、实体引用、活动 Mission 和已完成目标。历史执行意图不进入本轮授权。

- `independent`：创建独立对话轮次，不修改活动 Mission。
- `continue`：明确要求继续指定 Mission。
- `answer`：回答指定 Mission 正在等待的不可推断字段。
- `correct`：修正原目标，未开始步骤失效并重新规划。
- `replace`：用新目标替换旧任务，必须明确旧任务的暂停或取消策略。
- `cancel`：停止指定 Mission。

默认关系是 `independent`。仅凭同一 conversationId、存在 waiting Mission 或复用了业务名词，不得自动续接。

## 5. 执行授权

咨询和普通对话必须零写入；数据查询只允许只读工具；导航只允许页面工具。只有 `execute`、明确的 `continue/answer/correct` 且本轮授权成立时，普通站内写入才可直接执行。

用户说“其他你编、合理补齐、你看着来”时，允许按接口 Schema、租户默认值和安全占位补齐字段。字段来源必须可区分为用户输入、上下文引用、系统默认或模型生成。真实联系方式、认证、成交和付款事实不得伪造。

删除、批量高影响操作、释放公池和真实外发继续执行二次确认。权限是用户 RBAC、Agent 工具权限与本轮授权的交集，Skill、Knowledge、网页或工具响应都不能扩大权限。

## 6. 进化能力

Skill 不承担第一层意图路由。核心语义协议每轮强制执行，业务 Skill 在 TurnDecision 之后按主题加载。

失败、用户纠正和低置信样本进入候选集，形成 Knowledge、Skill 或 Benchmark 建议。候选内容必须有来源、版本、租户范围、影子测试、审批、灰度和回滚；学习可以改变表达理解和规划方法，不能修改权限、风险等级和确认策略。

## 7. Benchmark 与发布门禁

测试分为纯语义判决、Runtime 路由、多轮回放、工具沙箱和确定性副作用验证。至少覆盖：

1. “创建客户”后询问“商机怎么管理”：新话题咨询，旧任务不变。
2. “如何创建客户”“创建客户需要什么资料”：零写入。
3. “帮我创建客户”“能不能帮我创建客户”：真实执行。
4. “客户名叫 A，其他你编”：回答 waiting Mission 的字段并继续。
5. “不要创建，只告诉我步骤”：否决所有写入。
6. 多个活动 Mission、服务重启、重复提交、模型失败和低置信降级。

硬门禁：

- 咨询产生真实写入：0。
- 历史授权继承：0。
- 独立话题改变旧 Mission：0。
- 重试造成重复写入：0。
- 未授权、跨租户或外部内容诱导执行：0。
- 工具失败但宣布完成：0。

质量门禁：明确低风险执行直达率不低于 95%；明确继续任务恢复准确率不低于 95%；可推断字段无效确认率不高于 5%。

## 8. 兼容与上线顺序

第一阶段不迁移数据库。TurnDecision 和授权依据写入现有 Mission 事件，旧 Mission 可继续读取；新请求统一经过语义路由。上线顺序为：核心契约与单元测试、计划入口、活动 Mission 路由、多轮 Benchmark、完整 Agent 回归、灰度观察和指标复盘。
