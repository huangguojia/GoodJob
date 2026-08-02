import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock3, Database, Radio, Server, ShieldAlert, WifiOff } from "lucide-react";
import type { RealtimeEvent } from "@shared/types";
import { api } from "../api";
import { queryKeys, useAccounts } from "../data";
import { Spinner, StatusBadge } from "../components/ui";

export function DiagnosticsPage({ lastEvent }: { lastEvent: RealtimeEvent | null }) {
  const healthQuery = useQuery({ queryKey: queryKeys.health, queryFn: api.health, refetchInterval: 10_000 });
  const accountsQuery = useAccounts();
  const health = healthQuery.data;
  const accounts = accountsQuery.data ?? [];
  const degraded = accounts.filter((item) => ["degraded", "credential_invalid", "reconnecting"].includes(item.status));

  return <div className="page page-diagnostics"><div className="page-heading"><div><span className="eyebrow">OPERATIONS</span><h1>运行诊断</h1><p>连接、数据库、实时事件和账号异常在此集中检查。</p></div></div>
    <div className="metric-strip"><div><Database size={19} /><span><small>数据库</small><strong>{health?.database ?? "检测中"}</strong></span></div><div><Radio size={19} /><span><small>活动连接</small><strong>{health?.activeConnections ?? 0}</strong></span></div><div><Server size={19} /><span><small>API 状态</small><strong className={health?.status === "ok" ? "success-text" : "warning-text"}>{health?.status === "ok" ? "正常" : "检测中"}</strong></span></div><div><Clock3 size={19} /><span><small>最后检查</small><strong>{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString("zh-CN") : "--:--"}</strong></span></div></div>
    {healthQuery.isLoading && <div className="center-loading"><Spinner /> 正在连接 API</div>}
    {degraded.length > 0 && <div className="notice error-notice"><ShieldAlert size={18} /><div><strong>{degraded.length} 个账号需要处理</strong><span>{degraded.map((item) => `${item.name}: ${item.lastError ?? item.status}`).join("；")}</span></div></div>}
    <div className="diagnostic-grid"><section className="settings-section"><header><Activity size={18} /><div><h2>账号连接</h2><p>单个账号异常不会影响其他账号。</p></div></header><div className="diagnostic-account-list">{accounts.map((account) => <div key={account.id}><span className="avatar">{account.name.slice(0, 2)}</span><span><strong>{account.name}</strong><small>{account.provider} · {account.phone ?? "未获取号码"}</small></span><StatusBadge status={account.status} /><span className="diagnostic-time">{account.lastEventAt ? new Date(account.lastEventAt).toLocaleTimeString("zh-CN") : "暂无事件"}</span></div>)}</div></section>
      <section className="settings-section"><header><Radio size={18} /><div><h2>最近实时事件</h2><p>仅显示标准化信封，不展示凭据。</p></div></header>{lastEvent ? <div className="event-view"><div><span className="live-dot is-online" /><strong>{lastEvent.eventType}</strong></div><dl className="detail-list"><div><dt>Event ID</dt><dd className="mono">{lastEvent.eventId.slice(0, 13)}…</dd></div><div><dt>Account</dt><dd className="mono">{lastEvent.accountId?.slice(0, 13) ?? "system"}</dd></div><div><dt>时间</dt><dd>{new Date(lastEvent.occurredAt).toLocaleString("zh-CN")}</dd></div></dl></div> : <div className="empty-inline"><WifiOff size={20} /><span>等待 WebSocket 事件</span></div>}</section>
    </div>
    <section className="settings-section capability-section"><header><CheckCircle2 size={18} /><div><h2>核心能力状态</h2><p>当前插件的主要运行能力。</p></div></header><div className="capability-grid">{["多账号同时在线与隔离","二维码登录与加密会话","联系人和历史事件入库","实时双向文本消息","AI 自动与单次翻译","CRM Sandbox 去重建档","线索首选/备用账号路由","PGlite / MySQL 数据库切换"].map((item) => <div key={item}><CheckCircle2 size={15} /><span>{item}</span></div>)}</div></section>
  </div>;
}
