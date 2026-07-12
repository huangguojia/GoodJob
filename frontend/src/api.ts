export type Role = "sales" | "manager" | "admin" | "super_admin";

export interface User {
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
  stage: string;
  amount: number;
  health: number;
  nextReminder: string;
  wecomBound: boolean;
  billingName?: string;
  billingAddress?: string;
  documentContact?: string;
  defaultPortDischarge?: string;
  defaultIncoterm?: string;
  defaultPaymentTerm?: string;
}

export type LeadStatus = "new" | "following" | "converted" | "invalid";
export type LeadActivityType = "call" | "wechat" | "whatsapp" | "linkedin" | "email" | "meeting" | "note" | "stage" | "system";

export interface Lead {
  id: string;
  company: string;
  contact: string;
  country: string;
  email: string;
  phone: string;
  wechat: string;
  source: string;
  intent: string;
  stage: string;
  status: LeadStatus;
  ownerId: string;
  teamId: string;
  estimatedAmount: number;
  nextFollowAt: string;
  lastActivityAt: string;
  remark: string;
  convertedCustomerId: string;
  createdAt: string;
  deletedAt?: string;
  deletedReason?: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: LeadActivityType;
  content: string;
  operatorId: string;
  nextFollowAt: string;
  createdAt: string;
}

export interface Todo {
  id: string;
  title: string;
  type: string;
  priority: string;
  status?: string;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
}

export interface Deal {
  id: string;
  title: string;
  stage: string;
  product?: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
  nextAction: string;
}

export interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
  enabled?: boolean;
  lastRunAt?: string;
  lastMatchedCount?: number;
  lastCreatedCount?: number;
  lastSkippedCount?: number;
  lastFailedCount?: number;
}

export interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

export interface WecomMessage {
  id: string;
  summary: string;
  status: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || "";

export async function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const csrfToken = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("gj_csrf="))?.slice(8) || "";
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(!token && !["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error((await response.json()).message || "请求失败");
  return response.json() as Promise<T>;
}

export function money(value: number) {
  return `$${Math.round(value / 1000)}k`;
}
