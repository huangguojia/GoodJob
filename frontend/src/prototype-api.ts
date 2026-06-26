type Role = "sales" | "manager" | "admin";

interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string;
  avatar: string;
}

interface Customer {
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

interface Todo {
  id: string;
  title: string;
  type: string;
  priority: string;
  dueAt: string;
  related: string;
  done: boolean;
  impactAmount?: number;
}

interface Deal {
  id: string;
  title: string;
  stage: string;
  amount: number;
  nextAction: string;
}

interface Reminder {
  id: string;
  title: string;
  rule: string;
  dueAt: string;
  channel: string;
  status: string;
}

interface ImportExportJob {
  id: string;
  name: string;
  type: string;
  rows: number;
  status: string;
  createdAt: string;
}

interface KnowledgeAsset {
  id: string;
  title: string;
  category: string;
  status: string;
  version: string;
}

interface Exam {
  id: string;
  title: string;
  category: string;
  status: string;
  passRate: number;
  questionCount: number;
}

interface WecomMessage {
  id: string;
  summary: string;
  status: string;
}

interface OcrJob {
  id: string;
  status: string;
  confidence: number;
  fields: Record<string, string>;
}

interface DashboardSummary {
  scope: string;
  metrics: {
    customers: number;
    todos: number;
    overdueTodos: number;
    forecastAmount: number;
  };
}

interface AppState {
  user: User | null;
  summary: DashboardSummary | null;
  customers: Customer[];
  todos: Todo[];
  deals: Deal[];
  reminders: Reminder[];
  jobs: ImportExportJob[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  ocrJob: OcrJob | null;
  todoFilter: "all" | "today" | "overdue" | "mine" | "customer" | "knowledge";
  selectedCustomerId: string | null;
}

const state: AppState = {
  user: null,
  summary: null,
  customers: [],
  todos: [],
  deals: [],
  reminders: [],
  jobs: [],
  knowledgeAssets: [],
  exams: [],
  ocrJob: null,
  todoFilter: "all",
  selectedCustomerId: null
};

const roleEmail: Record<Role, string> = {
  sales: "shirley@goodjob.com",
  manager: "alex@goodjob.com",
  admin: "admin@goodjob.com"
};

const roleLabel: Record<Role, string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员"
};

const storage = {
  token: "gj_token",
  user: "gj_user"
};

function qs<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector(selector) as T | null;
}

function qsa<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)] as T[];
}

function money(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function amount(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

function badge(text: string, tone = "") {
  return `<span class="badge ${tone}">${text}</span>`;
}

function escapeHtml(value: string | number | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function ensureUiLayer() {
  if (!qs(".toast-stack")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="toast-stack" aria-live="polite"></div>`);
  }
  if (!qs("#appModal")) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal-backdrop" id="appModal" role="dialog" aria-modal="true">
        <div class="modal">
          <div class="modal-head"><h2 id="modalTitle">操作</h2><button class="btn icon-only" data-modal-close title="关闭">×</button></div>
          <div class="modal-body" id="modalBody"></div>
          <div class="modal-foot" id="modalFoot"></div>
        </div>
      </div>
    `);
    qs("[data-modal-close]")?.addEventListener("click", closeModal);
    qs("#appModal")?.addEventListener("click", (event) => {
      if (event.target === qs("#appModal")) closeModal();
    });
  }
}

function toast(message: string, type: "ok" | "error" = "ok") {
  ensureUiLayer();
  const stack = qs<HTMLElement>(".toast-stack")!;
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  stack.appendChild(item);
  window.setTimeout(() => item.remove(), 2600);
}

function openModal(title: string, body: string, foot: string) {
  ensureUiLayer();
  qs("#modalTitle")!.textContent = title;
  qs("#modalBody")!.innerHTML = body;
  qs("#modalFoot")!.innerHTML = foot;
  qsa("[data-modal-close]", qs("#appModal")!).forEach((node) => node.addEventListener("click", closeModal));
  qs("#appModal")!.classList.add("active");
}

function closeModal() {
  qs("#appModal")?.classList.remove("active");
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(storage.token);
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "请求失败" }));
    throw new Error(body.message || "请求失败");
  }
  return response.json() as Promise<T>;
}

async function loginByRole(role: Role) {
  const result = await api<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: roleEmail[role], password: "goodjob123" })
  });
  localStorage.setItem(storage.token, result.token);
  localStorage.setItem(storage.user, JSON.stringify(result.user));
  state.user = result.user;
  applyAuthedUser(result.user);
  document.body.classList.add("is-authenticated");
  await refreshAll(result.user);
  toast(`已登录：${result.user.name}`);
}

function applyAuthedUser(user: User) {
  const profileName = `${user.name} / ${roleLabel[user.role]}`;
  document.body.dataset.role = user.role === "sales" ? "sales" : "manager";
  qs("#scopeUser")!.textContent = profileName;
  qs("#scopeText")!.textContent = user.role === "sales" ? "仅本人客户、本人待办、本人线索" : user.role === "manager" ? "欧洲组全部客户、全部待办、团队考试成绩" : "全量客户、账号、权限、审计与系统配置";
  qs("#currentAvatar")!.textContent = user.avatar;
  const roleSwitcher = qs<HTMLSelectElement>("#roleSwitcher");
  const loginRole = qs<HTMLSelectElement>("#loginRole");
  if (roleSwitcher) roleSwitcher.value = user.role;
  if (loginRole) loginRole.value = user.role;
}

async function refreshAll(user: User) {
  const [summary, customers, todos, deals, reminders, jobs, wecom, knowledge, exams, ocr] = await Promise.all([
    api<DashboardSummary>("/api/dashboard/summary"),
    api<{ customers: Customer[] }>("/api/customers"),
    api<{ todos: Todo[] }>("/api/todos"),
    api<{ deals: Deal[] }>("/api/deals"),
    api<{ reminders: Reminder[] }>("/api/reminders"),
    api<{ jobs: ImportExportJob[] }>("/api/import-export/jobs"),
    api<{ messages: WecomMessage[] }>("/api/wecom/messages"),
    api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets"),
    api<{ exams: Exam[] }>("/api/exams"),
    api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1")
  ]);
  state.user = user;
  state.summary = summary;
  state.customers = customers.customers;
  state.todos = todos.todos;
  state.deals = deals.deals;
  state.reminders = reminders.reminders;
  state.jobs = jobs.jobs;
  state.knowledgeAssets = knowledge.assets;
  state.exams = exams.exams;
  state.ocrJob = ocr.job;
  state.selectedCustomerId = state.selectedCustomerId || customers.customers[0]?.id || null;
  renderDashboard(summary, todos.todos, customers.customers);
  renderCustomers(customers.customers);
  renderPipeline(deals.deals);
  renderReminders(reminders.reminders);
  renderJobs(jobs.jobs);
  renderWecom(wecom.messages);
  renderKnowledge(knowledge.assets);
  renderExams(exams.exams);
  renderAccounts(user);
  renderOcr(ocr.job);
}

function renderDashboard(summary: DashboardSummary, todos: Todo[], customers: Customer[]) {
  qs("#scopeText")!.textContent = summary.scope;
  const kpis = qsa<HTMLElement>("#dashboard .kpi strong");
  if (kpis[0]) kpis[0].textContent = String(summary.metrics.todos);
  if (kpis[1]) kpis[1].textContent = String(summary.metrics.customers);
  if (kpis[2]) kpis[2].textContent = money(summary.metrics.forecastAmount);
  const focus = qs<HTMLElement>(".focus-metric b");
  if (focus) focus.textContent = money(customers.filter((item) => item.nextReminder.includes("逾期")).reduce((sum, item) => sum + item.amount, 0));
  renderTodos(todos);
  updateTodoChips(todos);
}

function renderTodos(todos: Todo[]) {
  const list = qs<HTMLElement>("#dashboard .todo-list");
  if (!list) return;
  const visibleTodos = filterTodos(todos);
  list.innerHTML = visibleTodos.map((todo) => {
    const tone = todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green";
    return `<article class="todo-row ${todo.priority === "high" ? "urgent" : ""} ${todo.done ? "done" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <i class="todo-check" title="完成待办"></i>
      <div class="todo-main"><h3>${escapeHtml(todo.title)}</h3><div class="todo-meta"><i class="priority-dot" style="--color:var(--${tone === "red" ? "rose" : tone})"></i><span>${escapeHtml(priorityText(todo.priority))}</span><span>${escapeHtml(todo.dueAt)}</span><span>${escapeHtml(todo.related)}</span>${badge(todo.done ? "已完成" : todo.type, todo.done ? "green" : tone)}</div></div>
      <div class="todo-side"><div class="assignee-stack"><span class="mini-avatar">我</span></div><div class="subtask-bar"><i style="--p:${todo.done ? "100%" : "55%"}"></i></div></div>
    </article>`;
  }).join("");
  qsa<HTMLElement>(".todo-row .todo-check", list).forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const row = node.closest<HTMLElement>(".todo-row");
      if (!row?.dataset.todoId) return;
      await api(`/api/todos/${row.dataset.todoId}/complete`, { method: "POST" });
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) todo.done = true;
      row.classList.add("done");
      node.setAttribute("title", "已完成");
      updateTodoChips(state.todos);
      toast("待办已完成");
    });
  });
  qsa<HTMLElement>(".todo-row", list).forEach((row) => {
    row.addEventListener("click", () => {
      const todo = state.todos.find((item) => item.id === row.dataset.todoId);
      if (todo) toast(`${todo.related} · ${todo.dueAt}`);
    });
  });
  const total = visibleTodos.length;
  const overdue = visibleTodos.filter((todo) => todo.priority === "high" && !todo.done).length;
  const done = visibleTodos.filter((todo) => todo.done).length;
  const scoreCards = qsa<HTMLElement>(".todo-score-card b");
  if (scoreCards[0]) scoreCards[0].textContent = String(total);
  if (scoreCards[1]) scoreCards[1].textContent = String(overdue);
  if (scoreCards[2]) scoreCards[2].textContent = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  if (scoreCards[3]) scoreCards[3].textContent = money(visibleTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0));
}

function filterTodos(todos: Todo[]) {
  if (state.todoFilter === "overdue") return todos.filter((todo) => todo.priority === "high" && !todo.done);
  if (state.todoFilter === "customer") return todos.filter((todo) => todo.type === "customer");
  if (state.todoFilter === "knowledge") return todos.filter((todo) => todo.type === "knowledge" || todo.type === "exam");
  return todos;
}

function updateTodoChips(todos: Todo[]) {
  const chips = qsa<HTMLElement>("#dashboard .todo-chip");
  const values = [
    `今天 ${todos.filter((todo) => !todo.done).length}`,
    `逾期 ${todos.filter((todo) => todo.priority === "high" && !todo.done).length}`,
    `我负责 ${todos.length}`,
    "客户跟进",
    "资料/考试"
  ];
  chips.forEach((chip, index) => {
    chip.textContent = values[index] || chip.textContent || "";
    const filters: AppState["todoFilter"][] = ["today", "overdue", "mine", "customer", "knowledge"];
    chip.dataset.todoFilter = filters[index] || "all";
    chip.classList.toggle("active", state.todoFilter === chip.dataset.todoFilter || (state.todoFilter === "all" && index === 0));
  });
}

function priorityText(priority: string) {
  if (priority === "high") return "高优先级";
  if (priority === "medium") return "中优先级";
  return "普通";
}

function renderCustomers(customers: Customer[]) {
  const tbody = qs<HTMLElement>("#customers tbody");
  if (!tbody) return;
  tbody.innerHTML = customers.map((customer, index) => `<tr class="${index === 0 ? "selected" : ""}">
    <td><div class="company"><span class="flag">${countryFlag(customer.country)}</span><div><b>${escapeHtml(customer.company)}</b><span>${escapeHtml(customer.contact)}</span></div></div></td>
    <td>${escapeHtml(customer.country)}</td>
    <td>${badge(customer.stage, customer.stage === "成交" || customer.stage === "谈判" ? "green" : customer.stage === "已报价" ? "amber" : "")}</td>
    <td class="amount">${amount(customer.amount)}</td>
    <td>${health(customer.health)}</td>
    <td>今天</td>
    <td>${customer.nextReminder.includes("逾期") ? badge(customer.nextReminder, "red") : escapeHtml(customer.nextReminder)}</td>
    <td>${badge(customer.wecomBound ? "已绑定" : "未绑定", customer.wecomBound ? "green" : "gray")}</td>
    <td>${customer.id === "c3" || customer.id === "c4" ? "Mia" : "Shirley"}</td>
  </tr>`).join("");
  qsa<HTMLElement>("tr", tbody).forEach((row, index) => {
    const customer = customers[index];
    row.dataset.customerId = customer.id;
    row.classList.toggle("selected", customer.id === (state.selectedCustomerId || customers[0]?.id));
    row.addEventListener("click", () => {
      state.selectedCustomerId = customer.id;
      renderCustomerDrawer(customer);
      qsa<HTMLElement>("tr", tbody).forEach((item) => item.classList.toggle("selected", item.dataset.customerId === customer.id));
    });
  });
  renderCustomerDrawer(customers.find((item) => item.id === state.selectedCustomerId) || customers[0]);
}

function renderCustomerDrawer(customer?: Customer) {
  const drawer = qs<HTMLElement>("#customers .drawer");
  if (!drawer || !customer) return;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(customer.company)}</h2><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.stage)}</p></div>
      ${customer.nextReminder.includes("逾期") ? badge("报价未回复", "red") : badge("跟进中", "green")}
    </div>
    <div class="score-card">
      <div class="score-ring"><span>${customer.health}</span></div>
      <div><b>成交评分：${customer.health >= 80 ? "高" : customer.health >= 60 ? "中" : "需抢救"}</b><p>系统按金额、阶段、健康度和下一提醒生成优先级。</p></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>预计金额</span><b>${amount(customer.amount)}</b></div>
      <div class="info"><span>健康度</span><b>${customer.health}%</b></div>
      <div class="info"><span>当前阶段</span><b>${escapeHtml(customer.stage)}</b></div>
      <div class="info"><span>下一提醒</span><b>${escapeHtml(customer.nextReminder)}</b></div>
    </div>
    <button class="btn primary" data-add-follow style="width:100%">新增跟进记录</button>
    <div class="timeline">
      <div class="timeline-item"><b>企微摘要</b><span>${customer.wecomBound ? "客户已绑定企微，可归档会话摘要。" : "客户暂未绑定企微，建议补充联系方式。"}</span></div>
      <div class="timeline-item"><b>系统提醒</b><span>${escapeHtml(customer.nextReminder)}</span></div>
      <div class="timeline-item"><b>客户阶段</b><span>${escapeHtml(customer.stage)} · ${amount(customer.amount)}</span></div>
    </div>
  `;
  qs<HTMLButtonElement>("[data-add-follow]", drawer)?.addEventListener("click", () => toast(`已记录 ${customer.company} 的跟进动作`));
}

function countryFlag(country: string) {
  const flags: Record<string, string> = { 瑞典: "SE", 美国: "US", 日本: "JP", 阿联酋: "AE", 德国: "DE" };
  return flags[country] || "GL";
}

function health(value: number) {
  const active = Math.max(1, Math.round(value / 20));
  return `<span class="health ${value < 60 ? "bad" : value < 75 ? "warn" : ""}">${[1, 2, 3, 4, 5].map((item) => `<i class="${item <= active ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderPipeline(deals: Deal[]) {
  const strip = qs<HTMLElement>("#pipeline .pipeline-strip");
  if (!strip) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  strip.innerHTML = stages.map((stage) => {
    const stageDeals = deals.filter((deal) => deal.stage === stage || (stage === "成交" && deal.stage === "成交"));
    return `<div class="stage"><div class="stage-head"><span>${stage === "成交" ? "成交/丢单" : stage}</span><b>${stageDeals.length}</b></div>${stageDeals.map((deal) => `<div class="deal" data-deal-id="${escapeHtml(deal.id)}"><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(deal.nextAction)}</span><div class="deal-foot"><span>${money(deal.amount)}</span>${badge(deal.stage, deal.stage === "成交" ? "green" : deal.stage === "已报价" ? "red" : "")}</div><button class="btn" data-move-deal>推进阶段</button></div>`).join("") || `<div class="deal"><b>暂无商机</b><span>等待新线索进入</span><div class="deal-foot"><span>$0k</span><span>空</span></div></div>`}</div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-move-deal]", strip).forEach((button) => {
    button.addEventListener("click", () => void moveDeal(button.closest<HTMLElement>(".deal")?.dataset.dealId || ""));
  });
}

async function moveDeal(id: string) {
  const deal = state.deals.find((item) => item.id === id);
  if (!deal) return;
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"] as const;
  const nextStage = stages[Math.min(stages.indexOf(deal.stage as typeof stages[number]) + 1, stages.length - 1)];
  const result = await api<{ deal: Deal }>(`/api/deals/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({ stage: nextStage })
  });
  Object.assign(deal, result.deal);
  renderPipeline(state.deals);
  toast(`商机已推进到：${nextStage}`);
}

function renderReminders(reminders: Reminder[]) {
  const list = qs<HTMLElement>("#reminders .task-list");
  if (!list) return;
  list.innerHTML = reminders.map((reminder) => `<article class="task" data-reminder-id="${escapeHtml(reminder.id)}" style="--accent: var(--${reminder.status === "done" ? "green" : "rose"})"><i class="task-line"></i><div><h3>${escapeHtml(reminder.title)}</h3><p>${escapeHtml(reminder.rule)} · ${escapeHtml(reminder.dueAt)} · ${escapeHtml(reminder.channel)}</p></div><button class="btn">${reminder.status === "done" ? "已完成" : "完成"}</button></article>`).join("");
  qsa<HTMLButtonElement>("#reminders .task .btn", list).forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest<HTMLElement>(".task");
      if (!row?.dataset.reminderId) return;
      await api(`/api/reminders/${row.dataset.reminderId}/done`, { method: "POST" });
      button.textContent = "已完成";
    });
  });
}

function renderJobs(jobs: ImportExportJob[]) {
  const tbody = qs<HTMLElement>("#imports tbody");
  if (!tbody) return;
  tbody.innerHTML = jobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${job.type === "import" ? "导入" : "导出"}</td><td>${job.rows.toLocaleString("en-US")} 行</td><td>${badge(job.status === "done" ? "完成" : "待审批", job.status === "done" ? "green" : "amber")}</td><td>当前账号</td><td>${escapeHtml(job.createdAt)}</td></tr>`).join("");
}

async function createJob(type: "import" | "export") {
  const result = await api<{ job: ImportExportJob }>("/api/import-export/jobs", {
    method: "POST",
    body: JSON.stringify({
      name: type === "import" ? "手工导入客户" : "客户清单导出",
      type,
      rows: type === "import" ? 25 : state.customers.length
    })
  });
  state.jobs.unshift(result.job);
  renderJobs(state.jobs);
  toast(type === "import" ? "导入任务已创建" : "导出任务已提交审批");
}

function renderWecom(messages: WecomMessage[]) {
  const chat = qs<HTMLElement>("#wecom .chat");
  if (!chat) return;
  chat.innerHTML = messages.map((message, index) => `<div class="bubble ${index % 2 ? "me" : ""}">${escapeHtml(message.summary)} ${message.status === "archived" ? "已归档" : "待归档"}</div>`).join("");
}

function renderKnowledge(assets: KnowledgeAsset[]) {
  const grid = qs<HTMLElement>("#knowledge .file-grid");
  if (!grid) return;
  grid.innerHTML = assets.map((asset) => `<div class="file-card" data-asset-id="${escapeHtml(asset.id)}"><div class="file-icon">${escapeHtml(assetIcon(asset.category))}</div><b>${escapeHtml(asset.title)}</b><span>${escapeHtml(asset.category)} · ${asset.status === "published" ? "已发布" : "待审核"} · ${escapeHtml(asset.version)}</span><button class="btn" data-publish-asset>${asset.status === "published" ? "已发布" : "发布"}</button></div>`).join("");
  const total = qsa<HTMLElement>("#knowledge .dense-card b");
  if (total[0]) total[0].textContent = String(assets.length);
  if (total[1]) total[1].textContent = String(assets.filter((item) => item.status !== "published").length);
  qsa<HTMLButtonElement>("[data-publish-asset]", grid).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void publishAsset(button.closest<HTMLElement>(".file-card")?.dataset.assetId || "");
    });
  });
}

async function publishAsset(id: string) {
  const asset = state.knowledgeAssets.find((item) => item.id === id);
  if (!asset || asset.status === "published") {
    toast("资料已经是发布状态");
    return;
  }
  try {
    const result = await api<{ asset: KnowledgeAsset }>(`/api/knowledge/assets/${id}/publish`, { method: "PATCH" });
    Object.assign(asset, result.asset);
    renderKnowledge(state.knowledgeAssets);
    toast("资料已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

function openKnowledgeModal() {
  openModal("上传资料", `
    <div class="form-grid">
      <div class="form-field full"><label>资料标题</label><input id="assetTitleInput" value="新品参数说明"></div>
      <div class="form-field"><label>资料类目</label><select id="assetCategoryInput"><option>产品知识</option><option>认证资料</option><option>报价规则</option><option>销售 SOP</option></select></div>
      <div class="form-field"><label>版本</label><input id="assetVersionInput" value="v1"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAssetButton">上传资料</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveAssetButton")?.addEventListener("click", () => void saveAsset());
}

async function saveAsset() {
  const title = qs<HTMLInputElement>("#assetTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写资料标题", "error");
    return;
  }
  const result = await api<{ asset: KnowledgeAsset }>("/api/knowledge/assets", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#assetCategoryInput")?.value || "产品知识",
      version: qs<HTMLInputElement>("#assetVersionInput")?.value || "v1"
    })
  });
  state.knowledgeAssets.unshift(result.asset);
  renderKnowledge(state.knowledgeAssets);
  closeModal();
  toast("资料已上传");
}

function assetIcon(category: string) {
  if (category.includes("报价")) return "XLS";
  if (category.includes("认证")) return "DOC";
  return "PDF";
}

function renderExams(exams: Exam[]) {
  const list = qs<HTMLElement>("#exam .exam-sidebar .category-list");
  if (!list) return;
  list.innerHTML = exams.map((exam) => `<div class="category-item" data-exam-id="${escapeHtml(exam.id)}"><div><b>${escapeHtml(exam.title)}</b><span>${exam.questionCount} 题 · 通过率 ${exam.passRate}% · ${escapeHtml(exam.category)}</span></div><div style="display:flex; gap:6px; align-items:center">${badge(exam.status === "published" ? "发布" : exam.status === "draft" ? "草稿" : "排期", exam.status === "published" ? "green" : exam.status === "draft" ? "amber" : "")}<button class="btn" data-start-exam>考试</button><button class="btn" data-publish-exam>发布</button></div></div>`).join("");
  const cards = qsa<HTMLElement>("#exam .dense-card b");
  if (cards[0]) cards[0].textContent = String(exams.filter((item) => item.status !== "draft").length);
  if (cards[2]) cards[2].textContent = `${Math.round(exams.reduce((sum, item) => sum + item.passRate, 0) / Math.max(exams.length, 1))}%`;
  qsa<HTMLButtonElement>("[data-start-exam]", list).forEach((button) => {
    button.addEventListener("click", () => openExamModal(button.closest<HTMLElement>(".category-item")?.dataset.examId || ""));
  });
  qsa<HTMLButtonElement>("[data-publish-exam]", list).forEach((button) => {
    button.addEventListener("click", () => void publishExam(button.closest<HTMLElement>(".category-item")?.dataset.examId || ""));
  });
}

function openExamModal(id: string) {
  const exam = state.exams.find((item) => item.id === id) || state.exams[0];
  if (!exam) return;
  openModal(`${exam.title} · 在线考试`, `
    <div class="exam-paper">
      <div class="question-card"><h3>1. 客户要求 CE 证书时应优先提供什么？</h3><div class="option-row" data-question><span>A. 工厂营业执照</span><span data-correct="true">B. 对应产品型号的 CE 证书与测试报告</span><span>C. 宣传图</span></div></div>
      <div class="question-card"><h3>2. MOQ 变化需要同步更新哪些内容？</h3><div class="option-row" data-question><span>A. 仅备注</span><span data-correct="true">B. 单价、装箱、交期、付款条款影响</span><span>C. 客户国家</span></div></div>
      <div class="question-card"><h3>3. 样品寄出后何时触发反馈提醒？</h3><div class="option-row" data-question><span>A. 不提醒</span><span data-correct="true">B. 签收后 3 天</span><span>C. 30 天</span></div></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="submitExamButton">交卷</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qsa<HTMLElement>("#appModal [data-question] span").forEach((option) => {
    option.addEventListener("click", () => {
      qsa<HTMLElement>("span", option.parentElement!).forEach((item) => item.classList.remove("active"));
      option.classList.add("active");
    });
  });
  qs("#submitExamButton")?.addEventListener("click", () => void submitExam(exam.id));
}

async function submitExam(id: string) {
  const questions = qsa<HTMLElement>("#appModal [data-question]");
  const correct = questions.filter((question) => qs<HTMLElement>("span.active[data-correct='true']", question)).length;
  const score = Math.round((correct / Math.max(questions.length, 1)) * 100);
  const result = await api<{ attempt: { score: number; passed: boolean } }>(`/api/exams/${id}/submit`, {
    method: "POST",
    body: JSON.stringify({ score })
  });
  closeModal();
  toast(`交卷成功：${result.attempt.score} 分，${result.attempt.passed ? "已通过" : "需补考"}`);
}

async function publishExam(id: string) {
  const exam = state.exams.find((item) => item.id === id);
  if (!exam) return;
  try {
    const result = await api<{ exam: Exam }>(`/api/exams/${id}/publish`, { method: "PATCH" });
    Object.assign(exam, result.exam);
    renderExams(state.exams);
    toast("考试已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

function openExamCreateModal() {
  openModal("发布考试", `
    <div class="form-grid">
      <div class="form-field full"><label>考试名称</label><input id="examTitleInput" value="新品知识抽考"></div>
      <div class="form-field"><label>类目</label><select id="examCategoryInput"><option>产品知识</option><option>认证资料</option><option>报价规则</option></select></div>
      <div class="form-field"><label>题量</label><input id="examCountInput" type="number" value="20"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveExamButton">创建考试</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveExamButton")?.addEventListener("click", () => void saveExam());
}

async function saveExam() {
  const title = qs<HTMLInputElement>("#examTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写考试名称", "error");
    return;
  }
  const result = await api<{ exam: Exam }>("/api/exams", {
    method: "POST",
    body: JSON.stringify({
      title,
      category: qs<HTMLSelectElement>("#examCategoryInput")?.value || "产品知识",
      questionCount: Number(qs<HTMLInputElement>("#examCountInput")?.value || 20)
    })
  });
  state.exams.unshift(result.exam);
  renderExams(state.exams);
  closeModal();
  toast("考试已创建");
}

async function renderAccounts(user: User) {
  const tbody = qs<HTMLElement>("#settings tbody");
  if (!tbody) return;
  let accounts: User[] = [user];
  if (user.role !== "sales") {
    accounts = (await api<{ accounts: User[] }>("/api/accounts")).accounts;
  }
  tbody.innerHTML = accounts.map((account) => `<tr><td><div class="company"><span class="avatar">${escapeHtml(account.avatar)}</span><div><b>${escapeHtml(account.name)}</b><span>${escapeHtml(account.email)}</span></div></div></td><td>${badge(roleLabel[account.role], account.role === "admin" ? "amber" : account.role === "manager" ? "green" : "")}</td><td>${account.role === "sales" ? "仅本人数据" : account.role === "manager" ? "欧洲组全部" : "全量权限"}</td><td>${account.role === "admin" ? "全部" : account.role === "manager" ? "团队全部" : "本人客户"}</td><td>${badge("启用", "green")}</td><td>今天</td></tr>`).join("");
}

function renderOcr(job: OcrJob) {
  const fields = job.fields;
  const mapping: Record<string, string> = {
    company: "公司名",
    contact: "联系人",
    title: "职位",
    email: "邮箱",
    whatsapp: "WhatsApp",
    wechat: "微信",
    phone: "电话",
    country: "国家",
    city: "城市"
  };
  const cards = qs<HTMLElement>("#tools .ocr-fields");
  if (!cards) return;
  cards.innerHTML = Object.entries(mapping).map(([key, label]) => `<div class="field-card"><input type="checkbox" checked data-ocr-field="${escapeHtml(key)}"><div><label>${label}</label><input type="text" value="${escapeHtml(fields[key])}"></div></div>`).join("") +
    `<div class="field-card"><input type="checkbox"><div><label>标签</label><input type="text" value="LED灯具 / 欧洲进口商"></div></div>`;
  const statusRows = qsa<HTMLElement>("#tools .sync-row");
  if (statusRows[0]) statusRows[0].innerHTML = `<span>识别状态</span><b>${job.status === "synced" ? "已同步" : "完成"}</b>${badge(`${job.confidence}% 置信度`, "green")}`;
  const cardTitle = qs<HTMLElement>("#tools .business-card h2");
  if (cardTitle) cardTitle.textContent = fields.company;
  const card = qs<HTMLElement>("#tools .business-card");
  if (card) {
    card.innerHTML = `<h2>${escapeHtml(fields.company)}</h2><p>Import & Distribution</p><strong>${escapeHtml(fields.contact)}</strong><span>${escapeHtml(fields.title)}</span><span>${escapeHtml(fields.email)}</span><span>WhatsApp ${escapeHtml(fields.whatsapp)}</span><span>WeChat ${escapeHtml(fields.wechat)}</span><span>${escapeHtml(fields.city)}, ${escapeHtml(fields.country)}</span>`;
  }
}

async function recognizeOcr(overrides: Partial<Record<string, string>> = {}) {
  const result = await api<{ job: OcrJob }>("/api/tools/ocr/jobs/ocr1/recognize", {
    method: "POST",
    body: JSON.stringify({ confidence: 96, ...overrides })
  });
  state.ocrJob = result.job;
  renderOcr(result.job);
  toast("名片已识别");
}

function collectOcrFields() {
  const fields: Record<string, string> = {};
  qsa<HTMLInputElement>("#tools .field-card input[data-ocr-field]").forEach((checkbox) => {
    if (!checkbox.checked) return;
    const key = checkbox.dataset.ocrField;
    const input = checkbox.parentElement?.querySelector<HTMLInputElement>("input[type='text']");
    if (key && input) fields[key] = input.value;
  });
  return fields;
}

function openTodoModal(prefill = "") {
  openModal("新增待办", `
    <div class="form-grid">
      <div class="form-field full"><label>待办内容</label><input id="todoTitleInput" value="${escapeHtml(prefill)}" placeholder="例如：明天 10 点跟进 Nordic Tools 报价"></div>
      <div class="form-field"><label>类型</label><select id="todoTypeInput"><option value="customer">客户跟进</option><option value="knowledge">资料维护</option><option value="exam">在线考试</option><option value="ocr">OCR 线索</option></select></div>
      <div class="form-field"><label>优先级</label><select id="todoPriorityInput"><option value="normal">普通</option><option value="medium">中优先级</option><option value="high">高优先级</option></select></div>
      <div class="form-field"><label>时间</label><input id="todoDueInput" value="今天 17:00"></div>
      <div class="form-field"><label>关联对象</label><input id="todoRelatedInput" value="${escapeHtml(state.customers[0]?.company || "未关联")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveTodoButton">保存待办</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveTodoButton")?.addEventListener("click", () => void saveTodo());
  qs<HTMLInputElement>("#todoTitleInput")?.focus();
}

async function saveTodo() {
  const title = qs<HTMLInputElement>("#todoTitleInput")?.value.trim() || "";
  if (!title) {
    toast("请填写待办内容", "error");
    return;
  }
  const result = await api<{ todo: Todo }>("/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title,
      type: qs<HTMLSelectElement>("#todoTypeInput")?.value || "customer",
      priority: qs<HTMLSelectElement>("#todoPriorityInput")?.value || "normal",
      dueAt: qs<HTMLInputElement>("#todoDueInput")?.value || "今天",
      related: qs<HTMLInputElement>("#todoRelatedInput")?.value || "未关联"
    })
  });
  state.todos.unshift(result.todo);
  renderTodos(state.todos);
  updateTodoChips(state.todos);
  closeModal();
  toast("待办已新增");
}

function openCustomerModal() {
  openModal("新增客户", `
    <div class="form-grid">
      <div class="form-field full"><label>公司名</label><input id="customerCompanyInput" placeholder="例如：天津马赫进出口有限公司"></div>
      <div class="form-field"><label>联系人</label><input id="customerContactInput" value="待维护"></div>
      <div class="form-field"><label>国家</label><input id="customerCountryInput" value="中国"></div>
      <div class="form-field"><label>阶段</label><select id="customerStageInput"><option>询盘</option><option>已联系</option><option>已报价</option><option>样品</option><option>谈判</option></select></div>
      <div class="form-field"><label>预计金额</label><input id="customerAmountInput" type="number" value="12000"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerButton">保存客户</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveCustomerButton")?.addEventListener("click", () => void saveCustomer());
  qs<HTMLInputElement>("#customerCompanyInput")?.focus();
}

async function saveCustomer() {
  const company = qs<HTMLInputElement>("#customerCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写公司名", "error");
    return;
  }
  const result = await api<{ customer: Customer }>("/api/customers", {
    method: "POST",
    body: JSON.stringify({
      company,
      contact: qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
      country: qs<HTMLInputElement>("#customerCountryInput")?.value || "未知",
      stage: qs<HTMLSelectElement>("#customerStageInput")?.value || "询盘",
      amount: Number(qs<HTMLInputElement>("#customerAmountInput")?.value || 0)
    })
  });
  state.customers.unshift(result.customer);
  state.selectedCustomerId = result.customer.id;
  renderCustomers(state.customers);
  closeModal();
  toast("客户已新增");
}

async function syncOcrLead(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "同步中";
  try {
    await api("/api/tools/ocr/jobs/ocr1/recognize", {
      method: "POST",
      body: JSON.stringify(collectOcrFields())
    });
    await api("/api/tools/ocr/jobs/ocr1/sync-lead", { method: "POST" });
    button.textContent = "已同步";
    qsa<HTMLElement>("#tools .sync-row").at(2)!.innerHTML = `<span>目标模块</span><b>线索池 / 欧洲组</b>${badge("已同步", "green")}`;
    toast("OCR 线索已同步");
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "同步失败";
  }
}

async function exportReport() {
  const report = await api<{ title: string; forecastAmount: number; conversionRate: number; riskAmount: number; conclusions: string[] }>("/api/reports/executive");
  const content = [
    report.title,
    `预测成交额：${amount(report.forecastAmount)}`,
    `漏斗转化率：${report.conversionRate}%`,
    `高风险金额：${amount(report.riskAmount)}`,
    "",
    ...report.conclusions.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "GoodJob-CRM-经营汇报.txt";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("汇报已生成下载");
}

function installEvents() {
  ensureUiLayer();
  qs<HTMLButtonElement>("#loginButton")?.addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    const role = (qs<HTMLSelectElement>("#loginRole")?.value || "sales") as Role;
    void loginByRole(role);
  }, true);
  qs<HTMLSelectElement>("#roleSwitcher")?.addEventListener("change", (event) => {
    event.stopImmediatePropagation();
    void loginByRole((event.currentTarget as HTMLSelectElement).value as Role);
  }, true);
  qs<HTMLButtonElement>("#logoutButton")?.addEventListener("click", () => {
    localStorage.removeItem(storage.token);
    localStorage.removeItem(storage.user);
    state.user = null;
    toast("已退出登录");
  });
  qsa<HTMLElement>(".todo-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.todoFilter = (chip.dataset.todoFilter || "today") as AppState["todoFilter"];
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    });
  });
  qs<HTMLInputElement>(".quick-add input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.currentTarget as HTMLInputElement;
    openTodoModal(input.value.trim());
    input.value = "";
  });
  qsa<HTMLButtonElement>("#dashboard .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增待办")) button.addEventListener("click", () => openTodoModal());
    if (button.textContent?.includes("批量完成")) button.addEventListener("click", async () => {
      const pending = filterTodos(state.todos).filter((todo) => !todo.done).slice(0, 5);
      await Promise.all(pending.map((todo) => api(`/api/todos/${todo.id}/complete`, { method: "POST" })));
      pending.forEach((todo) => { todo.done = true; });
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      toast(`已完成 ${pending.length} 条待办`);
    });
  });
  qsa<HTMLButtonElement>("#customers .page-head .btn.primary, .top-actions .btn.primary").forEach((button) => {
    if (button.textContent?.includes("新增客户")) button.addEventListener("click", openCustomerModal);
  });
  qs<HTMLButtonElement>("#pipeline .page-head .btn.primary")?.addEventListener("click", () => toast("新增商机入口已就绪，下一步接客户选择与金额表单"));
  qs<HTMLButtonElement>("#reminders .page-head .btn.primary")?.addEventListener("click", () => toast("提醒规则入口已就绪，可继续配置 N 天未回复规则"));
  qs<HTMLButtonElement>("#imports .page-head .btn.primary")?.addEventListener("click", () => void createJob("import"));
  qsa<HTMLButtonElement>("#reports .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("导出")) button.addEventListener("click", () => void exportReport());
    if (button.textContent?.includes("切换月份")) button.addEventListener("click", () => toast("已切换到 2026 年 6 月经营汇报"));
    if (button.textContent?.includes("汇报备注")) button.addEventListener("click", () => openModal("汇报备注", `<div class="form-field full"><label>备注</label><input value="本周重点抢救欧洲报价逾期客户"></div>`, `<button class="btn primary" data-modal-close>保存备注</button>`));
  });
  qsa<HTMLButtonElement>("#knowledge .page-head .btn, #knowledge .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("上传资料")) button.addEventListener("click", openKnowledgeModal);
    if (button.textContent?.includes("新建类目")) button.addEventListener("click", () => toast("资料类目已新增：新品资料"));
    if (button.textContent?.includes("批量发布")) button.addEventListener("click", async () => {
      const pending = state.knowledgeAssets.filter((asset) => asset.status !== "published");
      for (const asset of pending) await publishAsset(asset.id);
      if (!pending.length) toast("没有待发布资料");
    });
    if (button.textContent?.includes("调整排序")) button.addEventListener("click", () => toast("资料类目排序已保存"));
  });
  qsa<HTMLButtonElement>("#exam .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("发布考试")) button.addEventListener("click", openExamCreateModal);
    if (button.textContent?.includes("题库维护")) button.addEventListener("click", () => toast("题库已新增 1 道产品知识题"));
    if (button.textContent?.includes("分类目考试维护")) button.addEventListener("click", () => toast("分类目考试规则已保存"));
  });
  qsa<HTMLButtonElement>(".top-actions .btn.ghost").forEach((button) => {
    if (button.textContent?.includes("导入")) button.addEventListener("click", () => activateNavView("imports", () => void createJob("import")));
    if (button.textContent?.includes("导出")) button.addEventListener("click", () => activateNavView("imports", () => void createJob("export")));
  });
  qsa<HTMLButtonElement>("#tools .page-head .btn, #tools .section-head .btn").forEach((button) => {
    if (button.textContent?.includes("加载名片")) button.addEventListener("click", () => void recognizeOcr({ company: "Tianjin Mahe Trading Co., Ltd.", contact: "Ma He", email: "sales@tjmahe.com", country: "中国" }));
    if (button.textContent?.includes("重新识别")) button.addEventListener("click", () => void recognizeOcr());
    if (button.textContent?.includes("工具配置")) button.addEventListener("click", () => toast("OCR 字段映射配置已保存"));
  });
  qsa<HTMLButtonElement>("#tools .btn.primary").forEach((button) => {
    if (button.textContent?.includes("同步")) button.addEventListener("click", () => void syncOcrLead(button));
  });
  qsa<HTMLButtonElement>("#settings .page-head .btn").forEach((button) => {
    if (button.textContent?.includes("新增账号")) button.addEventListener("click", () => openModal("新增账号", `<div class="form-grid"><div class="form-field"><label>姓名</label><input value="New Sales"></div><div class="form-field"><label>角色</label><select><option>业务员</option><option>主管</option></select></div><div class="form-field full"><label>邮箱</label><input value="new.sales@goodjob.com"></div></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" data-modal-close>保存账号</button>`));
    if (button.textContent?.includes("权限模板")) button.addEventListener("click", () => toast("权限模板已应用"));
    if (button.textContent?.includes("保存设置")) button.addEventListener("click", () => toast("账号与权限设置已保存"));
  });
}

function activateNavView(view: string, after?: () => void) {
  qsa<HTMLElement>(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  qsa<HTMLElement>(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  after?.();
}

async function restoreSession() {
  const rawUser = localStorage.getItem(storage.user);
  const token = localStorage.getItem(storage.token);
  if (!rawUser || !token) return;
  try {
    const { user } = await api<{ user: User }>("/api/auth/me");
    localStorage.setItem(storage.user, JSON.stringify(user));
    state.user = user;
    applyAuthedUser(user);
    document.body.classList.add("is-authenticated");
    await refreshAll(user);
  } catch {
    localStorage.removeItem(storage.token);
    localStorage.removeItem(storage.user);
  }
}

installEvents();
void restoreSession();
