import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, money, type Customer, type Deal, type ImportExportJob, type Reminder, type Todo, type User, type WecomMessage } from "./api";
import "./styles.css";

type View = "dashboard" | "customers" | "pipeline" | "reminders" | "imports" | "reports" | "wecom" | "knowledge" | "exam" | "tools" | "settings";

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
        <select value={email} onChange={(event) => setEmail(event.target.value)}>
          <option value="shirley@goodjob.com">Shirley / 业务员 / 仅本人业务与待办</option>
          <option value="alex@goodjob.com">Alex / 销售主管 / 团队业务，本人待办</option>
          <option value="admin@goodjob.com">Admin / 管理员 / 全局业务与账号</option>
          <option value="super@goodjob.com">Super Admin / 超级管理员 / 最高账号权限</option>
        </select>
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

function Customers({ customers }: { customers: Customer[] }) {
  return <section className="panel"><div className="panelHead"><h2>客户管理</h2><button>新增客户</button></div><table><thead><tr><th>客户</th><th>国家</th><th>阶段</th><th>金额</th><th>健康度</th><th>提醒</th></tr></thead><tbody>{customers.map((item) => <tr key={item.id}><td><b>{item.company}</b><small>{item.contact}</small></td><td>{item.country}</td><td>{item.stage}</td><td>{money(item.amount)}</td><td>{item.health}%</td><td>{item.nextReminder}</td></tr>)}</tbody></table></section>;
}

function Pipeline({ deals, token, onChanged }: { deals: Deal[]; token: string; onChanged: () => void }) {
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  async function moveDeal(id: string, stage: string) {
    await api(`/api/deals/${id}/stage`, token, { method: "PATCH", body: JSON.stringify({ stage }) });
    onChanged();
  }
  return <section className="panel"><div className="panelHead"><h2>商机管道</h2><button>新增商机</button></div><div className="pipeline">{stages.map((stage) => <div className="stage" key={stage}><h3>{stage}</h3>{deals.filter((deal) => deal.stage === stage).map((deal) => <article className="deal" key={deal.id}><b>{deal.title}</b><span>{money(deal.amount)} · {deal.nextAction}</span><select value={deal.stage} onChange={(event) => void moveDeal(deal.id, event.target.value)}>{stages.map((item) => <option key={item}>{item}</option>)}</select></article>)}</div>)}</div></section>;
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
