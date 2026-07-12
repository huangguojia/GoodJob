import { app } from "./server.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json();
  return { response, json };
}

async function login(email: string) {
  const { response, json } = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  if (!response.ok) throw new Error(`login failed ${email}`);
  return json.token as string;
}

try {
  const salesToken = await login("shirley@goodjob.com");
  const miaToken = await login("mia@goodjob.com");
  const managerToken = await login("alex@goodjob.com");
  const adminToken = await login("admin@goodjob.com");
  const superAdminToken = await login("super@goodjob.com");

  const salesCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  const managerCustomers = await request("/api/customers", { headers: { authorization: `Bearer ${managerToken}` } });
  if (salesCustomers.json.customers.length >= managerCustomers.json.customers.length) {
    throw new Error("manager should see more customers than sales");
  }

  const followContent = `客户持久化跟进-${Date.now()}`;
  const customerFollow = await request("/api/customers/c1/activities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ type: "email", content: followContent, nextReminder: "明天 14:00" })
  });
  if (!customerFollow.response.ok || customerFollow.json.customer.nextReminder !== "明天 14:00") throw new Error("customer activity create failed");
  const customersAfterFollow = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  const followedCustomer = customersAfterFollow.json.customers.find((customer: { id: string }) => customer.id === "c1");
  if (followedCustomer?.ownerName !== "Shirley" || followedCustomer?.activities?.[0]?.content !== followContent) throw new Error("customer activity must remain readable with real owner");
  const crossCustomerFollow = await request("/api/customers/c1/activities", {
    method: "POST",
    headers: { authorization: `Bearer ${miaToken}` },
    body: JSON.stringify({ type: "note", content: "越权跟进" })
  });
  if (crossCustomerFollow.response.status !== 404) throw new Error("sales customer activity must be owner isolated");

  const boundaryCompany = `隔离删除客户-${Date.now()}`;
  const boundaryCustomer = await request("/api/customers", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ company: boundaryCompany, country: "德国", contact: "Boundary Buyer", stage: "询盘", amount: 1000 })
  });
  if (!boundaryCustomer.response.ok) throw new Error("boundary customer create failed");
  const managerBoundaryTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ title: `主管跟进 ${boundaryCompany}`, type: "customer", related: boundaryCompany })
  });
  const salesBoundaryTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: `销售跟进 ${boundaryCompany}`, type: "customer", related: boundaryCompany })
  });
  if (!managerBoundaryTodo.response.ok || !salesBoundaryTodo.response.ok) throw new Error("boundary todo create failed");
  const boundaryDelete = await request("/api/customers/bulk-delete", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [boundaryCustomer.json.customer.id] })
  });
  if (!boundaryDelete.response.ok) throw new Error("boundary customer delete failed");
  const managerTodosAfterBoundaryDelete = await request("/api/todos", { headers: { authorization: `Bearer ${managerToken}` } });
  const salesTodosAfterBoundaryDelete = await request("/api/todos", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!managerTodosAfterBoundaryDelete.json.todos.some((todo: { id: string }) => todo.id === managerBoundaryTodo.json.todo.id)) throw new Error("customer delete must not remove manager personal todo");
  if (salesTodosAfterBoundaryDelete.json.todos.some((todo: { id: string }) => todo.id === salesBoundaryTodo.json.todo.id)) throw new Error("customer delete should remove current user's related todo");

  const ocr = await request("/api/tools/ocr/jobs/ocr1/sync-lead", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!ocr.response.ok || ocr.json.lead.company !== "NorthStar Lighting GmbH") {
    throw new Error("ocr sync failed");
  }
  const ocrRepeat = await request("/api/tools/ocr/jobs/ocr1/sync-lead", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const leadsAfterOcr = await request("/api/leads", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!ocrRepeat.response.ok || !ocrRepeat.json.duplicate || ocrRepeat.json.lead.id !== ocr.json.lead.id) throw new Error("ocr sync must be idempotent");
  if (!leadsAfterOcr.json.leads.some((lead: { id: string }) => lead.id === ocr.json.lead.id)) throw new Error("ocr lead must be persisted");
  const managerOcr = await request("/api/tools/ocr/jobs/ocr1", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!managerOcr.response.ok || managerOcr.json.job.ownerId !== "u_manager_alex") throw new Error("manager personal ocr job failed");
  const crossOcr = await request(`/api/tools/ocr/jobs/${managerOcr.json.job.id}`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (crossOcr.response.status !== 404) throw new Error("ocr job must be personal isolated");
  const invalidOcr = await request("/api/tools/ocr/jobs/ocr1/recognize", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ confidence: 101, company: "x".repeat(201), unexpected: "must be rejected" })
  });
  if (invalidOcr.response.status !== 400) throw new Error("ocr recognition input must be bounded");

  const aiConfig = await request("/api/tools/ai-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      name: "自动化AI解析配置",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "test-secret-1234",
      enabled: false
    })
  });
  if (!aiConfig.response.ok || aiConfig.json.config?.apiKey !== "****1234" || !aiConfig.json.config?.hasApiKey) throw new Error("ai config save failed");

  const aiConfigSecond = await request("/api/tools/ai-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      provider: "deepseek",
      protocol: "openai-compatible",
      name: "自动化AI解析配置-第二套Key",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "test-secret-5678",
      enabled: true,
      useLeadFinder: true,
      useWebsiteParse: false,
      useScoring: false,
      useEmailDraft: true,
      useExam: false
    })
  });
  if (!aiConfigSecond.response.ok || (aiConfigSecond.json.configs || []).length < 2 || aiConfigSecond.json.config?.apiKey !== "****5678") throw new Error("ai multi config save failed");

  const aiConfigRead = await request("/api/tools/ai-config", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!aiConfigRead.response.ok || (aiConfigRead.json.configs || []).length < 2 || aiConfigRead.json.config?.apiKey !== "****5678") throw new Error("ai config read failed");

  const aiConfigDelete = await request(`/api/tools/ai-config/${aiConfig.json.config.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!aiConfigDelete.response.ok || (aiConfigDelete.json.configs || []).some((item: { id: string }) => item.id === aiConfig.json.config.id) || aiConfigDelete.json.config?.apiKey !== "****5678") throw new Error("ai config delete failed");

  const profileBind = await request("/api/profile/email-binding", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      outboundEmail: "shirley.sender@example.com",
      emailSenderName: "Shirley Sender",
      emailSignature: "Best regards,\\nShirley Sender",
      smtpHost: "smtp.test.local",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "shirley.sender@example.com",
      smtpPassword: "test-smtp-password"
    })
  });
  if (!profileBind.response.ok || profileBind.json.user?.outboundEmail !== "shirley.sender@example.com" || !profileBind.json.user?.hasSmtpPassword) {
    throw new Error("profile email binding failed");
  }

  const profileTestMail = await request("/api/profile/test-email", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ to: "qa.receiver@example.com" })
  });
  if (!profileTestMail.response.ok || !profileTestMail.json.ok || profileTestMail.json.to !== "qa.receiver@example.com") {
    throw new Error("profile smtp test failed");
  }

  const profileMail = await request("/api/profile/send-development-email", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "buyer@example.com",
      company: "Buyer Test GmbH",
      subject: "Instrumentation supplier for your local market",
      body: "Dear Buyer Test GmbH team, we supply pressure and flow instruments for local distributors."
    })
  });
  if (!profileMail.response.ok || profileMail.json.sent?.status !== "sent" || profileMail.json.user?.lastDevelopmentEmailTo !== "buyer@example.com") {
    throw new Error("development email send failed");
  }

  const leadCreate = await request("/api/leads", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      company: "自动化线索工作区 GmbH",
      contact: "Lead Buyer",
      country: "德国",
      email: "lead.buyer@example.com",
      phone: "+49 30 1000 2000",
      wechat: "lead_buyer",
      source: "自测录入",
      sourceType: "inbound",
      sourceChannel: "self-test-api",
      sourceCampaign: "2026 欧洲仪表询盘",
      externalId: `self-test-lead-${Date.now()}`,
      sourceUrl: "https://partner.example/leads/self-test",
      intent: "高",
      estimatedAmount: 32000,
      nextFollowAt: "2026-07-12 10:00",
      remark: "用于验证线索详情、触达、跟进记录和垃圾箱"
    })
  });
  if (!leadCreate.response.ok || leadCreate.json.lead?.company !== "自动化线索工作区 GmbH") throw new Error("lead workspace create failed");
  const testLeadId = leadCreate.json.lead.id;

  const socialTouch = await request(`/api/leads/${testLeadId}/social-touch`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ channel: "whatsapp", message: "确认客户近期采购需求", nextFollowAt: "明天 11:00" })
  });
  if (!socialTouch.response.ok || socialTouch.json.activity?.type !== "whatsapp" || socialTouch.json.lead?.nextFollowAt !== "明天 11:00") {
    throw new Error("lead social touch failed");
  }

  const leadEmail = await request(`/api/leads/${testLeadId}/send-email`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "lead.buyer@example.com",
      subject: "GoodJob 产品资料与报价沟通",
      body: "Dear Lead Buyer, we would like to confirm your specification and prepare a quotation.",
      nextFollowAt: "后天 10:00"
    })
  });
  if (!leadEmail.response.ok || leadEmail.json.sent?.status !== "sent" || leadEmail.json.activity?.type !== "email") {
    throw new Error("lead email send failed");
  }

  const leadDetail = await request(`/api/leads/${testLeadId}`, { headers: { authorization: `Bearer ${salesToken}` } });
  const activityTypes = (leadDetail.json.activities || []).map((activity: { type: string }) => activity.type);
  const sourceEvent = (leadDetail.json.sourceEvents || []).find((event: { leadId: string }) => event.leadId === testLeadId);
  const testLeadOriginalStatus = leadDetail.json.lead?.status;
  if (
    !leadDetail.response.ok
    || !activityTypes.includes("whatsapp")
    || !activityTypes.includes("email")
    || sourceEvent?.channel !== "self-test-api"
    || sourceEvent?.externalId !== leadCreate.json.lead.externalId
    || !String(sourceEvent?.rawPayload || "").includes("2026 欧洲仪表询盘")
  ) {
    throw new Error("lead activity and source event detail failed");
  }

  const externalId = `external-rfq-${Date.now()}`;
  const externalLeadBody = {
    company: "自动化外部平台客户 GmbH",
    contact: "External Buyer",
    country: "德国",
    email: "external.buyer@example.com",
    source: "第三方平台",
    sourceType: "inbound",
    sourceChannel: "partner-api",
    externalId,
    sourceCampaign: "2026 Europe RFQ",
    sourceUrl: "https://partner.example/rfq/123",
    estimatedAmount: 88000,
    rawPayload: { rfqId: 123, product: "流量计" }
  };
  const externalLeadFirst = await request("/api/leads/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify(externalLeadBody)
  });
  const externalLeadSecond = await request("/api/leads/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify(externalLeadBody)
  });
  if (externalLeadFirst.response.status !== 201 || !externalLeadSecond.json.duplicate || externalLeadFirst.json.lead.id !== externalLeadSecond.json.lead.id) {
    throw new Error("external lead ingestion must be idempotent");
  }

  const matchingCustomer = await request("/api/customers", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      company: externalLeadBody.company,
      country: "德国",
      contact: "Existing Buyer",
      documentContact: externalLeadBody.email
    })
  });
  if (!matchingCustomer.response.ok) throw new Error("matching customer create failed");
  const customersBeforeExistingConversion = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  const conversionPreview = await request(`/api/leads/${externalLeadFirst.json.lead.id}/conversion-preview`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!conversionPreview.response.ok || conversionPreview.json.customerMatches?.[0]?.customer?.id !== matchingCustomer.json.customer.id) {
    throw new Error("conversion preview should find existing customer");
  }
  const existingConversion = await request(`/api/leads/${externalLeadFirst.json.lead.id}/convert`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      customerMode: "existing",
      customerId: matchingCustomer.json.customer.id,
      createDeal: true,
      deal: { title: "外部平台流量计 RFQ", product: "流量计", amount: 88000, nextAction: "确认量程与接口" }
    })
  });
  if (!existingConversion.response.ok || existingConversion.json.deal?.customerId !== matchingCustomer.json.customer.id) throw new Error("existing customer conversion failed");
  const customersAfterExistingConversion = await request("/api/customers", { headers: { authorization: `Bearer ${salesToken}` } });
  if (customersAfterExistingConversion.json.customers.length !== customersBeforeExistingConversion.json.customers.length) throw new Error("existing conversion must not duplicate customer");
  const aggregatedCustomer = customersAfterExistingConversion.json.customers.find((customer: { id: string }) => customer.id === matchingCustomer.json.customer.id);
  if (aggregatedCustomer?.pipelineAmount !== 88000 || aggregatedCustomer?.pipelineStage !== "询盘" || aggregatedCustomer?.activeDealCount !== 1) {
    throw new Error("customer pipeline fields must be deal-derived");
  }
  const repeatedConversion = await request(`/api/leads/${externalLeadFirst.json.lead.id}/convert`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ customerMode: "existing", customerId: matchingCustomer.json.customer.id, createDeal: true })
  });
  if (!repeatedConversion.response.ok || !repeatedConversion.json.duplicate || repeatedConversion.json.deal?.id !== existingConversion.json.deal.id) {
    throw new Error("lead conversion must be idempotent");
  }
  const convertedLeadDelete = await request(`/api/leads/${externalLeadFirst.json.lead.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ reason: "已转客户线索不应允许删除" })
  });
  if (convertedLeadDelete.response.status !== 400) throw new Error("converted lead must not be deleted");

  const customerOnlyLead = await request("/api/leads", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ company: `仅客户入库-${Date.now()}`, source: "手动录入" })
  });
  const customerOnlyConversion = await request(`/api/leads/${customerOnlyLead.json.lead.id}/convert`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ customerMode: "create", createDeal: false })
  });
  if (!customerOnlyConversion.response.ok || !customerOnlyConversion.json.customer || customerOnlyConversion.json.deal) {
    throw new Error("customer-only conversion failed");
  }

  const leadTrash = await request(`/api/leads/${testLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ reason: "自测移入垃圾箱" })
  });
  if (
    !leadTrash.response.ok
    || !leadTrash.json.lead?.deletedAt
    || leadTrash.json.lead.deletedReason !== "自测移入垃圾箱"
    || leadTrash.json.lead.deletedBy !== "u_sales_shirley"
    || !leadTrash.json.lead.purgeAt
    || leadTrash.json.lead.statusBeforeDelete !== testLeadOriginalStatus
  ) {
    throw new Error("lead trash audit metadata failed");
  }
  const leadTrashList = await request("/api/leads?trash=true", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!leadTrashList.json.leads.some((lead: { id: string }) => lead.id === testLeadId)) throw new Error("lead trash list failed");
  const leadActiveList = await request("/api/leads", { headers: { authorization: `Bearer ${salesToken}` } });
  if (leadActiveList.json.leads.some((lead: { id: string }) => lead.id === testLeadId)) throw new Error("trashed lead must leave active list");

  const leadRestore = await request(`/api/leads/${testLeadId}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (
    !leadRestore.response.ok
    || leadRestore.json.lead?.deletedAt
    || leadRestore.json.lead?.deletedReason
    || leadRestore.json.lead?.deletedBy
    || leadRestore.json.lead?.purgeAt
    || leadRestore.json.lead?.statusBeforeDelete
    || leadRestore.json.lead?.status !== testLeadOriginalStatus
  ) {
    throw new Error("lead restore metadata and status failed");
  }
  const leadTrashAgain = await request(`/api/leads/${testLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ reason: "自测永久删除前再次移入垃圾箱" })
  });
  if (!leadTrashAgain.response.ok || !leadTrashAgain.json.lead?.deletedAt) throw new Error("lead second trash failed");
  const leadPermanentDelete = await request(`/api/leads/${testLeadId}/permanent`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!leadPermanentDelete.response.ok || !leadPermanentDelete.json.ok || leadPermanentDelete.json.sourceEventsDeleted < 1) {
    throw new Error("lead permanent delete and source event cleanup failed");
  }

  const websitePreview = await request("/api/tools/website-scrape/preview", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ urls: ["https://example.com"] })
  });
  if (!websitePreview.response.ok || !websitePreview.json.opportunities?.[0]?.company) throw new Error("website scrape preview failed");
  const previewOpportunity = websitePreview.json.opportunities[0];

  const websiteSyncBeforeVerify = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ opportunities: [{ ...previewOpportunity, company: "自动化官网商机", business: "压力仪表" }] })
  });
  if (websiteSyncBeforeVerify.response.status !== 400) throw new Error("unverified website opportunity must not sync");

  const websiteVerificationEdit = await request(`/api/prospect-list/${previewOpportunity.id}/details`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      company: "自动化官网商机",
      business: "压力仪表",
      country: previewOpportunity.country,
      website: previewOpportunity.website,
      contact: "Purchasing Team",
      contactInfo: "verified.prospect@example.com",
      description: "人工核验官网与采购邮箱"
    })
  });
  if (!websiteVerificationEdit.response.ok || websiteVerificationEdit.json.opportunity?.contactInfo !== "verified.prospect@example.com") {
    throw new Error("website opportunity verification edit failed");
  }

  const markWebsiteContactable = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [previewOpportunity.id], action: "mark-contactable" })
  });
  if (!markWebsiteContactable.response.ok
    || markWebsiteContactable.json.opportunities?.[0]?.status !== "contactable"
    || !markWebsiteContactable.json.opportunities?.[0]?.verifiedAt) {
    throw new Error("website opportunity verify failed");
  }

  const websiteContactMail = await request(`/api/prospect-list/${previewOpportunity.id}/send-development-email`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "verified.prospect@example.com",
      subject: "Verified prospect outreach",
      body: "Dear team, we can support your verified pressure instrumentation sourcing requirements."
    })
  });
  if (!websiteContactMail.response.ok || websiteContactMail.json.opportunity?.status !== "contacted") {
    throw new Error("prospect email must move contactable opportunity to contacted");
  }

  const websiteSync = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ opportunities: [{ ...websitePreview.json.opportunities[0], company: "自动化官网商机", business: "压力仪表" }] })
  });
  if (!websiteSync.response.ok || websiteSync.json.created?.[0]?.lead?.company !== "自动化官网商机" || websiteSync.json.created?.[0]?.opportunity?.leadId !== websiteSync.json.created?.[0]?.lead?.id) {
    throw new Error("website opportunity sync failed");
  }
  const excludeSyncedWebsite = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [websiteSync.json.created[0].opportunity.id], action: "exclude" })
  });
  if (excludeSyncedWebsite.response.status !== 400) throw new Error("synced opportunity must not be excluded");
  const websiteSyncRepeat = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ opportunities: [{ ...websitePreview.json.opportunities[0], company: "自动化官网商机", business: "压力仪表" }] })
  });
  if (!websiteSyncRepeat.response.ok || !websiteSyncRepeat.json.created?.[0]?.duplicate || websiteSyncRepeat.json.created?.[0]?.lead?.id !== websiteSync.json.created?.[0]?.lead?.id) {
    throw new Error("website opportunity sync must be idempotent");
  }
  const forgedSourceSync = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      opportunities: [{
        id: `website_partner_${Date.now()}`,
        company: "自动化合作目录候选",
        business: "温度仪表",
        country: "德国",
        website: "https://partner.example",
        contact: "Purchasing Team",
        contactInfo: "buyer@partner-source.example",
        description: "客户端伪造的未核验候选不得直接进入线索",
        source: "partner-directory",
        sourceLabel: "合作伙伴目录"
      }]
    })
  });
  if (forgedSourceSync.response.status !== 404) throw new Error("unstored website opportunity must not bypass verification");

  const miaWebsitePreview = await request("/api/tools/website-scrape/preview", {
    method: "POST",
    headers: { authorization: `Bearer ${miaToken}` },
    body: JSON.stringify({ urls: ["https://example.net"] })
  });
  const miaOpportunity = miaWebsitePreview.json.opportunities?.[0];
  if (!miaWebsitePreview.response.ok || !miaOpportunity?.id || miaOpportunity.ownerId !== "u_sales_mia") {
    throw new Error("other salesperson website preview failed");
  }
  const shirleyOpportunities = await request("/api/tools/website-opportunities", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const managerOpportunities = await request("/api/tools/website-opportunities", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (shirleyOpportunities.json.opportunities.some((item: { id: string }) => item.id === miaOpportunity.id)) {
    throw new Error("sales must not read another salesperson website opportunities");
  }
  if (!managerOpportunities.json.opportunities.some((item: { id: string }) => item.id === miaOpportunity.id)) {
    throw new Error("manager should read team website opportunities");
  }
  const crossWebsiteSync = await request("/api/tools/website-scrape/sync-opportunities", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ opportunities: [miaOpportunity] })
  });
  if (crossWebsiteSync.response.status !== 404) {
    throw new Error("sales must not sync another salesperson website opportunity");
  }
  const salesAssignees = await request("/api/prospect-list/assignees", { headers: { authorization: `Bearer ${salesToken}` } });
  const managerAssignees = await request("/api/prospect-list/assignees", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!salesAssignees.response.ok || salesAssignees.json.assignees.length !== 0) throw new Error("sales must not receive prospect assignees");
  if (!managerAssignees.response.ok
    || !managerAssignees.json.assignees.some((item: { id: string }) => item.id === "u_sales_shirley")
    || !managerAssignees.json.assignees.some((item: { id: string }) => item.id === "u_sales_mia")) {
    throw new Error("manager prospect assignees scope failed");
  }
  const salesAssign = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${miaToken}` },
    body: JSON.stringify({ ids: [miaOpportunity.id], action: "assign", ownerId: "u_sales_shirley" })
  });
  if (salesAssign.response.status !== 403) throw new Error("sales must not assign prospect");
  const managerUnknownAssign = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ ids: [miaOpportunity.id], action: "assign", ownerId: "u_sales_outside_team" })
  });
  if (managerUnknownAssign.response.status !== 400) throw new Error("manager must not assign outside available team");
  const managerAssign = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ ids: [miaOpportunity.id], action: "assign", ownerId: "u_sales_shirley" })
  });
  if (!managerAssign.response.ok || managerAssign.json.opportunities?.[0]?.ownerId !== "u_sales_shirley") {
    throw new Error("manager same-team prospect assignment failed");
  }

  const excludedPreview = await request("/api/tools/website-scrape/preview", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ urls: ["https://example.org"] })
  });
  const excludedOpportunity = excludedPreview.json.opportunities?.[0];
  const excludePreview = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [excludedOpportunity.id], action: "exclude", reason: "非目标行业" })
  });
  const restorePreview = await request("/api/prospect-list/batch", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [excludedOpportunity.id], action: "restore" })
  });
  if (!excludePreview.response.ok
    || excludePreview.json.opportunities?.[0]?.status !== "excluded"
    || excludePreview.json.opportunities?.[0]?.excludedReason !== "非目标行业"
    || !restorePreview.response.ok
    || restorePreview.json.opportunities?.[0]?.status !== "preview"
    || restorePreview.json.opportunities?.[0]?.excludedReason) {
    throw new Error("prospect exclude and restore failed");
  }
  const miaSourceCollision = await request("/api/leads/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${miaToken}` },
    body: JSON.stringify({
      company: "Mia 同编号隔离线索",
      source: websiteSync.json.created[0].lead.source,
      sourceType: "outbound",
      sourceChannel: websiteSync.json.created[0].lead.sourceChannel,
      externalId: previewOpportunity.id,
      sourceUrl: `https://mia-source-${Date.now()}.example`
    })
  });
  if (!miaSourceCollision.response.ok
    || miaSourceCollision.json.duplicate
    || miaSourceCollision.json.lead?.ownerId !== "u_sales_mia"
    || miaSourceCollision.json.lead?.id === websiteSync.json.created[0].lead.id) {
    throw new Error("source idempotency must remain isolated by salesperson");
  }

  // 自动获客数据源中心：注册表 / 保存 Key（掩码）/ 删除
  const leadProviders = await request("/api/lead-finder/providers", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const providerList = leadProviders.json.providers || [];
  if (!leadProviders.response.ok || providerList.length < 8) throw new Error("lead providers list failed");
  const freeReady = providerList.filter((item: any) => !item.requiresKey && item.ready).length;
  const hunterMeta = providerList.find((item: any) => item.id === "hunter");
  if (freeReady < 2 || !hunterMeta || hunterMeta.tier !== "paid") throw new Error("lead providers metadata failed");
  const aiSearchMeta = providerList.find((item: any) => item.id === "ai_search");
  if (!aiSearchMeta || aiSearchMeta.tier !== "ai" || aiSearchMeta.requiresKey !== false) throw new Error("ai search source metadata failed");

  const leadSourceSave = await request("/api/lead-finder/source-config", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ provider: "serper", apiKey: "serper-secret-9911", enabled: true })
  });
  const serperStatus = (leadSourceSave.json.providers || []).find((item: any) => item.id === "serper");
  if (!leadSourceSave.response.ok || leadSourceSave.json.config?.apiKey !== "****9911" || !serperStatus?.ready || !serperStatus?.enabled) {
    throw new Error("lead source config save failed");
  }

  const leadSourceReadBack = await request("/api/lead-finder/providers", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const serperReadBack = (leadSourceReadBack.json.providers || []).find((item: any) => item.id === "serper");
  if (!serperReadBack?.hasApiKey || !serperReadBack?.ready) throw new Error("lead source config persist failed");

  const leadSourceDelete = await request("/api/lead-finder/source-config/serper", {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const serperAfterDelete = (leadSourceDelete.json.providers || []).find((item: any) => item.id === "serper");
  if (!leadSourceDelete.response.ok || serperAfterDelete?.hasApiKey) throw new Error("lead source config delete failed");

  const prospectMail = await request(`/api/prospect-list/${websiteSync.json.created[0].opportunity.id}/send-development-email`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      to: "prospect@example.com",
      subject: "Instrumentation supplier support",
      body: "Dear team, we can support your pressure and flow instrumentation sourcing."
    })
  });
  if (!prospectMail.response.ok || prospectMail.json.opportunity?.lastDevelopmentEmailTo !== "prospect@example.com") {
    throw new Error("prospect list development email failed");
  }

  const profileClear = await request("/api/profile/email-binding", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      outboundEmail: "",
      emailSenderName: "",
      emailSignature: "",
      smtpHost: "",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "",
      smtpPassword: "",
      clearSmtpPassword: true
    })
  });
  if (!profileClear.response.ok || profileClear.json.user?.outboundEmail !== "" || profileClear.json.user?.emailSenderName !== "" || profileClear.json.user?.hasSmtpPassword) {
    throw new Error("profile email clear failed");
  }

  const deals = await request("/api/deals", { headers: { authorization: `Bearer ${managerToken}` } });
  if (deals.json.deals.length < 5) throw new Error("manager deals scope failed");

  const newDeal = await request("/api/deals", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c1", title: "自动化新增商机", product: "自动化压力仪表", quantity: 10, unitPrice: 1200, currency: "USD", nextAction: "确认采购清单", nextActionAt: "2026-07-12", expectedCloseAt: "2026-08-15" })
  });
  if (!newDeal.response.ok || newDeal.json.deal.title !== "自动化新增商机" || newDeal.json.deal.amount !== 12000) throw new Error("deal create failed");

  const editedDeal = await request(`/api/deals/${newDeal.json.deal.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c1", title: "自动化编辑商机", product: "自动化温度仪表", quantity: 12, unitPrice: 900, currency: "USD", nextAction: "发送修订报价", nextActionAt: "2026-07-13", expectedCloseAt: "2026-08-15" })
  });
  if (!editedDeal.response.ok || editedDeal.json.deal.product !== "自动化温度仪表" || editedDeal.json.deal.amount !== 10800) throw new Error("deal edit failed");

  const crossDealEdit = await request(`/api/deals/${newDeal.json.deal.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${miaToken}` },
    body: JSON.stringify({ customerId: "c1", title: "越权编辑商机", product: "自动化温度仪表", quantity: 12, unitPrice: 900, currency: "USD", nextAction: "越权", nextActionAt: "2026-07-13", expectedCloseAt: "2026-08-15" })
  });
  if (crossDealEdit.response.status !== 404) throw new Error("sales deal must be owner isolated");

  const invalidJump = await request(`/api/deals/${newDeal.json.deal.id}/stage`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ stage: "谈判", result: "尝试跳阶段", nextAction: "继续推进", nextActionAt: "2026-07-14", expectedCloseAt: "2026-08-15" })
  });
  if (invalidJump.response.status !== 400) throw new Error("manager stage jump should require reason");

  let wonDeal = newDeal;
  for (const [index, targetStage] of ["已联系", "已报价", "样品", "谈判", "成交"].entries()) {
    wonDeal = await request(`/api/deals/${newDeal.json.deal.id}/stage`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({
        stage: targetStage,
        result: `自动化阶段结果 ${targetStage}`,
        nextAction: targetStage === "成交" ? "确认定金与订单交付" : `推进到 ${targetStage} 后续动作`,
        nextActionAt: `2026-07-${String(14 + index).padStart(2, "0")}`,
        expectedCloseAt: targetStage === "已联系" ? "" : "2026-08-15",
        wonReason: targetStage === "成交" ? "客户已确认 PI 与付款条件" : ""
      })
    });
    if (!wonDeal.response.ok) throw new Error(`deal stage failed: ${targetStage}`);
  }
  if (!wonDeal.response.ok || wonDeal.json.deal.stage !== "成交") throw new Error("deal won stage failed");
  const lostAfterWon = await request(`/api/deals/${newDeal.json.deal.id}/stage`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ stage: "丢单", result: "错误操作", nextAction: "无", nextActionAt: "2026-07-20" })
  });
  if (lostAfterWon.response.status !== 400) throw new Error("won deal should not move to lost");
  const archivedDeal = await request(`/api/deals/${newDeal.json.deal.id}/archive`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!archivedDeal.response.ok || !archivedDeal.json.deal.archivedAt) throw new Error("deal archive failed");

  const salesReport = await request("/api/reports/executive", { headers: { authorization: `Bearer ${salesToken}` } });
  const managerReport = await request("/api/reports/executive", { headers: { authorization: `Bearer ${managerToken}` } });
  const adminReport = await request("/api/reports/executive", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!salesReport.response.ok || !managerReport.response.ok || !adminReport.response.ok) throw new Error("executive report request failed");
  if (salesReport.json.scope?.label !== "本人业务") throw new Error("sales report scope label failed");
  if (managerReport.json.scope?.label !== "本团队业务") throw new Error("manager report scope label failed");
  if (adminReport.json.scope?.label !== "全公司业务") throw new Error("admin report scope label failed");
  if (!salesReport.json.period?.start || !salesReport.json.period?.asOf || !salesReport.json.definitions?.length) {
    throw new Error("executive report metadata missing");
  }
  const salesPerformanceOwners = salesReport.json.performance.map((row: { owner: string }) => row.owner);
  const managerPerformanceOwners = managerReport.json.performance.map((row: { owner: string }) => row.owner);
  if (salesPerformanceOwners.some((owner: string) => owner !== "Shirley")) throw new Error("sales report leaks another salesperson");
  if (!managerPerformanceOwners.includes("Shirley") || !managerPerformanceOwners.includes("Mia")) {
    throw new Error("manager report should include team members");
  }
  const reportMoneyCollections = [
    ...salesReport.json.metrics.activePipeline,
    ...salesReport.json.metrics.weightedForecast,
    ...salesReport.json.metrics.riskAmounts
  ];
  if (reportMoneyCollections.some((row: { currency: string; amount: number }) => !row.currency || typeof row.amount !== "number")) {
    throw new Error("report money rows must retain original currency");
  }
  if ("forecastAmount" in salesReport.json.metrics || "riskAmount" in salesReport.json.metrics) {
    throw new Error("report must not expose cross-currency aggregate amount");
  }
  const reportStages: Record<string, number> = { 询盘: 0.05, 已联系: 0.1, 已报价: 0.3, 样品: 0.5, 谈判: 0.7 };
  const salesDeals = await request("/api/deals", { headers: { authorization: `Bearer ${salesToken}` } });
  const expectedWeightedByCurrency = new Map<string, number>();
  salesDeals.json.deals
    .filter((deal: { stage: string; archivedAt?: string }) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单")
    .forEach((deal: { stage: string; currency: string; amount: number }) => {
      expectedWeightedByCurrency.set(deal.currency, (expectedWeightedByCurrency.get(deal.currency) || 0) + deal.amount * (reportStages[deal.stage] || 0));
    });
  for (const row of salesReport.json.metrics.weightedForecast as Array<{ currency: string; amount: number }>) {
    if (Math.abs(row.amount - (expectedWeightedByCurrency.get(row.currency) || 0)) > 0.01) {
      throw new Error("weighted forecast must be reproducible from scoped deals");
    }
  }
  if (!Array.isArray(salesReport.json.riskRows) || salesReport.json.riskRows.some((row: { owner: string }) => row.owner !== "Shirley")) {
    throw new Error("risk rows must follow report scope");
  }

  const commissionProduct = await request("/api/commission/products", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "自动化温度仪表", category: "测试仪表", model: "AUTO-T", defaultPrice: 900, costPrice: 600, remark: "自动化测试产品" })
  });
  if (!commissionProduct.response.ok || commissionProduct.json.product.name !== "自动化温度仪表") throw new Error("commission product create failed");
  const commissionRule = await request(`/api/commission/products/${commissionProduct.json.product.id}/rules`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ruleType: "rate", rate: 0.04, effectiveFrom: "2026-01", remark: "自动化测试 4%" })
  });
  if (!commissionRule.response.ok || commissionRule.json.rule.rate !== 0.04) throw new Error("commission rule create failed");
  const invalidCommissionRule = await request(`/api/commission/products/${commissionProduct.json.product.id}/rules`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ruleType: "rate", rate: 3, effectiveFrom: "2026-01", remark: "错误的 300% 费率" })
  });
  if (invalidCommissionRule.response.status !== 400) throw new Error("commission rate above 100% must be rejected");
  const editedCommissionProduct = await request(`/api/commission/products/${commissionProduct.json.product.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ model: "AUTO-T-EDIT", remark: "自动化测试产品已编辑" })
  });
  if (!editedCommissionProduct.response.ok || editedCommissionProduct.json.product.model !== "AUTO-T-EDIT") throw new Error("commission product edit failed");
  const editedCommissionRule = await request(`/api/commission/rules/${commissionRule.json.rule.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ rate: 0.04, enabled: true, remark: "自动化测试规则已编辑" })
  });
  if (!editedCommissionRule.response.ok || editedCommissionRule.json.rule.remark !== "自动化测试规则已编辑") throw new Error("commission rule edit failed");
  const commissionMonth = archivedDeal.json.deal.archivedAt.slice(0, 7);
  const commissionSync = await request("/api/commission/sales-records/sync-from-deals", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ month: commissionMonth, ownerId: "u_sales_shirley" })
  });
  const commissionRecord = commissionSync.json.records?.find((item: { dealId: string }) => item.dealId === newDeal.json.deal.id);
  if (!commissionSync.response.ok || !commissionRecord) throw new Error("commission sync from archived deal failed");
  const crossCommissionRead = await request(`/api/commission/sales-records?month=${commissionMonth}&ownerId=u_sales_shirley`, {
    headers: { authorization: `Bearer ${miaToken}` }
  });
  if (crossCommissionRead.response.status !== 403) throw new Error("sales must not read another salesperson commission records");
  const adminCommissionRead = await request(`/api/commission/sales-records?month=${commissionMonth}&ownerId=u_sales_shirley`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!adminCommissionRead.response.ok || !adminCommissionRead.json.records.some((item: { id: string }) => item.id === commissionRecord.id) || !adminCommissionRead.json.canSelectOwner) {
    throw new Error("admin should select salesperson commission records");
  }
  const editedCommissionRecord = await request(`/api/commission/sales-records/${commissionRecord.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      unitPrice: 950,
      salesAmount: 11400,
      currency: "USD",
      exchangeRate: 7.2,
      exchangeRateDate: "2026-07-10",
      exchangeRateSource: "finance",
      basisType: "receipt",
      basisDate: "2026-07-10",
      editNote: "自测：按实际回款和财务汇率调整"
    })
  });
  if (!editedCommissionRecord.response.ok || !editedCommissionRecord.json.record.edited || editedCommissionRecord.json.record.settlementAmount !== 82080) {
    throw new Error("commission record currency conversion or edit audit failed");
  }
  const confirmedCommissionRecord = await request(`/api/commission/sales-records/${commissionRecord.id}/confirm`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!confirmedCommissionRecord.response.ok || confirmedCommissionRecord.json.record.status !== "confirmed") throw new Error("commission record confirm failed");
  const commissionAudits = await request(`/api/commission/sales-records/${commissionRecord.id}/audits`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!commissionAudits.response.ok || !commissionAudits.json.audits.length) throw new Error("commission audits read failed");
  const commissionRecalc = await request("/api/commission/calculations/recalculate", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ month: commissionMonth, ownerId: "u_sales_shirley" })
  });
  const commissionCalculation = commissionRecalc.json.calculations?.find((item: { ownerId: string }) => item.ownerId === archivedDeal.json.deal.ownerId);
  if (!commissionRecalc.response.ok || !commissionCalculation || commissionCalculation.autoCommission !== 3283.2 || commissionCalculation.salesAmount !== 82080) {
    throw new Error("commission exact calculation failed");
  }
  const calculatedItem = commissionRecalc.json.items?.find((item: { recordId: string }) => item.recordId === commissionRecord.id);
  if (!calculatedItem?.ruleSnapshotJson?.includes("82080 × 4% = 3283.2")) throw new Error("commission calculation snapshot must explain formula");
  const salesManualCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/manual-item`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ itemType: "bonus", manualAmount: 50, remark: "越权奖金项" })
  });
  if (salesManualCommission.response.status !== 403) throw new Error("sales must not adjust commission manually");
  const commissionManual = await request(`/api/commission/calculations/${commissionCalculation.id}/manual-item`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ itemType: "bonus", manualAmount: 50, recordId: commissionRecord.id, remark: "自测奖金项" })
  });
  if (!commissionManual.response.ok || commissionManual.json.calculation.finalCommission <= commissionCalculation.finalCommission) throw new Error("commission manual item failed");
  const reviewedCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/review`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!reviewedCommission.response.ok || reviewedCommission.json.calculation.status !== "reviewed") throw new Error("commission review failed");
  const lockedCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/lock`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!lockedCommission.response.ok || lockedCommission.json.calculation.status !== "locked") throw new Error("commission lock failed");
  const editLockedCommissionRecord = await request(`/api/commission/sales-records/${commissionRecord.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ salesAmount: 12000, editNote: "锁定后越权修改" })
  });
  if (editLockedCommissionRecord.response.status !== 400) throw new Error("locked commission record must reject edit");
  const recalcLockedCommission = await request("/api/commission/calculations/recalculate", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ month: commissionMonth, ownerId: "u_sales_shirley" })
  });
  if (recalcLockedCommission.response.status !== 409) throw new Error("locked commission must reject recalculate");
  const adjustLockedCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/manual-item`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ itemType: "bonus", manualAmount: 1, remark: "锁定后调整" })
  });
  if (adjustLockedCommission.response.status !== 400) throw new Error("locked commission must reject manual adjustment");
  const commissionExport = await request("/api/commission/export", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ month: commissionMonth, ownerId: "u_sales_shirley", scopeType: "self", fileType: "xlsx" })
  });
  if (!commissionExport.response.ok || !commissionExport.json.rows?.length || commissionExport.json.rows.some((row: Record<string, unknown>) => "finalCommission" in row)) {
    throw new Error("commission detail export must not repeat monthly final commission");
  }
  if (commissionExport.json.summaryRows?.length !== 1 || commissionExport.json.summaryRows[0].finalCommission !== commissionManual.json.calculation.finalCommission) {
    throw new Error("commission summary export failed");
  }
  const salesUnlockCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/unlock`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ reason: "销售越权解锁测试" })
  });
  if (salesUnlockCommission.response.status !== 403) throw new Error("sales must not unlock commission calculation");
  const unlockedCommission = await request(`/api/commission/calculations/${commissionCalculation.id}/unlock`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: "自测需要修正财务汇率" })
  });
  if (!unlockedCommission.response.ok || unlockedCommission.json.calculation.version !== 2 || unlockedCommission.json.historyCalculation.isCurrent !== false) {
    throw new Error("commission unlock must preserve history and create new version");
  }

  const lostDeal = await request("/api/deals", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ customerId: "c2", title: "自动化丢单商机", product: "测试样品", quantity: 8, unitPrice: 1000, currency: "USD", nextAction: "确认客户最终选择", nextActionAt: "2026-07-12", expectedCloseAt: "2026-08-20" })
  });
  const markedLost = await request(`/api/deals/${lostDeal.json.deal.id}/lost`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ category: "价格原因", reason: "客户选择了更低价竞品", revisitAt: "2026-10-01" })
  });
  if (!markedLost.response.ok || markedLost.json.deal.stage !== "丢单" || !markedLost.json.deal.closedAt || markedLost.json.deal.lostReasonCategory !== "价格原因") throw new Error("deal lost failed");

  const stage = await request("/api/deals/d1/stage", {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ stage: "样品", result: "客户同意先做样品测试", nextAction: "确认样品寄出", nextActionAt: "2026-07-14", expectedCloseAt: "2026-07-25" })
  });
  if (!stage.response.ok || stage.json.deal.stage !== "样品") throw new Error("deal stage update failed");

  const dealsAfterWorkflow = await request("/api/deals", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!dealsAfterWorkflow.json.events.some((event: { dealId: string; type: string }) => event.dealId === newDeal.json.deal.id && event.type === "won")) throw new Error("deal events should persist workflow history");
  const closedDeals = await request("/api/deals/closed?page=1&pageSize=5&status=丢单&keyword=自动化丢单", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!closedDeals.response.ok || closedDeals.json.total < 1 || closedDeals.json.deals[0]?.lostReasonCategory !== "价格原因") throw new Error("closed deal query failed");

  const salesLeadScope = await request("/api/leads", { headers: { authorization: `Bearer ${salesToken}` } });
  const salesLeadTrashScope = await request("/api/leads?trash=true", { headers: { authorization: `Bearer ${salesToken}` } });
  const dashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!dashboard.response.ok || !dashboard.json.briefing?.title || !Array.isArray(dashboard.json.schedule)) throw new Error("dashboard summary aggregation failed");
  if (!Array.isArray(dashboard.json.leadFunnel?.stages) || dashboard.json.leadFunnel.stages.length !== 5) throw new Error("lead funnel aggregation failed");
  if (dashboard.json.leadFunnel.stages[0]?.count !== salesLeadScope.json.leads.length) throw new Error("sales lead funnel must show the current salesperson's active visible lead scope");
  if (dashboard.json.leadFunnel.filteredOut !== salesLeadTrashScope.json.leads.length) throw new Error("sales lead funnel must report filtered leads separately");
  if (dashboard.json.leadFunnel.stages.some((stage: { count: number; conversionRate: number }) => stage.count < 0 || stage.conversionRate < 0 || stage.conversionRate > 100)) throw new Error("lead funnel values must stay within valid ranges");
  if (!dashboard.json.briefing?.basis || !dashboard.json.briefing?.action || !dashboard.json.briefing?.impact) throw new Error("dashboard briefing guidance failed");
  if (dashboard.json.scopeLabels?.business !== "本人业务" || dashboard.json.scopeLabels?.todos !== "本人待办") throw new Error("sales dashboard scope labels failed");
  if (dashboard.json.briefing?.riskLabel !== "本人名下风险") throw new Error("sales dashboard risk label failed");
  if (!dashboard.json.periods?.today || !dashboard.json.periods?.week || !dashboard.json.periods?.month) throw new Error("dashboard period summaries missing");
  for (const period of Object.values(dashboard.json.periods) as Array<Record<string, unknown>>) {
    if (typeof period.pendingTodos !== "number" || typeof period.highPriorityTodos !== "number" || typeof period.newLeads !== "number") {
      throw new Error("dashboard period activity metrics missing");
    }
    const briefing = period.briefing as Record<string, unknown>;
    if (!briefing?.title || !briefing?.description || !briefing?.basis || !briefing?.action || !briefing?.impact) {
      throw new Error("dashboard period briefing missing");
    }
  }
  const salesVisibleDealIds = new Set(salesDeals.json.deals.map((deal: { id: string }) => deal.id));
  const expectedSalesMonthDeals = salesDeals.json.deals.filter((deal: { expectedCloseAt?: string; stage: string; archivedAt?: string }) =>
    !deal.archivedAt &&
    deal.stage !== "成交" &&
    deal.stage !== "丢单" &&
    Boolean(deal.expectedCloseAt) &&
    deal.expectedCloseAt!.slice(0, 7) === dashboard.json.periods.month.start.slice(0, 7)
  );
  if (dashboard.json.periods.month.expectedDeals !== expectedSalesMonthDeals.length) throw new Error("sales dashboard month forecast count failed");
  const expectedSalesMonthAmounts = new Map<string, number>();
  expectedSalesMonthDeals.forEach((deal: { currency?: string; amount: number }) => {
    const currency = deal.currency || "未设置";
    expectedSalesMonthAmounts.set(currency, (expectedSalesMonthAmounts.get(currency) || 0) + deal.amount);
  });
  if (dashboard.json.periods.month.expectedAmounts.some((row: { currency: string; amount: number }) => !row.currency || typeof row.amount !== "number")) {
    throw new Error("dashboard period forecast must retain currency");
  }
  if (dashboard.json.periods.month.expectedAmounts.length !== expectedSalesMonthAmounts.size) throw new Error("dashboard period forecast currency grouping failed");
  for (const row of dashboard.json.periods.month.expectedAmounts as Array<{ currency: string; amount: number }>) {
    if (row.amount !== expectedSalesMonthAmounts.get(row.currency)) throw new Error("dashboard period forecast amount must match scoped deals");
  }
  if (expectedSalesMonthDeals.some((deal: { id: string }) => !salesVisibleDealIds.has(deal.id))) throw new Error("dashboard period forecast leaks another salesperson");
  if (typeof dashboard.json.metrics?.riskCustomers !== "number") throw new Error("dashboard risk customer metric failed");
  if (typeof dashboard.json.metrics?.wecomBoundRate !== "number" || typeof dashboard.json.todoInsights?.completionRate !== "number") throw new Error("dashboard metrics aggregation failed");
  if (!Array.isArray(dashboard.json.pipelineHealth) || typeof dashboard.json.pipelineHealth[0]?.count !== "number") throw new Error("pipeline health aggregation failed");
  if (dashboard.json.pipelineHealth.some((item: { stage: string }) => item.stage === "丢单")) throw new Error("pipeline health should exclude lost deals");
  if (dashboard.json.pipelineHealth.some((item: { stage: string }) => item.stage === "成交")) throw new Error("pipeline health should exclude won deals");
  if (dashboard.json.pipelineHealth.some((item: { count: number; width: number }) => item.count === 0 && item.width !== 0)) throw new Error("empty pipeline stages should have zero width");
  if (!dashboard.json.priorityTasks?.[0]?.reason || typeof dashboard.json.priorityTasks?.[0]?.score !== "number") throw new Error("priority task scoring failed");

  const managerDashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerDashboard.response.ok || managerDashboard.json.scope !== "团队业务数据，本人待办") throw new Error("manager dashboard scope failed");
  if (managerDashboard.json.scopeLabels?.business !== "团队业务" || managerDashboard.json.scopeLabels?.todos !== "本人待办" || managerDashboard.json.briefing?.riskLabel !== "团队风险金额") throw new Error("manager dashboard scope labels failed");
  if (managerDashboard.json.periods.month.expectedDeals < dashboard.json.periods.month.expectedDeals) throw new Error("manager dashboard period scope should include the salesperson");
  const adminDashboard = await request("/api/dashboard/summary", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminDashboard.response.ok || adminDashboard.json.scope !== "全局业务数据，本人待办") throw new Error("admin dashboard personal todo scope failed");
  if (adminDashboard.json.scopeLabels?.business !== "全局业务" || adminDashboard.json.scopeLabels?.todos !== "本人待办" || adminDashboard.json.briefing?.riskLabel !== "全局风险金额") throw new Error("admin dashboard scope labels failed");

  const priorityBatch = await request("/api/dashboard/priority-tasks/batch-process", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!priorityBatch.response.ok || !Array.isArray(priorityBatch.json.created)) throw new Error("priority batch process failed");
  if (priorityBatch.json.created.some((item: { ownerId: string }) => item.ownerId !== "u_sales_shirley")) throw new Error("priority batch should create personal todos only");

  const managerTodos = await request("/api/todos", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerTodos.response.ok || managerTodos.json.todos.some((item: { ownerId: string }) => item.ownerId !== "u_manager_alex")) throw new Error("manager should only see own todos");
  const adminTodos = await request("/api/todos", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminTodos.response.ok || adminTodos.json.todos.some((item: { ownerId: string }) => item.ownerId !== "u_admin")) throw new Error("admin should only see own todos");

  const planTask = await request("/api/plan-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      title: "自动化计划任务",
      phase: "客户开发",
      category: "仪表开拓",
      priority: "high",
      status: "planned",
      dueAt: "2026-07-13T18:00",
      target: "完成自动化计划任务自测",
      description: "验证计划任务可新增、编辑、持久化和权限隔离",
      customerId: "c1",
      dealId: "d1"
    })
  });
  if (!planTask.response.ok || planTask.json.task.ownerId !== "u_sales_shirley" || planTask.json.task.customerId !== "c1" || planTask.json.task.dealId !== "d1") throw new Error("plan task create failed");
  const editedPlanTask = await request(`/api/plan-tasks/${planTask.json.task.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ status: "active", target: "已更新验收目标" })
  });
  if (!editedPlanTask.response.ok || editedPlanTask.json.task.status !== "active" || editedPlanTask.json.task.target !== "已更新验收目标") throw new Error("plan task edit failed");
  const bypassPlanTaskCompletion = await request(`/api/plan-tasks/${planTask.json.task.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ status: "done" })
  });
  if (bypassPlanTaskCompletion.response.ok) throw new Error("plan task completion should require dedicated action");
  const mismatchedPlanTask = await request("/api/plan-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "错误客户商机关联", dueAt: "2026-07-13T19:00", customerId: "c3", dealId: "d1" })
  });
  if (mismatchedPlanTask.response.ok) throw new Error("plan task should reject mismatched customer and deal");
  const mixedLeadPlanTask = await request("/api/plan-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "错误线索客户关联", dueAt: "2026-07-13T19:00", leadId: "l1", customerId: "c1" })
  });
  if (mixedLeadPlanTask.response.ok) throw new Error("plan task should reject lead mixed with customer");
  const completedPlanTask = await request(`/api/plan-tasks/${planTask.json.task.id}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ result: "报价已重发，客户确认收到" })
  });
  if (!completedPlanTask.response.ok || completedPlanTask.json.task.status !== "done" || !completedPlanTask.json.task.completedAt || completedPlanTask.json.task.completionResult !== "报价已重发，客户确认收到") throw new Error("plan task complete failed");
  const miaPlanTasks = await request("/api/plan-tasks", { headers: { authorization: `Bearer ${miaToken}` } });
  if (!miaPlanTasks.response.ok || miaPlanTasks.json.tasks.some((item: { id: string }) => item.id === planTask.json.task.id)) throw new Error("other sales should not see personal plan tasks");
  const managerPlanTasks = await request("/api/plan-tasks", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerPlanTasks.response.ok || managerPlanTasks.json.tasks.some((item: { id: string }) => item.id === planTask.json.task.id)) throw new Error("manager should not see personal plan tasks");
  const deletedPlanTask = await request(`/api/plan-tasks/${planTask.json.task.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedPlanTask.response.ok || deletedPlanTask.json.ok !== true) throw new Error("plan task delete failed");

  const cancelledPlanTask = await request("/api/plan-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "取消与改期自测", dueAt: "2026-07-13T08:00", leadId: "l1" })
  });
  if (!cancelledPlanTask.response.ok || cancelledPlanTask.json.task.leadId !== "l1") throw new Error("lead-linked plan task create failed");
  const rescheduledPlanTask = await request(`/api/plan-tasks/${cancelledPlanTask.json.task.id}/reschedule`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ dueAt: "2026-07-14T09:30", reason: "客户要求次日沟通" })
  });
  if (!rescheduledPlanTask.response.ok || rescheduledPlanTask.json.task.dueAt !== "2026-07-14T09:30" || rescheduledPlanTask.json.task.rescheduledFrom !== "2026-07-13T08:00") throw new Error("plan task reschedule failed");
  const cancelledResult = await request(`/api/plan-tasks/${cancelledPlanTask.json.task.id}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ reason: "线索确认无效，不再跟进" })
  });
  if (!cancelledResult.response.ok || cancelledResult.json.task.status !== "cancelled" || !cancelledResult.json.task.cancelledAt || cancelledResult.json.task.cancellationReason !== "线索确认无效，不再跟进") throw new Error("plan task cancel failed");
  await request(`/api/plan-tasks/${cancelledPlanTask.json.task.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });

  const planTemplates = await request("/api/plan-templates", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!planTemplates.response.ok || planTemplates.json.templates.length < 15) throw new Error("plan templates seed failed");
  if (!planTemplates.json.templates.some((item: { section: string }) => item.section === "execution")) throw new Error("execution templates seed failed");
  const templateId = planTemplates.json.templates[0].id;
  const editedTemplate = await request(`/api/plan-templates/${templateId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化模板编辑", summary: "模板编辑自测", sortOrder: 1 })
  });
  if (!editedTemplate.response.ok || editedTemplate.json.template.title !== "自动化模板编辑") throw new Error("plan template edit failed");
  const deletedTemplate = await request(`/api/plan-templates/${templateId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedTemplate.response.ok || deletedTemplate.json.ok !== true) throw new Error("plan template delete failed");

  const reminders = await request("/api/reminders", { headers: { authorization: `Bearer ${salesToken}` } });
  if (reminders.json.reminders.length < 2) throw new Error("reminders scope failed");

  const reminder = await request("/api/reminders", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "手工提醒规则", ruleType: "inactive_customer", targetStage: "已报价", days: 0, dueAt: "按触发日期生成", channel: "站内", priority: "high" })
  });
  if (!reminder.response.ok || reminder.json.reminder.title !== "手工提醒规则" || reminder.json.reminder.status !== "enabled" || reminder.json.reminder.targetOwnerId !== "u_sales_shirley") throw new Error("reminder create failed");
  const reminderPreview = await request(`/api/reminders/${reminder.json.reminder.id}/preview`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!reminderPreview.response.ok || typeof reminderPreview.json.creatableCount !== "number") throw new Error("reminder preview failed");
  const reminderRun = await request(`/api/reminders/${reminder.json.reminder.id}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!reminderRun.response.ok || reminderRun.json.reminder.lastRunBy !== "u_sales_shirley" || reminderRun.json.reminder.lastMatchedCount !== reminderRun.json.matchedCount) throw new Error("reminder rule run failed");
  const managerReminderRun = await request(`/api/reminders/${reminder.json.reminder.id}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (managerReminderRun.response.status !== 403) throw new Error("manager must not execute salesperson personal reminder rule");
  const reminderRunAgain = await request(`/api/reminders/${reminder.json.reminder.id}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!reminderRunAgain.response.ok || reminderRunAgain.json.createdCount !== 0 || reminderRunAgain.json.skippedCount !== reminderRunAgain.json.matchedCount) throw new Error("reminder stable dedupe failed");
  const salesReminderTodos = await request("/api/todos", { headers: { authorization: `Bearer ${salesToken}` } });
  const generatedReminderTodo = salesReminderTodos.json.todos.find((item: { reminderRuleId?: string }) => item.reminderRuleId === reminder.json.reminder.id);
  if (!generatedReminderTodo || generatedReminderTodo.ownerId !== "u_sales_shirley" || !generatedReminderTodo.customerId || !generatedReminderTodo.triggerKey || generatedReminderTodo.historyAt) throw new Error(`reminder todo ownership or linkage failed: ${JSON.stringify({ run: reminderRun.json, todo: generatedReminderTodo })}`);
  const managerReminderTodos = await request("/api/todos", { headers: { authorization: `Bearer ${managerToken}` } });
  if (managerReminderTodos.json.todos.some((item: { reminderRuleId?: string }) => item.reminderRuleId === reminder.json.reminder.id)) throw new Error("manager should not receive sales reminder todo");
  const reminderSnoozed = await request(`/api/todos/${generatedReminderTodo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ dueAt: "2026-07-20 09:00", snoozeReason: "客户要求下周联系" })
  });
  if (!reminderSnoozed.response.ok || reminderSnoozed.json.todo.snoozeCount !== 1 || !reminderSnoozed.json.todo.snoozedFrom) throw new Error("reminder snooze audit failed");
  const reminderCompleted = await request(`/api/todos/${generatedReminderTodo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ done: true, completionResult: "客户已回复，等待确认数量" })
  });
  if (!reminderCompleted.response.ok || !reminderCompleted.json.todo.completedAt || reminderCompleted.json.todo.completionResult !== "客户已回复，等待确认数量") throw new Error("reminder completion audit failed");
  const reminderDelete = await request(`/api/todos/${generatedReminderTodo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (reminderDelete.response.ok) throw new Error("reminder todo must not be physically deleted");
  const reminderToggle = await request(`/api/reminders/${reminder.json.reminder.id}/toggle`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!reminderToggle.response.ok || reminderToggle.json.reminder.enabled !== false || reminderToggle.json.reminder.status !== "disabled") throw new Error("reminder toggle failed");

  const todo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "可撤回待办", type: "other", priority: "normal", dueAt: "现在", related: "自测" })
  });
  if (!todo.response.ok || todo.json.todo.done !== false) throw new Error("todo create failed");

  const todoDone = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ done: true })
  });
  if (!todoDone.response.ok || todoDone.json.todo.done !== true) throw new Error("todo complete toggle failed");

	  const todoUndone = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ done: false })
  });
	  if (!todoUndone.response.ok || todoUndone.json.todo.done !== false) throw new Error("todo undo failed");

  const todoStarted = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ status: "in_progress" })
  });
  if (!todoStarted.response.ok || todoStarted.json.todo.status !== "in_progress") throw new Error("todo in-progress status failed");

  const todoOrdered = await request("/api/todos/reorder", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ ids: [todo.json.todo.id], mode: "top", targetId: todo.json.todo.id })
  });
  if (!todoOrdered.response.ok || todoOrdered.json.todos[0].pinState !== "top" || todoOrdered.json.todos[0].sortOrder !== 1) throw new Error("todo reorder failed");

  const archivedTodo = await request("/api/todos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动归档待办", type: "other", priority: "normal", dueAt: "昨天 23:00", related: "归档自测" })
  });
  if (!archivedTodo.response.ok || !archivedTodo.json.todo.historyAt) throw new Error("todo should archive when due date is past");
  const restoredTodo = await request(`/api/todos/${archivedTodo.json.todo.id}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!restoredTodo.response.ok || restoredTodo.json.todo.historyAt) throw new Error("todo restore from history failed");
  await request(`/api/todos/${archivedTodo.json.todo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });

  const todoDeleted = await request(`/api/todos/${todo.json.todo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!todoDeleted.response.ok || todoDeleted.json.ok !== true) throw new Error("todo delete failed");

  const problem = await request("/api/problems", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      title: "自动化问题清单",
      category: "报价跟进",
      severity: "high",
      rootCause: "客户审批缺少资料",
      solution: "补齐证书并二次确认",
      nextAction: "今天完成复盘"
    })
  });
  if (!problem.response.ok || problem.json.problem.title !== "自动化问题清单") throw new Error("problem create failed");

  const resolvedProblem = await request(`/api/problems/${problem.json.problem.id}/status`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ status: "resolved" })
  });
  if (!resolvedProblem.response.ok || resolvedProblem.json.problem.status !== "resolved") throw new Error("problem status failed");

  const memo = await request("/api/memos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化备忘录", content: "记录客户临时要求", category: "客户备忘", tags: "自动化,客户", dealId: "d1" })
  });
  if (!memo.response.ok || memo.json.memo.title !== "自动化备忘录" || memo.json.memo.customerId !== "c1") throw new Error("memo create or relation failed");

  const pinnedMemo = await request(`/api/memos/${memo.json.memo.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ pinned: true })
  });
  if (!pinnedMemo.response.ok || pinnedMemo.json.memo.pinned !== true) throw new Error("memo pin failed");

  const deletedMemo = await request(`/api/memos/${memo.json.memo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!deletedMemo.response.ok || !deletedMemo.json.memo.deletedAt) throw new Error("memo soft delete failed");

  const visibleMemos = await request("/api/memos", { headers: { authorization: `Bearer ${salesToken}` } });
  if (visibleMemos.json.memos.some((item: { id: string }) => item.id === memo.json.memo.id)) throw new Error("deleted memo should not remain active");
  const deletedMemos = await request("/api/memos?trash=true", { headers: { authorization: `Bearer ${salesToken}` } });
  if (!deletedMemos.json.memos.some((item: { id: string }) => item.id === memo.json.memo.id)) throw new Error("deleted memo should be visible in personal trash");
  const managerDeletedMemos = await request("/api/memos?trash=true", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerDeletedMemos.response.ok
    || managerDeletedMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_manager_alex")
    || managerDeletedMemos.json.memos.some((item: { id: string }) => item.id === memo.json.memo.id)) {
    throw new Error("manager should only see own memo trash");
  }
  const adminDeletedMemos = await request("/api/memos?trash=true", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminDeletedMemos.response.ok
    || adminDeletedMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_admin")
    || adminDeletedMemos.json.memos.some((item: { id: string }) => item.id === memo.json.memo.id)) {
    throw new Error("admin should only see own memo trash");
  }
  const managerDeleteSalesMemo = await request(`/api/memos/${memo.json.memo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (managerDeleteSalesMemo.response.status !== 404) throw new Error("manager must not delete salesperson memo");
  const managerRestoreSalesMemo = await request(`/api/memos/${memo.json.memo.id}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (managerRestoreSalesMemo.response.status !== 404) throw new Error("manager must not restore salesperson memo");

  const restoredMemo = await request(`/api/memos/${memo.json.memo.id}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!restoredMemo.response.ok || restoredMemo.json.memo.deletedAt) throw new Error("memo restore failed");

  await request(`/api/memos/${memo.json.memo.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  const permanentlyDeletedMemo = await request(`/api/memos/${memo.json.memo.id}/permanent`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!permanentlyDeletedMemo.response.ok || permanentlyDeletedMemo.json.ok !== true) throw new Error("memo permanent delete failed");

  const invalidMemoRelation = await request("/api/memos", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "错误关联备忘", customerId: "c2", dealId: "d1" })
  });
  if (invalidMemoRelation.response.status !== 400) throw new Error("memo relation mismatch should be rejected");

  const managerMemos = await request("/api/memos", { headers: { authorization: `Bearer ${managerToken}` } });
  if (!managerMemos.response.ok || managerMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_manager_alex")) throw new Error("manager should only see own memos");
  const adminMemos = await request("/api/memos", { headers: { authorization: `Bearer ${adminToken}` } });
  if (!adminMemos.response.ok || adminMemos.json.memos.some((item: { ownerId: string }) => item.ownerId !== "u_admin")) throw new Error("admin should only see own memos");

  const competitor = await request("/api/competitors", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ company: "Auto Competitor", country: "德国", segment: "电动工具", threatLevel: "high", competingProducts: "电钻套装", ourStrategy: "小批量定制" })
  });
  if (!competitor.response.ok || competitor.json.competitor.company !== "Auto Competitor") throw new Error("competitor create failed");

  const competitorThreat = await request(`/api/competitors/${competitor.json.competitor.id}/threat`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ threatLevel: "low" })
  });
  if (!competitorThreat.response.ok || competitorThreat.json.competitor.threatLevel !== "low") throw new Error("competitor threat failed");

  const caseStudy = await request("/api/case-studies", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "自动化成功案例", customer: "Nordic Tools AB", product: "工具套装", result: "拿下首单", story: "资料齐全后成交", reusablePoints: "资料先行" })
  });
  if (!caseStudy.response.ok || caseStudy.json.caseStudy.title !== "自动化成功案例") throw new Error("case study create failed");

  const publishedCase = await request(`/api/case-studies/${caseStudy.json.caseStudy.id}/publish`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!publishedCase.response.ok || publishedCase.json.caseStudy.status !== "published") throw new Error("case study publish failed");

  const customerImport = await request("/api/import-export/customers/import", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      fileName: "self-test-customers.xlsx",
      rows: [
        { company: `自动化导入客户-${Date.now()}`, country: "德国", contact: "Import Buyer", stage: "询盘", amount: 19000, health: 76, nextReminder: "明天 10:00", wecomBound: true },
        { company: "Nordic Tools AB", country: "瑞典", contact: "Emma Import", stage: "已报价", amount: 36000, health: 68, nextReminder: "今天 18:00", wecomBound: true }
      ]
    })
  });
  if (!customerImport.response.ok || customerImport.json.result.created !== 1 || customerImport.json.result.updated !== 1) throw new Error("customer import failed");
  const customerExport = await request("/api/import-export/customers/export", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!customerExport.response.ok || !Array.isArray(customerExport.json.customers) || customerExport.json.customers.length < 1) throw new Error("customer export failed");

  const tradeDocument = await request("/api/trade-documents", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      type: "CI",
      title: "自动化商业发票",
      number: `CI-${Date.now()}`,
      issueDate: "2026-07-06",
      buyer: "Automation Buyer Ltd.",
      buyerAddress: "Berlin, Germany",
      buyerContact: "Auto Buyer",
      seller: "GoodJob Instrument Co., Ltd.",
      sellerAddress: "Tianjin, China",
      currency: "USD",
      incoterm: "FOB Tianjin",
      paymentTerm: "30% T/T deposit, 70% before shipment",
      shippingMethod: "Sea freight",
      portLoading: "Tianjin",
      portDischarge: "Hamburg",
      validityDate: "2026-07-20",
      bankInfo: "Bank of China",
      notes: "Automation document test",
      templateStyle: "executive",
      status: "ready",
      items: [
        { product: "Pressure Transmitter", model: "GJ-PT", hsCode: "902620", quantity: 3, unit: "PCS", unitPrice: 180, originCountry: "China", weightKg: 5, packageCount: 1 }
      ]
    })
  });
  if (!tradeDocument.response.ok || tradeDocument.json.document.type !== "CI") throw new Error("trade document create failed");

  const tradeDocuments = await request("/api/trade-documents", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!tradeDocuments.response.ok || !tradeDocuments.json.documents.some((item: { id: string }) => item.id === tradeDocument.json.document.id)) throw new Error("trade document list failed");

  const tradeDocumentSubmit = await request(`/api/trade-documents/${tradeDocument.json.document.id}/submit-approval`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ note: "业务自测提交审批" })
  });
  if (!tradeDocumentSubmit.response.ok || tradeDocumentSubmit.json.document.status !== "pending_approval") throw new Error("trade document submit approval failed");

  const tradeDocumentApprove = await request(`/api/trade-documents/${tradeDocument.json.document.id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ note: "业务自测审批通过" })
  });
  if (!tradeDocumentApprove.response.ok || tradeDocumentApprove.json.document.status !== "approved") throw new Error("trade document approval failed");

  const tradeDocumentExport = await request(`/api/trade-documents/${tradeDocument.json.document.id}/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!tradeDocumentExport.response.ok || tradeDocumentExport.json.document.status !== "exported") throw new Error("trade document export failed");

  const examDetail = await request("/api/exams/e1/detail", {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!examDetail.response.ok || !Array.isArray(examDetail.json.questions) || examDetail.json.questions.length < 1) {
    throw new Error("exam detail failed");
  }
  if (examDetail.json.questions.some((question: { answerIndex: number; answerIndexes?: number[]; explanation?: string }) =>
    question.answerIndex !== -1 || question.answerIndexes?.length || question.explanation
  )) {
    throw new Error("sales exam detail must redact answers");
  }
  const managerExamDetail = await request("/api/exams/e1/detail", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!managerExamDetail.response.ok || managerExamDetail.json.questions.length !== examDetail.json.questions.length) {
    throw new Error("manager exam detail failed");
  }
  const examAnswers = Object.fromEntries(
    managerExamDetail.json.questions.map((question: { id: string; answerIndex: number; answerIndexes?: number[] }) => [
      question.id,
      question.answerIndexes?.length ? question.answerIndexes : question.answerIndex
    ])
  );
  const exam = await request("/api/exams/e1/submit", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ answers: examAnswers })
  });
  if (!exam.response.ok || exam.json.attempt.passed !== true || exam.json.attempt.score !== 100) throw new Error("exam submit failed");

  const salesQuestionForbidden = await request("/api/exam-questions", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      stem: "销售不能维护题库？",
      category: "权限测试",
      options: ["能", "不能"],
      answerIndex: 1,
      explanation: "销售只能参加考试，不能维护题库。",
      difficulty: "easy"
    })
  });
  if (salesQuestionForbidden.response.status !== 403) throw new Error("sales must not maintain question bank");

  const salesExamForbidden = await request("/api/exams", {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ title: "销售不能发布考试", category: "权限测试", questionIds: ["q1"] })
  });
  if (salesExamForbidden.response.status !== 403) throw new Error("sales must not create exams");

  const bankQuestion = await request("/api/exam-questions", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      stem: "压力仪表报价前必须优先确认哪组参数？",
      category: "仪表产品",
      options: ["量程、精度、接口、介质和工况", "客户公司人数", "包装颜色", "输出信号与供电"],
      answerIndex: 0,
      answerIndexes: [0, 3],
      questionType: "multiple",
      tags: ["仪表", "报价", "多选"],
      explanation: "仪表选型先确认量程、精度、接口、介质和工况，同时关注输出信号与供电。",
      difficulty: "medium"
    })
  });
  if (!bankQuestion.response.ok || bankQuestion.json.question.tags[0] !== "仪表") throw new Error("bank question create failed");

  const importedBankQuestions = await request("/api/exam-questions/import", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      questions: [
        {
          stem: "Excel导入：压力表选型优先确认什么？",
          category: "仪表产品",
          options: ["量程和介质", "客户邮箱", "包装颜色"],
          answerIndex: 0,
          tags: ["导入", "压力表"],
          explanation: "压力表必须先确认量程、介质、精度和接口。",
          difficulty: "easy"
        },
        {
          stem: "Excel导入：防爆场景需要确认什么？",
          category: "仪表产品",
          options: ["防爆等级和认证", "名片颜色", "聊天工具", "使用区域"],
          answerIndex: 0,
          answerIndexes: [0, 3],
          questionType: "multiple",
          tags: ["导入", "防爆"],
          explanation: "防爆场景需要确认认证体系和等级。",
          difficulty: "hard"
        }
      ]
    })
  });
  if (!importedBankQuestions.response.ok || importedBankQuestions.json.importedCount !== 2) throw new Error("bank question import failed");

  const exportedBank = await request("/api/exam-questions/export", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!exportedBank.response.ok || exportedBank.json.questions.length < 3) throw new Error("bank question export failed");

  const deleteCandidate = importedBankQuestions.json.questions[0];
  const deletedBankQuestion = await request(`/api/exam-questions/${deleteCandidate.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!deletedBankQuestion.response.ok || deletedBankQuestion.json.question.id !== deleteCandidate.id) throw new Error("bank question delete failed");

  const questionIds = [bankQuestion.json.question.id, importedBankQuestions.json.questions[1].id];
  const createdExam = await request("/api/exams", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({
      title: "自动化仪表专项考试",
      category: "仪表产品",
      questionIds,
      durationMinutes: 15,
      passScore: 80,
      targetRole: "sales"
    })
  });
  if (!createdExam.response.ok || createdExam.json.exam.questionCount !== questionIds.length) throw new Error("exam create from bank failed");

  const publishedExam = await request(`/api/exams/${createdExam.json.exam.id}/publish`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!publishedExam.response.ok || publishedExam.json.exam.status !== "published") throw new Error("exam publish failed");

  const createdExamDetail = await request(`/api/exams/${createdExam.json.exam.id}/detail`, {
    headers: { authorization: `Bearer ${salesToken}` }
  });
  if (!createdExamDetail.response.ok || createdExamDetail.json.questions.length !== questionIds.length) throw new Error("created exam detail failed");
  if (createdExamDetail.json.questions.some((question: { answerIndex: number; answerIndexes?: number[]; explanation?: string }) =>
    question.answerIndex !== -1 || question.answerIndexes?.length || question.explanation
  )) {
    throw new Error("created sales exam detail must redact answers");
  }
  const managerCreatedExamDetail = await request(`/api/exams/${createdExam.json.exam.id}/detail`, {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!managerCreatedExamDetail.response.ok || managerCreatedExamDetail.json.questions.length !== questionIds.length) {
    throw new Error("manager created exam detail failed");
  }

  const salesExamAnswers = Object.fromEntries(
    managerCreatedExamDetail.json.questions.map((question: { id: string; answerIndex: number; answerIndexes?: number[] }) => [
      question.id,
      question.answerIndexes?.length ? question.answerIndexes : question.answerIndex
    ])
  );
  const salesExamAttempt = await request(`/api/exams/${createdExam.json.exam.id}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ answers: salesExamAnswers })
  });
  if (!salesExamAttempt.response.ok || salesExamAttempt.json.attempt.score !== 100) throw new Error("multi-select exam scoring failed");

  const managerAccounts = await request("/api/accounts", {
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (managerAccounts.response.status !== 403) throw new Error("manager must not access account management");

  const accountList = await request("/api/accounts", {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  if (!accountList.response.ok || !accountList.json.accounts.some((item: { role: string }) => item.role === "super_admin")) throw new Error("admin account list failed");

  const forbiddenSuper = await request("/api/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Forbidden Super", email: `forbidden.super.${Date.now()}@goodjob.com`, password: "forbid123", role: "super_admin" })
  });
  if (forbiddenSuper.response.status !== 403) throw new Error("admin must not create super admin");

  const account = await request("/api/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${superAdminToken}` },
    body: JSON.stringify({ name: "Auto Sales", email: `auto.${Date.now()}@goodjob.com`, password: "start123", role: "sales" })
  });
  if (!account.response.ok || account.json.account.name !== "Auto Sales") throw new Error("account create failed");

  const passwordChanged = await request(`/api/accounts/${account.json.account.id}/password`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${superAdminToken}` },
    body: JSON.stringify({ password: "changed123" })
  });
  if (!passwordChanged.response.ok) throw new Error("account password update failed");
  const loginCreated = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.json.account.email, password: "changed123" })
  });
  if (!loginCreated.response.ok) throw new Error("created account password login failed");

  const disabled = await request(`/api/accounts/${account.json.account.id}/disable`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${superAdminToken}` }
  });
  if (!disabled.response.ok) throw new Error("account disable failed");

  const deleted = await request(`/api/accounts/${account.json.account.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${superAdminToken}` }
  });
  if (!deleted.response.ok || deleted.json.ok !== true) throw new Error("account delete failed");
  const loginDeleted = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.json.account.email, password: "changed123" })
  });
  if (loginDeleted.response.status !== 401) throw new Error("deleted account must not login");

  console.log(JSON.stringify({
    ok: true,
    salesCustomers: salesCustomers.json.customers.length,
    managerCustomers: managerCustomers.json.customers.length,
    syncedLead: ocr.json.lead.company,
    managerDeals: deals.json.deals.length,
    createdDeal: newDeal.json.deal.title,
    archivedDeal: Boolean(archivedDeal.json.deal.archivedAt),
    commissionRecord: confirmedCommissionRecord.json.record.status,
    commissionFinal: commissionManual.json.calculation.finalCommission,
    commissionExportRows: commissionExport.json.rows.length,
    lostDeal: markedLost.json.deal.stage,
    createdReminder: reminder.json.reminder.title,
	    todoUndo: todoUndone.json.todo.done === false,
	    todoRestored: !restoredTodo.json.todo.historyAt,
    problemResolved: resolvedProblem.json.problem.status,
    memoPinned: pinnedMemo.json.memo.pinned,
    competitorThreat: competitorThreat.json.competitor.threatLevel,
    casePublished: publishedCase.json.caseStudy.status,
    aiConfigMasked: aiConfigRead.json.config.apiKey,
    aiConfigDeleteRemaining: aiConfigDelete.json.configs.length,
    profileOutboundEmail: profileBind.json.user.outboundEmail,
    profileSmtpTest: profileTestMail.json.ok,
    profileSmtpTestTo: profileTestMail.json.to,
    profileCleared: !profileClear.json.user.hasSmtpPassword,
    developmentEmailTo: profileMail.json.user.lastDevelopmentEmailTo,
    prospectEmailTo: prospectMail.json.opportunity.lastDevelopmentEmailTo,
    leadProviderCount: providerList.length,
    leadSourceMaskedKey: leadSourceSave.json.config.apiKey,
    leadSourceDeleted: !serperAfterDelete?.hasApiKey,
    importJob: customerImport.json.job.name,
    exportRows: customerExport.json.customers.length,
    tradeDocument: tradeDocument.json.document.number,
    tradeDocumentExported: tradeDocumentExport.json.document.status,
    examPassed: exam.json.attempt.passed,
    examCreated: createdExam.json.exam.title,
    examPublished: publishedExam.json.exam.status,
    examImported: importedBankQuestions.json.importedCount,
    salesExamPublished: publishedExam.json.exam.status,
    multiExamScore: salesExamAttempt.json.attempt.score,
    accountCreated: account.json.account.name,
    accountPasswordLogin: loginCreated.response.ok,
    accountDeleted: deleted.json.ok,
    managerAccountForbidden: managerAccounts.response.status,
    adminSuperForbidden: forbiddenSuper.response.status
  }, null, 2));
} finally {
  server.close();
}
