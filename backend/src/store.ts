import {
  aiModelConfigs,
  caseStudies,
  competitors,
  customers,
  deals,
  examAttempts,
  examQuestions,
  exams,
  importExportJobs,
  knowledgeAssets,
  memos,
  ocrJobs,
  problems,
  reminders,
  todos,
  users,
  wecomMessages,
  websiteOpportunities
} from "./data.js";
import type { AiModelConfig, CaseStudy, Competitor, Customer, Deal, Exam, ExamAttempt, ExamQuestion, ImportExportJob, KnowledgeAsset, Memo, OcrJob, ProblemItem, Reminder, Todo, User, WecomMessage, WebsiteOpportunity } from "./types.js";

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
  examAttempts: ExamAttempt[];
  importExportJobs: ImportExportJob[];
  wecomMessages: WecomMessage[];
  ocrJobs: OcrJob[];
  websiteOpportunities: WebsiteOpportunity[];
  aiModelConfigs: AiModelConfig[];
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
  examAttempts,
  importExportJobs,
  wecomMessages,
  ocrJobs,
  websiteOpportunities,
  aiModelConfigs,
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
