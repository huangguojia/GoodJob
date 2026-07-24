import { compileAgentGoalSpec, type AgentGoalAction, type AgentGoalDomain } from "./agent-goal.js";

export interface AgentIntentCorpusCase {
  id: string;
  phrase: string;
  domain: AgentGoalDomain;
  action?: AgentGoalAction;
  readOnly?: boolean;
  delegatedFields?: boolean;
}

function cases(
  prefix: string,
  domain: AgentGoalDomain,
  action: AgentGoalAction | undefined,
  phrases: string[],
  flags: Pick<AgentIntentCorpusCase, "readOnly" | "delegatedFields"> = {}
) {
  return phrases.map((phrase, index): AgentIntentCorpusCase => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    phrase,
    domain,
    action,
    ...flags
  }));
}

export const GJAB_INTENT_CORPUS: AgentIntentCorpusCase[] = [
  ...cases("customer-create", "customers", "create", [
    "新增一个客户，名字叫 Northstar Ltd",
    "帮我加家客户叫星海贸易",
    "给系统录入一个新客户",
    "创建客户档案，企业名为 Good Lamp GmbH",
    "建一个客户，其他资料待维护",
    "生成个客户，名字叫 Demo Buyer",
    "添加一家海外客户",
    "录一个客记，公司叫远洋照明",
    "新建客户并保存到客户列表",
    "帮我做个新客户资料"
  ]),
  ...cases("customer-create-delegated", "customers", "create", [
    "生成一个客户，其他你编",
    "客户名字你来定，数据你看着填",
    "创建一条模拟客户数据",
    "随便编点安全数据加个客户",
    "新建客户，非敏感字段自动补齐"
  ], { delegatedFields: true }),
  ...cases("customer-read", "customers", "read", [
    "看看我的客户列表",
    "查一下当前客户资料",
    "读取这个客户的全景信息",
    "有哪些客户需要跟进",
    "列出德国客户",
    "检查客户健康度",
    "给我看看客户联系方式",
    "查询客户最近的跟进记录"
  ]),
  ...cases("customer-update", "customers", "update", [
    "把当前客户分级改成 A",
    "客户健康度设置为 80",
    "修改这个客户的国家",
    "更新客户联系人资料",
    "把客户阶段改为已联系",
    "标记当前客户为重点客户",
    "调整客户等级为 B",
    "更新客户下一次提醒时间"
  ]),
  ...cases("lead-create", "leads", "create", [
    "新建一条线索",
    "添加线索 Bright Future LLC",
    "录入一个潜在线索",
    "生成一条模拟线索",
    "把这家公司加到线索列表"
  ]),
  ...cases("lead-read", "leads", "read", [
    "查看当前线索",
    "列出尚未跟进的线索",
    "查询德国的线索",
    "看看最近新增线索",
    "检查线索联系方式是否完整"
  ]),
  ...cases("lead-update", "leads", "update", [
    "把线索状态改为跟进中",
    "更新当前线索意向等级",
    "修改线索联系人",
    "标记这条线索无效",
    "把线索转成客户"
  ]),
  ...cases("deal-create", "deals", "create", [
    "给当前客户创建商机",
    "新建一条成交机会",
    "添加一个 LED 灯具商机",
    "生成商机，产品先填待确认",
    "给这个客户建一个报价机会"
  ]),
  ...cases("deal-read", "deals", "read", [
    "查看商机管道",
    "查看目前成交机会",
    "哪些商机快到期了",
    "看看谈判阶段的商机",
    "读取当前客户相关商机"
  ]),
  ...cases("deal-update", "deals", "update", [
    "把商机推进到已报价",
    "更新商机预计成交时间",
    "修改当前商机金额",
    "商机阶段改成谈判",
    "把这条机会标记为成交"
  ]),
  ...cases("document-create", "documents", "create", [
    "根据当前商机生成 PI",
    "帮我给客户 Nordic Tools AB 的活跃商机做一个PI",
    "创建一份形式发票",
    "做一张商业发票 CI",
    "准备客户装箱单",
    "生成报价单并保存到单据平台",
    "给这个订单做报关资料",
    "新建贸易单据",
    "从商机生成 PI 草稿"
  ]),
  ...cases("document-read", "documents", "read", [
    "查看单据平台",
    "找出待审批的 PI",
    "查询最近的商业发票",
    "看看已导出的单据"
  ]),
  ...cases("prospecting", "prospecting", "search", [
    "在德国搜索 LED 进口商",
    "帮我找一批美国采购商",
    "推进法国市场，找当地买家",
    "搜集日本照明经销商",
    "为这个产品寻找潜在企业",
    "跑一次自动获客",
    "用超级搜索找 20 家客户",
    "查找英国批发商",
    "挖掘中东地区的工程客户",
    "寻找东南亚 OEM 买家",
    "帮我拓展海外目标客户",
    "从合法公开来源找采购线索"
  ]),
  ...cases("outreach-draft", "outreach", "draft", [
    "给当前客户写一封开发信",
    "生成开发邮件草稿",
    "帮我起草首次联系邮件",
    "写一封专业的英文冷邮件",
    "为这条线索准备开发信",
    "拟一封简洁的外贸邮件"
  ]),
  ...cases("outreach-send", "outreach", "send", [
    "给当前客户发送开发信",
    "把这封邮件发给客户",
    "真实发送首次联系邮件",
    "给线索发一封跟进邮件",
    "发送已经写好的开发信"
  ]),
  ...cases("communication", "communication", "send", [
    "通过 WhatsApp 联系当前客户",
    "给客户发一条 Communication 消息",
    "用 Communication 发送跟进内容",
    "在 WhatsApp 上问客户是否收到报价",
    "通过聊天渠道联系这个买家"
  ]),
  ...cases("communication-read", "communication", "read", [
    "查看 Communication 未读消息",
    "看看 WhatsApp 收件箱",
    "读取客户最新聊天回复",
    "有哪些未读会话"
  ]),
  ...cases("research", "research", "analyze", [
    "背调当前客户",
    "调查这家企业的真实情况",
    "对线索做 AI 背调",
    "检查客户公司背景",
    "研究这家买家的采购能力",
    "帮我尽调这个潜在客户"
  ]),
  ...cases("maintenance", "maintenance", "manage", [
    "启用客户自动维护",
    "建立客户守护策略",
    "定期检查沉默客户",
    "暂停当前客户守护",
    "恢复自动维护任务",
    "管理客户健康度巡检"
  ]),
  ...cases("todo", "todos", "create", [
    "新建一个待办",
    "安排下周联系客户的任务",
    "添加高优先级跟进待办",
    "创建提醒我报价的任务"
  ]),
  ...cases("memo", "memos", "create", [
    "新增客户备忘录",
    "记到备忘：客户采购偏好",
    "创建备忘：季度采购计划",
    "把这段内容保存成备忘"
  ]),
  ...cases("training", "sales-training", undefined, [
    "查看业务员蒸馏",
    "开始销售打法训练",
    "应用团队蒸馏打法",
    "检查业务员训练进度",
    "暂停当前训练任务"
  ]),
  ...cases("knowledge", "knowledge", undefined, [
    "查看产品知识库",
    "查询公司的销售 SOP",
    "沉淀一条团队打法",
    "检查系统知识",
    "找一下产品认证资料"
  ]),
  ...cases("conversation", "general", "unknown", [
    "你好",
    "您好",
    "你是谁",
    "你能做什么",
    "谢谢"
  ]),
  ...cases("readonly", "customers", undefined, [
    "只读检查客户，不要修改",
    "只分析客户健康度，不要写入数据",
    "看看客户资料，不创建任何内容",
    "仅查看客户，禁止发送消息",
    "只检查客户跟进，不做修改"
  ], { readOnly: true })
];

export interface AgentIntentCorpusResult {
  total: number;
  passed: number;
  failures: Array<{ id: string; phrase: string; expected: string; actual: string }>;
}

export function runAgentIntentCorpusBenchmark(): AgentIntentCorpusResult {
  const failures: AgentIntentCorpusResult["failures"] = [];
  for (const scenario of GJAB_INTENT_CORPUS) {
    const spec = compileAgentGoalSpec(scenario.phrase);
    const checks = [
      spec.primaryDomain === scenario.domain,
      !scenario.action || spec.primaryAction === scenario.action,
      scenario.readOnly === undefined || spec.authorization.readOnly === scenario.readOnly,
      scenario.delegatedFields === undefined || spec.authorization.delegatedFieldSynthesis === scenario.delegatedFields
    ];
    if (checks.every(Boolean)) continue;
    failures.push({
      id: scenario.id,
      phrase: scenario.phrase,
      expected: `${scenario.action || "*"}/${scenario.domain}/只读=${scenario.readOnly ?? "*"}/代填=${scenario.delegatedFields ?? "*"}`,
      actual: `${spec.primaryAction}/${spec.primaryDomain}/只读=${spec.authorization.readOnly}/代填=${spec.authorization.delegatedFieldSynthesis}`
    });
  }
  return { total: GJAB_INTENT_CORPUS.length, passed: GJAB_INTENT_CORPUS.length - failures.length, failures };
}
