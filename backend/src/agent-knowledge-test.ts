import {
  agentKnowledgeOverview,
  compileAgentKnowledgeEnvelope,
  createAgentKnowledgeDraft,
  listAgentKnowledgeDocuments,
  reloadSystemAgentKnowledge,
  retrieveAgentKnowledge,
  setAgentKnowledgeStatus,
  updateAgentKnowledgeDraft
} from "./agent-knowledge.js";
import { memoryStore } from "./store.js";

const sales = { id: "knowledge_sales", teamId: "europe", role: "sales" as const };
const manager = { id: "knowledge_manager", teamId: "europe", role: "manager" as const };
const otherTeam = { id: "knowledge_other", teamId: "asia", role: "manager" as const };

memoryStore.agentKnowledgeDocuments.splice(0);
const system = reloadSystemAgentKnowledge();
if (system.documents.length < 8 || system.errors.length) throw new Error("system knowledge compilation failed");

const poolHits = retrieveAgentKnowledge(memoryStore, sales, "把这个客户扔进公池，检查有没有活跃商机", { activeView: "customers", trackUsage: false });
if (!poolHits.some((hit) => hit.document.id === "workflow.customer-pool.v1")) throw new Error("customer pool knowledge retrieval failed");
const navigationHits = retrieveAgentKnowledge(memoryStore, sales, "我要写 PI 和商业发票，应该去哪个页面", { activeView: "ai-agent", trackUsage: false });
if (!navigationHits.some((hit) => hit.document.id === "workflow.navigation.v1")) throw new Error("navigation knowledge retrieval failed");
const semanticProspectingHits = retrieveAgentKnowledge(memoryStore, sales, "帮我推进德国市场，找一批当地买家", { trackUsage: false });
if (semanticProspectingHits[0]?.document.id !== "workflow.prospecting.v1") throw new Error("semantic prospecting knowledge rerank failed");
if (!semanticProspectingHits[0]?.reasons.some((reason) => reason.includes("目标域"))) throw new Error("semantic prospecting rerank reason missing");

const draft = await createAgentKnowledgeDraft(memoryStore, sales, {
  kind: "workflow",
  scope: "team",
  module: "deals",
  title: "样品确认流程",
  summary: "样品发送前核对地址和费用",
  content: "样品发送前必须核对收件地址、样品费用、快递账号和预计送达日期。",
  keywords: ["样品", "地址", "费用"],
  roles: ["sales", "manager", "admin", "super_admin"],
  toolRefs: ["api.catalog"],
  successCriteria: ["地址已确认", "费用已确认"],
  failureCases: ["地址未确认就发出"]
});
if (draft.status !== "draft") throw new Error("knowledge draft status invalid");
if (retrieveAgentKnowledge(memoryStore, sales, "发送样品", { trackUsage: false }).some((hit) => hit.document.id === draft.id)) {
  throw new Error("unpublished knowledge leaked into retrieval");
}

await setAgentKnowledgeStatus(memoryStore, sales, draft.id, "submit");
let salesPublishBlocked = false;
try {
  await setAgentKnowledgeStatus(memoryStore, sales, draft.id, "publish");
} catch {
  salesPublishBlocked = true;
}
if (!salesPublishBlocked) throw new Error("sales user published team knowledge");

const published = await setAgentKnowledgeStatus(memoryStore, manager, draft.id, "publish");
if (published.status !== "published" || published.trustLevel !== "reviewed") throw new Error("knowledge publish failed");
if (!retrieveAgentKnowledge(memoryStore, sales, "样品费用和地址", { activeView: "deals", trackUsage: false }).some((hit) => hit.document.id === draft.id)) {
  throw new Error("published knowledge not retrieved");
}
if (listAgentKnowledgeDocuments(memoryStore, otherTeam).some((item) => item.id === draft.id)) throw new Error("cross-team knowledge leaked");

const envelope = compileAgentKnowledgeEnvelope(memoryStore, sales, "发送样品前需要做什么", { activeView: "deals" });
if (envelope.protocol !== "goodjob-agent-context/v1" || !envelope.knowledge.some((item) => item.id === draft.id)) {
  throw new Error("knowledge context envelope failed");
}

const revised = await updateAgentKnowledgeDraft(memoryStore, sales, draft.id, { content: "样品发送前必须核对收件地址、费用、快递账号、包装和预计送达日期。" });
if (revised.status !== "review" || revised.trustLevel !== "candidate") throw new Error("published knowledge edit did not return to review");

const overview = agentKnowledgeOverview(memoryStore, manager);
if (overview.systemCount < 8 || overview.vectorEnabled || overview.retrievalMode !== "结构化 + 加权词法 + 语义扩展") throw new Error("knowledge overview invalid");

console.log(JSON.stringify({
  ok: true,
  systemDocuments: system.documents.length,
  customerPoolRetrieved: true,
  navigationKnowledgeRetrieved: true,
  semanticRerank: true,
  unpublishedExcluded: true,
  reviewRequired: true,
  roleIsolation: true,
  contextEnvelope: envelope.protocol,
  retrievalMode: overview.retrievalMode
}, null, 2));
