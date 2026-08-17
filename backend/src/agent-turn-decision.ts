import { z } from "zod";

export const agentSpeechActSchema = z.enum([
  "explain",
  "query_data",
  "navigate",
  "execute",
  "continue",
  "answer_slot",
  "correct",
  "cancel",
  "chat"
]);

export const agentMissionRelationSchema = z.enum([
  "independent",
  "continue",
  "answer",
  "correct",
  "replace",
  "cancel"
]);

export const agentTurnDecisionSchema = z.object({
  protocol: z.literal("goodjob-turn/v1"),
  speechAct: agentSpeechActSchema,
  topic: z.string().max(80),
  operation: z.string().max(80),
  target: z.string().max(160),
  relationToMission: agentMissionRelationSchema,
  missionId: z.string().max(120),
  writeAuthorized: z.boolean(),
  delegatedFieldSynthesis: z.boolean(),
  intentConfidence: z.number().min(0).max(1),
  missionRelationConfidence: z.number().min(0).max(1),
  entityConfidence: z.number().min(0).max(1),
  evidenceTurnIds: z.array(z.string().max(120)).max(12),
  reason: z.string().max(500),
  decidedBy: z.enum(["rules", "model+runtime"])
}).strict();

export const agentTurnDecisionModelSchema = agentTurnDecisionSchema.omit({
  protocol: true,
  decidedBy: true
}).partial({
  topic: true,
  operation: true,
  target: true,
  missionId: true,
  delegatedFieldSynthesis: true,
  evidenceTurnIds: true,
  reason: true
}).strict();

export type AgentTurnDecision = z.infer<typeof agentTurnDecisionSchema>;
export type AgentTurnDecisionModel = z.infer<typeof agentTurnDecisionModelSchema>;

export interface AgentMissionContextSnapshot {
  id: string;
  goal: string;
  status: string;
  stopReason: string;
  topic: string;
  updatedAt: string;
}

const WRITE_OPERATION = /(?:新增|新建|创建|生成|制作|录入|添加|加上|加个|加一个|记录|记一条|写入|更新|修改|改成|改为|设置|标记|提交|保存|导入|导出|下载|同步|领取|转为|关联|安排|启用|启动|停用|运行|执行|重试|发送|发给)/u;
const EXPLICIT_ACTION_REQUEST = /(?:^|[，,。；;\s])(?:请|请你|帮我|替我|给我|麻烦|现在|直接|立即|马上|我要|我需要|我想要).{0,28}(?:新增|新建|创建|生成|制作|录入|添加|加个|加一个|记录|写入|更新|修改|设置|标记|提交|保存|导入|导出|下载|同步|领取|转为|关联|安排|启用|启动|停用|运行|执行|重试|发送|发给)/u;
const BUSINESS_ACTION_REQUEST = /(?:^|[，,。；;\s])(?:请|请你|帮我|替我|给我|麻烦|现在|直接|立即|马上|我要|我需要|我想要).{0,24}(?:找|搜索|搜|分析|背调|调查|准备|起草|草拟|做一份|推进|管理|维护|跟进|联系)/u;
const DOCUMENT_ACTION_REQUEST = /(?:帮我|替我|给我|请|我要|我需要)?[^。！？!?\n]{0,80}做(?:一个|一份|个|份)?\s*(?:PI|CI|形式发票|商业发票|单据)/iu;
const DIRECT_ACTION = /^\s*(?:新增|新建|创建|生成|制作|录入|添加|记录|写入|更新|修改|设置|标记|提交|保存|导入|导出|下载|同步|领取|转为|关联|安排|启用|启动|停用|运行|执行|重试|发送|发给)/u;
const DIRECT_BUSINESS_ACTION = /^\s*(?:自动|持续|整理|安排|推进|跟进|维护|准备|起草|草拟|搜索|搜|找|调查|背调).{0,40}(?:客户|线索|商机|待办|跟进|单据|邮件|开发信|买家|采购商|资料|任务|Communication|WhatsApp)/iu;
const EXPLAIN_QUESTION = /(?:如何|怎么|怎样|该怎么|要怎么|为什么|是什么|什么意思|(?:是)?做什么的?|有什么区别|需要什么|需要哪些|有哪些步骤|如何管理|怎么管理|能介绍|说明一下|讲一下|告诉我.{0,8}(?:方法|步骤|规则|流程)|能干什么|可以做什么|有什么用|能做哪些|有哪些功能)/u;
const READ_ONLY = /(?:只读|仅查看|只查看|只检查|只分析|不要修改|不修改|不要创建|不创建|不要新增|不新增|不要写入|不写入|不要发送|不发送|只告诉我|只说|仅说明)/u;
const EXPLANATION_ONLY = /(?:只告诉我|只说|仅说明).{0,20}(?:方法|步骤|规则|流程|怎么做|如何做)/u;
const NAVIGATE = /(?:打开|进入|跳转|切换|前往|带我去|导航到|去到).{0,20}(?:页面|界面|管理|工作台|平台|客户|线索|商机|单据|搜客|设置)?/u;
const IMPLICIT_NAVIGATE = /(?:我要|我想|我需要|帮我|给我).{0,12}(?:写|做|处理|管理|维护|配置|设置).{0,12}(?:单据|PI|CI|开发信|邮件|模型|账号|客户|线索|商机|搜客)/iu;
const CONTINUE = /(?:^|[，,。；;\s])(?:继续|接着|接着做|继续执行|接着执行|按刚才|照刚才|用刚才|上一个任务|刚才那个任务)/u;
const CANCEL = /(?:取消|停止|终止|别做了|不用做了|停下来|中止)(?:刚才|上一个|当前|这个)?(?:任务|操作|执行)?/u;
const CORRECT = /(?:改成|改为|更正|纠正|不是.{0,12}是|刚才说错|我说错了|调整为)/u;
const CHAT = /^(?:你好|您好|嗨|哈喽|hello|hi|早上好|下午好|晚上好|在吗|谢谢|感谢|多谢|辛苦了|好的|好|明白了|知道了|ok|okay|你是谁|你叫什么|你叫什么名字|你的名字是什么|你的名字叫什么|what(?:'s| is) your name|你能做什么|你可以做什么|怎么用你|如何使用你|能帮我什么)[。！？!?\s]*$/iu;

function clampConfidence(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function delegatedFields(message: string) {
  return /(?:你(?:自己|来)?编|自己编|随便(?:填|编|写)|自行(?:填写|补充|补齐|完善|生成)|自动(?:填写|补充|补齐|完善|生成)|你看着(?:填|编|来|处理)|看着来|其他.{0,8}(?:你编|补齐|补充|填写)|自拟|你来定)/u.test(message);
}

function inferTopic(message: string) {
  if (/(单据|PI|CI|形式发票|商业发票|装箱单)/iu.test(message)) return "documents";
  if (/(商机|销售管道|机会管道|成交机会)/u.test(message)) return "deals";
  if (/(客户公池|公海客户|公池客户)/u.test(message)) return "customer-pool";
  if (/(客户|客记)/u.test(message)) return "customers";
  if (/(线索)/u.test(message)) return "leads";
  if (/(搜客|获客|采购商|进口商|经销商|买家)/u.test(message)) return "prospecting";
  if (/(开发信|邮件)/u.test(message)) return "outreach";
  if (/(Communication|WhatsApp|聊天|会话)/iu.test(message)) return "communication";
  if (/(待办|提醒)/u.test(message)) return "todos";
  return "general";
}

function inferOperation(message: string, speechAct: AgentTurnDecision["speechAct"]) {
  if (speechAct === "explain") return "explain";
  if (speechAct === "query_data") return "read";
  if (speechAct === "navigate") return "navigate";
  if (speechAct === "cancel") return "cancel";
  if (/(PI|CI|单据|发票)/iu.test(message) && /(制作|创建|生成|做|写)/u.test(message) && /(下载|导出)/u.test(message)) return "create_and_export";
  if (/(创建|新建|新增|录入|添加|生成|制作|建一个|建个)/u.test(message)) return "create";
  if (/(修改|更新|改成|改为|设置|标记)/u.test(message)) return "update";
  if (/(发送|发给)/u.test(message)) return "send";
  return speechAct;
}

function explicitActionRequest(message: string) {
  if (EXPLAIN_QUESTION.test(message) && !/(?:能不能|可以|可不可以|能否).{0,10}(?:帮我|替我|给我)/u.test(message)) return false;
  if (/^\s*(?:POST|PUT|PATCH|DELETE)\s+\/api\//iu.test(message)) return true;
  if (EXPLICIT_ACTION_REQUEST.test(message) || BUSINESS_ACTION_REQUEST.test(message) || DOCUMENT_ACTION_REQUEST.test(message) || DIRECT_ACTION.test(message) || DIRECT_BUSINESS_ACTION.test(message)) return true;
  if (/^\s*(?:根据|基于|用|把|将|给|帮我).{0,60}(?:新增|新建|创建|生成|制作|录入|添加|记录|记一条|记个|更新|修改|设置|标记|提交|保存|导入|导出|下载|同步|关联|安排|发送|准备|起草)/u.test(message)) return true;
  if (/^\s*(?:通过|使用).{0,40}(?:发送|创建|新增|修改|更新|执行|同步|导入)/u.test(message)) return true;
  if (/(?:并|然后|再|同时).{0,10}(?:新增|新建|创建|生成|制作|录入|添加|记录|写入|更新|修改|设置|标记|提交|保存|导出|下载|安排|发送)/u.test(message)) return true;
  return /(?:能不能|可以|可不可以|能否).{0,10}(?:帮我|替我|给我).{0,14}(?:创建|新建|新增|录入|添加|生成|修改|更新|发送|执行)/u.test(message);
}

function looksLikeSlotAnswer(message: string, snapshot: AgentMissionContextSnapshot | undefined) {
  if (!snapshot || snapshot.status !== "waiting_user") return false;
  if (message.length > 240 || EXPLAIN_QUESTION.test(message) || NAVIGATE.test(message)) return false;
  const currentTopic = inferTopic(message);
  if (currentTopic !== "general" && snapshot.topic !== "general" && currentTopic !== snapshot.topic) return false;
  return /(?:叫|名称|名字|公司|国家|地区|邮箱|电话|时间|日期|金额|产品|资料|信息|是|为|用|选|填|都由你|你来|你编)/u.test(message);
}

export function deterministicAgentTurnDecision(
  rawMessage: string,
  snapshots: AgentMissionContextSnapshot[] = []
): AgentTurnDecision {
  const message = rawMessage.normalize("NFKC").trim().slice(0, 2_000);
  const snapshot = snapshots[0];
  const actionRequest = explicitActionRequest(message);
  const readOnly = READ_ONLY.test(message);
  let speechAct: AgentTurnDecision["speechAct"];
  let relationToMission: AgentTurnDecision["relationToMission"] = "independent";
  let missionId = "";
  let reason = "按本轮自然语言和安全降级规则判断";

  if (CHAT.test(message)) {
    speechAct = "chat";
    reason = "问候、致谢或能力交流";
  } else if (snapshot && CANCEL.test(message)) {
    speechAct = "cancel";
    relationToMission = "cancel";
    missionId = snapshot.id;
    reason = "明确要求停止当前任务";
  } else if (snapshot && CONTINUE.test(message)) {
    speechAct = "continue";
    relationToMission = "continue";
    missionId = snapshot.id;
    reason = "明确引用并继续当前任务";
  } else if (snapshot && CORRECT.test(message) && !EXPLAIN_QUESTION.test(message)) {
    speechAct = "correct";
    relationToMission = "correct";
    missionId = snapshot.id;
    reason = "明确修正当前任务";
  } else if (!actionRequest && (EXPLANATION_ONLY.test(message) || EXPLAIN_QUESTION.test(message))) {
    speechAct = "explain";
    reason = EXPLANATION_ONLY.test(message) ? "明确要求只说明操作方法" : "询问方法、规则或原因";
  } else if ((NAVIGATE.test(message) && !WRITE_OPERATION.test(message)) || IMPLICIT_NAVIGATE.test(message)) {
    speechAct = "navigate";
    reason = "明确要求打开或切换页面";
  } else if (looksLikeSlotAnswer(message, snapshot)) {
    speechAct = "answer_slot";
    relationToMission = "answer";
    missionId = snapshot!.id;
    reason = "本轮内容与等待任务的缺失信息一致";
  } else if (/^\s*GET\s+\/api\//iu.test(message)) {
    speechAct = "query_data";
    reason = "本轮明确要求读取 API 数据";
  } else if (/^\s*(?:MCP|外部工具)\s+[a-z][a-z0-9._:-]{2,119}/iu.test(message)) {
    speechAct = "query_data";
    reason = "本轮明确要求调用已授权外部只读工具";
  } else if (actionRequest || (/^\s*(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//iu.test(message) && !/^\s*GET/iu.test(message))) {
    speechAct = "execute";
    reason = "本轮明确要求系统执行操作";
  } else if (/(?:查询|查一下|看看|查看|读取|检查|分析|列出|有哪些|多少|当前|最近|只读).{0,30}(?:客户|线索|商机|待办|数据|记录|情况|进度|快照|消息|会话|Communication|WhatsApp|邮件|单据|报表|MCP|外部工具|集成工具)/iu.test(message)) {
    speechAct = "query_data";
    reason = "本轮要求读取真实业务数据";
  } else {
    speechAct = "chat";
    reason = "未取得执行授权，按自然交流安全降级";
  }

  const writeAuthorized = !readOnly && ["execute", "continue", "answer_slot", "correct"].includes(speechAct);
  return {
    protocol: "goodjob-turn/v1",
    speechAct,
    topic: inferTopic(message),
    operation: inferOperation(message, speechAct),
    target: message.slice(0, 160),
    relationToMission,
    missionId,
    writeAuthorized,
    delegatedFieldSynthesis: delegatedFields(message),
    intentConfidence: ["chat", "explain", "continue", "cancel"].includes(speechAct) ? 0.94 : 0.86,
    missionRelationConfidence: relationToMission === "independent" ? 0.9 : 0.92,
    entityConfidence: inferTopic(message) === "general" ? 0.62 : 0.9,
    evidenceTurnIds: [],
    reason,
    decidedBy: "rules"
  };
}

export function finalizeAgentTurnDecision(
  rawMessage: string,
  snapshots: AgentMissionContextSnapshot[],
  modelDecision?: AgentTurnDecisionModel
): AgentTurnDecision {
  const fallback = deterministicAgentTurnDecision(rawMessage, snapshots);
  if (!modelDecision) return fallback;
  const message = rawMessage.normalize("NFKC").trim();
  const actionRequest = explicitActionRequest(message);
  const explicitConsultation = !actionRequest && (EXPLANATION_ONLY.test(message) || EXPLAIN_QUESTION.test(message));
  const explicitChat = CHAT.test(message);
  const currentTopic = inferTopic(message);
  const snapshotIds = new Set(snapshots.map((item) => item.id));
  let speechAct = modelDecision.speechAct;
  let relationToMission = modelDecision.relationToMission;
  let missionId = modelDecision.missionId || "";

  // Runtime may downgrade unsafe model decisions, but never upgrades a consultation into execution.
  if (explicitChat) {
    speechAct = "chat";
    relationToMission = "independent";
    missionId = "";
  } else if (explicitConsultation) {
    speechAct = "explain";
    relationToMission = "independent";
    missionId = "";
  } else if (!snapshots.length || (missionId && !snapshotIds.has(missionId))) {
    relationToMission = "independent";
    missionId = "";
  }
  const relatedSnapshot = snapshots.find((item) => item.id === missionId) || snapshots[0];
  const explicitMissionReference = CONTINUE.test(message) || CORRECT.test(message) || CANCEL.test(message);
  if (relatedSnapshot
    && currentTopic !== "general"
    && relatedSnapshot.topic !== "general"
    && currentTopic !== relatedSnapshot.topic
    && !explicitMissionReference
    && speechAct !== "answer_slot") {
    relationToMission = "independent";
    missionId = "";
  }
  if (relationToMission !== "independent" && !missionId) {
    missionId = snapshots[0]?.id || "";
    if (!missionId) relationToMission = "independent";
  }
  const canAuthorizeWrite = ["execute", "continue", "answer_slot", "correct"].includes(speechAct)
    && !explicitConsultation
    && !READ_ONLY.test(message);

  return agentTurnDecisionSchema.parse({
    protocol: "goodjob-turn/v1",
    speechAct,
    topic: modelDecision.topic || fallback.topic,
    operation: modelDecision.operation || fallback.operation,
    target: modelDecision.target || fallback.target,
    relationToMission,
    missionId,
    writeAuthorized: Boolean(modelDecision.writeAuthorized && canAuthorizeWrite),
    delegatedFieldSynthesis: Boolean(modelDecision.delegatedFieldSynthesis || fallback.delegatedFieldSynthesis),
    intentConfidence: clampConfidence(modelDecision.intentConfidence, fallback.intentConfidence),
    missionRelationConfidence: clampConfidence(modelDecision.missionRelationConfidence, fallback.missionRelationConfidence),
    entityConfidence: clampConfidence(modelDecision.entityConfidence, fallback.entityConfidence),
    evidenceTurnIds: modelDecision.evidenceTurnIds || [],
    reason: modelDecision.reason || fallback.reason,
    decidedBy: "model+runtime"
  });
}

export function agentTurnRequestKind(decision: AgentTurnDecision): "execute" | "query" | "conversation" {
  if (["execute", "continue", "answer_slot", "correct", "cancel", "navigate"].includes(decision.speechAct)) return "execute";
  if (decision.speechAct === "query_data") return "query";
  return "conversation";
}

export type AgentMissionRoute = "new" | "resume" | "keep_running" | "steer" | "cancel";

export function resolveAgentMissionRoute(
  decision: AgentTurnDecision,
  mission?: Pick<AgentMissionContextSnapshot, "id" | "status">
): AgentMissionRoute {
  if (!mission || decision.relationToMission === "independent" || decision.missionId !== mission.id) return "new";
  if (decision.relationToMission === "cancel") return "cancel";
  if (["continue", "answer"].includes(decision.relationToMission)) {
    return ["waiting_user", "paused", "failed", "cancelled"].includes(mission.status) ? "resume" : "keep_running";
  }
  if (["correct", "replace"].includes(decision.relationToMission)) {
    return ["waiting_user", "paused", "failed", "cancelled"].includes(mission.status) ? "resume" : "steer";
  }
  return "new";
}
