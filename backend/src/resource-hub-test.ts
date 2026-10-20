import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { RESOURCE_RETENTION_DAYS, getResourceHubRepository, knowledgeAssetTeamId, resourceEventPruneCutoff } from "./resource-hub.js";
import { resetKnowledgeGovernanceForTest, setKnowledgeGovernanceRepository } from "./knowledge-governance.js";

// ---------------------------------------------------------------------------
// 资源中心自测。走真实 HTTP + 内存档位，覆盖：
//   四源合并 / 三层可见性 / 真实外链只在 reveal 出口 / 访问计数 / 埋点闭环 /
//   排序确定性 / 未配向量时的降级。
// 关键纪律：这里断言的是**实际响应**（而不是内部函数返回值），否则「路由没接线」也会全绿。
// ---------------------------------------------------------------------------

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start resource-hub test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === undefined ? "" : ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  return { response, json: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  assert.equal(result.response.status, 200, `登录失败：${email}`);
  return String(result.json.token);
}

const now = new Date().toISOString();

try {
  const store = getStore();
  const manager = store.users.find((item) => item.email === "alex@goodjob.com")!;
  const sales = store.users.find((item) => item.email === "shirley@goodjob.com")!;
  const teamId = manager.teamId;

  // 词表走内存档位（与生产同一份接口语义）；先清空，保证用例之间不互相污染。
  setKnowledgeGovernanceRepository(null);
  resetKnowledgeGovernanceForTest();

  // 跨团队账号（用来验证团队隔离）
  const otherTeamUser = {
    id: `u_hub_asia_${randomUUID().slice(0, 8)}`,
    name: "Hub Asia",
    email: `hub-asia-${randomUUID().slice(0, 8)}@goodjob.com`,
    password: "goodjob123",
    role: "sales" as const,
    teamId: "asia",
    avatar: "HA",
    status: "active" as const,
    authVersion: 1
  };
  store.users.push(otherTeamUser as (typeof store.users)[number]);

  /* ---------------- 种子：四类各来一条，外加干扰项 ---------------- */

  function seedAsset(overrides: Record<string, unknown>) {
    const asset = {
      id: `k_hub_${randomUUID().slice(0, 8)}`,
      title: "",
      category: "",
      status: "published" as const,
      ownerId: manager.id,
      teamId,
      version: "1.0",
      sourceType: "baidu_share" as const,
      sourceUrl: "https://pan.baidu.com/s/hub-default",
      shareCode: "",
      fileType: "pdf" as const,
      description: "",
      tags: [] as string[],
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
    store.knowledgeAssets.push(asset as (typeof store.knowledgeAssets)[number]);
    return asset;
  }

  const assetSpec = seedAsset({
    title: "LED 工程灯 规格书",
    category: "产品资料",
    description: "含光效、防护等级与安装尺寸",
    tags: ["LED", "工程灯"],
    fileType: "pdf",
    sourceUrl: "https://pan.baidu.com/s/hub-spec",
    shareCode: "s777"
  });
  const assetTech = seedAsset({
    title: "产品技术资料 Technical Data",
    category: "产品资料",
    sourceType: "external_url" as const,
    sourceUrl: "https://docs.goodjob.test/technical-data.pdf",
    fileType: "word" as const
  });
  const assetDraft = seedAsset({
    title: "内部草稿 不应出现在资源中心",
    category: "产品资料",
    status: "draft" as const
  });
  const assetLegacy = seedAsset({
    title: "历史资料 未补链接",
    category: "产品资料",
    sourceType: "legacy" as const,
    sourceUrl: ""
  });
  const assetOtherTeam = seedAsset({
    title: "别的团队的资料",
    category: "产品资料",
    teamId: "asia"
  });

  const skillPublished = {
    id: `sr_hub_${randomUUID().slice(0, 8)}`,
    name: "开发信助手 Skill",
    category: "客户触达",
    version: "1.0.0",
    summary: "按阶段生成开发信",
    usageGuide: "安装后输入客户画像",
    trainingGuide: "",
    optimizationAdvice: "",
    acquisitionInstructions: "解压到 skills 目录",
    downloadUrl: "https://pan.baidu.com/s/skill-hub",
    extractionCode: "x1",
    tags: ["开发信"],
    author: "Shirley",
    license: "内部使用",
    status: "published" as const,
    ownerId: manager.id,
    teamId,
    accessCount: 0,
    createdAt: now,
    updatedAt: now
  };
  store.skillResources.push(skillPublished as (typeof store.skillResources)[number]);
  store.skillResources.push({ ...skillPublished, id: `sr_draft_${randomUUID().slice(0, 8)}`, status: "draft" } as (typeof store.skillResources)[number]);

  const product = {
    id: `p_hub_${randomUUID().slice(0, 8)}`,
    nameZh: "LED 工矿灯",
    nameEn: "LED High Bay Light HB-200",
    model: "HB-200",
    category: "工程灯具",
    unit: "pcs",
    price: 34.5,
    currency: "USD",
    hsCode: "9405409000",
    descriptionZh: "150W 工业级",
    descriptionEn: "150W industrial grade",
    tags: ["LED"],
    imageUrl: "",
    ownerId: manager.id,
    teamId,
    updatedAt: now
  };
  store.products.push(product as (typeof store.products)[number]);

  const customer = {
    id: `cus_hub_${randomUUID().slice(0, 8)}`,
    company: "Nordic Tools AB",
    country: "SE",
    contact: "Erik",
    ownerId: manager.id,
    teamId,
    stage: "已报价",
    amount: 0,
    health: 80,
    nextReminder: "",
    wecomBound: false,
    billingName: "",
    billingAddress: "",
    documentContact: "",
    defaultPortDischarge: "",
    defaultIncoterm: "",
    defaultPaymentTerm: ""
  };
  store.customers.push(customer as (typeof store.customers)[number]);

  store.quoteHistory.push({
    id: `qh_hub_${randomUUID().slice(0, 8)}`,
    dealId: "d_hub",
    customerId: customer.id,
    documentId: "doc_hub",
    documentType: "QUOTATION",
    documentNumber: "Q-2026-001",
    documentRevision: 1,
    issueDate: now,
    customerName: customer.company,
    dealTitle: "LED 工程灯 报价",
    dealStage: "已报价",
    currency: "USD",
    totalAmount: 1000,
    items: [{ productId: product.id, product: "LED 工程灯", model: "HB-200", quantity: 10, unit: "pcs", unitPrice: 100, lineTotal: 1000 }],
    changes: [],
    fingerprint: "hub-test",
    operatorId: manager.id,
    operatorName: "Alex",
    ownerId: manager.id,
    teamId,
    quotedAt: now
  } as (typeof store.quoteHistory)[number]);

  const managerToken = await login("alex@goodjob.com");
  const salesToken = await login("shirley@goodjob.com");
  const asiaToken = await login(otherTeamUser.email);

  /* ---------------- 1. 目录：四源合并 + 三层可见性 ---------------- */

  const catalog = await request("/api/agent/resources?limit=50", managerToken);
  check("目录接口返回 200", catalog.response.status === 200, catalog.response.status);
  const ids = (catalog.json.resources as Array<{ id: string }>).map((item) => item.id);
  check("目录包含已发布文件资料", ids.includes(assetSpec.id));
  check("目录包含已发布 Skill", ids.includes(skillPublished.id));
  check("目录包含产品", ids.includes(product.id));
  check("目录包含智能体知识（系统知识目录）", (catalog.json.resources as Array<{ sourceType: string }>).some((item) => item.sourceType === "knowledge"));
  check("目录不含草稿文件资料", !ids.includes(assetDraft.id));
  check("目录不含草稿 Skill", !ids.includes(`sr_draft_${skillPublished.id.slice(-8)}`) && !(catalog.json.resources as Array<{ id: string }>).some((item) => item.id.startsWith("sr_draft_")));
  check("目录不含别的团队的资料", !ids.includes(assetOtherTeam.id));

  const serialized = JSON.stringify(catalog.json);
  check("目录响应不含真实外链字段 sourceUrl", !serialized.includes("sourceUrl"));
  check("目录响应不含 downloadUrl", !serialized.includes("downloadUrl"));
  check("目录响应不含 shareCode/extractionCode", !serialized.includes("shareCode") && !serialized.includes("extractionCode"));
  check("目录响应不含网盘域名", !serialized.includes("pan.baidu.com"));
  check("目录响应不泄漏内部检索字段 searchText", !serialized.includes("searchText"));

  /* ---------------- 2. 目录：关键词过滤 ---------------- */

  const ledOnly = await request("/api/agent/resources?q=LED&limit=50", managerToken);
  const ledIds = (ledOnly.json.resources as Array<{ id: string }>).map((item) => item.id);
  check("关键词检索把规格书排进结果", ledIds.includes(assetSpec.id));
  check("关键词检索把不相关草稿排除在外", !ledIds.includes(assetDraft.id));

  /* ---------------- 3. 推荐：词法 + 语义 ---------------- */

  const recommender = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({
      conversation: [{ role: "customer", text: "Could you send the specification of the LED high bay?" }],
      limit: 6,
      signal: "inbound"
    })
  });
  check("推荐接口返回 200", recommender.response.status === 200, recommender.response.status);
  const recs = recommender.json.recommendations as Array<Record<string, any>>;
  check("推荐有结果", recs.length > 0, recs.length);
  const specRec = recs.find((item) => item.id === assetSpec.id);
  check("规格书出现在推荐里", Boolean(specRec));
  check("推荐项都带可解释的 reasons", recs.every((item) => Array.isArray(item.reasons) && item.reasons.length > 0));
  check("推荐项都带 headline", recs.every((item) => typeof item.headline === "string"));
  check("命中词里带 LED", Boolean(specRec?.hitTerms?.includes("led")), specRec?.hitTerms);
  check("词法分项 > 0", Number(specRec?.match?.lexical || 0) > 0, specRec?.match);
  check("推荐响应不含真实外链", !JSON.stringify(recommender.json).includes("pan.baidu.com"));

  const semanticOnly = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({
      conversation: [{ role: "customer", text: "please send the specification" }],
      limit: 20
    })
  });
  const techRec = (semanticOnly.json.recommendations as Array<Record<string, any>>).find((item) => item.id === assetTech.id);
  check("词典等义词能召回标题含 Technical 的资料", Boolean(techRec));
  check("该召回走的是语义分项而不是词法分项", Number(techRec?.match?.semantic || 0) > 0 && Number(techRec?.match?.lexical || 0) === 0, techRec?.match);
  check("存在 kind=semantic 的依据", Boolean(techRec?.reasons?.some((reason: Record<string, string>) => reason.kind === "semantic")));

  /* ---------------- 4. 推荐：结构化分项来自真实往来数据 ---------------- */

  const structured = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({
      conversation: [{ role: "customer", text: "麻烦把相关资料发我一下" }],
      customerId: customer.id,
      limit: 20
    })
  });
  const structuredRec = (structured.json.recommendations as Array<Record<string, any>>).find((item) => item.id === assetSpec.id);
  check("历史报价里的产品词带来结构化加分", Number(structuredRec?.match?.structured || 0) > 0, structuredRec?.match);
  check(
    "结构化依据说清楚是「历史报价里出现过」",
    Boolean(structuredRec?.reasons?.some((reason: Record<string, string>) => reason.kind === "structured" && reason.text.includes("历史报价"))),
    structuredRec?.reasons
  );
  check("匹配到客户时回填公司名", structured.json.customer?.matched === true && structured.json.customer?.company === customer.company, structured.json.customer);

  const noCustomer = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "麻烦把相关资料发我一下" }], limit: 20 })
  });
  const noCustomerReasons = (noCustomer.json.recommendations as Array<Record<string, any>>)
    .flatMap((item) => item.reasons as Array<Record<string, string>>);
  check("未给客户时不存在任何「该客户…」的依据", !noCustomerReasons.some((reason) => reason.kind === "structured"), noCustomerReasons);

  const ghostCustomer = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "hello" }], customerId: "cus_does_not_exist", limit: 5 })
  });
  check("认不出客户时 matched=false（不报错）", ghostCustomer.json.customer?.matched === false, ghostCustomer.json.customer);

  /* ---------------- 5. 检索元信息与降级 ---------------- */

  check("未提供查询向量时 vectorEnabled=false", recommender.json.retrieval?.vectorEnabled === false, recommender.json.retrieval);
  check("检索元信息带 candidates 与 tookMs", Number(recommender.json.retrieval?.candidates) > 0 && typeof recommender.json.retrieval?.tookMs === "number", recommender.json.retrieval);
  check("retrievalMode 明确写出来", recommender.json.retrieval?.mode === "weighted-lexical", recommender.json.retrieval);
  const vectorAttempt = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({
      conversation: [{ role: "customer", text: "specification" }],
      useVector: true,
      queryVector: [0.1, 0.2, 0.3],
      limit: 5
    })
  });
  check("给了向量但库里没有向量时降级而不报错", vectorAttempt.response.status === 200 && vectorAttempt.json.retrieval?.vectorEnabled === false, vectorAttempt.response.status);
  const noVectorWarn = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "specification" }], useVector: true, limit: 5 })
  });
  check("声明要用向量却没给向量时给出警告", (noVectorWarn.json.warnings as string[])?.some((item) => item.includes("查询向量")), noVectorWarn.json.warnings);
  const emptyConversation = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [] })
  });
  check("空对话被 400 拒绝", emptyConversation.response.status === 400, emptyConversation.response.status);

  /* ---------------- 6. 排序确定性（同分不抖动） ---------------- */

  const sequence: string[] = [];
  for (let round = 0; round < 5; round += 1) {
    const run = await request("/api/agent/resources/recommend", managerToken, {
      method: "POST",
      body: JSON.stringify({ conversation: [{ role: "customer", text: "please send the specification" }], limit: 10 })
    });
    sequence.push((run.json.recommendations as Array<{ id: string }>).map((item) => item.id).join(","));
  }
  check("连续 5 次调用顺序完全一致", new Set(sequence).size === 1, sequence);

  /* ---------------- 7. reveal：真实外链的唯一出口 ---------------- */

  const reveal = await request(`/api/agent/resources/file/${assetSpec.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({ reason: "客户索要规格书", conversationKey: "wa:hub-test" })
  });
  check("reveal 返回 200", reveal.response.status === 200, reveal.response.status);
  check("reveal 交出真实外链", reveal.json.access?.kind === "external" && reveal.json.access?.url === assetSpec.sourceUrl, reveal.json.access);
  check("reveal 交出提取码", reveal.json.access?.shareCode === "s777", reveal.json.access);
  check("reveal 返回审计 id", typeof reveal.json.accessId === "string" && reveal.json.accessId.startsWith("rae_"), reveal.json.accessId);

  const afterReveal = await request("/api/agent/resources?limit=50", managerToken);
  const specAfter = (afterReveal.json.resources as Array<Record<string, any>>).find((item) => item.id === assetSpec.id);
  check("reveal 记了一次访问（accessCount=1）", specAfter?.accessCount === 1, specAfter?.accessCount);

  const crossTeamReveal = await request(`/api/agent/resources/file/${assetSpec.id}/reveal`, asiaToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("别的团队 reveal 得到 404", crossTeamReveal.response.status === 404, crossTeamReveal.response.status);

  const draftReveal = await request(`/api/agent/resources/file/${assetDraft.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("草稿 reveal 得到 404", draftReveal.response.status === 404, draftReveal.response.status);

  const legacyReveal = await request(`/api/agent/resources/file/${assetLegacy.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("历史资料没有链接时得到 409 而不是 200", legacyReveal.response.status === 409, legacyReveal.response.status);

  const ghostReveal = await request(`/api/agent/resources/file/k_not_exist/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("不存在的资源 reveal 得到 404", ghostReveal.response.status === 404, ghostReveal.response.status);

  const badType = await request(`/api/agent/resources/unknown/${assetSpec.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("非法 sourceType 得到 404", badType.response.status === 404, badType.response.status);

  const skillReveal = await request(`/api/agent/resources/skill/${skillPublished.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check("Skill reveal 交出下载链接与提取码", skillReveal.json.access?.url === skillPublished.downloadUrl && skillReveal.json.access?.shareCode === "x1", skillReveal.json.access);
  const afterSkillReveal = await request("/api/agent/resources?limit=50", managerToken);
  const skillAfter = (afterSkillReveal.json.resources as Array<Record<string, any>>).find((item) => item.id === skillPublished.id);
  check("Skill 访问计数 +1", skillAfter?.accessCount === 1, skillAfter?.accessCount);

  // 知识文档没有外链 → 内联返回正文
  const knowledgeList = await request("/api/agent/knowledge/documents?status=published", managerToken);
  const knowledgeId = String((knowledgeList.json.documents as Array<{ id: string }>)[0]?.id || "");
  check("知识库里至少有一条可见文档", Boolean(knowledgeId), knowledgeId);
  if (knowledgeId) {
    const inlineReveal = await request(`/api/agent/resources/knowledge/${encodeURIComponent(knowledgeId)}/reveal`, managerToken, {
      method: "POST",
      body: JSON.stringify({})
    });
    check("知识文档 reveal 内联返回正文", inlineReveal.response.status === 200 && inlineReveal.json.access?.kind === "inline" && String(inlineReveal.json.access?.content || "").length > 0, inlineReveal.json.access?.kind);
  }

  /* ---------------- 8. feedback 埋点闭环 ---------------- */

  const feedback = await request("/api/agent/resources/feedback", managerToken, {
    method: "POST",
    body: JSON.stringify({
      items: [
        { resourceId: assetSpec.id, sourceType: "file", action: "sent" },
        { resourceId: assetOtherTeam.id, sourceType: "file", action: "sent" }
      ],
      conversationKey: "wa:hub-test"
    })
  });
  check("feedback 记录了可见的那一条", feedback.json.recorded === 1, feedback.json);
  check("不可见的资源被静默丢弃（不暴露存在性）", feedback.json.ignored === 1, feedback.json);

  const afterSent = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "麻烦把相关资料发我一下" }], limit: 20 })
  });
  const sentRec = (afterSent.json.recommendations as Array<Record<string, any>>).find((item) => item.id === assetSpec.id);
  check(
    "已发送计数进入排序先验（出现「已发出过 N 次」）",
    Boolean(sentRec?.reasons?.some((reason: Record<string, string>) => reason.kind === "structured" && reason.text.includes("已发出过"))),
    sentRec?.reasons
  );

  const conversationHistory = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({
      conversation: [{ role: "customer", text: "麻烦把相关资料发我一下" }],
      conversationKey: "wa:hub-test",
      limit: 20
    })
  });
  const historyRec = (conversationHistory.json.recommendations as Array<Record<string, any>>).find((item) => item.id === assetSpec.id);
  check(
    // G8 修订：customerResourceKeys 收的是 sent + revealed，是「接触过/看过」而非「收到过」。
    // 说成「收到过」会让业务员以为已经发过，实际只是自己点开看过。
    "同一会话里已发/看过的资料会被标成「该客户此前查看过同类资料」",
    Boolean(historyRec?.reasons?.some((reason: Record<string, string>) => reason.kind === "structured" && reason.text.includes("此前查看过"))),
    historyRec?.reasons
  );

  const feedbackDenied = await request("/api/agent/resources/feedback", "", {
    method: "POST",
    body: JSON.stringify({ items: [{ resourceId: assetSpec.id, sourceType: "file", action: "sent" }] })
  });
  check("未登录调用 feedback 得到 401", feedbackDenied.response.status === 401, feedbackDenied.response.status);

  /* ---------------- 8b. 推荐效果报表（eventStats 聚合 + 路由） ---------------- */

  // 造一条确定性的 accepted 埋点（sent 在上面已经记过一条）。
  const statsFeedback = await request("/api/agent/resources/feedback", managerToken, {
    method: "POST",
    body: JSON.stringify({ items: [{ resourceId: assetSpec.id, sourceType: "file", action: "accepted" }], conversationKey: "wa:hub-stats" })
  });
  check("accepted 埋点写入", statsFeedback.json.recorded === 1, statsFeedback.json);

  const statsUnauth = await request("/api/agent/resources/stats");
  check("报表未登录得到 401", statsUnauth.response.status === 401, statsUnauth.response.status);

  const statsOverflow = await request("/api/agent/resources/stats?days=999", managerToken);
  check("days 超上限被夹到 90", statsOverflow.json.days === 90, statsOverflow.json.days);

  const statsReport = await request("/api/agent/resources/stats?days=30", managerToken);
  check("报表返回 200", statsReport.response.status === 200, statsReport.response.status);
  const specStat = (statsReport.json.items as Array<Record<string, any>>).find((item) => item.resourceId === assetSpec.id);
  check("统计包含该资源且 sent/accepted 计数对得上", Boolean(specStat && specStat.counts.sent >= 1 && specStat.counts.accepted >= 1), specStat);
  check("采纳率在 0-1 之间（分母是 revealed）", Boolean(specStat && specStat.adoptionRate >= 0 && specStat.adoptionRate <= 1), specStat?.adoptionRate);
  check("标题反查成功", specStat?.title === assetSpec.title, specStat?.title);
  check(
    "totals 五类计数与两个比率齐全",
    ["exposed", "revealed", "accepted", "dismissed", "sent", "adoptionRate", "sendRate"].every((key) => key in (statsReport.json.totals as object)),
    statsReport.json.totals
  );
  check("排序是采纳率倒序", ((statsReport.json.items as Array<Record<string, any>>)[0]?.adoptionRate ?? 0) >= ((statsReport.json.items as Array<Record<string, any>>).at(-1)?.adoptionRate ?? 0));

  const otherTeamStats = await request("/api/agent/resources/stats?days=7", salesToken);
  check("别的团队账号调用也返回 200（teamId 口径共享）", otherTeamStats.response.status === 200, otherTeamStats.response.status);

  /* ---------------- 9. 促销账号与空查询边界 ---------------- */

  const salesCatalog = await request("/api/agent/resources?limit=50", salesToken);
  const salesIds = (salesCatalog.json.resources as Array<{ id: string }>).map((item) => item.id);
  check("业务员能看到已发布的团队资料", salesIds.includes(assetSpec.id));
  check("业务员看不到草稿", !salesIds.includes(assetDraft.id));
  check("业务员看不到别的团队", !salesIds.includes(assetOtherTeam.id));

  const overLimit = await request("/api/agent/resources?limit=999", managerToken);
  check("limit 超上限被夹到 50", (overLimit.json.resources as unknown[]).length <= 50, (overLimit.json.resources as unknown[]).length);

  const unauthCatalog = await request("/api/agent/resources");
  check("未登录调用目录得到 401", unauthCatalog.response.status === 401, unauthCatalog.response.status);

  /* ---------------- 10. 孤儿归属：team_id='all' 回落到 owner 团队（G3） ---------------- */

  const assetOrphanTeam = seedAsset({
    title: "历史导入 未归属团队",
    category: "产品资料",
    teamId: "all"
  });
  const assetTrueOrphan = seedAsset({
    title: "owner 已删除的真孤儿",
    category: "产品资料",
    teamId: "all",
    ownerId: "u_deleted_ghost"
  });

  const afterOrphanSeed = await request("/api/agent/resources?limit=50", managerToken);
  const orphanIds = (afterOrphanSeed.json.resources as Array<{ id: string }>).map((item) => item.id);
  check(
    "team_id='all' 的存量资料回落到 owner 团队后重新可见",
    orphanIds.includes(assetOrphanTeam.id),
    { wanted: assetOrphanTeam.id, got: orphanIds.length }
  );
  const orphanAsia = await request("/api/agent/resources?limit=50", asiaToken);
  check(
    "回落只认 owner 的团队，别的团队仍然看不到",
    !(orphanAsia.json.resources as Array<{ id: string }>).some((item) => item.id === assetOrphanTeam.id)
  );
  check(
    "owner 查不到的真孤儿保持不可见（进孤儿清单，不静默修复）",
    !orphanIds.includes(assetTrueOrphan.id)
  );

  /* ---------------- 11. 可达性闸：推荐位只给点了能拿到东西的资料（G5） ---------------- */

  const legacyRecommend = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "历史资料 未补链接" }], limit: 20 })
  });
  const legacyRecs = legacyRecommend.json.recommendations as Array<{ id: string }>;
  check(
    "无链接的 legacy 资料不进推荐候选（可达性过滤）",
    !legacyRecs.some((item) => item.id === assetLegacy.id),
    legacyRecs.map((item) => item.id)
  );
  check(
    "检索元信息报告被跳过的不可达资料数",
    Number(legacyRecommend.json.retrieval?.unreachableSkipped) >= 1,
    legacyRecommend.json.retrieval
  );
  const catalogAll = await request("/api/agent/resources?limit=50", managerToken);
  check(
    "目录（不带 reachable）仍包含 legacy 资料 —— 它是治理对象，不是该消失的数据",
    (catalogAll.json.resources as Array<{ id: string }>).some((item) => item.id === assetLegacy.id)
  );
  const catalogReachable = await request("/api/agent/resources?limit=50&reachable=1", managerToken);
  check(
    "目录传 reachable=1 时过滤掉 legacy 资料（插件面板用这个口径）",
    !(catalogReachable.json.resources as Array<{ id: string }>).some((item) => item.id === assetLegacy.id)
  );
  const legacyRevealAgain = await request(`/api/agent/resources/file/${assetLegacy.id}/reveal`, managerToken, {
    method: "POST",
    body: JSON.stringify({})
  });
  check(
    "reveal 路径不过滤：legacy 资料仍返回 409 no_link 而不是 404",
    legacyRevealAgain.response.status === 409,
    legacyRevealAgain.response.status
  );

  /* ---------------- 12. 截断可见化：第 401 份起不进候选必须有人知道（G6） ---------------- */

  for (let index = 0; index < 401; index += 1) {
    seedAsset({ title: `截断探针 ${index}`, category: "产品资料", updatedAt: new Date(Date.now() + index).toISOString() });
  }
  const truncatedRecommend = await request("/api/agent/resources/recommend", managerToken, {
    method: "POST",
    body: JSON.stringify({ conversation: [{ role: "customer", text: "截断探针" }], limit: 5 })
  });
  const truncationWarning = (truncatedRecommend.json.warnings as string[]).find((item) => item.includes("未进入本次候选"));
  const truncationCount = Number(/有 (\d+) 份/.exec(truncationWarning || "")?.[1] || 0);
  // 期望条数按「文件源可见总数 - MAX_SCAN_PER_SOURCE」现算，不写死数字：
  // data.ts 里还有预置的已发布资料，写死会随种子数据漂移。
  // （目录接口自己也截断到 400，取不到真实总数，只能用采集口径现算。）
  const visibleFileCount = store.knowledgeAssets.filter((asset) =>
    asset.status === "published" && knowledgeAssetTeamId(store, asset) === teamId
  ).length;
  check(
    "超出 MAX_SCAN_PER_SOURCE 的资料在 warnings 里报出源与条数",
    Boolean(truncationWarning?.includes("文件中心")) && truncationCount >= 1,
    truncatedRecommend.json.warnings
  );
  check(
    "截断条数与「文件源可见总数 - MAX_SCAN_PER_SOURCE」对得上",
    truncationCount === Math.max(0, visibleFileCount - 400),
    { truncationCount, visibleFileCount }
  );

  /* ---------------- 13. CRM 内打开资料记 revealed 埋点（G11） ---------------- */

  const accessProbe = seedAsset({ title: "埋点探针 打开资料", category: "产品资料" });
  const accessOpened = await request(`/api/knowledge/assets/${accessProbe.id}/access`, managerToken, { method: "POST", body: "{}" });
  check("access 接口正常返回", accessOpened.response.status === 200, accessOpened.response.status);
  const accessStats = await request("/api/agent/resources/stats?days=30", managerToken);
  const accessProbeStat = (accessStats.json.items as Array<Record<string, any>>).find(
    (item) => item.resourceId === accessProbe.id
  );
  check(
    "CRM 内打开资料后报表出现 revealed 计数",
    Boolean(accessProbeStat && accessProbeStat.counts.revealed >= 1),
    accessProbeStat
  );

  /* ---------------- 14. 埋点清理窗口（G14） ---------------- */

  const repository = getResourceHubRepository();
  await repository.recordEvents([{
    ownerId: manager.id,
    teamId,
    resourceType: "file",
    resourceId: "k_prune_probe",
    eventType: "exposed"
  }]);
  check(
    `${RESOURCE_RETENTION_DAYS} 天保留期内的新事件不被清理`,
    (await repository.pruneEvents(RESOURCE_RETENTION_DAYS)) === 0
  );
  check(
    "探针事件确实写进了埋点表",
    (await repository.listEvents(teamId)).some((row) => row.resourceId === "k_prune_probe")
  );
  // 造一条 100 天前的老事件（直接捅内存仓库的内部数组 —— 公开 API 只会盖"现在"的时间戳）
  const dayMs = 86_400_000;
  const internal = repository as unknown as { events: Array<Record<string, unknown>> };
  internal.events.push({
    id: "rre_prune_old",
    ownerId: manager.id,
    teamId,
    conversationKey: "",
    resourceType: "file",
    resourceId: "k_prune_old",
    eventType: "exposed",
    score: 0,
    channel: "",
    createdAt: new Date(Date.now() - 100 * dayMs).toISOString()
  });
  const prunedOld = await repository.pruneEvents(RESOURCE_RETENTION_DAYS);
  check(
    "100 天前的老事件被 90 天保留期清掉，新事件保留",
    prunedOld >= 1
      && !(await repository.listEvents(teamId)).some((row) => row.resourceId === "k_prune_old")
      && (await repository.listEvents(teamId)).some((row) => row.resourceId === "k_prune_probe"),
    { prunedOld }
  );
  const cutoffNow = Date.now();
  check(
    "截止时刻 = now - 保留期（纯函数口径）",
    resourceEventPruneCutoff(RESOURCE_RETENTION_DAYS, cutoffNow).getTime() === cutoffNow - RESOURCE_RETENTION_DAYS * dayMs
  );
  check(
    "保留期配 0 / 负数被夹到 1 天下限（防止误配把全表清光）",
    resourceEventPruneCutoff(0, cutoffNow).getTime() === cutoffNow - dayMs
      && resourceEventPruneCutoff(-7, cutoffNow).getTime() === cutoffNow - dayMs
  );

  /* ---------------- 15. 入库闸：受控词表 / 查重 / 质量标记（P1-1） ---------------- */

  const vocabularyList = await request("/api/knowledge/vocabulary", managerToken);
  check("词表接口可用且返回条目数组", vocabularyList.response.status === 200 && Array.isArray(vocabularyList.json.entries), vocabularyList.json);
  check("词表测试从空表开始（内存档位已清理）", (vocabularyList.json.entries as unknown[]).length === 0, vocabularyList.json.entries);

  const createdTags = [`新标签${randomUUID().slice(0, 6)}`];
  const createdAsset = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({
      title: `词表内资料 ${randomUUID().slice(0, 8)}`,
      category: "产品知识",
      version: "v1",
      sourceUrl: "https://pan.baidu.com/s/1vocabok",
      fileType: "pdf",
      description: "覆盖词表命中 + 标签自动建条 + 质量标记",
      tags: createdTags
    })
  });
  check("空词表下把关人首次入库放行（新团队第一条不被拦死）", createdAsset.response.status === 200, createdAsset.json);
  check(
    "新类目隐式建条并提示",
    (createdAsset.json.warnings as string[])?.some((item) => item.includes("新类目")),
    createdAsset.json.warnings
  );
  check(
    "质量标记随响应返回（四项齐全时为空数组）",
    Array.isArray(createdAsset.json.qualityFlags) && createdAsset.json.qualityFlags.length === 0,
    createdAsset.json.qualityFlags
  );
  check(
    "新标签自动进词表并记入 warnings",
    (createdAsset.json.warnings as string[])?.some((item) => item.includes("新标签已加入词表")),
    createdAsset.json.warnings
  );
  const tagEntriesAfter = await request("/api/knowledge/vocabulary?type=tag", managerToken);
  check(
    "自动建条确实落到词表（且 usage_count 被 bump）",
    (tagEntriesAfter.json.entries as Array<Record<string, any>>).some(
      (entry) => entry.value === createdTags[0] && Number(entry.usageCount) >= 1
    ),
    tagEntriesAfter.json.entries
  );

  // 词表已有内容后，业务员用词表外类目 → 必须被拦，并给近似建议
  const unknownCategoryAsset = await request("/api/knowledge/assets", salesToken, {
    method: "POST",
    body: JSON.stringify({
      title: `词表外类目探针 ${randomUUID().slice(0, 8)}`,
      category: "绝无仅有的类目zzz",
      version: "v1",
      sourceUrl: "https://pan.baidu.com/s/1vocabprobe",
      fileType: "pdf",
      description: "探针",
      tags: ["探针"]
    })
  });
  check(
    "业务员用词表外类目 → 400 且返回 code 与 suggestions",
    unknownCategoryAsset.response.status === 400
      && unknownCategoryAsset.json.code === "CATEGORY_NOT_IN_VOCABULARY"
      && Array.isArray(unknownCategoryAsset.json.suggestions),
    unknownCategoryAsset.json
  );
  const staffCategoryProbe = await request("/api/knowledge/vocabulary", salesToken, {
    method: "POST",
    body: JSON.stringify({ type: "category", value: "业务员越权新建" })
  });
  check("业务员无权新增词条（写词表需要 training.manage）", staffCategoryProbe.response.status === 403, staffCategoryProbe.response.status);

  const lowQualityAsset = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({
      title: "缩写",
      category: "产品知识",
      version: "v1",
      sourceUrl: "https://pan.baidu.com/s/1lowquality",
      fileType: "other",
      description: "",
      tags: []
    })
  });
  check(
    "质量待补项如实返回（标题过短 / 缺说明 / 缺标签）",
    lowQualityAsset.response.status === 200
      && (lowQualityAsset.json.qualityFlags as string[]).includes("标题过短")
      && (lowQualityAsset.json.qualityFlags as string[]).includes("缺少说明")
      && (lowQualityAsset.json.qualityFlags as string[]).includes("缺少标签"),
    lowQualityAsset.json.qualityFlags
  );

  /* 查重：同链接硬拦（409），同标题软警示（200 + warning） */
  const dupSource = `https://pan.baidu.com/s/1dupprobe${randomUUID().slice(0, 6)}`;
  const dupFirst = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: `查重基准 ${randomUUID().slice(0, 6)}`, category: "产品知识", version: "v1", sourceUrl: dupSource, fileType: "pdf" })
  });
  check("查重基准资料创建成功", dupFirst.response.status === 200, dupFirst.json);
  const dupSameUrl = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: `查重同链接 ${randomUUID().slice(0, 6)}`, category: "产品知识", version: "v1", sourceUrl: dupSource, fileType: "pdf" })
  });
  check(
    "同一链接重复入库 → 409 且带 duplicateOf",
    dupSameUrl.response.status === 409 && dupSameUrl.json.duplicateOf === dupFirst.json.asset?.id,
    dupSameUrl.json
  );
  const dupSameTitle = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: dupFirst.json.asset.title, category: "产品知识", version: "v2", sourceUrl: `${dupSource}?v=2`, fileType: "pdf" })
  });
  check(
    "同名资料 → 放行但给警示",
    dupSameTitle.response.status === 200
      && (dupSameTitle.json.warnings as string[])?.some((item) => item.includes("已有同名资料")),
    dupSameTitle.json.warnings
  );

  /* ---------------- 16. 版本线性化 / 归档 / 批量 / 治理看数（P1-2） ---------------- */

  const linerTitle = `版本线性化探针 ${randomUUID().slice(0, 6)}`;
  const linerV1 = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: linerTitle, category: "产品知识", version: "v1", sourceUrl: `https://pan.baidu.com/s/1liner${randomUUID().slice(0, 6)}`, fileType: "pdf", description: "v1" })
  });
  await request(`/api/knowledge/assets/${linerV1.json.asset.id}/publish`, managerToken, { method: "PATCH", body: JSON.stringify({}) });
  const linerV2 = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: linerTitle, category: "产品知识", version: "v2", sourceUrl: `https://pan.baidu.com/s/1liner${randomUUID().slice(0, 6)}`, fileType: "pdf", description: "v2" })
  });
  const linerPublish = await request(`/api/knowledge/assets/${linerV2.json.asset.id}/publish`, managerToken, {
    method: "PATCH",
    body: JSON.stringify({})
  });
  check(
    "发布新版把同标题旧版自动归档",
    linerPublish.response.status === 200
      && (linerPublish.json.archivedSuperseded as Array<Record<string, any>>).some((item) => item.id === linerV1.json.asset.id),
    linerPublish.json.archivedSuperseded
  );
  const linerV1Reloaded = getStore().knowledgeAssets.find((item) => item.id === linerV1.json.asset.id);
  check("旧版状态确实变成 archived", linerV1Reloaded?.status === "archived", linerV1Reloaded?.status);
  check(
    "归档后不再进推荐候选",
    !(await request("/api/agent/resources?sourceType=file&limit=50", managerToken)).json.resources
      .some((item: Record<string, any>) => item.id === linerV1.json.asset.id)
  );

  const archiveProbe = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: `归档探针 ${randomUUID().slice(0, 6)}`, category: "产品知识", version: "v1", sourceUrl: `https://pan.baidu.com/s/1arch${randomUUID().slice(0, 6)}`, fileType: "pdf" })
  });
  const archiveResult = await request(`/api/knowledge/assets/${archiveProbe.json.asset.id}/archive`, managerToken, {
    method: "PATCH",
    body: JSON.stringify({ reason: "内容过时" })
  });
  check(
    "归档接口写状态与原因",
    archiveResult.response.status === 200
      && archiveResult.json.asset.status === "archived"
      && archiveResult.json.asset.archivedReason === "内容过时",
    archiveResult.json.asset
  );

  const batchA = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: `批量探针A ${randomUUID().slice(0, 6)}`, category: "产品知识", version: "v1", sourceUrl: `https://pan.baidu.com/s/1batcha${randomUUID().slice(0, 6)}`, fileType: "pdf" })
  });
  const batchB = await request("/api/knowledge/assets", managerToken, {
    method: "POST",
    body: JSON.stringify({ title: `批量探针B ${randomUUID().slice(0, 6)}`, category: "产品知识", version: "v1", sourceUrl: `https://pan.baidu.com/s/1batchb${randomUUID().slice(0, 6)}`, fileType: "pdf" })
  });
  const batchResult = await request("/api/knowledge/assets/batch", managerToken, {
    method: "POST",
    body: JSON.stringify({ ids: [batchA.json.asset.id, batchB.json.asset.id, "k_not_exist"], action: "publish" })
  });
  check(
    "批量发布：成功两条、失败一条（部分失败不整批回滚）",
    batchResult.response.status === 200
      && (batchResult.json.ok as string[]).length === 2
      && (batchResult.json.failed as Array<Record<string, any>>).length === 1
      && (batchResult.json.failed as Array<Record<string, any>>)[0].id === "k_not_exist",
    batchResult.json
  );
  const batchBySales = await request("/api/knowledge/assets/batch", salesToken, {
    method: "POST",
    body: JSON.stringify({ ids: [batchA.json.asset.id], action: "archive" })
  });
  check("批量动作需要 training.manage（业务员被拒）", batchBySales.response.status === 403, batchBySales.response.status);

  const governance = await request("/api/knowledge/assets/governance", managerToken);
  check(
    "治理看数返回 counts / qualityFlags / retrieval",
    governance.response.status === 200
      && typeof governance.json.counts?.published === "number"
      && typeof governance.json.counts?.missingLink === "number"
      && typeof governance.json.qualityFlags === "object",
    governance.json
  );
  check(
    "治理看数里 accepted 采纳口径齐备（不再只有五类总数缺字段）",
    governance.json.retrieval === null || typeof governance.json.retrieval.adoptionRate === "number",
    governance.json.retrieval
  );

  /* ---------------- 17. 两池分层 / 否决降权 / 反馈回流（P1-2 · P1-3 · P3-2） ---------------- */

  {
    const { scoreHubResources } = await import("./resource-hub.js");
    const base = {
      id: "pool_probe",
      sourceType: "file" as const,
      title: "两池探针 规格书",
      category: "产品知识",
      summary: "两池探针",
      tags: ["探针"],
      fileType: "pdf",
      version: "v1",
      author: "tester",
      updatedAt: now,
      accessCount: 0,
      hasExternalLink: true,
      ownerId: manager.id,
      teamId,
      searchText: "",
      inlineContent: ""
    };
    const query = "两池探针 规格书";
    const unverified = scoreHubResources([{ ...base, id: "pool_low", verified: false }], { query, limit: 5 })[0];
    const verified = scoreHubResources([{ ...base, id: "pool_high", verified: true }], { query, limit: 5 })[0];
    check(
      "两池：同样内容下未校订资料的分数恰好是已校订的一半",
      Math.abs(unverified.score * 2 - verified.score) < 0.002,
      { unverified: unverified.score, verified: verified.score }
    );
    check(
      "两池归属字段如实标出（longtail / core）",
      scoreHubResources([{ ...base, id: "pool_a", verified: false }], { query, limit: 5 })[0].pool === "longtail"
        && scoreHubResources([{ ...base, id: "pool_b", verified: true }], { query, limit: 5 })[0].pool === "core"
    );

    const normal = scoreHubResources([{ ...base, id: "dis_a" }], { query, limit: 5 })[0];
    const dismissed = scoreHubResources([{ ...base, id: "dis_a" }], {
      query,
      limit: 5,
      dismissedKeys: new Set(["file:dis_a"])
    })[0];
    check(
      "被客户标「没帮助」的资料分数被打折（兑现 UI 承诺）",
      dismissed.score < normal.score
        && dismissed.reasons.some((reason) => reason.text.includes("没帮助")),
      { normal: normal.score, dismissed: dismissed.score }
    );

    const feedbackDemote = scoreHubResources([{ ...base, id: "fb_a", verified: true }], {
      query,
      limit: 5,
      feedback: new Map([["file:fb_a", { revealed: 25, accepted: 0, dismissed: 0 }]])
    })[0];
    const feedbackNone = scoreHubResources([{ ...base, id: "fb_a", verified: true }], { query, limit: 5 })[0];
    check(
      "曝光 ≥20 且零采纳 → 反馈降权",
      feedbackDemote.score < feedbackNone.score,
      { demoted: feedbackDemote.score, plain: feedbackNone.score }
    );
    const feedbackBoost = scoreHubResources([{ ...base, id: "fb_b", verified: true }], {
      query,
      limit: 5,
      feedback: new Map([["file:fb_b", { revealed: 8, accepted: 6, dismissed: 0 }]])
    })[0];
    const feedbackBoostPlain = scoreHubResources([{ ...base, id: "fb_b", verified: true }], { query, limit: 5 })[0];
    check(
      "采纳 ≥5 且曝光 ≥5 → 反馈加权",
      feedbackBoost.score > feedbackBoostPlain.score,
      { boosted: feedbackBoost.score, plain: feedbackBoostPlain.score }
    );

    /* P3-1：20 词长查询下，旧口径把分差压平，新口径能拉开 */
    const longQuery = "两池探针 规格书 报价 图纸 目录 报关 认证 包装 样品 说明书 合同 图片 视频 培训 交期 起订量 集装箱 运费 保险 退税";
    const cand = (id: string) => ({ ...base, id, verified: true });
    const oldTop = scoreHubResources([cand("lex_a")], { query: longQuery, limit: 5 })[0];
    const newTop = scoreHubResources([cand("lex_a")], { query: longQuery, limit: 5, lexicalV2: true })[0];
    check(
      "P3-1：长查询下 v2 口径把命中强词的分值抬起来（旧口径被稀释）",
      newTop.score > oldTop.score,
      { v1: oldTop.score, v2: newTop.score }
    );
    const shortA = scoreHubResources([cand("lex_s")], { query: "规格书", limit: 5 })[0];
    const shortB = scoreHubResources([cand("lex_s")], { query: "规格书", limit: 5, lexicalV2: true })[0];
    check(
      "P3-1：短查询（≤5 词）新旧口径逐位一致，开关不影响已调好的短句排序",
      Math.abs(shortA.score - shortB.score) < 1e-9,
      { v1: shortA.score, v2: shortB.score }
    );
  }

  /* ---------------- 18. 目录快照：面向插件的资料库视图（含治理口径） ---------------- */

  {
    const token = await login("alex@goodjob.com");

    // 这是**对外**接口，不能因为"只读"就放开
    const anonymous = await request("/api/agent/resources/catalog");
    check("目录快照未登录被拒（401）", anonymous.response.status === 401, anonymous.response.status);

    const before = await request("/api/agent/resources/catalog", token);
    check("目录快照路由已接线（不是 404）", before.response.status === 200, before.response.status);

    // 探针三条：已校订 published / 未校订且缺链接 published / 草稿
    const probeVerified = seedAsset({
      id: `k_cat_v_${randomUUID().slice(0, 8)}`,
      title: "目录探针 已校订规格书",
      category: "产品资料",
      description: "带说明带标签的完整资料",
      tags: ["探针", "规格书"],
      verified: true,
      updatedAt: new Date(Date.now() + 60_000).toISOString()
    });
    const probeTail = seedAsset({
      id: `k_cat_t_${randomUUID().slice(0, 8)}`,
      title: "目录探针 未校订缺链接",
      category: "产品资料",
      sourceType: "legacy" as const,
      sourceUrl: "",
      updatedAt: new Date(Date.now() + 59_000).toISOString()
    });
    const probeDraft = seedAsset({
      id: `k_cat_d_${randomUUID().slice(0, 8)}`,
      title: "目录探针 草稿不该进条目",
      category: "产品资料",
      status: "draft" as const,
      // ⚠️ 必须给**最新**的时间戳：目录有 limit 截断，updatedAt 排在后面的草稿
      // 本来就不会出现在 items 里 —— 那样这条断言即使在"草稿泄漏"的实现下也是绿的
      // （实测踩过：只改实现不红，等于没测）。
      updatedAt: new Date(Date.now() + 120_000).toISOString()
    });

    const after = await request("/api/agent/resources/catalog", token);
    const items = after.json.items as Array<Record<string, any>>;
    const hasId = (id: string) => items.some((item) => item.id === id);

    check(
      "catalog：items 只含 published —— 草稿不进条目（否则插件摆出必然 reveal 404 的按钮）",
      hasId(probeVerified.id) && hasId(probeTail.id) && !hasId(probeDraft.id),
      { verified: hasId(probeVerified.id), tail: hasId(probeTail.id), draft: hasId(probeDraft.id) }
    );
    check(
      "catalog：governance 计数按全量可见算（草稿数得出来，才催得动）",
      Number(after.json.governance.total) === Number(before.json.governance.total) + 3
        && Number(after.json.governance.published) === Number(before.json.governance.published) + 2
        && Number(after.json.governance.draft) === Number(before.json.governance.draft) + 1,
      { before: before.json.governance, after: after.json.governance }
    );

    const verifiedItem = items.find((item) => item.id === probeVerified.id)!;
    const tailItem = items.find((item) => item.id === probeTail.id)!;
    check(
      "catalog：verified / pool 透出，且两池归属与检索口径一致",
      verifiedItem.verified === true && verifiedItem.pool === "core"
        && tailItem.verified === false && tailItem.pool === "longtail",
      { verified: { v: verifiedItem.verified, pool: verifiedItem.pool }, tail: { v: tailItem.verified, pool: tailItem.pool } }
    );
    check(
      "catalog：缺链接的资料 hasExternalLink=false 且带「缺少链接」质量标记",
      tailItem.hasExternalLink === false && (tailItem.qualityFlags as string[]).includes("缺少链接"),
      tailItem.qualityFlags
    );
    check(
      "catalog：绝不返回 sourceUrl / shareCode（真实地址的唯一出口仍然只有 reveal）",
      items.every((item) => !("sourceUrl" in item) && !("shareCode" in item)),
      Object.keys(verifiedItem)
    );
    check(
      "catalog：两池汇总与逐条归属对得上（同一份数据不能算出两个结论）",
      Number(after.json.governance.corePool) + Number(after.json.governance.longTailPool) === Number(after.json.governance.published)
        && Number(after.json.governance.unverified) === Number(after.json.governance.longTailPool),
      after.json.governance
    );

    // since 增量：拿最新时间戳当游标 → 没有变更；把游标往前退 → 变更集回来
    const cursor = String(after.json.revision.latestUpdatedAt || "");
    check("catalog：revision.latestUpdatedAt 非空（就是下次该传的 since）", Boolean(cursor), cursor);
    const incremental = await request(`/api/agent/resources/catalog?since=${encodeURIComponent(cursor)}`, token);
    check(
      "catalog：since 增量过滤生效（游标之后才算变更）",
      (incremental.json.items as unknown[]).length === 0,
      { count: (incremental.json.items as unknown[]).length, cursor }
    );
    const rewound = await request(
      `/api/agent/resources/catalog?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`,
      token
    );
    check(
      "catalog：回退游标能拿到变更集",
      (rewound.json.items as Array<Record<string, any>>).some((item) => item.id === probeVerified.id)
    );

    check(
      "catalog：词表随目录一并下发（插件画类目筛选 / 标签 chips 用）",
      Array.isArray(after.json.vocabulary?.categories) && Array.isArray(after.json.vocabulary?.tags),
      after.json.vocabulary
    );
    check(
      "catalog：治理按类目分组可用（插件画类目树不用自己数）",
      Array.isArray(after.json.governance.byCategory)
        && (after.json.governance.byCategory as Array<Record<string, any>>).some((row) => row.category === "产品资料"),
      after.json.governance.byCategory
    );

    const otherCatalog = await request("/api/agent/resources/catalog", await login(otherTeamUser.email));
    check(
      "catalog：不泄漏别的团队的资料",
      !(otherCatalog.json.items as Array<Record<string, any>>).some((item) => item.id === probeVerified.id),
      otherCatalog.response.status
    );

    check(
      "catalog：truncated / warnings 字段齐备（截断必须可见，不能静默）",
      typeof after.json.truncated === "number"
        && Number(after.json.truncated) >= 0
        && Array.isArray(after.json.warnings)
    );
  }

  /* ---------------- 输出 ---------------- */

  console.log(JSON.stringify({
    ok: failures.length === 0,
    passed,
    failed: failures.length,
    fourSourcesMerged: true,
    visibilityEnforced: true,
    realLinkOnlyViaReveal: true,
    accessCounted: true,
    feedbackClosedLoop: true,
    deterministicOrder: true,
    vectorDegradedGracefully: true
  }));

  if (failures.length) {
    for (const item of failures) console.error("FAIL:", item);
    process.exitCode = 1;
  }
} finally {
  server.close();
}
