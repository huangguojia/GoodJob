import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, money, type Customer, type Deal, type ImportExportJob, type Lead, type LeadActivity, type Reminder, type Todo, type User, type WecomMessage } from "./api";
import "./styles.css";

type View = "dashboard" | "leads" | "customers" | "pipeline" | "reminders" | "imports" | "reports" | "wecom" | "knowledge" | "exam" | "tools" | "settings";

interface DashboardSummary {
  scope: string;
  metrics: {
    customers: number;
    todos: number;
    overdueTodos: number;
    forecastAmount: number;
  };
}

function Login({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [email, setEmail] = useState("shirley@goodjob.com");
  const [password, setPassword] = useState("goodjob123");
  const [error, setError] = useState("");

  async function submit() {
    try {
      setError("");
      const result = await api<{ token: string; user: User }>("/api/auth/login", undefined, {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      onLogin(result.token, result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  return (
    <main className="login">
      <section className="loginHero">
        <div className="brandMark">GJ</div>
        <h1>GoodJob CRM</h1>
        <p>登录后按账号角色加载不同数据范围：业务员看本人，主管看团队业务，管理员看全局业务；待办和备忘只看本人。</p>
        <div className="proof"><b>RBAC</b><b>Data Scope</b><b>Audit</b></div>
      </section>
      <section className="loginCard">
        <h2>账号登录</h2>
        <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" onClick={submit}>登录系统</button>
      </section>
    </main>
  );
}

function Layout({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>("dashboard");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [accounts, setAccounts] = useState<User[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [jobs, setJobs] = useState<ImportExportJob[]>([]);
  const [wecomMessages, setWecomMessages] = useState<WecomMessage[]>([]);
  const token = localStorage.getItem("gj_token") || "";

  useEffect(() => {
    void Promise.all([
      api<DashboardSummary>("/api/dashboard/summary", token).then(setSummary),
      api<{ customers: Customer[] }>("/api/customers", token).then((data) => setCustomers(data.customers)),
      api<{ todos: Todo[] }>("/api/todos", token).then((data) => setTodos(data.todos)),
      api<{ deals: Deal[] }>("/api/deals", token).then((data) => setDeals(data.deals)),
      api<{ reminders: Reminder[] }>("/api/reminders", token).then((data) => setReminders(data.reminders)),
      api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs", token).then((data) => setJobs(data.jobs)),
      api<{ messages: WecomMessage[] }>("/api/wecom/messages", token).then((data) => setWecomMessages(data.messages)),
      user.role === "admin" || user.role === "super_admin" ? api<{ accounts: User[] }>("/api/accounts", token).then((data) => setAccounts(data.accounts)) : Promise.resolve()
    ]);
  }, [token, user.role]);

  const nav: Array<[View, string]> = [
    ["dashboard", "工作台"],
    ["leads", "线索"],
    ["customers", "客户"],
    ["pipeline", "商机"],
    ["reminders", "跟进提醒"],
    ["imports", "导入导出"],
    ["reports", "经营汇报"],
    ["wecom", "企业微信"],
    ["knowledge", "资料维护"],
    ["exam", "在线考试"],
    ["tools", "小工具"],
    ["settings", "账号管理"]
  ];

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><div className="brandMark">GJ</div><div><b>GoodJob CRM</b><span>外贸客户增长中台</span></div></div>
        {nav.map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}
      </aside>
      <main className="main">
        <header className="top">
          <input placeholder="搜索客户、联系人、资料、考试或待办" />
          <div className="user"><span className="avatar">{user.avatar}</span><b>{user.name}</b><small>{user.role}</small><button onClick={onLogout}>退出</button></div>
        </header>
        <section className="content">
          {view === "dashboard" && <Dashboard user={user} summary={summary} todos={todos} customers={customers} />}
          {view === "leads" && <Leads token={token} />}
          {view === "customers" && <Customers customers={customers} />}
          {view === "pipeline" && <Pipeline deals={deals} token={token} onChanged={() => api<{ deals: Deal[] }>("/api/deals", token).then((data) => setDeals(data.deals))} />}
          {view === "reminders" && <Reminders reminders={reminders} token={token} onChanged={() => api<{ reminders: Reminder[] }>("/api/reminders", token).then((data) => setReminders(data.reminders))} />}
          {view === "imports" && <ImportExport jobs={jobs} token={token} onCreated={() => api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs", token).then((data) => setJobs(data.jobs))} />}
          {view === "reports" && <Reports summary={summary} />}
          {view === "wecom" && <Wecom messages={wecomMessages} />}
          {view === "knowledge" && <Knowledge />}
          {view === "exam" && <Exam />}
          {view === "tools" && <Tools token={token} />}
          {view === "settings" && <Settings user={user} accounts={accounts} />}
        </section>
      </main>
    </div>
  );
}

function Dashboard({ user, summary, todos, customers }: { user: User; summary: DashboardSummary | null; todos: Todo[]; customers: Customer[] }) {
  const forecast = summary?.metrics.forecastAmount || customers.reduce((sum, item) => sum + item.amount, 0);
  return (
    <>
      <div className="pageTitle"><div><p>Sales Command Center</p><h1>外贸客户工作台</h1><span>{user.role === "sales" ? "业务员仅本人数据" : "主管/管理员查看团队或全量数据"}</span></div></div>
      <div className="scope">当前账号：<b>{user.name}</b> · 数据范围：<b>{summary?.scope || "加载中"}</b></div>
      <div className="metrics">
        <Card label="可见客户" value={summary?.metrics.customers ?? 0} />
        <Card label="今日待办" value={summary?.metrics.todos ?? 0} />
        <Card label="逾期待办" value={summary?.metrics.overdueTodos ?? 0} danger />
        <Card label="预测金额" value={money(forecast)} />
      </div>
      <section className="panel">
        <div className="panelHead"><h2>待办清单</h2><button>新增待办</button></div>
        <div className="chips"><span className="active">今天</span><span>逾期</span><span>我负责</span><span>客户跟进</span><span>资料/考试</span></div>
        <div className="todoList">
          {todos.map((todo) => <article key={todo.id} className={`todo ${todo.done ? "done" : ""}`}><i /><div><b>{todo.title}</b><span>{todo.dueAt} · {todo.related} · {todo.priority}</span></div><em>{todo.type}</em></article>)}
        </div>
      </section>
    </>
  );
}

function Card({ label, value, danger = false }: { label: string; value: string | number; danger?: boolean }) {
  return <div className={`metric ${danger ? "danger" : ""}`}><span>{label}</span><b>{value}</b></div>;
}

const LEAD_STAGES = ["新线索", "已联系", "已建联", "已报价", "已转化", "已放弃"];
const LEAD_INTENTS = ["高", "中", "低"];
const LEAD_STATUS_LABEL: Record<Lead["status"], string> = { new: "待跟进", following: "跟进中", converted: "已转化", invalid: "无效" };
const ACTIVITY_LABEL: Record<string, string> = { call: "电话", wechat: "微信", whatsapp: "WhatsApp", linkedin: "LinkedIn", email: "邮件", meeting: "会面", note: "备注", stage: "阶段", system: "系统" };
type LeadWorkspaceTab = "pool" | "detail" | "activities" | "trash";

function Leads({ token }: { token: string }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [trashLeads, setTrashLeads] = useState<Lead[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<LeadWorkspaceTab>("pool");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ company: "", contact: "", country: "", email: "", phone: "", wechat: "", source: "手动录入", intent: "中", estimatedAmount: 0, remark: "" });

  async function refresh() {
    const [active, trash] = await Promise.all([
      api<{ leads: Lead[] }>("/api/leads", token),
      api<{ leads: Lead[] }>("/api/leads?trash=true", token)
    ]);
    setLeads(active.leads);
    setTrashLeads(trash.leads);
  }
  useEffect(() => {
    void refresh();
  }, [token]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((lead) => {
      const matchStage = stageFilter === "all" || lead.stage === stageFilter;
      const matchSearch = !q || lead.company.toLowerCase().includes(q) || lead.contact.toLowerCase().includes(q) || lead.country.toLowerCase().includes(q);
      return matchStage && matchSearch;
    });
  }, [leads, search, stageFilter]);

  async function createLead() {
    if (!form.company.trim()) return;
    await api<{ lead: Lead }>("/api/leads", token, { method: "POST", body: JSON.stringify({ ...form, estimatedAmount: Number(form.estimatedAmount) || 0 }) });
    setCreating(false);
    setForm({ company: "", contact: "", country: "", email: "", phone: "", wechat: "", source: "手动录入", intent: "中", estimatedAmount: 0, remark: "" });
    await refresh();
  }

  async function moveToTrash(id: string, reason = "暂时无效或不适合继续跟进") {
    await api(`/api/leads/${id}`, token, { method: "DELETE", body: JSON.stringify({ reason }) });
    if (selectedId === id) {
      setSelectedId(null);
      setTab("pool");
    }
    await refresh();
  }

  async function restoreLead(id: string) {
    await api(`/api/leads/${id}/restore`, token, { method: "POST" });
    await refresh();
    setSelectedId(id);
    setTab("detail");
  }

  async function permanentlyDeleteLead(id: string) {
    await api(`/api/leads/${id}/permanent`, token, { method: "DELETE" });
    await refresh();
  }

  const counts = LEAD_STAGES.map((stage) => [stage, leads.filter((lead) => lead.stage === stage).length] as const);
  const selectedLead = selectedId ? leads.find((lead) => lead.id === selectedId) || null : null;
  const totalAmount = leads.reduce((sum, lead) => sum + lead.estimatedAmount, 0);

  const tabs: Array<[LeadWorkspaceTab, string, number | null]> = [
    ["pool", "线索池", leads.length],
    ["detail", "详细信息/触达", selectedLead ? null : 0],
    ["activities", "跟进记录", selectedLead ? null : 0],
    ["trash", "垃圾箱", trashLeads.length]
  ];

  function openLead(id: string, nextTab: LeadWorkspaceTab = "detail") {
    setSelectedId(id);
    setTab(nextTab);
  }

  return (
    <section className="panel">
      <div className="panelHead">
        <div><h2>线索工作区</h2><p className="panelSub">线索池、触达、跟进记录和垃圾箱统一处理</p></div>
        <button onClick={() => setCreating((v) => !v)}>{creating ? "取消" : "新增线索"}</button>
      </div>
      <div className="leadKpis">
        <Card label="活跃线索" value={leads.length} />
        <Card label="高意向" value={leads.filter((lead) => lead.intent === "高").length} />
        <Card label="待跟进" value={leads.filter((lead) => lead.status === "new" || lead.status === "following").length} />
        <Card label="预估金额" value={money(totalAmount)} />
      </div>
      <div className="leadTabs">
        {tabs.map(([key, label, count]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}{count !== null ? ` ${count}` : ""}</button>)}
      </div>
      {creating ? <LeadCreateForm form={form} setForm={setForm} onSave={createLead} /> : null}
      {tab === "pool" ? <LeadPool leads={filtered} allLeads={leads} counts={counts} search={search} stageFilter={stageFilter} setSearch={setSearch} setStageFilter={setStageFilter} onOpen={openLead} onTrash={moveToTrash} /> : null}
      {tab === "detail" ? selectedLead ? <LeadDetail lead={selectedLead} token={token} onOpenActivities={() => setTab("activities")} onChanged={refresh} onTrash={moveToTrash} /> : <LeadEmptyPick leads={leads} onOpen={openLead} /> : null}
      {tab === "activities" ? selectedLead ? <LeadActivityPage lead={selectedLead} token={token} onChanged={refresh} /> : <LeadEmptyPick leads={leads} onOpen={(id) => openLead(id, "activities")} /> : null}
      {tab === "trash" ? <LeadTrash leads={trashLeads} onRestore={restoreLead} onPermanentDelete={permanentlyDeleteLead} /> : null}
    </section>
  );
}

function LeadCreateForm({ form, setForm, onSave }: { form: { company: string; contact: string; country: string; email: string; phone: string; wechat: string; source: string; intent: string; estimatedAmount: number; remark: string }; setForm: (form: { company: string; contact: string; country: string; email: string; phone: string; wechat: string; source: string; intent: string; estimatedAmount: number; remark: string }) => void; onSave: () => Promise<void> }) {
  return <div className="leadForm">
    <input placeholder="客户/公司名 *" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
    <input placeholder="联系人" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
    <input placeholder="国家/地区" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
    <input placeholder="邮箱" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
    <input placeholder="电话/WhatsApp" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
    <input placeholder="微信" value={form.wechat} onChange={(e) => setForm({ ...form, wechat: e.target.value })} />
    <input placeholder="来源" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
    <select value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })}>{LEAD_INTENTS.map((it) => <option key={it} value={it}>意向{it}</option>)}</select>
    <input type="number" placeholder="预估金额" value={form.estimatedAmount} onChange={(e) => setForm({ ...form, estimatedAmount: Number(e.target.value) })} />
    <input placeholder="备注" value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
    <button className="primary" onClick={() => void onSave()}>保存线索</button>
  </div>;
}

function LeadPool({ leads, allLeads, counts, search, stageFilter, setSearch, setStageFilter, onOpen, onTrash }: { leads: Lead[]; allLeads: Lead[]; counts: ReadonlyArray<readonly [string, number]>; search: string; stageFilter: string; setSearch: (value: string) => void; setStageFilter: (value: string) => void; onOpen: (id: string, tab?: LeadWorkspaceTab) => void; onTrash: (id: string) => Promise<void> }) {
  return <>
    <div className="chips">
      <span className={stageFilter === "all" ? "active" : ""} onClick={() => setStageFilter("all")}>全部 {allLeads.length}</span>
      {counts.map(([stage, count]) => <span key={stage} className={stageFilter === stage ? "active" : ""} onClick={() => setStageFilter(stage)}>{stage} {count}</span>)}
    </div>
    <input className="leadSearch" placeholder="搜索客户名 / 联系人 / 国家" value={search} onChange={(e) => setSearch(e.target.value)} />
    <table>
      <thead><tr><th>客户</th><th>国家</th><th>来源</th><th>意向</th><th>阶段</th><th>预估金额</th><th>下次跟进</th><th>状态</th><th>动作</th></tr></thead>
      <tbody>
        {leads.map((lead) => <LeadRow key={lead.id} lead={lead} onOpen={onOpen} onTrash={onTrash} />)}
        {leads.length === 0 ? <tr><td colSpan={9} className="emptyRow">暂无线索</td></tr> : null}
      </tbody>
    </table>
  </>;
}

function LeadRow({ lead, onOpen, onTrash }: { lead: Lead; onOpen: (id: string, tab?: LeadWorkspaceTab) => void; onTrash: (id: string) => Promise<void> }) {
  return <tr>
    <td><button className="linkName" onClick={() => onOpen(lead.id)}>{lead.company}</button><small>{lead.contact || "—"}</small></td>
    <td>{lead.country || "—"}</td>
    <td>{lead.source || "—"}</td>
    <td><span className={`intent intent-${lead.intent}`}>{lead.intent}</span></td>
    <td>{lead.stage}</td>
    <td>{money(lead.estimatedAmount)}</td>
    <td>{lead.nextFollowAt || "—"}</td>
    <td><span className={`leadStatus s-${lead.status}`}>{LEAD_STATUS_LABEL[lead.status]}</span></td>
    <td><div className="tableActions"><button onClick={() => onOpen(lead.id, "detail")}>详情</button><button onClick={() => onOpen(lead.id, "activities")}>记录</button><button onClick={() => void onTrash(lead.id)}>移入垃圾箱</button></div></td>
  </tr>;
}

function LeadEmptyPick({ leads, onOpen }: { leads: Lead[]; onOpen: (id: string) => void }) {
  return <div className="emptyPick"><b>先选择一条线索</b><span>最近线索</span><div className="cards">{leads.slice(0, 4).map((lead) => <button key={lead.id} onClick={() => onOpen(lead.id)}><b>{lead.company}</b><span>{lead.contact || lead.country || "待维护"}</span></button>)}</div></div>;
}

function LeadDetail({ lead, token, onOpenActivities, onChanged, onTrash }: { lead: Lead; token: string; onOpenActivities: () => void; onChanged: () => Promise<void> | void; onTrash: (id: string) => Promise<void> }) {
  const [socialChannel, setSocialChannel] = useState("whatsapp");
  const [socialMessage, setSocialMessage] = useState(`你好 ${lead.contact || ""}，我是 GoodJob 的外贸顾问，想和您确认一下近期采购需求。`);
  const [emailSubject, setEmailSubject] = useState(`${lead.company} 产品资料与报价沟通`);
  const [emailBody, setEmailBody] = useState(`Hi ${lead.contact || "there"},\n\nThank you for your interest. I would like to confirm your target product, quantity, and required certificates so we can prepare a suitable quotation.\n\nBest regards`);
  const [nextFollowAt, setNextFollowAt] = useState(lead.nextFollowAt || "明天 10:00");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSocialMessage(`你好 ${lead.contact || ""}，我是 GoodJob 的外贸顾问，想和您确认一下近期采购需求。`);
    setEmailSubject(`${lead.company} 产品资料与报价沟通`);
    setEmailBody(`Hi ${lead.contact || "there"},\n\nThank you for your interest. I would like to confirm your target product, quantity, and required certificates so we can prepare a suitable quotation.\n\nBest regards`);
    setNextFollowAt(lead.nextFollowAt || "明天 10:00");
    setMessage("");
  }, [lead.id]);

  async function changeStage(stage: string) {
    await api(`/api/leads/${lead.id}`, token, { method: "PATCH", body: JSON.stringify({ stage }) });
    await onChanged();
  }
  async function convert() {
    await api(`/api/leads/${lead.id}/convert`, token, { method: "POST" });
    await onChanged();
  }
  async function sendSocial() {
    if (!socialMessage.trim()) return;
    await api(`/api/leads/${lead.id}/social-touch`, token, { method: "POST", body: JSON.stringify({ channel: socialChannel, message: socialMessage, nextFollowAt }) });
    setMessage("触达已记录到跟进记录");
    await onChanged();
  }
  async function sendEmail() {
    try {
      await api(`/api/leads/${lead.id}/send-email`, token, { method: "POST", body: JSON.stringify({ to: lead.email, subject: emailSubject, body: emailBody, nextFollowAt }) });
      setMessage("邮件已发送并写入跟进记录");
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邮件发送失败");
    }
  }

  const fields: Array<[string, string]> = [
    ["联系人", lead.contact || "—"], ["国家/地区", lead.country || "—"], ["邮箱", lead.email || "—"],
    ["电话/WhatsApp", lead.phone || "—"], ["微信", lead.wechat || "—"], ["来源", lead.source || "—"],
    ["意向", lead.intent], ["预估金额", money(lead.estimatedAmount)], ["下次跟进", lead.nextFollowAt || "—"]
  ];

  return <>
    <div className="leadHead">
      <div className="pageTitle"><div><p>Lead Detail</p><h1>{lead.company}</h1><span>状态：{LEAD_STATUS_LABEL[lead.status]} · 阶段：{lead.stage}</span></div></div>
      <div className="leadHeadActions">
        <select value={lead.stage} onChange={(e) => void changeStage(e.target.value)}>{LEAD_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select>
        <button onClick={onOpenActivities}>查看跟进记录</button>
        {lead.convertedCustomerId ? <span className="leadStatus s-converted">已转客户</span> : <button className="primary" onClick={() => void convert()}>转为客户</button>}
        <button onClick={() => void onTrash(lead.id)}>移入垃圾箱</button>
      </div>
    </div>
    {lead.remark ? <p className="leadRemark">{lead.remark}</p> : null}
    <div className="leadFields">{fields.map(([label, value]) => <div key={label} className="leadField"><span>{label}</span><b>{value}</b></div>)}</div>
    <div className="touchGrid">
      <div className="touchPanel">
        <div className="panelHead"><h2>通讯/社媒发送</h2></div>
        <div className="leadCompose"><select value={socialChannel} onChange={(e) => setSocialChannel(e.target.value)}><option value="whatsapp">WhatsApp</option><option value="wechat">微信</option><option value="linkedin">LinkedIn</option><option value="call">电话</option></select><input placeholder="下次跟进" value={nextFollowAt} onChange={(e) => setNextFollowAt(e.target.value)} /></div>
        <textarea value={socialMessage} onChange={(e) => setSocialMessage(e.target.value)} />
        <button className="primary" onClick={() => void sendSocial()}>记录并发送</button>
      </div>
      <div className="touchPanel">
        <div className="panelHead"><h2>邮箱发送</h2></div>
        <input disabled={!lead.email} value={lead.email || "未维护邮箱"} readOnly />
        <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
        <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} />
        <button className="primary" disabled={!lead.email} onClick={() => void sendEmail()}>发送邮件</button>
      </div>
    </div>
    {message ? <p className={message.includes("失败") || message.includes("配置") || message.includes("邮箱") ? "error" : "successMsg"}>{message}</p> : null}
  </>;
}

function LeadActivityPage({ lead, token, onChanged }: { lead: Lead; token: string; onChanged: () => Promise<void> | void }) {
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [note, setNote] = useState("");
  const [noteType, setNoteType] = useState("call");
  const [nextFollowAt, setNextFollowAt] = useState("");

  function load() {
    return api<{ lead: Lead; activities: LeadActivity[] }>(`/api/leads/${lead.id}`, token).then((data) => {
      setActivities(data.activities);
    });
  }
  useEffect(() => {
    void load();
  }, [lead.id]);

  async function addActivity() {
    if (!note.trim()) return;
    await api(`/api/leads/${lead.id}/activities`, token, { method: "POST", body: JSON.stringify({ type: noteType, content: note, nextFollowAt }) });
    setNote("");
    setNextFollowAt("");
    await load();
    await onChanged();
  }

  return (
    <>
      <div className="panelHead"><h2>跟进记录</h2></div>
      <p className="leadRemark">{lead.company} · {lead.contact || "联系人待维护"} · {lead.nextFollowAt || "暂无下次跟进"}</p>
      <div className="leadCompose">
        <select value={noteType} onChange={(e) => setNoteType(e.target.value)}><option value="call">电话</option><option value="wechat">微信</option><option value="whatsapp">WhatsApp</option><option value="linkedin">LinkedIn</option><option value="email">邮件</option><option value="meeting">会面</option><option value="note">备注</option></select>
        <input placeholder="填写本次跟进内容" value={note} onChange={(e) => setNote(e.target.value)} />
        <input placeholder="下次跟进时间(可选)" value={nextFollowAt} onChange={(e) => setNextFollowAt(e.target.value)} />
        <button className="primary" onClick={() => void addActivity()}>添加跟进</button>
      </div>
      <div className="todoList">
        {activities.map((activity) => (
          <article className="todo" key={activity.id}>
            <i />
            <div><b>{ACTIVITY_LABEL[activity.type] || activity.type} · {activity.content}</b><span>{new Date(activity.createdAt).toLocaleString()}{activity.nextFollowAt ? ` · 下次：${activity.nextFollowAt}` : ""}</span></div>
          </article>
        ))}
        {activities.length === 0 ? <p className="emptyRow">暂无跟进记录</p> : null}
      </div>
    </>
  );
}

function LeadTrash({ leads, onRestore, onPermanentDelete }: { leads: Lead[]; onRestore: (id: string) => Promise<void>; onPermanentDelete: (id: string) => Promise<void> }) {
  return <>
    <div className="panelHead"><h2>垃圾箱</h2></div>
    <table>
      <thead><tr><th>线索</th><th>国家</th><th>移入时间</th><th>原因</th><th>动作</th></tr></thead>
      <tbody>
        {leads.map((lead) => <tr key={lead.id}><td><b>{lead.company}</b><small>{lead.contact || "—"}</small></td><td>{lead.country || "—"}</td><td>{lead.deletedAt ? new Date(lead.deletedAt).toLocaleString() : "—"}</td><td>{lead.deletedReason || "—"}</td><td><div className="tableActions"><button className="primary" onClick={() => void onRestore(lead.id)}>恢复</button><button onClick={() => void onPermanentDelete(lead.id)}>永久删除</button></div></td></tr>)}
        {leads.length === 0 ? <tr><td colSpan={5} className="emptyRow">垃圾箱为空</td></tr> : null}
      </tbody>
    </table>
  </>;
}

function Customers({ customers }: { customers: Customer[] }) {
  return <section className="panel"><div className="panelHead"><h2>客户管理</h2><button>新增客户</button></div><table><thead><tr><th>客户</th><th>国家</th><th>阶段</th><th>金额</th><th>单据抬头</th><th>提醒</th></tr></thead><tbody>{customers.map((item) => <tr key={item.id}><td><b>{item.company}</b><small>{item.contact}</small></td><td>{item.country}</td><td>{item.stage}</td><td>{money(item.amount)}</td><td>{item.billingName || item.company}</td><td>{item.nextReminder}</td></tr>)}</tbody></table></section>;
}

function Pipeline({ deals, token, onChanged }: { deals: Deal[]; token: string; onChanged: () => void }) {
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  async function moveDeal(id: string, stage: string) {
    await api(`/api/deals/${id}/stage`, token, { method: "PATCH", body: JSON.stringify({ stage }) });
    onChanged();
  }
  return <section className="panel"><div className="panelHead"><h2>商机管道</h2><button>新增商机</button></div><div className="pipeline">{stages.map((stage) => <div className="stage" key={stage}><h3>{stage}</h3>{deals.filter((deal) => deal.stage === stage).map((deal) => <article className="deal" key={deal.id}><b>{deal.title}</b><span>{deal.product || "产品待维护"} · {deal.quantity || 0} 件 × {money(deal.unitPrice || 0)}</span><span>{money(deal.amount)} · {deal.nextAction}</span><select value={deal.stage} onChange={(event) => void moveDeal(deal.id, event.target.value)}>{stages.map((item) => <option key={item}>{item}</option>)}</select></article>)}</div>)}</div></section>;
}

function Reminders({ reminders, token, onChanged }: { reminders: Reminder[]; token: string; onChanged: () => void }) {
  async function done(id: string) {
    await api(`/api/reminders/${id}/done`, token, { method: "POST" });
    onChanged();
  }
  return <section className="panel"><div className="panelHead"><h2>跟进提醒</h2><button>设置规则</button></div><div className="todoList">{reminders.map((reminder) => <article className="todo" key={reminder.id}><i /><div><b>{reminder.title}</b><span>{reminder.rule} · {reminder.dueAt} · {reminder.channel}</span></div><button onClick={() => void done(reminder.id)}>{reminder.status === "done" ? "已完成" : "完成"}</button></article>)}</div></section>;
}

function ImportExport({ jobs, token, onCreated }: { jobs: ImportExportJob[]; token: string; onCreated: () => void }) {
  async function createJob(type: "import" | "export") {
    await api("/api/import-export/jobs", token, { method: "POST", body: JSON.stringify({ name: type === "import" ? "新导入任务" : "新导出任务", type, rows: 100 }) });
    onCreated();
  }
  return <section className="panel"><div className="panelHead"><h2>导入导出</h2><div><button onClick={() => void createJob("import")}>新建导入</button><button onClick={() => void createJob("export")}>新建导出</button></div></div><table><thead><tr><th>任务</th><th>类型</th><th>行数</th><th>状态</th><th>时间</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.name}</td><td>{job.type}</td><td>{job.rows}</td><td>{job.status}</td><td>{job.createdAt}</td></tr>)}</tbody></table></section>;
}

function Wecom({ messages }: { messages: WecomMessage[] }) {
  return <section className="panel"><div className="panelHead"><h2>企业微信</h2><button>立即同步</button></div><div className="cards">{messages.map((message) => <div className="mini" key={message.id}><b>{message.status === "archived" ? "已归档" : "待归档"}</b><span>{message.summary}</span></div>)}</div></section>;
}

function Reports({ summary }: { summary: DashboardSummary | null }) {
  return <div className="report"><section className="reportHero"><small>Executive Report Deck</small><h1>经营汇报</h1><p>本月预测成交额 {money(summary?.metrics.forecastAmount || 0)}，按销售漏斗、市场结构、团队效率和风险动作生成汇报。</p></section><div className="reportGrid"><div className="panel"><h2>销售漏斗</h2><div className="bars"><span style={{ width: "92%" }}>询盘 42</span><span style={{ width: "74%" }}>已联系 31</span><span style={{ width: "62%" }}>已报价 26</span><span style={{ width: "33%" }}>样品 14</span></div></div><div className="panel"><h2>管理层关注</h2><ol><li>报价逾期日清</li><li>认证资料复训</li><li>样品反馈标准化</li></ol></div></div></div>;
}

function Knowledge() {
  return <section className="panel"><div className="panelHead"><h2>资料维护</h2><button>上传资料</button></div><div className="cards">{["LED 灯具参数手册 V3", "欧洲报价模板", "CE 证书客户解释话术", "包装唛头示例图库"].map((title) => <div className="mini" key={title}><b>{title}</b><span>版本审核 · 类目关联 · 考试联动</span></div>)}</div></section>;
}

function Exam() {
  return <section className="panel"><div className="panelHead"><h2>销售在线考试系统</h2><button>发布考试</button></div><div className="exam"><div><h3>1. 客户要求 CE 证书时，优先提供什么？</h3><p className="selected">对应产品型号的 CE 证书与测试报告</p><p>产品宣传图</p><p>海运提单</p></div><aside><b>分类目考试维护</b><span>LED 灯具基础 · 认证资料专项 · 报价规则进阶</span></aside></div></section>;
}

function Tools({ token }: { token: string }) {
  const [synced, setSynced] = useState(false);
  async function syncLead() {
    await api("/api/tools/ocr/jobs/ocr1/sync-lead", token, { method: "POST" });
    setSynced(true);
  }
  return <section className="panel"><div className="panelHead"><h2>小工具 · 名片 OCR 识别</h2><button onClick={syncLead}>{synced ? "已同步" : "同步到线索"}</button></div><div className="ocr"><div className="business"><h2>NorthStar Lighting GmbH</h2><b>James Müller</b><span>james.mueller@northstar-light.de</span><span>WhatsApp +49 151 2388 9012</span><span>德国 Berlin</span></div><div className="fields">{["公司名", "联系人", "邮箱", "WhatsApp", "微信", "电话", "国家"].map((field) => <label key={field}><input type="checkbox" defaultChecked />{field}<input defaultValue={field === "公司名" ? "NorthStar Lighting GmbH" : field === "联系人" ? "James Müller" : ""} /></label>)}</div></div></section>;
}

function Settings({ user, accounts }: { user: User; accounts: User[] }) {
  const canManage = user.role === "admin" || user.role === "super_admin";
  const visibleAccounts = canManage ? accounts : [user];
  const scopeText = (role: User["role"]) => role === "sales" ? "本人业务，本人待办/备忘" : role === "manager" ? "团队业务，本人待办/备忘" : role === "admin" ? "全局业务，账号管理" : "全局业务，最高账号权限";
  return <section className="panel"><div className="panelHead"><h2>账号管理</h2><button disabled={!canManage}>新增账号</button></div>{!canManage ? <p>只有管理员和超级管理员可以管理账号。</p> : null}<table><thead><tr><th>账号</th><th>角色</th><th>数据范围</th></tr></thead><tbody>{visibleAccounts.map((account) => <tr key={account.id}><td><b>{account.name}</b><small>{account.email}</small></td><td>{account.role}</td><td>{scopeText(account.role)}</td></tr>)}</tbody></table></section>;
}

function App() {
  const [token, setToken] = useState(localStorage.getItem("gj_token"));
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("gj_user");
    return raw ? JSON.parse(raw) as User : null;
  });

  const authed = useMemo(() => token && user, [token, user]);

  function onLogin(nextToken: string, nextUser: User) {
    localStorage.setItem("gj_token", nextToken);
    localStorage.setItem("gj_user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  }

  function onLogout() {
    localStorage.removeItem("gj_token");
    localStorage.removeItem("gj_user");
    setToken(null);
    setUser(null);
  }

  return authed && user ? <Layout user={user} onLogout={onLogout} /> : <Login onLogin={onLogin} />;
}

createRoot(document.getElementById("root")!).render(<App />);
