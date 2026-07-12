import {
  aiModelConfigs,
  caseStudies,
  commissionCalculations,
  commissionExports,
  commissionItems,
  commissionProducts,
  commissionRules,
  competitors,
  customerActivities,
  customers,
  dealEvents,
  deals,
  examAttempts,
  examQuestionLinks,
  examQuestions,
  exams,
  importExportJobs,
  knowledgeAssets,
  leadActivities,
  leadSourceConfigs,
  leadSourceEvents,
  leads,
  memos,
  monthlySalesRecords,
  ocrJobs,
  planTemplates,
  planTasks,
  problems,
  reminders,
  salesRecordAudits,
  todos,
  tradeDocuments,
  users,
  wecomMessages,
  websiteOpportunities,
  whatsappBindings,
  whatsappMessages
} from "./data.js";
import type { AiModelConfig, CaseStudy, CommissionCalculation, CommissionExport, CommissionItem, CommissionProduct, CommissionRule, Competitor, Customer, CustomerActivity, Deal, DealEvent, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, KnowledgeAsset, Lead, LeadActivity, LeadSourceConfig, LeadSourceEvent, Memo, MonthlySalesRecord, OcrJob, PlanTask, PlanTemplate, ProblemItem, Reminder, SalesRecordAudit, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity, WhatsAppMessage, WhatsAppBinding } from "./types.js";

export interface CrmStore {
  mode: "memory" | "mysql";
  users: User[];
  customers: Customer[];
  customerActivities: CustomerActivity[];
  leads: Lead[];
  leadActivities: LeadActivity[];
  leadSourceEvents: LeadSourceEvent[];
  todos: Todo[];
  deals: Deal[];
  dealEvents: DealEvent[];
  reminders: Reminder[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examQuestionLinks: ExamQuestionLink[];
  examAttempts: ExamAttempt[];
  importExportJobs: ImportExportJob[];
  tradeDocuments: TradeDocument[];
  wecomMessages: WecomMessage[];
  ocrJobs: OcrJob[];
  websiteOpportunities: WebsiteOpportunity[];
  aiModelConfigs: AiModelConfig[];
  leadSourceConfigs: LeadSourceConfig[];
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  whatsappMessages: WhatsAppMessage[];
  whatsappBindings: WhatsAppBinding[];
  commissionProducts: CommissionProduct[];
  commissionRules: CommissionRule[];
  monthlySalesRecords: MonthlySalesRecord[];
  salesRecordAudits: SalesRecordAudit[];
  commissionCalculations: CommissionCalculation[];
  commissionItems: CommissionItem[];
  commissionExports: CommissionExport[];
  persist(): Promise<void>;
}

export const memoryStore: CrmStore = {
  mode: "memory",
  users,
  customers,
  customerActivities,
  leads,
  leadActivities,
  leadSourceEvents,
  todos,
  deals,
  dealEvents,
  reminders,
  knowledgeAssets,
  exams,
  examQuestions,
  examQuestionLinks,
  examAttempts,
  importExportJobs,
  tradeDocuments,
  wecomMessages,
  ocrJobs,
  websiteOpportunities,
  aiModelConfigs,
  leadSourceConfigs,
  planTasks,
  planTemplates,
  problems,
  memos,
  competitors,
  caseStudies,
  whatsappMessages,
  whatsappBindings,
  commissionProducts,
  commissionRules,
  monthlySalesRecords,
  salesRecordAudits,
  commissionCalculations,
  commissionItems,
  commissionExports,
  async persist() {
    // Memory mode intentionally keeps current in-process state only.
  }
};

let activeStore: CrmStore = memoryStore;

export function getStore() {
  return activeStore;
}

export function setStore(store: CrmStore) {
  activeStore = store;
}
