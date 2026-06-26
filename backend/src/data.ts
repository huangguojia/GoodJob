import type { Customer, Deal, Exam, ImportExportJob, KnowledgeAsset, OcrJob, Reminder, Todo, User, WecomMessage } from "./types.js";

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
