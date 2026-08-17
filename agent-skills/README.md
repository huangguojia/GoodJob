# GoodJob CRM Agent Skills

每个 Skill 使用独立目录保存：

- `skill.json`：机器可读的匹配、版本和 Tool 引用。
- `SKILL.md`：业务流程、完成标准和失败恢复说明。

开发初期保持少量宽 Skill。只有当真实任务和 benchmark 证明某一流程需要独立演进时，才拆分更细的 Skill。

当前内置 Skill：

- `system-overview`：系统能力、业务对象、权限边界和通用完成标准，始终注入。
- `customer-lifecycle`：线索、客户、跟进、待办和商机闭环。
- `prospecting`：自动获客、清洗、复核和导入闭环。
- `outreach`：开发信、Communication 和后续触达闭环。
- `trade-documents`：从客户与商机制作、审批、导出和下载 PI/CI 的闭环。

Skill 负责告诉 Agent 如何完成业务目标，Tool 负责执行确定、可校验的系统操作。Skill 只能引用已有 Tool，不能扩大账号权限、降低风险等级或绕过确认策略。

新增或拆分 Skill 前，先在 benchmark 中加入真实用户表达、期望 Tool 轨迹和完成证据。只有现有宽 Skill 的成功率、上下文长度或维护责任出现明确问题时才拆分。
