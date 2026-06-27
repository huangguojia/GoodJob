import type { CaseStudy, Competitor, Customer, Deal, Exam, ImportExportJob, KnowledgeAsset, Memo, OcrJob, ProblemItem, Reminder, Todo, User, WecomMessage } from "./types.js";

export const users: User[] = [
  { id: "u_sales_shirley", name: "Shirley", email: "shirley@goodjob.com", password: "goodjob123", role: "sales", teamId: "europe", avatar: "SH", status: "active" },
  { id: "u_sales_mia", name: "Mia", email: "mia@goodjob.com", password: "goodjob123", role: "sales", teamId: "europe", avatar: "MI", status: "active" },
  { id: "u_manager_alex", name: "Alex", email: "alex@goodjob.com", password: "goodjob123", role: "manager", teamId: "europe", avatar: "AL", status: "active" },
  { id: "u_admin", name: "Admin", email: "admin@goodjob.com", password: "goodjob123", role: "admin", teamId: "all", avatar: "AD", status: "active" }
];

export const customers: Customer[] = [
  { id: "c1", company: "Nordic Tools AB", country: "瑞典", contact: "Emma", ownerId: "u_sales_shirley", teamId: "europe", stage: "已报价", amount: 36000, health: 58, nextReminder: "已逾期", wecomBound: true },
  { id: "c2", company: "Atlas Home Inc", country: "美国", contact: "Daniel", ownerId: "u_sales_shirley", teamId: "europe", stage: "样品", amount: 22000, health: 82, nextReminder: "今天 16:00", wecomBound: true },
  { id: "c3", company: "Kanto Retail", country: "日本", contact: "Sato", ownerId: "u_sales_mia", teamId: "europe", stage: "谈判", amount: 48000, health: 90, nextReminder: "明天 09:30", wecomBound: false },
  { id: "c4", company: "Al Noor Trading", country: "阿联酋", contact: "Hassan", ownerId: "u_sales_mia", teamId: "europe", stage: "已报价", amount: 18000, health: 45, nextReminder: "今天 10:30", wecomBound: true },
  { id: "c5", company: "Evergreen GmbH", country: "德国", contact: "Anna", ownerId: "u_sales_shirley", teamId: "europe", stage: "成交", amount: 57000, health: 95, nextReminder: "7 天后复购", wecomBound: true }
];

export const todos: Todo[] = [
  { id: "t1", title: "补发 Nordic Tools AB 的 CE 证书与新版交期说明", type: "customer", priority: "high", dueAt: "今天 09:45", ownerId: "u_sales_shirley", teamId: "europe", related: "Nordic Tools AB", done: false, impactAmount: 36000 },
  { id: "t2", title: "审核欧洲报价模板并同步到资料库", type: "knowledge", priority: "medium", dueAt: "今天 11:30", ownerId: "u_sales_mia", teamId: "europe", related: "报价规则", done: false },
  { id: "t3", title: "给中东组推送认证资料专项补考提醒", type: "exam", priority: "normal", dueAt: "今天 15:00", ownerId: "u_manager_alex", teamId: "europe", related: "在线考试", done: false },
  { id: "t4", title: "复核 OCR 名片识别结果并同步 8 条展会线索", type: "ocr", priority: "normal", dueAt: "今天 16:20", ownerId: "u_sales_shirley", teamId: "europe", related: "OCR 线索", done: false },
  { id: "t5", title: "确认 Atlas Home Inc 样品签收状态", type: "customer", priority: "normal", dueAt: "09:12", ownerId: "u_sales_shirley", teamId: "europe", related: "Atlas Home Inc", done: true }
];

export const knowledgeAssets: KnowledgeAsset[] = [
  { id: "k1", title: "LED 灯具参数手册 V3", category: "产品知识", status: "published", ownerId: "u_sales_mia", version: "v3" },
  { id: "k2", title: "欧洲报价模板", category: "报价规则", status: "review", ownerId: "u_sales_mia", version: "v2" },
  { id: "k3", title: "CE 证书客户解释话术", category: "认证资料", status: "published", ownerId: "u_sales_shirley", version: "v1" }
];

export const exams: Exam[] = [
  { id: "e1", title: "LED 灯具基础", category: "产品知识", status: "published", passRate: 72, questionCount: 25 },
  { id: "e2", title: "认证资料专项", category: "认证资料", status: "draft", passRate: 64, questionCount: 30 },
  { id: "e3", title: "报价规则进阶", category: "报价规则", status: "scheduled", passRate: 83, questionCount: 20 }
];

export const ocrJobs: OcrJob[] = [
  {
    id: "ocr1",
    status: "recognized",
    confidence: 94,
    fields: {
      company: "NorthStar Lighting GmbH",
      contact: "James Müller",
      title: "Purchasing Manager",
      email: "james.mueller@northstar-light.de",
      whatsapp: "+49 151 2388 9012",
      wechat: "james_light_de",
      phone: "+49 30 8842 1290",
      country: "德国",
      city: "Berlin"
    }
  }
];

export const deals: Deal[] = [
  { id: "d1", customerId: "c1", title: "Nordic Tools 电动工具年度采购", stage: "已报价", amount: 36000, ownerId: "u_sales_shirley", teamId: "europe", nextAction: "二次确认报价" },
  { id: "d2", customerId: "c2", title: "Atlas Home 家居样品测试", stage: "样品", amount: 22000, ownerId: "u_sales_shirley", teamId: "europe", nextAction: "确认样品反馈" },
  { id: "d3", customerId: "c3", title: "Kanto Retail 付款条款谈判", stage: "谈判", amount: 48000, ownerId: "u_sales_mia", teamId: "europe", nextAction: "主管参与账期谈判" },
  { id: "d4", customerId: "c4", title: "Al Noor LED 灯具报价", stage: "已报价", amount: 18000, ownerId: "u_sales_mia", teamId: "europe", nextAction: "更新汇率报价" },
  { id: "d5", customerId: "c5", title: "Evergreen GmbH 复购订单", stage: "成交", amount: 57000, ownerId: "u_sales_shirley", teamId: "europe", nextAction: "7 天后复购回访" }
];

export const reminders: Reminder[] = [
  { id: "r1", title: "报价后 3 天未回复", rule: "A 级客户报价后 3 天提醒", dueAt: "今天 09:45", ownerId: "u_sales_shirley", teamId: "europe", channel: "企业微信", status: "pending" },
  { id: "r2", title: "样品签收后待反馈", rule: "签收后 3 天提醒", dueAt: "今天 16:00", ownerId: "u_sales_shirley", teamId: "europe", channel: "站内", status: "pending" },
  { id: "r3", title: "A 级客户 14 天未联系", rule: "高价值客户长期未触达", dueAt: "本周五", ownerId: "u_manager_alex", teamId: "europe", channel: "邮件", status: "sent" }
];

export const importExportJobs: ImportExportJob[] = [
  { id: "io1", name: "2026 春季展会客户", type: "import", rows: 1286, status: "done", operatorId: "u_admin", createdAt: "今天 09:12" },
  { id: "io2", name: "欧洲 A 级客户", type: "export", rows: 184, status: "review", operatorId: "u_sales_shirley", createdAt: "今天 08:40" }
];

export const wecomMessages: WecomMessage[] = [
  { id: "w1", customerId: "c1", summary: "客户关注 CE 证书与交期，已承诺今日补发新版参数。", ownerId: "u_sales_shirley", teamId: "europe", status: "archived" },
  { id: "w2", customerId: "c2", summary: "样品测试反馈预计明天下午给出，需要提醒客户确认复购时间。", ownerId: "u_sales_shirley", teamId: "europe", status: "pending" }
];

export const problems: ProblemItem[] = [
  {
    id: "p1",
    title: "Nordic Tools 报价后 5 天未回复",
    category: "报价跟进",
    severity: "high",
    status: "solving",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    relatedCustomer: "Nordic Tools AB",
    rootCause: "CE 证书和交期说明不完整，客户采购内部审批被卡住。",
    solution: "补发对应型号 CE 证书、测试报告摘要和新版交期承诺，并在邮件中拆分技术资料与商务确认。",
    nextAction: "今天 16:00 前发送资料包，明天上午企微二次确认。",
    dueAt: "今天 16:00",
    createdAt: "2026-06-27T08:20:00.000Z"
  },
  {
    id: "p2",
    title: "欧洲报价模板版本混用",
    category: "资料维护",
    severity: "medium",
    status: "open",
    ownerId: "u_sales_mia",
    teamId: "europe",
    relatedCustomer: "团队共用",
    rootCause: "旧模板仍在销售个人文件夹中流转，MOQ 与汇率说明口径不一致。",
    solution: "资料库只保留 V3 模板，企微群推送替换通知，并让考试系统加入报价模板题。",
    nextAction: "Mia 今日完成模板替换，Alex 明日晨会抽查。",
    dueAt: "明天 10:00",
    createdAt: "2026-06-27T07:45:00.000Z"
  },
  {
    id: "p3",
    title: "OCR 展会线索国家字段识别偏差",
    category: "工具/OCR",
    severity: "low",
    status: "resolved",
    ownerId: "u_manager_alex",
    teamId: "europe",
    relatedCustomer: "展会线索池",
    rootCause: "名片城市和国家字段靠近，英文缩写被误映射。",
    solution: "增加国家白名单校验和人工确认提示，低置信度字段默认不勾选。",
    nextAction: "已更新字段映射，下周复盘识别准确率。",
    dueAt: "已完成",
    createdAt: "2026-06-26T10:30:00.000Z"
  }
];

export const memos: Memo[] = [
  {
    id: "m1",
    title: "欧洲客户常问认证资料",
    content: "客户问 CE/ROHS 时，优先发对应型号证书、测试报告摘要、产品参数页。不要只发整包资料，容易增加客户筛选成本。",
    category: "销售话术",
    tags: "CE,认证,欧洲",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    pinned: true,
    archived: false,
    updatedAt: "2026-06-27T09:10:00.000Z"
  },
  {
    id: "m2",
    title: "天津马赫客户信息补充",
    content: "新线索需要补齐 WhatsApp、微信和主营产品。下一次沟通重点确认进口品类、年采购量和是否接受样品费。",
    category: "客户备忘",
    tags: "天津马赫,线索,补充资料",
    ownerId: "u_manager_alex",
    teamId: "europe",
    pinned: false,
    archived: false,
    updatedAt: "2026-06-27T08:40:00.000Z"
  },
  {
    id: "m3",
    title: "报价复盘要点",
    content: "成交前复盘三个点：价格是否含汇率缓冲、交期是否写清工作日、付款条款是否与客户等级匹配。",
    category: "复盘",
    tags: "报价,复盘,SOP",
    ownerId: "u_sales_mia",
    teamId: "europe",
    pinned: false,
    archived: false,
    updatedAt: "2026-06-26T17:30:00.000Z"
  }
];

export const competitors: Competitor[] = [
  {
    id: "cp1",
    company: "EuroLift Tools GmbH",
    country: "德国",
    segment: "电动工具",
    threatLevel: "high",
    website: "https://eurolift.example.com",
    strengths: "欧洲本地仓、交期短、CE 资料齐全，老客户续单粘性较强。",
    weaknesses: "定制能力弱，MOQ 高，小批量项目报价不灵活。",
    competingProducts: "18V 无刷电钻、工业级角磨机、锂电套装",
    ourStrategy: "主打小批量定制和更完整的配件组合，报价中拆出备件与售后响应优势。",
    ownerId: "u_manager_alex",
    teamId: "europe",
    updatedAt: "2026-06-27T09:40:00.000Z"
  },
  {
    id: "cp2",
    company: "Nordic Home Supply",
    country: "瑞典",
    segment: "家居用品",
    threatLevel: "medium",
    website: "https://nordichome.example.com",
    strengths: "渠道覆盖北欧中小零售商，包装设计本地化程度高。",
    weaknesses: "新品开发慢，价格体系对大客户缺少阶梯策略。",
    competingProducts: "收纳架、厨房小工具、园艺套装",
    ourStrategy: "用快速打样和多 SKU 组合报价抢新品窗口期，强调工厂直供价格弹性。",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    updatedAt: "2026-06-27T08:50:00.000Z"
  },
  {
    id: "cp3",
    company: "MENA Lighting FZCO",
    country: "阿联酋",
    segment: "LED 灯具",
    threatLevel: "low",
    website: "https://menalighting.example.com",
    strengths: "本地项目资源强，对工程客户响应快。",
    weaknesses: "产品认证覆盖不足，复杂规格仍依赖外采。",
    competingProducts: "面板灯、投光灯、户外灯具",
    ourStrategy: "强调认证完整度和交付稳定性，在工程项目中提供规格替代建议。",
    ownerId: "u_sales_mia",
    teamId: "europe",
    updatedAt: "2026-06-26T16:20:00.000Z"
  }
];

export const caseStudies: CaseStudy[] = [
  {
    id: "cs1",
    title: "Nordic Tools 年度工具套装复购",
    customer: "Nordic Tools AB",
    country: "瑞典",
    product: "18V 无刷电钻套装",
    industry: "工具批发",
    result: "$36,000 首单，预计 Q3 复购 2 个柜",
    story: "客户原供应商交期不稳定，我们用 CE 资料包、备件清单和分批交付方案打消采购顾虑，最终拿下年度试单。",
    reusablePoints: "资料先行、交期分段承诺、备件包单独报价、报价后 48 小时内二次确认。",
    status: "published",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    updatedAt: "2026-06-27T09:00:00.000Z"
  },
  {
    id: "cs2",
    title: "Kanto Retail 付款条款谈判",
    customer: "Kanto Retail",
    country: "日本",
    product: "连锁零售家居套装",
    industry: "连锁零售",
    result: "样品阶段进入账期谈判，预测金额 $48,000",
    story: "客户关注长期账期和 SKU 组合风险，主管介入后拆分首单与复购条款，降低客户首次下单压力。",
    reusablePoints: "大客户账期分阶段、样品反馈表标准化、首单 SKU 不超过 12 个。",
    status: "draft",
    ownerId: "u_sales_mia",
    teamId: "europe",
    updatedAt: "2026-06-27T08:10:00.000Z"
  },
  {
    id: "cs3",
    title: "Al Noor LED 报价快速修正",
    customer: "Al Noor Trading",
    country: "阿联酋",
    product: "LED 面板灯",
    industry: "工程贸易",
    result: "汇率修正后保住报价窗口，客户进入二轮议价",
    story: "客户对 MOQ 与汇率波动敏感，销售当天补发阶梯报价和替代规格，避免客户转向本地供应商。",
    reusablePoints: "报价内置汇率有效期、MOQ 阶梯表、替代型号提前准备。",
    status: "published",
    ownerId: "u_sales_mia",
    teamId: "europe",
    updatedAt: "2026-06-26T14:45:00.000Z"
  }
];
