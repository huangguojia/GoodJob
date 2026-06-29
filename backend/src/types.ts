export type Role = "sales" | "manager" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  teamId: string;
  avatar: string;
  status: "active" | "disabled";
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  avatar: string;
}

export interface Customer {
  id: string;
  company: string;
  country: string;
  contact: string;
  ownerId: string;
  teamId: string;
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
}

export interface Todo {
  id: string;
  title: string;
  type: "customer" | "knowledge" | "exam" | "ocr" | "other";
  priority: "high" | "medium" | "normal";
  status?: "pending" | "in_progress";
  pinState?: "top" | "bottom" | "";
  sortOrder?: number;
  dueAt: string;
  ownerId: string;
  teamId: string;
  related: string;
  done: boolean;
  impactAmount?: number;
  createdAt?: string;
}

export interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: "published" | "draft" | "review";
  ownerId: string;
  version: string;
}

export interface Exam {
  id: string;
  title: string;
  category: string;
  status: "published" | "draft" | "scheduled";
  passRate: number;
  questionCount: number;
}

export interface OcrJob {
  id: string;
  status: "recognized" | "synced";
  confidence: number;
  fields: Record<string, string>;
}

export interface Deal {
  id: string;
  customerId: string;
  title: string;
  stage: "询盘" | "已联系" | "已报价" | "样品" | "谈判" | "成交" | "丢单";
  amount: number;
  ownerId: string;
  teamId: string;
  nextAction: string;
}

export interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  ownerId: string;
  teamId: string;
  channel: "站内" | "邮件" | "企业微信";
  status: "pending" | "sent" | "done";
}

export interface ImportExportJob {
  id: string;
  name: string;
  type: "import" | "export";
  rows: number;
  status: "done" | "review" | "failed";
  operatorId: string;
  createdAt: string;
}

export interface WecomMessage {
  id: string;
  customerId: string;
  summary: string;
  ownerId: string;
  teamId: string;
  status: "archived" | "pending";
}

export interface ProblemItem {
  id: string;
  title: string;
  category: string;
  severity: "high" | "medium" | "low";
  status: "open" | "solving" | "resolved";
  ownerId: string;
  teamId: string;
  relatedCustomer: string;
  rootCause: string;
  solution: string;
  nextAction: string;
  dueAt: string;
  createdAt: string;
}

export interface Memo {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  ownerId: string;
  teamId: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface Competitor {
  id: string;
  company: string;
  country: string;
  segment: string;
  threatLevel: "high" | "medium" | "low";
  website: string;
  strengths: string;
  weaknesses: string;
  competingProducts: string;
  ourStrategy: string;
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

export interface CaseStudy {
  id: string;
  title: string;
  customer: string;
  country: string;
  product: string;
  industry: string;
  result: string;
  story: string;
  reusablePoints: string;
  status: "draft" | "published";
  ownerId: string;
  teamId: string;
  updatedAt: string;
}
