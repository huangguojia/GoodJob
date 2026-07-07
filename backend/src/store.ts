import {
  aiModelConfigs,
  caseStudies,
  competitors,
  customers,
  deals,
  examAttempts,
  examQuestionLinks,
  examQuestions,
  exams,
  importExportJobs,
  knowledgeAssets,
  memos,
  ocrJobs,
  planTemplates,
  planTasks,
  problems,
  reminders,
  todos,
  tradeDocuments,
  users,
  wecomMessages,
  websiteOpportunities
} from "./data.js";
import type { AiModelConfig, CaseStudy, Competitor, Customer, Deal, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, KnowledgeAsset, Memo, OcrJob, PlanTask, PlanTemplate, ProblemItem, Reminder, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity } from "./types.js";

export interface CrmStore {
  mode: "memory" | "mysql";
  users: User[];
  customers: Customer[];
  todos: Todo[];
  deals: Deal[];
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
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  persist(): Promise<void>;
}

export const memoryStore: CrmStore = {
  mode: "memory",
  users,
  customers,
  todos,
  deals,
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
  planTasks,
  planTemplates,
  problems,
  memos,
  competitors,
  caseStudies,
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
