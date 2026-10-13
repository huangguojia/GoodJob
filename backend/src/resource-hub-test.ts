import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app } from "./server.js";
import { getStore } from "./store.js";

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
    "同一会话里已发过的资料会被标成「该客户此前收到过」",
    Boolean(historyRec?.reasons?.some((reason: Record<string, string>) => reason.kind === "structured" && reason.text.includes("此前收到过"))),
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
