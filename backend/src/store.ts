import {
  caseStudies,
  competitors,
  customers,
  deals,
  exams,
  importExportJobs,
  knowledgeAssets,
  memos,
  ocrJobs,
  problems,
  reminders,
  todos,
  users,
  wecomMessages
} from "./data.js";
import type { CaseStudy, Competitor, Customer, Deal, Exam, ImportExportJob, KnowledgeAsset, Memo, OcrJob, ProblemItem, Reminder, Todo, User, WecomMessage } from "./types.js";

export interface CrmStore {
  mode: "memory" | "mysql";
  users: User[];
  customers: Customer[];
  todos: Todo[];
  deals: Deal[];
  reminders: Reminder[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  importExportJobs: ImportExportJob[];
  wecomMessages: WecomMessage[];
  ocrJobs: OcrJob[];
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
  importExportJobs,
  wecomMessages,
  ocrJobs,
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
