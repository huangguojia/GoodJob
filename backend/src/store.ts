import {
  customers,
  deals,
  exams,
  importExportJobs,
  knowledgeAssets,
  ocrJobs,
  reminders,
  todos,
  users,
  wecomMessages
} from "./data.js";
import type { Customer, Deal, Exam, ImportExportJob, KnowledgeAsset, OcrJob, Reminder, Todo, User, WecomMessage } from "./types.js";

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
