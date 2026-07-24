export type AgentOperationRisk = "read" | "write" | "external";
export type AgentAuthorizationPolicy =
  | "read_only"
  | "direct_user_intent"
  | "explicit_confirmation"
  | "frozen_payload_confirmation";

export interface AgentCompletionEvidence {
  type: "response" | "created_object_id" | "deleted_object";
  responsePaths?: string[];
  description: string;
}

export interface AgentOperationContract {
  version: "1.0";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operation: string;
  entity: string;
  intentExamples: string[];
  requestSchema: Record<string, unknown> | null;
  risk: AgentOperationRisk;
  authorizationPolicy: AgentAuthorizationPolicy;
  completionEvidence: AgentCompletionEvidence;
  refreshView: string;
  guidance: string;
  schemaSource: "registry" | "openapi" | "none";
  executable: boolean;
}

interface AgentApiBusinessContract {
  schema: Record<string, unknown>;
  guidance: string;
}

type JsonSchema = Record<string, unknown>;

const string = (options: JsonSchema = {}): JsonSchema => ({ type: "string", ...options });
const number = (options: JsonSchema = {}): JsonSchema => ({ type: "number", ...options });
const integer = (options: JsonSchema = {}): JsonSchema => ({ type: "integer", ...options });
const boolean = (options: JsonSchema = {}): JsonSchema => ({ type: "boolean", ...options });
const array = (items: JsonSchema, options: JsonSchema = {}): JsonSchema => ({ type: "array", items, ...options });
const oneOf = (...values: string[]): JsonSchema => ({ type: "string", enum: values });

const objectSchema = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  required,
  properties,
  additionalProperties: false
});

const emptySchema = objectSchema([], {});
const reasonSchema = objectSchema([], { reason: string({ maxLength: 1000, default: "" }) });
const idsSchema = objectSchema(["ids"], { ids: array(string({ minLength: 1 }), { minItems: 1, maxItems: 200 }) });
const hitIdsSchema = objectSchema(["hitIds"], {
  hitIds: array(string({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" }), { minItems: 1, maxItems: 200 })
});

const customerFields: Record<string, JsonSchema> = {
  company: string({ minLength: 1 }),
  country: string({ minLength: 1, default: "未知" }),
  contact: string({ minLength: 1, default: "待维护" }),
  whatsapp: string({ pattern: "^\\+[1-9]\\d{6,14}$|^$", default: "", description: "没有真实号码时必须留空" }),
  stage: string({ minLength: 1, default: "询盘" }),
  amount: integer({ minimum: 0, default: 0 }),
  health: integer({ minimum: 0, maximum: 100, default: 72 }),
  grade: oneOf("A", "B", "C", "D"),
  nextReminder: string({ minLength: 1 }),
  wecomBound: boolean(),
  billingName: string({ default: "" }),
  billingAddress: string({ default: "" }),
  documentContact: string({ default: "" }),
  defaultPortDischarge: string({ default: "" }),
  defaultIncoterm: string({ default: "" }),
  defaultPaymentTerm: string({ default: "" })
};

const leadFields: Record<string, JsonSchema> = {
  company: string({ minLength: 1 }), contact: string({ default: "" }), country: string({ default: "" }),
  email: string({ default: "" }), phone: string({ default: "" }), wechat: string({ default: "" }),
  source: string({ default: "手动录入" }), intent: oneOf("高", "中", "低"), stage: string({ default: "新线索" }),
  estimatedAmount: number({ minimum: 0, default: 0 }), nextFollowAt: string({ default: "" }), remark: string({ default: "" }),
  sourceType: oneOf("outbound", "inbound", "offline", "referral", "import"), sourceChannel: string({ default: "manual", maxLength: 80 }),
  sourceCampaign: string({ default: "", maxLength: 120 }), externalId: string({ default: "", maxLength: 180 }), sourceUrl: string({ default: "", maxLength: 500 })
};

const dealFields: Record<string, JsonSchema> = {
  customerId: string({ minLength: 1 }), title: string({ minLength: 1 }), product: string({ minLength: 1, maxLength: 200 }),
  quantity: integer({ minimum: 0, default: 0 }), unitPrice: number({ minimum: 0, default: 0 }), amount: number({ minimum: 0 }),
  currency: string({ pattern: "^[A-Z]{3}$", default: "USD" }), nextAction: string({ minLength: 1 }), nextActionAt: string({ minLength: 1 }),
  expectedCloseAt: string({ default: "" }), recommendationId: string({ default: "", maxLength: 90 })
};

const todoFields: Record<string, JsonSchema> = {
  title: string({ minLength: 1 }), type: oneOf("customer", "knowledge", "exam", "ocr", "other"),
  priority: oneOf("high", "medium", "normal"), dueAt: string({ default: "" }), related: string({ default: "" }),
  done: boolean(), status: oneOf("pending", "in_progress"), pinState: oneOf("top", "bottom", ""), sortOrder: number(),
  historyAt: string(), snoozeReason: string({ maxLength: 255 }), completionResult: string({ maxLength: 255 })
};

const planTaskFields: Record<string, JsonSchema> = {
  title: string({ minLength: 1 }), phase: string({ minLength: 1, default: "计划任务" }), category: string({ minLength: 1, default: "客户开发" }),
  priority: oneOf("high", "medium", "normal"), status: oneOf("planned", "active"), dueAt: string({ pattern: "^$|^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }),
  target: string(), description: string(), customerId: string(), leadId: string(), dealId: string()
};

const planTemplateFields: Record<string, JsonSchema> = {
  section: oneOf("knowledge", "persona", "execution"), title: string({ minLength: 1 }), summary: string(), output: string(), badge: string(), badgeTone: string(),
  phase: string({ minLength: 1 }), category: string({ minLength: 1 }), priority: oneOf("high", "medium", "normal"), target: string(), description: string(), sortOrder: integer()
};

const memoryFields: Record<string, JsonSchema> = {
  type: oneOf("user_preference", "company_knowledge", "customer_memory", "team_playbook"), scope: oneOf("personal", "team", "customer", "company"),
  subjectId: string({ maxLength: 120 }), title: string({ minLength: 2, maxLength: 120 }), content: string({ minLength: 2, maxLength: 2000 }),
  sourceType: oneOf("crm", "manual", "agent", "playbook"), sourceId: string({ maxLength: 160 }), confidence: integer({ minimum: 0, maximum: 100 }), expiresAt: string({ maxLength: 40 })
};

const knowledgeFields: Record<string, JsonSchema> = {
  kind: oneOf("module", "workflow", "policy", "field", "playbook", "failure_case"), scope: oneOf("team", "company"), module: string({ minLength: 2, maxLength: 80 }),
  title: string({ minLength: 2, maxLength: 160 }), summary: string({ minLength: 2, maxLength: 500 }), content: string({ minLength: 10, maxLength: 8000 }),
  keywords: array(string({ minLength: 1, maxLength: 80 }), { maxItems: 40 }), roles: array(oneOf("sales", "manager", "admin", "super_admin"), { minItems: 1, maxItems: 4 }),
  toolRefs: array(string({ minLength: 2, maxLength: 120 }), { maxItems: 40 }), successCriteria: array(string({ minLength: 2, maxLength: 300 }), { maxItems: 20 }),
  failureCases: array(string({ minLength: 2, maxLength: 300 }), { maxItems: 20 }), sourceType: oneOf("manual", "agent_feedback"), sourceId: string({ maxLength: 160 })
};

const triggerFields: Record<string, JsonSchema> = {
  name: string({ minLength: 2, maxLength: 120 }),
  eventType: oneOf("lead_overdue", "customer_reply", "stalled_deal", "next_action_due", "health_decline", "communication_unread", "prospect_completed"),
  mode: oneOf("notify", "internal", "approval"), intervalMinutes: integer({ minimum: 5, maximum: 10080 }), thresholdDays: integer({ minimum: 1, maximum: 180 }),
  healthBelow: integer({ minimum: 0, maximum: 100 }), maxPerScan: integer({ minimum: 1, maximum: 20 })
};

const registry: Record<string, AgentApiBusinessContract> = {};
const define = (key: string, schema: JsonSchema, guidance: string) => { registry[key] = { schema, guidance }; };
const defineMany = (keys: string[], schema: JsonSchema, guidance: string) => keys.forEach((key) => define(key, schema, guidance));

define("POST /api/customers", objectSchema(["company"], customerFields), "创建客户。用户允许补齐时只能使用明确的待维护默认值，不得编造真实联系方式；响应 customer.id 是完成证据。");
define("PATCH /api/customers/{id}", objectSchema([], customerFields), "更新当前账号有写权限的客户；只提交用户要求修改的字段。");
define("POST /api/customers/{id}/release", objectSchema(["reason"], { reason: string({ minLength: 2, maxLength: 500 }), expectedVersion: integer({ minimum: 0 }) }), "释放客户到公池；必须说明原因并再次确认。");
define("POST /api/customers/{id}/claim", objectSchema([], { expectedVersion: integer({ minimum: 0 }) }), "领取公池客户；使用列表返回的真实客户 ID 和版本。");
define("POST /api/customers/bulk-delete", idsSchema, "批量删除客户会连带清理关联数据，必须展示完整 ID 清单并单独确认。");
define("POST /api/customers/{id}/activities", objectSchema(["type", "content"], { type: oneOf("call", "email", "whatsapp", "wechat", "meeting", "note"), content: string({ minLength: 1, maxLength: 2000 }), nextReminder: string({ maxLength: 100 }) }), "记录真实客户跟进；响应 activity.id 是写入证据。");
define("POST /api/customer-intelligence/{id}/accept", objectSchema([], { selectedFields: array(oneOf("company", "country", "contact", "documentContact"), { maxItems: 4 }) }), "采纳客户情报建议，只能选择人工确认过的字段。");
define("POST /api/customer-intelligence/{id}/reject", reasonSchema, "拒绝客户情报建议，可记录原因。");

define("POST /api/leads", objectSchema(["company"], leadFields), "创建线索。未知联系资料保持空值；响应 lead.id 或 duplicate 是完成证据。");
define("POST /api/leads/ingest", objectSchema(["company"], { ...leadFields, occurredAt: string({ format: "date-time" }), rawPayload: {} }), "从可信来源写入线索并保留来源事件；不得伪造来源载荷。");
define("PATCH /api/leads/{id}", objectSchema([], { ...leadFields, status: oneOf("new", "following", "converted", "invalid") }), "更新当前账号可见线索，只提交需要变更的字段。");
define("DELETE /api/leads/{id}", objectSchema([], { reason: string({ default: "" }) }), "把线索移入垃圾箱；已转客户线索不能删除。");
defineMany(["POST /api/leads/{id}/restore", "DELETE /api/leads/{id}/permanent"], emptySchema, "恢复或永久删除线索；永久删除必须单独确认。");
define("POST /api/leads/{id}/activities", objectSchema(["content"], { type: oneOf("call", "wechat", "whatsapp", "linkedin", "email", "meeting", "note"), content: string({ minLength: 1 }), nextFollowAt: string() }), "记录线索跟进并核验 activity.id。");
define("POST /api/leads/{id}/social-touch", objectSchema(["channel", "message"], { channel: oneOf("call", "wechat", "whatsapp", "linkedin"), message: string({ minLength: 1, maxLength: 1200 }), nextFollowAt: string() }), "只记录社媒触达结果，不代表系统真实发送消息。");
define("POST /api/leads/{id}/send-email", objectSchema(["to", "subject", "body"], { to: string({ format: "email" }), subject: string({ minLength: 1, maxLength: 160 }), body: string({ minLength: 10, maxLength: 3000 }), nextFollowAt: string() }), "真实发送开发邮件；收件人、主题和完整正文冻结后确认。");
define("POST /api/leads/{id}/convert", objectSchema([], { customerMode: oneOf("create", "existing"), customerId: string(), createDeal: boolean(), deal: { type: "object", additionalProperties: false, properties: { title: string({ maxLength: 200 }), product: string({ maxLength: 200 }), amount: number({ minimum: 0 }), quantity: integer({ minimum: 0 }), unitPrice: number({ minimum: 0 }), nextAction: string({ maxLength: 200 }) } } }), "将线索转为新客户或关联现有客户；创建商机时必须使用用户确认的信息。");

define("POST /api/deals", objectSchema(["customerId", "title", "product", "nextAction", "nextActionAt"], dealFields), "创建商机。必须使用真实可写 customerId；产品、下一动作和时间不能替用户臆造。");
define("PATCH /api/deals/{id}", objectSchema(["customerId", "title", "product", "nextAction", "nextActionAt"], dealFields), "编辑商机基础信息；服务端会重新计算金额。");
define("PATCH /api/deals/{id}/stage", objectSchema(["stage", "result", "nextAction", "nextActionAt"], { stage: oneOf("询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"), result: string({ minLength: 1, maxLength: 2000 }), nextAction: string({ minLength: 1, maxLength: 200 }), nextActionAt: string({ minLength: 1 }), expectedCloseAt: string(), transitionReason: string(), wonReason: string() }), "推进商机阶段；跨阶段、回退和成交需要对应业务依据。");
define("POST /api/deals/{id}/events", objectSchema(["type", "content", "nextAction", "nextActionAt"], { type: oneOf("follow_up", "quote", "sample", "negotiation", "payment"), content: string({ minLength: 1, maxLength: 2000 }), nextAction: string({ minLength: 1, maxLength: 200 }), nextActionAt: string({ minLength: 1 }) }), "记录商机进展，并同步下一动作。");
define("POST /api/deals/{id}/archive", emptySchema, "只有已成交商机可以归档。");
define("POST /api/deals/{id}/lost", objectSchema(["category", "reason"], { category: string({ minLength: 1, maxLength: 80 }), reason: string({ minLength: 1, maxLength: 2000 }), revisitAt: string() }), "标记丢单并记录真实原因；该动作需要明确确认。");

define("POST /api/todos", objectSchema(["title"], todoFields), "创建当前账号待办；未指定日期时 dueAt 留空。");
define("PATCH /api/todos/{id}", objectSchema([], todoFields), "更新当前账号待办，只提交需要变更的字段。");
define("POST /api/todos/{id}/complete", objectSchema([], { completionResult: string({ maxLength: 255 }) }), "完成待办；规则提醒必须填写处理结果。");
defineMany(["POST /api/todos/archive-due", "POST /api/todos/{id}/restore", "DELETE /api/todos/{id}"], emptySchema, "执行待办归档、恢复或删除动作；删除需要明确确认。");
define("POST /api/todos/reorder", objectSchema(["ids"], { ids: array(string(), { minItems: 1 }), mode: oneOf("manual", "top", "bottom"), targetId: string() }), "调整本人待办排序。");

define("POST /api/plan-tasks", objectSchema(["title"], planTaskFields), "创建执行计划任务；关联对象 ID 必须来自当前账号可见数据。");
define("PATCH /api/plan-tasks/{id}", objectSchema([], planTaskFields), "编辑执行计划任务。");
define("POST /api/plan-tasks/{id}/complete", objectSchema(["result"], { result: string({ minLength: 1, maxLength: 2000 }) }), "完成计划任务并记录实际结果。");
define("POST /api/plan-tasks/{id}/cancel", objectSchema(["reason"], { reason: string({ minLength: 1, maxLength: 1000 }) }), "取消计划任务并记录原因。");
define("POST /api/plan-tasks/{id}/reschedule", objectSchema(["dueAt"], { dueAt: string({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }), reason: string({ maxLength: 500 }) }), "调整计划时间并保留原因。");
define("DELETE /api/plan-tasks/{id}", emptySchema, "永久删除计划任务，需要明确确认。");
define("POST /api/plan-templates", objectSchema(["title"], planTemplateFields), "创建本人计划模板。");
define("PATCH /api/plan-templates/{id}", objectSchema([], planTemplateFields), "编辑本人计划模板。");
define("DELETE /api/plan-templates/{id}", emptySchema, "删除本人计划模板，需要明确确认。");

define("POST /api/problems", objectSchema(["title"], { title: string({ minLength: 1 }), category: string(), severity: oneOf("high", "medium", "low"), status: oneOf("open", "solving", "resolved"), relatedCustomer: string(), rootCause: string(), solution: string(), nextAction: string(), dueAt: string() }), "创建业务问题记录。");
define("PATCH /api/problems/{id}/status", objectSchema(["status"], { status: oneOf("open", "solving", "resolved") }), "更新业务问题状态。");
define("POST /api/memos", objectSchema(["title"], { title: string({ minLength: 1 }), content: string(), category: string({ minLength: 1 }), tags: string(), customerId: string(), dealId: string(), pinned: boolean() }), "创建备忘录；关联 ID 必须真实可见。");
define("PATCH /api/memos/{id}", objectSchema([], { title: string({ minLength: 1 }), content: string(), category: string({ minLength: 1 }), tags: string(), customerId: string(), dealId: string(), pinned: boolean(), archived: boolean() }), "编辑备忘录。");
defineMany(["DELETE /api/memos/{id}", "POST /api/memos/{id}/restore", "DELETE /api/memos/{id}/permanent"], emptySchema, "执行备忘录删除、恢复或永久删除；永久删除需要明确确认。");

define("POST /api/competitors", objectSchema(["company"], { company: string({ minLength: 1 }), country: string(), segment: string(), threatLevel: oneOf("high", "medium", "low"), website: string(), strengths: string(), weaknesses: string(), competingProducts: string(), ourStrategy: string() }), "创建竞品档案，只使用有依据的信息。");
define("PATCH /api/competitors/{id}/threat", objectSchema(["threatLevel"], { threatLevel: oneOf("high", "medium", "low") }), "更新竞品威胁等级。");
define("POST /api/case-studies", objectSchema(["title"], { title: string({ minLength: 1 }), customer: string(), country: string(), product: string(), industry: string(), result: string(), story: string(), reusablePoints: string(), status: oneOf("draft", "published") }), "创建案例，禁止编造客户结果。");
defineMany(["PATCH /api/case-studies/{id}/publish", "PATCH /api/knowledge/assets/{id}/publish"], emptySchema, "发布内容；服务端按当前角色复核权限。");
define("POST /api/knowledge/assets", objectSchema(["title"], { title: string({ minLength: 1 }), category: string({ minLength: 1 }), version: string({ minLength: 1 }) }), "创建知识资料记录。");

define("POST /api/daily-reports", objectSchema(["reportDate", "completedWork"], { reportDate: string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), completedWork: string({ minLength: 1, maxLength: 5000 }), customerProgress: string({ maxLength: 5000 }), results: string({ maxLength: 5000 }), risks: string({ maxLength: 5000 }), nextPlan: string({ maxLength: 5000 }), supportNeeded: string({ maxLength: 5000 }) }), "提交或更新本人的业务日报。");
define("POST /api/daily-reports/{id}/comments", objectSchema(["content"], { content: string({ minLength: 1, maxLength: 2000 }), parentId: string({ maxLength: 64 }) }), "评论可见日报。");
define("POST /api/internal-messages", objectSchema(["recipientId", "subject", "content"], { recipientId: string({ minLength: 1, maxLength: 64 }), subject: string({ minLength: 1, maxLength: 180 }), content: string({ minLength: 1, maxLength: 5000 }), threadId: string({ maxLength: 64 }) }), "发送站内消息也属于对他人的外部副作用，必须确认收件人和完整内容。");
define("POST /api/internal-messages/{id}/read", emptySchema, "将本人收到的站内消息标记已读。");

define("PUT /api/company-profile", objectSchema([], { companyName: string({ maxLength: 200 }), website: string({ maxLength: 300 }), productSummary: string({ maxLength: 2000 }), address: string({ maxLength: 1000 }), phone: string({ maxLength: 100 }), email: string({ maxLength: 180 }) }), "维护团队公司资料，仅管理员可执行。");
define("POST /api/ai-background-research", objectSchema(["entityType", "entityId"], { entityType: oneOf("lead", "customer"), entityId: string({ minLength: 1, maxLength: 120 }) }), "执行客户或线索背调，可能访问外部来源，必须确认目标对象。");
define("POST /api/development-email/draft", objectSchema(["entityType", "entityId"], { entityType: oneOf("lead", "customer"), entityId: string({ minLength: 1, maxLength: 120 }), tone: oneOf("professional", "concise", "warm"), requireAi: boolean() }), "生成开发信草稿，不发送。");
define("POST /api/development-email/send", objectSchema(["entityType", "entityId", "to", "subject", "body"], { entityType: oneOf("lead", "customer"), entityId: string({ minLength: 1, maxLength: 120 }), to: string({ format: "email" }), subject: string({ minLength: 1, maxLength: 160 }), body: string({ minLength: 10, maxLength: 6000 }), nextFollowAt: string({ maxLength: 100 }) }), "真实发送开发信；收件人、主题、正文必须冻结并确认。");

define("POST /api/agent/sales-training", objectSchema(["sourceUserId"], { sourceUserId: string({ minLength: 1, maxLength: 100 }), periodDays: integer({ minimum: 7, maximum: 365 }) }), "创建业务员训练任务；只能选择服务端允许的团队成员。");
define("PATCH /api/agent/sales-training/{id}/samples/{sampleId}", objectSchema([], { label: oneOf("positive", "negative", "neutral"), included: boolean(), managerNote: string({ maxLength: 500 }) }), "人工标注训练样本，作为后续训练证据。");
define("POST /api/agent/sales-distillation", objectSchema(["sourceUserId"], { sourceUserId: string({ minLength: 1, maxLength: 100 }), periodDays: integer({ minimum: 7, maximum: 365 }) }), "创建业务打法蒸馏任务。");
defineMany(["POST /api/agent/outreach-sequences/{id}/{action}", "POST /api/agent/customer-maintenance/{id}/{action}", "POST /api/agent/sales-training/{id}/{action}", "POST /api/agent/sales-distillation/{id}/publish", "POST /api/agent/sales-distillation/{id}/activate", "POST /api/agent/sales-distillation/activations/{id}/pause"], emptySchema, "执行 Agent 业务对象的状态动作；路径 action 必须来自接口目录允许值。");
define("POST /api/agent/memories", objectSchema(["type", "scope", "title", "content"], memoryFields), "创建待审核业务记忆；团队、公司或客户范围仍受当前角色和对象权限限制。");
define("PATCH /api/agent/memories/{id}", objectSchema([], { title: memoryFields.title, content: memoryFields.content, expiresAt: memoryFields.expiresAt }), "修改当前账号有权管理的业务记忆。");
defineMany(["DELETE /api/agent/memories/{id}", "POST /api/agent/memories/{id}/activate", "POST /api/agent/memories/{id}/archive"], emptySchema, "管理业务记忆状态；删除需要明确确认。");
define("POST /api/agent/knowledge/documents", objectSchema(["kind", "module", "title", "summary", "content"], knowledgeFields), "创建待审核知识文档，不能直接伪装成系统知识。");
define("PATCH /api/agent/knowledge/documents/{id}", objectSchema([], knowledgeFields), "编辑有权限维护的知识草稿。");
define("POST /api/agent/knowledge/documents/{id}/{action}", emptySchema, "提交、发布或归档知识文档；路径 action 必须来自接口目录允许值。");
define("POST /api/agent/tuning/inspect", objectSchema(["goal"], {
  goal: string({ minLength: 2, maxLength: 2000 }),
  context: objectSchema([], {
    activeView: string({ maxLength: 80 }),
    selectedCustomerId: string({ maxLength: 120 }),
    selectedDealId: string({ maxLength: 120 }),
    selectedLeadId: string({ maxLength: 120 })
  })
}), "只读诊断自然语言目标将命中的 GoalSpec、Skill、Knowledge、工具和授权策略，不创建或修改业务数据。");
define("POST /api/agent/triggers", objectSchema(["name", "eventType"], triggerFields), "创建本人自动触发规则；真实发送仍必须进入单独审批。");
define("PATCH /api/agent/triggers/{id}", objectSchema([], triggerFields), "编辑本人自动触发规则。");
defineMany(["DELETE /api/agent/triggers/{id}", "POST /api/agent/triggers/{id}/{action}", "POST /api/agent/evaluations/run"], emptySchema, "执行 Agent 规则状态动作或评测；不会绕过下游动作权限。");

const prospectContactFields: Record<string, JsonSchema> = {
  channel: oneOf("email", "whatsapp", "call"), contactValue: string({ maxLength: 255 }), subject: string({ maxLength: 255 }),
  content: string({ maxLength: 5000 }), occurredAt: string({ format: "date-time" }), nextFollowAt: string({ maxLength: 40 }), requestId: string({ minLength: 1, maxLength: 120 })
};
define("POST /api/prospect-list/{id}/send-development-email", objectSchema(["to", "subject", "body"], { to: string({ format: "email" }), subject: string({ minLength: 1, maxLength: 160 }), body: string({ minLength: 10, maxLength: 3000 }), requestId: string({ minLength: 1, maxLength: 120 }) }), "真实向已核验可联系候选发送开发信；冻结收件人、主题、正文和幂等 requestId 后确认。");
define("POST /api/prospect-list/{id}/touchpoints", objectSchema(["channel", "requestId"], prospectContactFields), "记录候选客户触达事实；requestId 用于避免重复记录。");
define("POST /api/prospect-list/{id}/replies", objectSchema(["channel", "classification", "requestId"], { ...prospectContactFields, classification: oneOf("clear_demand", "interested_nurture", "referral", "no_current_demand", "rejected", "unsubscribed", "bounced", "auto_unknown"), procurement: { type: "object", additionalProperties: false, properties: { evidenceSummary: string({ maxLength: 2000 }), evidenceTypes: array(oneOf("quote_request", "product_requirement", "quantity", "sample_request", "purchase_timeline", "target_price", "certification", "delivery", "project_tender", "manual_confirmation"), { maxItems: 10 }), product: string({ maxLength: 200 }), specification: string({ maxLength: 1000 }), quantity: integer({ minimum: 0 }), quantityType: oneOf("unknown", "sample", "trial", "forecast", "order"), targetPrice: number({ minimum: 0 }), currency: string({ pattern: "^[A-Za-z]{3}$" }), priceBasis: string({ maxLength: 80 }), deliveryRequirement: string({ maxLength: 500 }), certificationRequirement: string({ maxLength: 500 }), purchaseTimeline: string({ maxLength: 500 }), projectName: string({ maxLength: 500 }), buyerRole: string({ maxLength: 100 }), nextAction: string({ maxLength: 200 }), confidence: number({ minimum: 0, maximum: 100 }) } } }), "记录候选客户真实回复；明确需求时才提交有证据的采购信息。");
define("POST /api/prospect-list/{id}/follow-up", objectSchema([], { channel: oneOf("email", "whatsapp", "call"), dueAt: string({ maxLength: 40 }), priority: oneOf("high", "medium", "normal") }), "为候选客户创建或复用跟进待办。");
define("POST /api/deal-recommendations/{id}/dismiss", reasonSchema, "忽略商机建议并记录原因。");
define("POST /api/deal-recommendations/{id}/link-deal", objectSchema(["dealId"], { dealId: string({ minLength: 1 }) }), "把商机建议关联到本人真实商机。");

define("POST /api/whatsapp/customers/{customerId}/binding", objectSchema(["phoneNumber"], { phoneNumber: string({ pattern: "^\\+[1-9]\\d{6,14}$" }), waProfileName: string() }), "保存客户的 WhatsApp 号码，不涉及个人 Communication 账号扫码绑定。");
define("POST /api/whatsapp/customers/{customerId}/messages", objectSchema(["direction", "content"], { direction: oneOf("inbound", "outbound"), content: string({ minLength: 1, maxLength: 4000 }), mediaUrl: string() }), "outbound 可能真实发送，必须冻结客户、方向、正文和媒体地址后确认；inbound 只可记录已发生事实。");
defineMany(["POST /api/whatsapp/customers/{customerId}/read", "POST /api/whatsapp/messages/{id}/translate", "DELETE /api/whatsapp/messages/{id}"], emptySchema, "管理本人可见 Communication 消息；删除需要明确确认。");

const commissionProductFields: Record<string, JsonSchema> = { name: string({ minLength: 1 }), category: string(), model: string(), currency: string(), defaultPrice: number({ minimum: 0 }), costPrice: number({ minimum: 0 }), status: oneOf("active", "disabled"), remark: string() };
const commissionRuleFields: Record<string, JsonSchema> = { ruleType: oneOf("rate", "fixed", "tier", "gross_profit", "none"), rate: number({ minimum: 0, maximum: 1 }), fixedAmount: number({ minimum: 0 }), tierJson: string(), grossProfitRate: number({ minimum: 0, maximum: 1 }), effectiveFrom: string(), effectiveTo: string(), enabled: boolean(), remark: string() };
const salesRecordFields: Record<string, JsonSchema> = { ownerId: string(), month: string({ pattern: "^\\d{4}-\\d{2}$" }), customerId: string(), customerName: string({ minLength: 1 }), productId: string(), productName: string({ minLength: 1 }), quantity: number({ minimum: 0 }), unitPrice: number({ minimum: 0 }), salesAmount: number({ minimum: 0 }), currency: string(), exchangeRate: number({ minimum: 0 }), exchangeRateDate: string(), exchangeRateSource: oneOf("pending", "manual", "finance"), settlementCurrency: { type: "string", enum: ["CNY"] }, basisType: oneOf("deal_amount", "receipt"), basisDate: string(), status: oneOf("draft", "confirmed"), editNote: string() };
define("POST /api/commission/products", objectSchema(["name"], commissionProductFields), "管理员创建提成产品。");
define("PATCH /api/commission/products/{id}", objectSchema([], commissionProductFields), "管理员编辑提成产品。");
define("POST /api/commission/products/{id}/rules", objectSchema(["ruleType"], commissionRuleFields), "管理员创建提成规则；费率必须在 0 到 1 之间。");
define("PATCH /api/commission/rules/{id}", objectSchema([], commissionRuleFields), "管理员编辑提成规则；已使用规则会生成新版本。");
define("POST /api/commission/sales-records", objectSchema(["customerName", "productName"], salesRecordFields), "创建销售记录；人员、客户、币种和计提依据必须来自真实业务数据。");
define("PATCH /api/commission/sales-records/{id}", objectSchema(["editNote"], salesRecordFields), "编辑销售记录必须填写至少 2 字的审计原因。");
define("POST /api/commission/sales-records/sync-from-deals", objectSchema([], { month: string({ pattern: "^\\d{4}-\\d{2}$" }), ownerId: string() }), "从已归档成交商机同步销售记录。");
defineMany(["POST /api/commission/sales-records/{id}/confirm", "POST /api/commission/calculations/{id}/review", "POST /api/commission/calculations/{id}/lock"], emptySchema, "执行提成确认、复核或锁定；服务端按角色和当前状态校验。");
define("POST /api/commission/calculations/recalculate", objectSchema([], { month: string({ pattern: "^\\d{4}-\\d{2}$" }), ownerId: string() }), "基于已确认销售记录重算提成。");
define("POST /api/commission/calculations/{id}/manual-item", objectSchema(["remark"], { itemType: oneOf("bonus", "deduction", "subsidy", "refund", "special", "other"), manualAmount: number(), recordId: string(), remark: string({ minLength: 2 }) }), "管理员手工调整提成，必须记录原因。");
define("POST /api/commission/calculations/{id}/unlock", objectSchema(["reason"], { reason: string({ minLength: 4 }) }), "解锁已锁定提成单并生成新版本，必须记录原因。");
define("POST /api/commission/export", objectSchema([], { month: string({ pattern: "^\\d{4}-\\d{2}$" }), scopeType: oneOf("self", "team", "all"), ownerId: string(), fileType: oneOf("xlsx", "csv") }), "导出当前权限范围内的提成数据。");

const questionFields: Record<string, JsonSchema> = { stem: string({ minLength: 1 }), category: string({ minLength: 1 }), options: array(string({ minLength: 1 }), { minItems: 2, maxItems: 6 }), answerIndex: integer({ minimum: 0 }), answerIndexes: array(integer({ minimum: 0 })), questionType: oneOf("single", "multiple"), tags: array(string()), explanation: string({ minLength: 1 }), difficulty: oneOf("easy", "medium", "hard") };
define("POST /api/exam-questions", objectSchema(["stem", "options"], questionFields), "主管或管理员创建题库题目。");
define("PATCH /api/exam-questions/{id}", objectSchema(["stem", "options"], questionFields), "主管或管理员完整更新题目。");
define("POST /api/exam-questions/import", objectSchema(["questions"], { questions: array(objectSchema(["stem", "options"], questionFields), { minItems: 1, maxItems: 500 }) }), "批量导入题库，先核验题目和正确答案索引。");
define("DELETE /api/exam-questions/{id}", emptySchema, "删除题库题目，需要明确确认。");
define("POST /api/exams", objectSchema(["title", "category", "questionIds"], { title: string({ minLength: 1 }), category: string({ minLength: 1 }), questionIds: array(string(), { minItems: 1 }), durationMinutes: integer({ minimum: 1 }), passScore: integer({ minimum: 1, maximum: 100 }), targetRole: oneOf("all", "sales", "manager") }), "主管或管理员创建考试并使用真实题目 ID。");
define("POST /api/exams/{id}/questions", objectSchema(["stem", "options"], questionFields), "为考试创建一道题目。");
define("POST /api/exams/{id}/questions/import", objectSchema(["questions"], { questions: array(objectSchema(["stem", "options"], questionFields), { minItems: 1, maxItems: 300 }) }), "为考试批量导入题目。");
defineMany(["PATCH /api/exams/{id}/publish", "DELETE /api/exams/{id}"], emptySchema, "发布或删除考试；删除需要明确确认。");
define("POST /api/exams/bulk-delete", idsSchema, "批量删除考试及作答记录，需要单独确认完整清单。");
define("POST /api/exams/{id}/submit", objectSchema([], { answers: { type: "object", additionalProperties: { oneOf: [{ type: "integer", minimum: 0 }, { type: "array", items: { type: "integer", minimum: 0 } }] } } }), "提交当前账号的考试答案。");

const reminderFields: Record<string, JsonSchema> = { title: string({ minLength: 1 }), rule: string({ minLength: 1 }), dueAt: string({ minLength: 1 }), channel: { type: "string", enum: ["站内"] }, ruleType: oneOf("quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"), targetStage: string(), days: integer({ minimum: 0, maximum: 90 }), priority: oneOf("high", "medium", "normal"), enabled: boolean(), targetOwnerId: string() };
define("POST /api/reminders", objectSchema([], reminderFields), "创建站内提醒规则；目标负责人必须在当前权限范围内。");
define("PATCH /api/reminders/{id}", objectSchema([], reminderFields), "编辑提醒规则。");
defineMany(["POST /api/reminders/{id}/run", "POST /api/reminders/{id}/toggle"], emptySchema, "运行或启停提醒规则；运行只创建站内待办，不外发消息。");

define("POST /api/import-export/jobs", objectSchema(["name", "type", "rows"], { name: string({ minLength: 1 }), type: oneOf("import", "export"), rows: integer({ minimum: 0 }) }), "登记导入导出任务。");
define("POST /api/import-export/customers/import", objectSchema(["rows"], { rows: array(objectSchema(["company"], { ...customerFields, amount: number({ minimum: 0 }) }), { minItems: 1, maxItems: 2000 }), fileName: string() }), "批量导入客户；同名本人客户会被更新，执行前必须确认数据范围。");
define("POST /api/import-export/customers/export", emptySchema, "导出当前账号可见客户数据。");

const documentItemFields: Record<string, JsonSchema> = { id: string({ maxLength: 64 }), product: string({ minLength: 1, maxLength: 500 }), model: string({ maxLength: 200 }), hsCode: string({ maxLength: 40 }), quantity: number({ minimum: 0 }), unit: string({ maxLength: 40 }), unitPrice: number({ minimum: 0 }), originCountry: string({ maxLength: 80 }), weightKg: number({ minimum: 0 }), packageCount: integer({ minimum: 0 }) };
const documentFields: Record<string, JsonSchema> = { customerId: string({ maxLength: 64 }), dealId: string({ maxLength: 64 }), revision: integer({ minimum: 1 }), type: oneOf("PI", "CI"), title: string({ minLength: 1, maxLength: 255 }), number: string({ minLength: 1, maxLength: 80 }), issueDate: string({ minLength: 1, maxLength: 40 }), buyer: string({ maxLength: 200 }), buyerAddress: string({ maxLength: 4000 }), buyerContact: string({ maxLength: 200 }), seller: string({ minLength: 1, maxLength: 200 }), sellerAddress: string({ maxLength: 4000 }), currency: string({ minLength: 1, maxLength: 12 }), incoterm: string({ minLength: 1, maxLength: 80 }), paymentTerm: string({ maxLength: 255 }), shippingMethod: string({ maxLength: 120 }), portLoading: string({ maxLength: 120 }), portDischarge: string({ maxLength: 120 }), validityDate: string({ maxLength: 40 }), bankInfo: string({ maxLength: 8000 }), notes: string({ maxLength: 8000 }), templateStyle: oneOf("executive", "classic", "compact"), status: oneOf("draft", "ready", "pending_approval", "approved", "rejected", "exported"), approvalNote: string({ maxLength: 2000 }), approvedAt: string({ maxLength: 100 }), approvedBy: string({ maxLength: 64 }), audits: array({}), sendRecords: array({}), items: array(objectSchema(["product"], documentItemFields), { minItems: 1, maxItems: 80 }) };
define("POST /api/trade-documents", objectSchema(["title", "number", "issueDate", "seller", "items"], documentFields), "创建 PI/CI 单据；客户、商机、商品和贸易条款必须来自真实业务数据。");
define("PATCH /api/trade-documents/{id}", objectSchema(["title", "number", "issueDate", "seller", "items"], documentFields), "完整更新未审批单据；已审批或导出单据必须创建新版本。");
defineMany(["POST /api/trade-documents/{id}/revision", "POST /api/trade-documents/{id}/export"], emptySchema, "创建单据新版本或导出已审批单据。");
defineMany(["POST /api/trade-documents/{id}/submit-approval", "POST /api/trade-documents/{id}/approve"], objectSchema([], { note: string() }), "提交或批准贸易单据，可记录审批说明。");
define("POST /api/trade-documents/{id}/reject", objectSchema(["note"], { note: string({ minLength: 1 }) }), "驳回单据必须填写原因。");
define("POST /api/trade-documents/{id}/send", objectSchema(["recipient"], { channel: oneOf("email", "whatsapp", "wechat", "manual"), recipient: string({ minLength: 1 }), message: string() }), "记录或发送已审批单据；渠道、接收方和内容冻结后确认。");
define("POST /api/deals/{dealId}/generate-customs", emptySchema, "根据真实商机、客户及已有关联单据生成报关资料草稿。");
define("POST /api/customs-documents/export", objectSchema(["customsDocument"], { customsDocument: { type: "object", required: ["customerId", "dealId", "number", "issueDate", "items"], additionalProperties: false, properties: { id: string(), customerId: string({ minLength: 1 }), dealId: string({ minLength: 1 }), tradeDocumentId: string(), number: string({ minLength: 1 }), issueDate: string({ minLength: 1 }), shipper: string(), shipperAddress: string(), shipperTaxNo: string(), consignee: string(), consigneeAddress: string(), manufacturer: string(), manufacturerTaxNo: string(), transportMode: string(), vesselName: string(), exitPort: string(), exitDate: string(), tradeMode: string(), supervisionMode: string(), tradeCountry: string(), destinationCountry: string(), packageType: string(), packageCount: number({ minimum: 0 }), grossWeight: number({ minimum: 0 }), netWeight: number({ minimum: 0 }), tradeMethod: string(), contractNo: string(), currency: string(), incoterm: string(), paymentTerm: string(), notes: string(), status: oneOf("draft", "ready", "exported"), ownerId: string(), teamId: string(), updatedAt: string(), items: array(objectSchema(["product"], { ...documentItemFields, brand: string(), brandType: string(), exportBenefit: string(), inspectionCode: string(), productEnglish: string() }), { minItems: 1 }) } } }), "导出报关资料；服务端再次校验商机、客户归属和必填报关字段。");

defineMany(["POST /api/wecom/messages/{id}/archive", "POST /api/tools/ocr/jobs/{id}/sync-lead", "POST /api/prospect-agent-jobs/{id}/retry", "POST /api/prospect-agent-jobs/{id}/cancel", "POST /api/prospect-schedules/{id}/pause", "POST /api/prospect-schedules/{id}/resume", "DELETE /api/prospect-schedules/{id}", "POST /api/dashboard/priority-tasks/batch-process"], emptySchema, "执行当前账号有权限的状态动作；服务端核验对象归属和可转换状态。");
define("POST /api/tools/ocr/jobs/{id}/recognize", objectSchema([], { confidence: number({ minimum: 0, maximum: 100 }), company: string({ maxLength: 200 }), contact: string({ maxLength: 120 }), title: string({ maxLength: 120 }), email: string({ maxLength: 254 }), whatsapp: string({ maxLength: 60 }), wechat: string({ maxLength: 80 }), phone: string({ maxLength: 60 }), country: string({ maxLength: 80 }), city: string({ maxLength: 120 }) }), "保存名片 OCR 识别结果；仅写入真实识别或人工纠正的字段。");
define("PATCH /api/prospect-list/{id}/details", objectSchema(["company", "website"], { company: string({ minLength: 1, maxLength: 200 }), business: string({ maxLength: 255 }), country: string({ maxLength: 80 }), website: string({ minLength: 3, maxLength: 255 }), contact: string({ maxLength: 120 }), contactInfo: string({ maxLength: 255 }), description: string({ maxLength: 1000 }) }), "更新未入库候选详情，信息必须有来源依据。");
define("PATCH /api/prospect-list/batch", objectSchema(["ids", "action"], { ids: array(string({ minLength: 1 }), { minItems: 1, maxItems: 100 }), action: oneOf("mark-contactable", "exclude", "restore", "assign"), ownerId: string({ minLength: 1 }), reason: string({ maxLength: 255 }), requestId: string({ minLength: 1, maxLength: 120 }), effectiveAt: string({ format: "date-time" }) }), "批量处理候选客户；分配涉及人员目录且只允许主管或管理员执行。");

const leadFinderFields: Record<string, JsonSchema> = { productKeywords: string(), countries: string(), industry: string(), customerType: string(), goal: string(), excludeKeywords: string(), sources: array(string({ pattern: "^[a-z0-9_]+$" }), { maxItems: 64 }), useAi: boolean(), limit: number({ minimum: 1, maximum: 30 }) };
define("POST /api/lead-finder/free-search", objectSchema([], { productKeywords: string(), countries: string(), industry: string(), customerType: string(), goal: string(), limit: number({ minimum: 1, maximum: 30 }) }), "使用公开免费来源搜索候选客户，属于外部数据访问，需要确认搜索条件。");
define("POST /api/lead-finder/search", objectSchema([], leadFinderFields), "使用已启用来源执行自动搜客，属于外部数据访问，需要确认来源和条件。");
define("POST /api/prospect-super-search/preview", objectSchema(["products", "markets", "customerTypes", "providerIds"], { products: array(string({ minLength: 1 }), { minItems: 1, maxItems: 30 }), markets: array(string({ minLength: 1 }), { minItems: 1, maxItems: 30 }), customerTypes: array(string({ minLength: 1 }), { minItems: 1, maxItems: 20 }), industries: array(string({ minLength: 1 }), { maxItems: 30 }), providerIds: array(string({ pattern: "^[a-z0-9_]+$" }), { minItems: 1, maxItems: 30 }), depth: oneOf("balanced", "deep", "extreme"), targetCandidateCount: integer({ minimum: 20, maximum: 10000 }), maxDurationMinutes: integer({ minimum: 30, maximum: 4320 }), costLimit: number({ minimum: 0 }), currency: string({ pattern: "^$|^[A-Z]{3}$" }) }), "预估超级搜索矩阵、轮次、时长与预算，不访问外部数据源。");
define("POST /api/prospect-super-search", objectSchema(["strategyId"], { strategyId: string({ minLength: 1, maxLength: 80 }), targetCandidateCount: integer({ minimum: 20, maximum: 10000 }), maxDurationMinutes: integer({ minimum: 30, maximum: 4320 }), depth: oneOf("balanced", "deep", "extreme"), costLimit: number({ minimum: 0 }), currency: string({ pattern: "^$|^[A-Z]{3}$" }), aiMode: oneOf("auto", "off") }), "创建多轮超级搜索任务；只调用策略 allowlist 中的公开或已授权 API，预算大于零时必须冻结预算确认。");
defineMany(["POST /api/prospect-super-search/{id}/pause", "POST /api/prospect-super-search/{id}/resume", "POST /api/prospect-super-search/{id}/cancel"], reasonSchema, "暂停、恢复或取消当前账号有权限的超级搜索任务，不改变已形成的候选和来源证据。");
defineMany([
  "POST /api/prospect-runs/{id}/import-pending",
  "POST /api/prospect-super-search/{id}/import-pending"
], hitIdsSchema, "只处理用户明确选择的待清洗原始命中；hitIds 必须属于当前账号可见的已结束任务，继续执行字段校验、身份归一和覆盖分流，不自动生成正式线索。");
define("POST /api/tools/website-scrape/preview", objectSchema(["urls"], { urls: array(string({ minLength: 3 }), { minItems: 1, maxItems: 12 }), useAi: boolean() }), "登记官网链接并生成候选预览；当前实现不会抓取企业网页。");
define("POST /api/tools/website-scrape/sync-opportunities", objectSchema(["opportunities"], { opportunities: array(objectSchema(["id", "company", "website"], { id: string({ minLength: 1 }), company: string({ minLength: 1 }), business: string(), country: string(), website: string({ minLength: 3 }), contact: string(), contactInfo: string(), description: string(), source: string({ maxLength: 40 }), sourceLabel: string({ maxLength: 80 }) }), { minItems: 1, maxItems: 100 }), allowPending: boolean() }), "把已有候选预览同步为线索；每个候选 ID 必须属于当前账号。allowPending=true 时允许用户主动导入尚未完成核验的候选。");
defineMany(["POST /api/prospect-strategy-suggestions/{id}/accept", "POST /api/prospect-strategy-suggestions/{id}/reject"], objectSchema([], { note: string({ maxLength: 500 }) }), "接受或拒绝本人获客策略建议。");
define("POST /api/prospect-strategies/{id}/schedules", objectSchema(["frequency"], { frequency: oneOf("daily", "weekly", "monthly"), timezone: string({ minLength: 1, maxLength: 100 }), recurringCostApproved: boolean() }), "为已批准策略建立定时获客计划；重复外部成本必须明确授权。");
define("PATCH /api/reports/executive/note", objectSchema([], { note: string({ maxLength: 1000 }) }), "维护本人经营报告备注。");

function normalizeTemplate(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

function isStrongSchema(schema: unknown): schema is JsonSchema {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as JsonSchema;
  return record.type === "object" && record.additionalProperties !== true;
}

function entityForPath(path: string) {
  const segment = path.split("/").filter(Boolean)[1] || "crm";
  return segment.replace(/-/gu, "_");
}

function refreshViewForPath(path: string) {
  const rules: Array<[string, string]> = [
    ["/api/customers", "customers"], ["/api/leads", "leads"], ["/api/deals", "pipeline"], ["/api/todos", "todos"],
    ["/api/plan-", "plan"], ["/api/whatsapp", "whatsapp"], ["/api/reminders", "reminders"], ["/api/memos", "memos"],
    ["/api/development-email", "development-email"], ["/api/trade-documents", "documents"], ["/api/prospect", "lead-finder"],
    ["/api/lead-finder", "lead-finder"], ["/api/agent/sales-", "sales-distillation"], ["/api/reports", "reports"]
  ];
  return rules.find(([prefix]) => path.startsWith(prefix))?.[1] || "";
}

function completionFor(method: string, path: string): AgentCompletionEvidence {
  if (method === "DELETE") return { type: "deleted_object", responsePaths: ["id", "deleted", "ok", "lead.id", "memo.id", "todo.id", "task.id", "template.id", "message.id", "question.id", "exam.id", "schedule.id", "rule.id", "memory.id"], description: "HTTP 成功且响应确认删除对象或状态" };
  const createPaths: Record<string, string[]> = {
    "/api/customers": ["customer.id"], "/api/leads": ["lead.id"], "/api/deals": ["deal.id"], "/api/todos": ["todo.id"],
    "/api/plan-tasks": ["task.id"], "/api/plan-templates": ["template.id"], "/api/memos": ["memo.id"], "/api/problems": ["problem.id"], "/api/competitors": ["competitor.id"],
    "/api/case-studies": ["caseStudy.id"], "/api/knowledge/assets": ["asset.id"], "/api/daily-reports": ["report.id"],
    "/api/daily-reports/{id}/comments": ["comment.id"], "/api/internal-messages": ["message.id"],
    "/api/commission/products": ["product.id"], "/api/commission/products/{id}/rules": ["rule.id"], "/api/commission/sales-records": ["record.id"],
    "/api/exam-questions": ["question.id"], "/api/exams": ["exam.id"], "/api/reminders": ["reminder.id"], "/api/trade-documents": ["document.id"],
    "/api/agent/sales-training": ["run.id"], "/api/agent/sales-distillation": ["distillation.id"],
    "/api/agent/memories": ["memory.id"], "/api/agent/knowledge/documents": ["document.id"], "/api/agent/triggers": ["rule.id"],
    "/api/prospect-strategies/{id}/schedules": ["schedule.id"]
  };
  const responsePaths = createPaths[path];
  return responsePaths
    ? { type: "created_object_id", responsePaths, description: "响应必须包含服务端生成的对象 ID" }
    : { type: "response", description: "HTTP 成功且返回当前操作的业务结果" };
}

function authorizationFor(method: string, path: string, risk: AgentOperationRisk): AgentAuthorizationPolicy {
  if (risk === "read") return "read_only";
  if (risk === "external") return "frozen_payload_confirmation";
  if (method === "DELETE" || /(bulk|batch|\/permanent$|\/release$|\/lost$)/u.test(path)) return "explicit_confirmation";
  return "direct_user_intent";
}

export function agentApiOperationContract(methodInput: string, rawPath: string, openApiSchema?: unknown, riskInput?: AgentOperationRisk): AgentOperationContract {
  const method = methodInput.toUpperCase() as AgentOperationContract["method"];
  const path = normalizeTemplate(rawPath);
  const risk = riskInput || (method === "GET" ? "read" : "write");
  const registered = registry[`${method} ${path}`];
  const openApiStrong = isStrongSchema(openApiSchema);
  const requestSchema = method === "GET"
    ? null
    : registered?.schema || (openApiStrong ? openApiSchema : null);
  const operation = `${method === "GET" ? "查询" : method === "DELETE" ? "删除" : method === "POST" ? "执行/创建" : "更新"}${entityForPath(path)}`;
  return {
    version: "1.0",
    method,
    path,
    operation,
    entity: entityForPath(path),
    intentExamples: [],
    requestSchema,
    risk,
    authorizationPolicy: authorizationFor(method, path, risk),
    completionEvidence: completionFor(method, path),
    refreshView: method === "GET" ? "" : refreshViewForPath(path),
    guidance: registered?.guidance || (method === "GET" ? "只读取当前账号有权访问的数据。" : openApiStrong ? "严格按当前接口 Schema 提交；业务权限由服务端再次校验。" : "接口尚未建立可执行参数契约。"),
    schemaSource: registered ? "registry" : openApiStrong ? "openapi" : "none",
    executable: method === "GET" || Boolean(requestSchema)
  };
}

export function agentApiBusinessContract(method: string, path: string): AgentApiBusinessContract | null {
  return registry[`${method.toUpperCase()} ${normalizeTemplate(path)}`] || null;
}

export function assertAgentOperationInput(contract: AgentOperationContract, body: unknown) {
  if (!contract.executable) throw new Error("该接口尚未建立严格 Agent 操作契约，已阻止盲目执行");
  if (contract.method === "GET") return;
  validateJsonSchema(contract.requestSchema!, body === undefined ? {} : body, "body");
}

function validateJsonSchema(schema: JsonSchema, value: unknown, path: string) {
  if (!Object.keys(schema).length) return;
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
    const record = value as Record<string, unknown>;
    const properties = (schema.properties || {}) as Record<string, JsonSchema>;
    for (const required of (schema.required || []) as string[]) {
      if (record[required] === undefined || record[required] === null || record[required] === "") throw new Error(`${path}.${required} 为必填字段`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(record).find((key) => !Object.prototype.hasOwnProperty.call(properties, key));
      if (unknown) throw new Error(`${path}.${unknown} 不在接口契约中`);
    }
    for (const [key, item] of Object.entries(record)) if (properties[key]) validateJsonSchema(properties[key], item, `${path}.${key}`);
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} 至少需要 ${schema.minItems} 项`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} 最多允许 ${schema.maxItems} 项`);
    value.forEach((item, index) => validateJsonSchema(schema.items as JsonSchema, item, `${path}[${index}]`));
    return;
  }
  if (type === "string" && typeof value !== "string") throw new Error(`${path} 必须是字符串`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} 必须是数字`);
  if (type === "integer" && (!Number.isInteger(value))) throw new Error(`${path} 必须是整数`);
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} 不在允许值范围内`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`${path} 长度不足`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${path} 长度超限`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) throw new Error(`${path} 格式不符合接口契约`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${path} 小于允许值`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${path} 大于允许值`);
  }
}

export function assertAgentCompletionEvidence(contract: AgentOperationContract, payload: unknown) {
  if (contract.completionEvidence.type === "response") return;
  const paths = contract.completionEvidence.responsePaths || [];
  if (paths.some((path) => pathValue(payload, path) !== undefined && pathValue(payload, path) !== "" && pathValue(payload, path) !== false)) return;
  throw new Error(`接口返回成功，但缺少完成证据：${contract.completionEvidence.description}`);
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}
