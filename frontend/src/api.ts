export type Role = "sales" | "manager" | "admin";

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
}

export interface Todo {
  id: string;
  title: string;
  type: string;
  priority: string;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
}

export interface Deal {
  id: string;
  title: string;
  stage: string;
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
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error((await response.json()).message || "请求失败");
  return response.json() as Promise<T>;
}

export function money(value: number) {
  return `$${Math.round(value / 1000)}k`;
}
