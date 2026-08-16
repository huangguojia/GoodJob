import { z } from "zod";

export const agentGoalActionSchema = z.enum([
  "navigate",
  "read",
  "analyze",
  "create",
  "update",
  "record",
  "search",
  "draft",
  "export",
  "send",
  "manage",
  "unknown"
]);

export const agentGoalDomainSchema = z.enum([
  "customers",
  "leads",
  "deals",
  "documents",
  "todos",
  "memos",
  "prospecting",
  "outreach",
  "communication",
  "research",
  "maintenance",
  "knowledge",
  "navigation",
  "general"
]);

const objectiveSchema = z.object({
  id: z.string().min(1).max(80),
  action: agentGoalActionSchema,
  domain: agentGoalDomainSchema,
  description: z.string().min(1).max(300),
  completionCriteria: z.array(z.string().min(1).max(300)).max(8)
}).strict();

const pageContextSchema = z.object({
  activeView: z.string().max(80),
  selectedCustomerId: z.string().max(120),
  selectedDealId: z.string().max(120),
  selectedLeadId: z.string().max(120),
  selectedCustomerIds: z.array(z.string().max(120)).max(20)
}).strict();

export const agentGoalSpecSchema = z.object({
  protocol: z.literal("goodjob-goal/v1"),
  rawGoal: z.string().min(1).max(4_000),
  primaryAction: agentGoalActionSchema,
  primaryDomain: agentGoalDomainSchema,
  subject: z.string().max(300),
  objectives: z.array(objectiveSchema).min(1).max(8),
  constraints: z.array(z.string().min(1).max(300)).max(20),
  completionCriteria: z.array(z.string().min(1).max(300)).max(20),
  authorization: z.object({
    readOnly: z.boolean(),
    directExecution: z.boolean(),
    delegatedFieldSynthesis: z.boolean(),
    externalConfirmationRequired: z.boolean(),
    destructiveConfirmationRequired: z.boolean()
  }).strict(),
  pageContext: pageContextSchema,
  compiledBy: z.enum(["rules", "model+rules"])
}).strict();

export type AgentGoalSpec = z.infer<typeof agentGoalSpecSchema>;
export type AgentGoalAction = z.infer<typeof agentGoalActionSchema>;
export type AgentGoalDomain = z.infer<typeof agentGoalDomainSchema>;

export const agentGoalModelPatchSchema = z.object({
  primaryAction: agentGoalActionSchema.optional(),
  primaryDomain: agentGoalDomainSchema.optional(),
  subject: z.string().max(300).optional(),
  objectives: z.array(z.object({
    action: agentGoalActionSchema,
    domain: agentGoalDomainSchema,
    description: z.string().min(1).max(300),
    completionCriteria: z.array(z.string().min(1).max(300)).max(8).default([])
  }).strict()).max(8).optional(),
  constraints: z.array(z.string().min(1).max(300)).max(12).optional(),
  completionCriteria: z.array(z.string().min(1).max(300)).max(12).optional()
}).strict();

export type AgentGoalModelPatch = z.infer<typeof agentGoalModelPatchSchema>;

export interface AgentGoalContext {
  activeView?: string;
  selectedCustomerId?: string;
  selectedDealId?: string;
  selectedLeadId?: string;
  selectedCustomerIds?: string[];
}

function unique(values: string[], limit = 20) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function hasReadOnlyIntent(goal: string) {
  return /(只读|仅查看|只查看|只检查|只分析|不要修改|不修改|不要创建|不创建|不要新增|不新增|不要写入|不写入|不要发送|不发送)/u.test(goal);
}

function hasDelegatedFields(goal: string) {
  return /((?:你(?:自己|来)?|自己)编|编(?:一套|一些|点)?数据|模拟(?:一套|一些|点)?(?:客户|线索)?数据|随便(?:填|编|写)|自行(?:填写|补充|补齐|完善|生成)|自动(?:填写|补充|补齐|完善|生成)|(?:你|自己)看着(?:填|编|来|处理)|看着来|其(?:他|它|余).{0,8}(?:你(?:自己)?编|补齐|补充|填写)|自拟|你来定)/u.test(goal);
}

function hasExecutionIntent(goal: string) {
  return /(?:新增|新建|创建|生成|制作|录入|添加|加|建|记录|记一条|写入|更新|修改|设置|标记|完成|提交|保存|导入|导出|下载|同步|领取|转为|关联|安排|启用|停用|运行|执行|重试|取消|发送|发给)/u.test(goal)
    || /做(?:一个|一份|个|份)?\s*(?:PI|CI|形式发票|商业发票)/iu.test(goal)
    || /\b(?:POST|PUT|PATCH|DELETE)\s+\/api\//iu.test(goal);
}

export function requiresDocumentFile(goalInput: string) {
  const goal = goalInput.normalize("NFKC");
  const documentIntent = /(?:PI|CI|形式发票|商业发票)/iu.test(goal)
    && /(?:生成|创建|新建|制作|做|准备|写)/u.test(goal);
  const draftOnly = /(?:草稿|仅创建|只创建|只保存|不要导出|不导出|无需导出|暂不导出)/u.test(goal);
  return documentIntent && !draftOnly;
}

function inferDomain(goal: string): AgentGoalDomain {
  if (/(Communication|WhatsApp|聊天|会话|未读消息|聊天渠道)/iu.test(goal)) return "communication";
  if (/(开发信|外贸邮件|冷邮件|邮件草稿|首次联系邮件|跟进邮件|这封邮件|发送.{0,6}邮件|发一封.{0,6}邮件)/u.test(goal)) return "outreach";
  if (/(背调|尽调|企业调查|客户调查|公司背景|企业背景|调查这家企业|研究这家.{0,6}(?:买家|客户)|采购能力)/u.test(goal)) return "research";
  if (/(客户守护|自动维护|定期维护|健康度巡检|定期检查.{0,8}客户)/u.test(goal)) return "maintenance";
  if (/(搜客|获客|超级搜索|采购商|进口商|经销商|批发商|买家|潜在企业|目标市场|市场客户|海外目标客户|采购线索|公开来源.{0,8}找|挖掘.{0,8}客户|寻找.{0,8}企业)/u.test(goal)) return "prospecting";
  if (/(PI|CI|单据|形式发票|商业发票|装箱单|报关)/iu.test(goal)) return "documents";
  if (/(商机|管道|成交机会|报价机会|这条机会|成交进度)/u.test(goal)) return "deals";
  if (/(线索)/u.test(goal)) return "leads";
  if (/(待办|任务清单|跟进任务|联系客户.{0,4}任务|报价.{0,4}任务|提醒.{0,8}任务)/u.test(goal)) return "todos";
  if (/(备忘|备忘录)/u.test(goal)) return "memos";
  if (/(知识库|系统知识|产品知识|公司知识|销售\s*SOP|团队打法|产品认证资料|产品资料库)/iu.test(goal)) return "knowledge";
  if (/(客户|客记)/u.test(goal)) return "customers";
  if (/(打开|进入|跳转|切换|前往|带我去|导航)/u.test(goal)) return "navigation";
  return "general";
}

function inferAction(goal: string, domain: AgentGoalDomain): AgentGoalAction {
  if (domain === "research") return "analyze";
  if (domain === "maintenance") return "manage";
  if (domain === "communication" && /(查看|看看|读取|未读|哪些|有哪些)/u.test(goal)) return "read";
  if (domain === "communication" && /(联系|发送|发一条|发消息|问客户|跟进)/u.test(goal)) return "send";
  if (domain === "documents" && /(生成|创建|新建|制作|做|准备|保存).{0,16}(?:PI|CI|单据|发票|装箱单|报关|报价单|草稿)/iu.test(goal)) return "create";
  if (/(查看|看看|检查|读取|列出|哪些|有哪些|查询|查一下)/u.test(goal)) return /分析/u.test(goal) ? "analyze" : "read";
  if (domain === "documents" && /(下载|导出|生成PDF|打印)/iu.test(goal)) return "export";
  if (domain !== "prospecting" && /(找出|查找)/u.test(goal)) return "read";
  if (domain === "prospecting") return "search";
  if (domain === "todos" && /(新增|新建|创建|添加|安排|提醒)/u.test(goal)) return "create";
  if (domain === "memos" && /(新增|新建|创建|添加|记录|记一条|记到|保存)/u.test(goal)) return "create";
  if (/(?:创建|建立|启用|生成).{0,10}(?:触达序列|跟进序列|自动跟进)/u.test(goal)) return "create";
  if (/(发送|发给|发一封|发消息|触达)/u.test(goal)) return "send";
  if (/(草稿|起草|写一封|拟一封|写.{0,6}开发信|准备.{0,6}开发信)/u.test(goal)) return "draft";
  if (/(搜客|获客|搜索|查找|寻找|找(?:出|到)?|买家|采购商|进口商|经销商)/u.test(goal)) return "search";
  if (/(新增|新建|创建|生成|录入|添加|加(?:一个|个|一家)?|建(?:一个|个|一家)?|录(?:一个|个|一家)?|做个)/u.test(goal)) return "create";
  if (/(记录|记一条|写入跟进|跟进记录)/u.test(goal)) return "record";
  if (/(更新|修改|改成|改为|设置|标记|调整|推进|转成|转为)/u.test(goal)) return "update";
  if (/(分析|评估|判断|诊断|比较)/u.test(goal)) return "analyze";
  if (/(打开|进入|跳转|切换|前往|带我去|导航)/u.test(goal) || domain === "navigation") return "navigate";
  if (/(查看|看看|检查|读取|列出|多少|哪些)/u.test(goal)) return "read";
  if (/(启用|停用|暂停|恢复|取消|管理|维护)/u.test(goal)) return "manage";
  if (domain === "customers" && hasDelegatedFields(goal)) return "create";
  return "unknown";
}

function criterion(action: AgentGoalAction, domain: AgentGoalDomain) {
  if (action === "navigate") return "目标页面已在前台打开并返回真实 view";
  if (action === "send") return "外部渠道返回发送回执，且 CRM 已记录触达结果";
  if (action === "search" && domain === "prospecting") return "搜客任务进入终态，并返回来源、清洗和候选统计";
  if (action === "create") {
    const labels: Partial<Record<AgentGoalDomain, string>> = {
      customers: "客户",
      leads: "线索",
      deals: "商机",
      documents: "单据",
      todos: "待办",
      memos: "备忘录"
    };
    return `${labels[domain] || "业务对象"}已由服务端创建并返回对象 ID`;
  }
  if (action === "record") return "记录已写入并返回记录 ID";
  if (action === "export" && domain === "documents") return "目标单据已导出，服务端返回文件名和导出任务 ID";
  if (action === "update") return "目标对象已更新并可回读新状态";
  if (action === "read" || action === "analyze") return "已读取真实业务数据并形成可追溯结果";
  return "用户目标已取得可验证的业务结果";
}

function deterministicObjectives(goal: string, primaryAction: AgentGoalAction, primaryDomain: AgentGoalDomain) {
  const definitions: Array<{ pattern: RegExp; action: AgentGoalAction; domain: AgentGoalDomain; description: string }> = [
    { pattern: /(?:新增|新建|创建|生成|添加|加|建)(?:(?!待办|任务|商机|线索|备忘|单据|PI|CI).){0,12}客户/iu, action: "create", domain: "customers", description: "创建客户" },
    { pattern: /(?:新增|新建|创建|生成|添加|加|建).{0,12}线索/u, action: "create", domain: "leads", description: "创建线索" },
    { pattern: /(?:新增|新建|创建|生成|添加|加|建|做).{0,12}商机/u, action: "create", domain: "deals", description: "创建商机" },
    { pattern: /(?:生成|创建|制作|保存|做|写).{0,12}(?:PI|CI|单据|形式发票|商业发票)/iu, action: "create", domain: "documents", description: "创建贸易单据" },
    { pattern: /(?:下载|导出|生成PDF|打印).{0,16}(?:PI|CI|单据|形式发票|商业发票)?|(?:PI|CI|单据|形式发票|商业发票).{0,16}(?:下载|导出|生成PDF|打印)/iu, action: "export", domain: "documents", description: "导出并准备下载贸易单据" },
    { pattern: /(?:记录|记一条|写入).{0,12}(?:跟进|活动)/u, action: "record", domain: "customers", description: "记录客户跟进" },
    { pattern: /(?:新增|新建|创建|添加|安排).{0,12}(?:待办|任务)/u, action: "create", domain: "todos", description: "创建待办" },
    { pattern: /(?:新增|新建|创建|添加|记录).{0,12}(?:备忘|备忘录)/u, action: "create", domain: "memos", description: "创建备忘录" },
    { pattern: /(?:发送|发给|发一封|发消息).{0,20}(?:开发信|邮件|Communication|WhatsApp|客户)/iu, action: "send", domain: /Communication|WhatsApp/iu.test(goal) ? "communication" : "outreach", description: "向真实联系人发送消息" }
  ];
  const matched = definitions.filter((item) => item.pattern.test(goal)
    && (item.action !== "export" || ["create", "export"].includes(primaryAction)));
  if (requiresDocumentFile(goal) && !matched.some((item) => item.action === "export" && item.domain === "documents")) {
    matched.push({ pattern: /$^/u, action: "export", domain: "documents", description: "生成并提供可下载的单据 PDF" });
  }
  const base = matched.length ? matched : [{ action: primaryAction, domain: primaryDomain, description: goal.slice(0, 300) }];
  return base.slice(0, 8).map((item, index) => ({
    id: `objective-${index + 1}`,
    action: item.action,
    domain: item.domain,
    description: item.description,
    completionCriteria: [criterion(item.action, item.domain)]
  }));
}

export function compileAgentGoalSpec(goalInput: string, context: AgentGoalContext = {}, modelPatchInput?: unknown): AgentGoalSpec {
  const goal = goalInput.normalize("NFKC").trim().slice(0, 4_000);
  const readOnly = hasReadOnlyIntent(goal);
  const delegatedFieldSynthesis = hasDelegatedFields(goal);
  const deterministicDomain = inferDomain(goal);
  const deterministicAction = inferAction(goal, deterministicDomain);
  const safeDeterministicAction = readOnly && !["read", "analyze", "navigate"].includes(deterministicAction)
    ? "read"
    : deterministicAction;
  const parsedModel = agentGoalModelPatchSchema.safeParse(modelPatchInput);
  const modelPatch = parsedModel.success ? parsedModel.data : undefined;
  const primaryDomain = modelPatch?.primaryDomain || deterministicDomain;
  const modelAction = modelPatch?.primaryAction;
  const primaryAction = readOnly && modelAction && !["read", "analyze", "navigate"].includes(modelAction)
    ? safeDeterministicAction
    : modelAction || safeDeterministicAction;
  const modelObjectives = modelPatch?.objectives
    ?.filter((item) => !readOnly || ["read", "analyze", "navigate"].includes(item.action))
    .map((item, index) => ({
    id: `objective-${index + 1}`,
    ...item,
    completionCriteria: item.completionCriteria.length ? item.completionCriteria : [criterion(item.action, item.domain)]
  }));
  const deterministic = deterministicObjectives(goal, primaryAction, primaryDomain);
  const candidateObjectives = modelObjectives?.length
    ? [
        ...modelObjectives,
        ...deterministic.filter((required) => !modelObjectives.some((item) => item.action === required.action && item.domain === required.domain))
      ].slice(0, 8).map((item, index) => ({ ...item, id: `objective-${index + 1}` }))
    : deterministic;
  const readOnlyObjectives = readOnly
    ? candidateObjectives.filter((item) => ["read", "analyze", "navigate"].includes(item.action))
    : candidateObjectives;
  const objectives = readOnlyObjectives.length
    ? readOnlyObjectives
    : [{
        id: "objective-1",
        action: primaryAction,
        domain: primaryDomain,
        description: goal.slice(0, 300),
        completionCriteria: [criterion(primaryAction, primaryDomain)]
      }];
  const external = objectives.some((item) => item.action === "send")
    || primaryDomain === "communication"
    || (primaryDomain === "prospecting" && primaryAction === "search");
  const destructive = /(删除|永久删除|批量|释放.{0,6}公池|丢单|转移负责人)/u.test(goal);
  const constraints = unique([
    ...(modelPatch?.constraints || []),
    ...(readOnly ? ["只读执行，不创建、不修改、不发送"] : []),
    ...(delegatedFieldSynthesis ? ["允许补齐非敏感站内字段，禁止伪造联系方式和业务事实"] : []),
    ...(external ? ["外部动作必须冻结最终载荷并确认一次"] : []),
    ...(destructive ? ["破坏性或批量动作必须明确确认"] : [])
  ]);
  const completionCriteria = unique([
    ...objectives.flatMap((item) => item.completionCriteria),
    ...(modelPatch?.completionCriteria || [])
  ]);
  return agentGoalSpecSchema.parse({
    protocol: "goodjob-goal/v1",
    rawGoal: goal,
    primaryAction,
    primaryDomain,
    subject: (modelPatch?.subject || goal).slice(0, 300),
    objectives,
    constraints,
    completionCriteria,
    authorization: {
      readOnly,
      directExecution: !readOnly && (hasExecutionIntent(goal) || delegatedFieldSynthesis),
      delegatedFieldSynthesis,
      externalConfirmationRequired: external,
      destructiveConfirmationRequired: destructive
    },
    pageContext: {
      activeView: String(context.activeView || "").slice(0, 80),
      selectedCustomerId: String(context.selectedCustomerId || "").slice(0, 120),
      selectedDealId: String(context.selectedDealId || "").slice(0, 120),
      selectedLeadId: String(context.selectedLeadId || "").slice(0, 120),
      selectedCustomerIds: Array.isArray(context.selectedCustomerIds)
        ? context.selectedCustomerIds.filter((item): item is string => typeof item === "string").slice(0, 20)
        : []
    },
    compiledBy: modelPatch ? "model+rules" : "rules"
  });
}

export function goalSpecSearchText(spec: AgentGoalSpec) {
  return unique([
    spec.rawGoal,
    spec.subject,
    spec.primaryDomain,
    spec.primaryAction,
    ...spec.objectives.flatMap((item) => [item.domain, item.action, item.description]),
    ...spec.completionCriteria
  ]).join(" ");
}
