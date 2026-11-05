/**
 * 新增客户与客户资料文件识别。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type Customer, type OcrJob, type ReportMoneyRow } from "./models";
import { refreshDashboardOnly } from "./dashboard";
import { normalizeWhatsAppPhone, renderCustomers } from "./customers";
import { badge, cookieValue, escapeHtml, qs, qsa } from "./shared";
import { openCustomerDrawer, renderCustomerDetailPage, renderCustomerDrawer } from "./customer-detail";
import { activeOcrJobId, collectOcrFields, renderOcr } from "./tools";
import { api, setButtonPending, toast } from "./ui";
import { customerDocumentName, customerGradeValue, reloadLeads } from "./leads";

// ---------------------------------------------------------------------------
// 新增客户 · 客户资料文件识别（本机 CLI）
//
// 上传名片 / 合同 / 询盘邮件 / 表格 → 后端交给本机 CLI 读文件 → 字段回填表单。
// 只填空白格子：已经手工填过的字段一律不覆盖，避免识别结果盖掉用户输入。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 新增客户 · 客户资料文件识别（本机 CLI）
//
// 上传名片 / 合同 / 询盘邮件 / 表格 → 先暂存到本机 Runner 目录 → 交给本机 CLI 读文件
// → 字段回填表单。只填空白格子：已经手工填过的字段一律不覆盖，避免识别结果盖掉用户输入。
//
// 速度与「连不上 CLI」两条体验要求（2026-10-10 用户反馈）：
//   - 弹窗一打开就检查本机 CLI，连不上直接在最上面说清楚原因 + 手动修复命令；
//   - 识别中显示「已用多久 / 现在在哪一步 / 是否在排队」——CLI 本身只要 10-20 秒，
//     慢通常是因为 Runner 同时在跑别的任务（同一时间只执行一个任务）。
// ---------------------------------------------------------------------------
const CUSTOMER_INTAKE_MAX_FILES = 3;
const CUSTOMER_INTAKE_MAX_BYTES = 12 * 1024 * 1024;
const CUSTOMER_INTAKE_POLL_TIMEOUT_MS = 210_000;
/** 轮询间隔：比原先的 3 秒更密，让进度文案真的在动 */
const CUSTOMER_INTAKE_POLL_INTERVAL_MS = 2_000;
const CUSTOMER_INTAKE_FIELD_INPUTS: Array<[string, string, string]> = [
  ["company", "客户简称", "#customerCompanyInput"],
  ["companyFullName", "公司全名", "#customerCompanyFullNameInput"],
  ["contact", "联系人", "#customerContactInput"],
  ["country", "国家", "#customerCountryInput"],
  ["phone", "电话", "#customerPhoneInput"],
  ["email", "邮箱", "#customerEmailInput"],
  ["whatsapp", "WhatsApp", "#customerWhatsappInput"],
  ["wechat", "微信", "#customerWechatInput"],
  ["website", "官网", "#customerWebsiteInput"],
  ["source", "客户来源", "#customerSourceInput"],
  ["billingAddress", "账单地址", "#customerBillingAddressInput"],
  ["contactRemark", "联系方式备注", "#customerContactRemarkInput"],
  ["otherNotes", "其它说明", "#customerOtherNotesInput"],
  ["defaultPortDischarge", "默认目的港", "#customerPortDischargeInput"],
  ["defaultIncoterm", "默认贸易条款", "#customerIncotermInput"],
  ["defaultPaymentTerm", "默认付款条款", "#customerPaymentTermInput"]
];

/** 本机 CLI 的故障说明：后端已翻译成「结论 + 修复命令」，前端只负责显示 */
interface CustomerIntakeIssue {
  code: string;
  title: string;
  detail: string;
  command: string;
}

interface CustomerIntakeHealth {
  ready: boolean;
  checkedAt: string;
  engine: string;
  adapter: string;
  runner: { id: string; displayName: string; workspace: string; cliVersion: string; cliIssue?: string } | null;
  busy: { taskId: string; status: string; label: string; elapsedSeconds: number } | null;
  lastFailure: (CustomerIntakeIssue & { taskId: string; at: string; adapter: string }) | null;
  issue: CustomerIntakeIssue | null;
}

interface CustomerIntakeFile {
  id: string;
  file: File;
  status: "ready" | "uploading" | "uploaded" | "running" | "done" | "error";
  message: string;
  /** 后端暂存后的文件号：识别阶段用它引用文件 */
  fileId: string;
  /** 服务端把 Office 文档转成纯文本后的说明（如「已由 CRM 从 Excel 转为文本」） */
  convertNote?: string;
  /** 服务端没能自动转换时的可执行建议（怎么改格式再传） */
  convertError?: string;
}

interface CustomerIntakeResult {
  pending: boolean;
  status: string;
  terminal: boolean;
  /** 归因：ok 抽到字段 / empty 解析成功但零字段 / unparsable 拿不到 JSON / no_output 没返回内容 */
  outcome: "ok" | "empty" | "unparsable" | "no_output";
  /** 拿到可用字段即为 true（CLI 收尾报错但结果完整时也是 true） */
  usable: boolean;
  salvaged: boolean;
  taskId: string;
  engine: string;
  fileName: string;
  fileNames: string[];
  fields: Record<string, string>;
  warnings: string[];
  summary: string;
  confidence: number;
  parseError: string;
  /** outcome=empty 时的如实说明（解析成功但没抽到字段） */
  emptyReason: string;
  /** CLI 原始返回片段，供自查 */
  rawPreview: string;
  errorMessage: string;
  outputTruncated: boolean;
  progress: string;
  queue: { queuedSeconds: number; runningSeconds: number; runnerOnline: boolean; busy: boolean } | null;
  diagnosis: CustomerIntakeIssue | null;
}

let customerIntakeFiles: CustomerIntakeFile[] = [];
let customerIntakeBusy = false;
let customerIntakeHealth: CustomerIntakeHealth | null = null;
let customerIntakeHealthChecking = false;
/** 最近一次识别失败的结论（显示在顶部提示条里，附修复命令） */
let customerIntakeFailure: CustomerIntakeIssue | null = null;

function customerIntakePanelHtml() {
  return `
    <section class="customer-intake" id="customerIntake">
      <div class="customer-intake-head">
        <div>
          <b>从资料自动填表</b>
          <small>上传名片、合同、询盘邮件或表格，本机 CLI 读文件后把字段填进下面的格子（只填空白项，不覆盖已填内容）</small>
        </div>
        <span class="badge lf-tag-source">本机 CLI</span>
      </div>
      <div class="customer-intake-health is-checking" id="customerIntakeHealth" data-state="checking">
        <span class="customer-intake-health-dot" aria-hidden="true"></span>
        <div class="customer-intake-health-body">
          <strong id="customerIntakeHealthTitle">正在检查本机 CLI…</strong>
          <small id="customerIntakeHealthDetail"></small>
          <code id="customerIntakeHealthCommand" hidden></code>
        </div>
        <button class="btn" id="customerIntakeHealthRetry" type="button">重新检测</button>
      </div>
      <label class="customer-intake-drop" id="customerIntakeDrop">
        <input type="file" id="customerIntakeInput" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.txt,.md,.csv,.json,.eml,.html,.htm,.doc,.docx,.xls,.xlsx">
        <span class="customer-intake-drop-icon" aria-hidden="true">＋</span>
        <span class="customer-intake-drop-copy"><strong>拖拽文件到这里，或点击选择</strong><small>支持 PDF / 图片 / Word / Excel / CSV / 文本，单个 ≤ 12 MB，一次最多 ${CUSTOMER_INTAKE_MAX_FILES} 个（Excel / Word 会先自动转成文本再识别）</small></span>
      </label>
      <div class="customer-intake-list" id="customerIntakeList" hidden></div>
      <div class="customer-intake-foot">
        <button class="btn primary" id="customerIntakeAnalyzeButton" type="button" disabled>开始识别并填入</button>
        <button class="btn" id="customerIntakeClearButton" type="button" disabled>清空</button>
        <span class="customer-intake-status" id="customerIntakeStatus">尚未选择文件</span>
      </div>
    </section>
  `;
}

function customerIntakeFileText(file: File) {
  const size = file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return `${file.name} · ${size}`;
}

function customerIntakeSeconds(value: number) {
  return value >= 60 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${value} 秒`;
}

/** 顶部 CLI 状态条：把「连不上 CLI」的原因、上次失败、正在排队都摆出来 */
function renderCustomerIntakeHealth() {
  const box = qs<HTMLElement>("#customerIntakeHealth");
  const title = qs<HTMLElement>("#customerIntakeHealthTitle");
  const detail = qs<HTMLElement>("#customerIntakeHealthDetail");
  const command = qs<HTMLElement>("#customerIntakeHealthCommand");
  const retry = qs<HTMLButtonElement>("#customerIntakeHealthRetry");
  if (!box || !title || !detail || !command) return;
  if (retry) retry.disabled = customerIntakeHealthChecking;
  command.hidden = true;
  command.textContent = "";
  detail.textContent = "";
  const apply = (state: string, heading: string, sub: string, fix = "") => {
    box.dataset.state = state;
    box.className = `customer-intake-health is-${state}`;
    title.textContent = heading;
    detail.textContent = sub;
    if (fix) {
      command.hidden = false;
      command.textContent = fix;
    }
  };
  if (customerIntakeHealthChecking) {
    apply("checking", "正在检查本机 CLI…", "检查 Runner 是否在线、CLI 是否已登录");
    return;
  }
  if (customerIntakeFailure) {
    apply("error", `识别失败：${customerIntakeFailure.title}`, customerIntakeFailure.detail, customerIntakeFailure.command);
    return;
  }
  const health = customerIntakeHealth;
  if (!health) {
    apply("warn", "暂时读不到本机 CLI 状态", "仍可尝试识别；失败时这里会给出具体原因");
    return;
  }
  if (!health.ready) {
    apply("error", health.issue?.title || "本机 CLI 不可用", health.issue?.detail || "", health.issue?.command || "");
    return;
  }
  if (health.lastFailure) {
    apply(
      "warn",
      `本机 CLI 最近一次任务失败：${health.lastFailure.title}`,
      `${health.lastFailure.detail}（这台机器最近一次跑完的 CLI 任务没有成功，识别前建议先按下面处理）`,
      health.lastFailure.command
    );
    return;
  }
  if (health.busy) {
    const busyLabel = health.busy.status === "queued" ? "队列里有任务等着跑" : "正在执行另一个任务";
    apply(
      "warn",
      `本机 CLI 忙：${busyLabel}（已 ${customerIntakeSeconds(health.busy.elapsedSeconds)}）`,
      `Runner 同一时间只执行一个任务，识别会先排队；CLI 顺起来后一件资料通常只要 10-20 秒`,
      ""
    );
    return;
  }
  // CLI 账号可以在外部随意切换（workbuddy switch 之类）；这台机器上报了探测故障时要说清原因，
  // 但不要吓唬用户：能力在恢复中，识别照常可以试。
  const cliIssue = (health.runner?.cliIssue || "").trim();
  if (cliIssue) {
    apply(
      "warn",
      "本机 CLI 可用，但这台机器上报了故障",
      `${cliIssue}。CLI 账号在外部切换或 CLI 重装后，Runner 会自动重新探测（十几秒内恢复），不必改 CRM 配置。`,
      ""
    );
    return;
  }
  apply("ok", `本机 CLI 就绪${health.engine ? ` · ${health.engine}` : ""}`, "识别通常 10-20 秒完成");
}

async function refreshCustomerIntakeHealth() {
  if (customerIntakeHealthChecking) return;
  customerIntakeHealthChecking = true;
  customerIntakeFailure = null;
  renderCustomerIntakeHealth();
  try {
    customerIntakeHealth = await api<CustomerIntakeHealth>("/api/customers/intake/health");
  } catch (error) {
    customerIntakeHealth = null;
    if (error instanceof Error && !/无法获取|Failed to fetch|NetworkError/iu.test(error.message)) {
      toast(`本机 CLI 状态检查失败：${error.message}`, "error");
    }
  } finally {
    customerIntakeHealthChecking = false;
    renderCustomerIntakeHealth();
    renderCustomerIntake();
  }
}

function renderCustomerIntake() {
  const list = qs<HTMLElement>("#customerIntakeList");
  const status = qs<HTMLElement>("#customerIntakeStatus");
  const analyzeButton = qs<HTMLButtonElement>("#customerIntakeAnalyzeButton");
  const clearButton = qs<HTMLButtonElement>("#customerIntakeClearButton");
  if (!list || !status) return;
  if (customerIntakeFiles.length) {
    list.hidden = false;
    list.innerHTML = customerIntakeFiles.map((item) => `
      <div class="customer-intake-item is-${item.status}" data-intake-id="${escapeHtml(item.id)}">
        <span class="customer-intake-item-name">${escapeHtml(customerIntakeFileText(item.file))}</span>
        <span class="customer-intake-item-message">${escapeHtml(item.message || (item.status === "ready" ? "待识别" : ""))}</span>
        ${item.convertNote ? `<span class="customer-intake-item-convert">${escapeHtml(item.convertNote)}</span>` : ""}
        ${item.convertError ? `<span class="customer-intake-item-convert is-warn">${escapeHtml(item.convertError)}</span>` : ""}
      </div>
    `).join("");
  } else {
    list.hidden = true;
    list.innerHTML = "";
  }
  const pending = customerIntakeFiles.filter((item) => item.status === "ready" || item.status === "error").length;
  const cliReady = customerIntakeHealth ? customerIntakeHealth.ready : true;
  if (analyzeButton) {
    analyzeButton.disabled = customerIntakeBusy || !pending || !cliReady;
    analyzeButton.textContent = customerIntakeBusy ? "识别中…" : "开始识别并填入";
    analyzeButton.title = cliReady ? "" : "本机 CLI 当前不可用：先按上方提示处理，再点这里重试";
  }
  if (clearButton) clearButton.disabled = customerIntakeBusy || !customerIntakeFiles.length;
  if (customerIntakeBusy) {
    const running = customerIntakeFiles.find((item) => item.status === "running") || customerIntakeFiles.find((item) => item.status === "uploading");
    status.textContent = running ? `${running.file.name}：${running.message || "识别中"}` : "识别中…";
    return;
  }
  const done = customerIntakeFiles.filter((item) => item.status === "done").length;
  const failed = customerIntakeFiles.filter((item) => item.status === "error").length;
  if (done || failed) {
    status.textContent = [done ? `已识别 ${done} 个文件` : "", failed ? `${failed} 个失败` : "", pending ? `${pending} 个待识别` : ""].filter(Boolean).join(" · ");
    return;
  }
  status.textContent = customerIntakeFiles.length ? `${customerIntakeFiles.length} 个文件待识别` : "尚未选择文件";
}

function addCustomerIntakeFiles(input: FileList | File[]) {
  const incoming = Array.from(input);
  if (!incoming.length) return;
  const rejected: string[] = [];
  let accepted = 0;
  incoming.forEach((file) => {
    if (customerIntakeFiles.length >= CUSTOMER_INTAKE_MAX_FILES) {
      rejected.push(`${file.name}（一次最多 ${CUSTOMER_INTAKE_MAX_FILES} 个文件）`);
      return;
    }
    if (!file.size) {
      rejected.push(`${file.name}（空文件）`);
      return;
    }
    if (file.size > CUSTOMER_INTAKE_MAX_BYTES) {
      rejected.push(`${file.name}（超过 ${Math.round(CUSTOMER_INTAKE_MAX_BYTES / 1024 / 1024)} MB）`);
      return;
    }
    if (customerIntakeFiles.some((item) => item.file.name === file.name && item.file.size === file.size)) {
      rejected.push(`${file.name}（已在列表中）`);
      return;
    }
    customerIntakeFiles.push({ id: `cif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, file, status: "ready", message: "", fileId: "" });
    accepted += 1;
  });
  renderCustomerIntake();
  if (accepted && !rejected.length) toast(`已选择 ${accepted} 个文件，点「开始识别并填入」由本机 CLI 读取`);
  if (rejected.length) toast(`已跳过：${rejected.join("、")}`, "error");
}

interface CustomerIntakeApplyResult {
  applied: string[];
  kept: string[];
}

/** 把识别结果填进空白格子；已有内容一律保留 */
function applyCustomerIntakeFields(fields: Record<string, string>): CustomerIntakeApplyResult {
  const applied: string[] = [];
  const kept: string[] = [];
  CUSTOMER_INTAKE_FIELD_INPUTS.forEach(([key, label, selector]) => {
    const value = (fields[key] || "").trim();
    if (!value) return;
    const input = qs<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!input) return;
    // 「客户来源」新增时预置了「手动新增」默认值：那只是占位，识别到真实来源时应当采用
    const existing = input.value.trim();
    const untouchedDefault = selector === "#customerSourceInput" && existing === "手动新增";
    if (existing && !untouchedDefault) {
      kept.push(label);
      return;
    }
    input.value = value;
    input.classList.add("is-intake-filled");
    window.setTimeout(() => input.classList.remove("is-intake-filled"), 2600);
    applied.push(label);
  });
  return { applied, kept };
}

/** 上传一个文件到本机暂存区；后端会在这一步就检查 Runner / CLI，连不上会直接带诊断回来 */
async function stageCustomerIntakeFile(item: CustomerIntakeFile): Promise<{ fileId: string; convertNote: string; convertError: string }> {
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch("/api/customers/intake/files", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(item.file.name),
      "x-file-type": item.file.type || "application/octet-stream",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
    },
    body: await item.file.arrayBuffer()
  });
  const body = await response.json().catch(() => ({ message: "上传失败" })) as {
    fileId?: string;
    message?: string;
    diagnosis?: CustomerIntakeIssue;
    convertNote?: string;
    convertError?: string;
  };
  if (!response.ok) throw customerIntakeError(body.message || "上传失败", body.diagnosis);
  if (!body.fileId) throw new Error("上传成功但没有拿到文件号，请重试");
  return {
    fileId: body.fileId,
    convertNote: body.convertNote || "",
    convertError: body.convertError || ""
  };
}

function customerIntakeError(message: string, diagnosis?: CustomerIntakeIssue | null) {
  const error = new Error(message);
  if (diagnosis) (error as Error & { diagnosis?: CustomerIntakeIssue }).diagnosis = diagnosis;
  return error;
}

function customerIntakeErrorDiagnosis(error: unknown): CustomerIntakeIssue | null {
  const diagnosis = (error as { diagnosis?: CustomerIntakeIssue } | null)?.diagnosis;
  return diagnosis && diagnosis.title ? diagnosis : null;
}

/** 缺省诊断：连本机 CLI 都没连上时，至少把「去把 Runner 起起来」讲清楚 */
function customerIntakeFallbackDiagnosis(error: unknown): CustomerIntakeIssue {
  const message = error instanceof Error ? error.message : "识别失败";
  return {
    code: "cli_failed",
    title: "本机 CLI 不可用",
    detail: message,
    command: "cd ~/Desktop/GoodJob_private/goodjob-runner && node dist/cli.js start"
  };
}

async function runCustomerIntakeAnalysis(fileIds: string[], onProgress: (text: string) => void): Promise<CustomerIntakeResult> {
  const csrfToken = cookieValue("gj_csrf");
  const response = await fetch("/api/customers/intake/analyze", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
    body: JSON.stringify({ fileIds })
  });
  const body = await response.json().catch(() => ({ message: "识别失败" })) as CustomerIntakeResult & { message?: string };
  if (!response.ok) throw customerIntakeError(body.message || "识别失败", body.diagnosis);
  let latest = body;
  const deadline = Date.now() + CUSTOMER_INTAKE_POLL_TIMEOUT_MS;
  while (latest.pending && latest.taskId && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, CUSTOMER_INTAKE_POLL_INTERVAL_MS));
    latest = await api<CustomerIntakeResult>(`/api/customers/intake/analyze/${encodeURIComponent(latest.taskId)}`);
    onProgress(customerIntakeProgressText(latest));
    // 排队很久而且 Runner 心跳断了：顺手刷新顶部状态条，让提示条给出修复命令
    if (latest.diagnosis) {
      customerIntakeFailure = latest.diagnosis;
      renderCustomerIntakeHealth();
    }
  }
  if (latest.pending) {
    throw customerIntakeError(
      "识别超时：本机 CLI 一直没有返回结果",
      latest.diagnosis || {
        code: "cli_timeout",
        title: "识别超时",
        detail: `任务已等待 ${customerIntakeSeconds(Math.round(CUSTOMER_INTAKE_POLL_TIMEOUT_MS / 1000))} 仍未结束。`,
        command: "确认本机 Runner 在运行（cd ~/Desktop/GoodJob_private/goodjob-runner && node dist/cli.js start），或换更小的文件重试"
      }
    );
  }
  return latest;
}

/** 识别中的一句人话：先讲排队，再讲当前步骤 */
function customerIntakeProgressText(result: CustomerIntakeResult) {
  const queue = result.queue;
  if (queue && result.status === "queued") {
    const waited = customerIntakeSeconds(queue.queuedSeconds || 0);
    if (!queue.runnerOnline) return `已排队 ${waited} · 本机 Runner 心跳中断`;
    return queue.busy ? `已排队 ${waited} · 前面还有 1 个任务在跑` : `已排队 ${waited}`;
  }
  const seconds = queue ? queue.runningSeconds : 0;
  const step = (result.progress || "").replace(/^正在调用工具：/u, "读取中：");
  return [`已用 ${customerIntakeSeconds(seconds)}`, step].filter(Boolean).join(" · ");
}

async function analyzeCustomerIntakeFiles() {
  if (customerIntakeBusy) return;
  const targets = customerIntakeFiles.filter((item) => item.status === "ready" || item.status === "error");
  if (!targets.length) {
    toast("请先选择要识别的文件", "error");
    return;
  }
  customerIntakeBusy = true;
  customerIntakeFailure = null;
  renderCustomerIntakeHealth();
  renderCustomerIntake();
  const appliedLabels: string[] = [];
  const keptLabels: string[] = [];
  const warnings: string[] = [];
  let failure: string = "";
  let failureDiagnosis: CustomerIntakeIssue | null = null;
  /** 「解析成功但没抽到字段」的说明：这不是失败，不该走红色诊断 */
  let emptyNotice = "";
  try {
    // 1) 逐个上传到本机暂存区（本地回环，几十毫秒；Runner 不在会在这里就报出来）
    const fileIds: string[] = [];
    for (const item of targets) {
      item.status = "uploading";
      item.message = "上传中…";
      renderCustomerIntake();
      try {
        const staged = await stageCustomerIntakeFile(item);
        item.fileId = staged.fileId;
        item.convertNote = staged.convertNote;
        item.convertError = staged.convertError;
        item.status = "uploaded";
        item.message = "已就绪";
        fileIds.push(item.fileId);
      } catch (error) {
        const diagnosis = customerIntakeErrorDiagnosis(error) || customerIntakeFallbackDiagnosis(error);
        item.status = "error";
        item.message = `上传失败：${diagnosis.title}`;
        failure = failure || diagnosis.title;
        failureDiagnosis = failureDiagnosis || diagnosis;
        renderCustomerIntake();
      }
    }
    renderCustomerIntake();
    if (!fileIds.length) {
      if (failureDiagnosis) {
        customerIntakeFailure = failureDiagnosis;
        renderCustomerIntakeHealth();
      }
      throw customerIntakeError(failure || "文件上传失败", failureDiagnosis);
    }

    // 2) 多个文件合并成**一个** CLI 任务，避免串行等 N 次 CLI
    const activeItems = targets.filter((item) => item.fileId);
    activeItems.forEach((item) => {
      item.status = "running";
      item.message = "排队 / 等待本机 CLI…";
    });
    renderCustomerIntake();
    const startedAt = Date.now();
    const result = await runCustomerIntakeAnalysis(fileIds, (text) => {
      activeItems.forEach((item) => { item.message = text || "本机 CLI 正在读文件…"; });
      renderCustomerIntake();
      const status = qs<HTMLElement>("#customerIntakeStatus");
      if (status && text) status.textContent = text;
    });
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (result.outcome === "empty") {
      // JSON 是合法的、CLI 也没报错，只是这份资料里没有可回填的字段（二进制表格、纯图片、空白模板…）。
      // 这不是失败：把 CLI 给出的原因（它往往已经写明「该文件是二进制 .xls，Read 无法解析」）如实摆出来，
      // 而不是丢一句「不是可解析的 JSON」让人去猜。
      activeItems.forEach((item) => {
        item.status = "done";
        item.message = `未识别到可填入的字段 · 用时 ${customerIntakeSeconds(elapsed)}`;
      });
      result.warnings.forEach((warning) => warnings.push(warning));
      emptyNotice = result.emptyReason || "识别完成，但没有从资料里抽到可回填的客户字段。";
    } else if (!result.usable) {
      const diagnosis = result.diagnosis || customerIntakeFallbackDiagnosis(new Error(result.errorMessage || `任务${result.status}`));
      customerIntakeFailure = diagnosis;
      activeItems.forEach((item) => {
        item.status = "error";
        item.message = result.parseError || diagnosis.title;
      });
      failure = failure || diagnosis.title;
      failureDiagnosis = diagnosis;
    } else if (result.parseError) {
      activeItems.forEach((item) => {
        item.status = "error";
        item.message = result.parseError;
      });
      failure = failure || result.parseError;
    } else {
      const outcome = applyCustomerIntakeFields(result.fields);
      appliedLabels.push(...outcome.applied);
      keptLabels.push(...outcome.kept);
      result.warnings.forEach((warning) => warnings.push(warning));
      activeItems.forEach((item) => {
        item.status = "done";
        item.message = outcome.applied.length
          ? `已填入 ${outcome.applied.length} 项${result.confidence ? `（置信度 ${Math.round(result.confidence * 100)}%）` : ""} · 用时 ${customerIntakeSeconds(elapsed)}${result.salvaged ? " · CLI 收尾报错但结果已拿到" : ""}`
          : `未识别到可填入的字段 · 用时 ${customerIntakeSeconds(elapsed)}`;
      });
      if (result.salvaged) toast("本机 CLI 收尾时报了错，但识别结果已经拿到，请核对后保存", "error");
      if (!outcome.applied.length) failure = failure || "没有识别到能填入的字段，请检查文件内容或手工填写";
    }
  } catch (error) {
    if (!failureDiagnosis) failureDiagnosis = customerIntakeErrorDiagnosis(error);
    failure = failure || (error instanceof Error ? error.message : "识别失败");
    if (failureDiagnosis) {
      customerIntakeFailure = failureDiagnosis;
    }
    customerIntakeFiles.forEach((item) => {
      if (item.status === "running" || item.status === "uploaded") {
        item.status = "error";
        item.message = failureDiagnosis ? failureDiagnosis.title : failure;
      }
    });
  } finally {
    customerIntakeBusy = false;
    renderCustomerIntake();
    renderCustomerIntakeHealth();
  }
  const uniqueApplied = Array.from(new Set(appliedLabels));
  const uniqueKept = Array.from(new Set(keptLabels));
  if (uniqueApplied.length) {
    toast(`已填入：${uniqueApplied.join("、")}${uniqueKept.length ? `；已保留原有内容：${uniqueKept.join("、")}` : ""}`);
  } else if (!failure) {
    toast(emptyNotice || "没有识别到可填入的字段，请手工核对");
  }
  if (warnings.length) toast(`识别提示：${warnings.slice(0, 3).join("；")}`);
  if (!uniqueApplied.length && failure) toast(failureDiagnosis ? `${failureDiagnosis.title}：${failureDiagnosis.command}` : failure, "error");
  // 失败后顺手刷新一次体检，让顶部提示条与实际情况保持一致
  if (failure) void refreshCustomerIntakeHealth();
}

function bindCustomerIntake() {
  const drop = qs<HTMLElement>("#customerIntakeDrop");
  const input = qs<HTMLInputElement>("#customerIntakeInput");
  if (!drop || !input) return;
  input.addEventListener("change", () => {
    if (input.files) addCustomerIntakeFiles(input.files);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("is-dragging");
  }));
  ["dragleave", "dragend", "drop"].forEach((type) => drop.addEventListener(type, () => drop.classList.remove("is-dragging")));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = (event as DragEvent).dataTransfer?.files;
    if (files?.length) addCustomerIntakeFiles(files);
  });
  qs<HTMLButtonElement>("#customerIntakeAnalyzeButton")?.addEventListener("click", () => void analyzeCustomerIntakeFiles());
  qs<HTMLButtonElement>("#customerIntakeHealthRetry")?.addEventListener("click", () => void refreshCustomerIntakeHealth());
  qs<HTMLButtonElement>("#customerIntakeClearButton")?.addEventListener("click", () => {
    if (customerIntakeBusy) return;
    customerIntakeFiles = [];
    customerIntakeFailure = null;
    renderCustomerIntake();
  });
  renderCustomerIntake();
  // 弹窗一打开就体检：连不上 CLI 的话，用户在上传之前就能看到原因和修复命令
  void refreshCustomerIntakeHealth();
}

export function openCustomerModal(customer?: Customer) {
  const editing = Boolean(customer);
  const selectedGrade = customer ? customerGradeValue(customer) : "C";
  const customerLifecycle = customer?.lifecycleStatus === "won" ? "won" : "open";
  customerIntakeFiles = [];
  customerIntakeHealth = null;
  customerIntakeFailure = null;
  openModal(editing ? "编辑客户" : "新增客户", `
    ${editing ? "" : customerIntakePanelHtml()}
    <div class="form-grid">
      <div class="form-field full"><label>客户简称</label><input id="customerCompanyInput" placeholder="例如：Nordic Tools" value="${escapeHtml(customer?.company || "")}"><small class="form-hint">工作台、商机和跟进中使用的短名称</small></div>
      <div class="form-field"><label>联系人</label><input id="customerContactInput" value="${escapeHtml(customer?.contact || "")}"></div>
      <div class="form-field"><label>国家</label><input id="customerCountryInput" value="${escapeHtml(customer?.country || "")}"></div>
      <div class="form-field full"><label>公司全名（单据 / 资料）</label><input id="customerCompanyFullNameInput" maxlength="200" value="${escapeHtml(customerDocumentName(customer || { company: "" } as Customer))}" placeholder="例如：Nordic Tools International Trading Co., Ltd."><small class="form-hint">报价、合同、发票、装箱单、报关资料优先使用此名称</small></div>
      <div class="form-field full"><label>客户来源</label><input id="customerSourceInput" list="customerSourceOptions" maxlength="120" value="${escapeHtml(customer?.source || (editing ? "" : "手动新增"))}" placeholder="例如 官网询盘、展会、转介绍、Alibaba、LinkedIn"><datalist id="customerSourceOptions"><option value="手动新增"></option><option value="官网询盘"></option><option value="展会"></option><option value="转介绍"></option><option value="Alibaba"></option><option value="LinkedIn"></option><option value="WhatsApp"></option><option value="批量导入"></option><option value="智能获客"></option></datalist></div>
      <div class="form-field full"><label>WhatsApp</label><input id="customerWhatsappInput" inputmode="tel" value="${escapeHtml(customer?.whatsapp || customer?.whatsappPhone || "")}" placeholder="例如 +49123456789（含国家码）"></div>
      <div class="form-field"><label>微信</label><input id="customerWechatInput" maxlength="100" value="${escapeHtml(customer?.wechat || "")}" placeholder="微信号或绑定手机号"></div>
      <div class="form-field"><label>电话</label><input id="customerPhoneInput" inputmode="tel" value="${escapeHtml(customer?.phone || "")}" placeholder="公司电话或联系人电话"></div>
      <div class="form-field"><label>邮箱</label><input id="customerEmailInput" type="email" value="${escapeHtml(customer?.email || "")}" placeholder="例如 sales@example.com"></div>
      <div class="form-field full"><label>联系方式备注 / 其它渠道</label><textarea id="customerContactRemarkInput" rows="2" maxlength="500" placeholder="例如：LinkedIn / 微信 / Telegram / 展会名片；可分行记录多个渠道">${escapeHtml(customer?.contactRemark || "")}</textarea></div>
      <div class="form-field full"><label>官网</label><input id="customerWebsiteInput" value="${escapeHtml(customer?.website || "")}" placeholder="例如 https://example.com"></div>
      <div class="form-field full"><label>其它说明</label><textarea id="customerOtherNotesInput" rows="3" maxlength="2000" placeholder="客户偏好、业务背景、注意事项等自由记录">${escapeHtml(customer?.otherNotes || "")}</textarea></div>
      <label class="form-field"><span>客户分级</span><select id="customerGradeInput"><option value="A" ${selectedGrade === "A" ? "selected" : ""}>A · 核心客户</option><option value="B" ${selectedGrade === "B" ? "selected" : ""}>B · 重点客户</option><option value="C" ${selectedGrade === "C" ? "selected" : ""}>C · 常规客户</option><option value="D" ${selectedGrade === "D" ? "selected" : ""}>D · 低优先级</option></select></label>
      <label class="form-field"><span>成交状态</span><select id="customerLifecycleInput"><option value="open" ${customerLifecycle !== "won" ? "selected" : ""}>未成交</option><option value="won" ${customerLifecycle === "won" ? "selected" : ""}>已成交</option></select><small class="form-hint">默认未成交；商机阶段确认为「成交」时这里会自动变为已成交</small></label>
      <div class="form-field"><label>健康度（人工评分）</label><input id="customerHealthInput" type="number" min="0" max="100" value="${customer?.health ?? 72}"></div>
      <div class="form-field"><label>下一提醒</label><input id="customerReminderInput" value="${escapeHtml(customer?.nextReminder || "")}"></div>
      <div class="form-field full"><label>账单地址</label><input id="customerBillingAddressInput" value="${escapeHtml(customer?.billingAddress || "")}" placeholder="公司地址、城市、国家"></div>
      <div class="form-field full"><label>单据联系人</label><input id="customerDocumentContactInput" value="${escapeHtml(customer?.documentContact || customer?.contact || "")}" placeholder="联系人 / 邮箱 / 电话"></div>
      <div class="form-field"><label>默认目的港</label><input id="customerPortDischargeInput" value="${escapeHtml(customer?.defaultPortDischarge || "")}" placeholder="例如 Hamburg"></div>
      <div class="form-field"><label>默认贸易条款</label><input id="customerIncotermInput" value="${escapeHtml(customer?.defaultIncoterm || "")}" placeholder="例如 FOB、CIF、DAP"></div>
      <div class="form-field full"><label>默认付款条款</label><input id="customerPaymentTermInput" value="${escapeHtml(customer?.defaultPaymentTerm || "")}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerButton" data-editing-id="${escapeHtml(customer?.id || "")}">${editing ? "保存修改" : "保存客户"}</button>`, { closeOnBackdrop: false, modalClass: "customer-editor-modal" });
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveCustomerButton")?.addEventListener("click", () => void saveCustomer());
  if (!editing) bindCustomerIntake();
  qs<HTMLInputElement>("#customerCompanyInput")?.focus();
}

async function saveCustomer() {
  const company = qs<HTMLInputElement>("#customerCompanyInput")?.value.trim() || "";
  if (!company) {
    toast("请填写公司名", "error");
    return;
  }
  const saveButton = qs<HTMLButtonElement>("#saveCustomerButton");
  const editingId = saveButton?.dataset.editingId || "";
  const whatsappInput = qs<HTMLInputElement>("#customerWhatsappInput")?.value.trim() || "";
  const whatsapp = whatsappInput ? normalizeWhatsAppPhone(whatsappInput) : "";
  if (whatsappInput && !whatsapp) {
    toast("WhatsApp 号码需包含国家码，例如 +49123456789", "error");
    qs<HTMLInputElement>("#customerWhatsappInput")?.focus();
    return;
  }
  const payload = {
    company,
    companyFullName: qs<HTMLInputElement>("#customerCompanyFullNameInput")?.value.trim() || company,
    contact: qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    country: qs<HTMLInputElement>("#customerCountryInput")?.value || "未知",
    whatsapp,
    wechat: qs<HTMLInputElement>("#customerWechatInput")?.value.trim() || "",
    source: qs<HTMLInputElement>("#customerSourceInput")?.value.trim() || (editingId ? "" : "手动新增"),
    phone: qs<HTMLInputElement>("#customerPhoneInput")?.value.trim() || "",
    email: qs<HTMLInputElement>("#customerEmailInput")?.value.trim() || "",
    contactRemark: qs<HTMLTextAreaElement>("#customerContactRemarkInput")?.value.trim() || "",
    website: qs<HTMLInputElement>("#customerWebsiteInput")?.value.trim() || "",
    otherNotes: qs<HTMLTextAreaElement>("#customerOtherNotesInput")?.value.trim() || "",
    grade: (qs<HTMLSelectElement>("#customerGradeInput")?.value || "C") as "A" | "B" | "C" | "D",
    lifecycleStatus: (qs<HTMLSelectElement>("#customerLifecycleInput")?.value === "won" ? "won" : "open") as "open" | "won",
    health: Math.max(0, Math.min(100, Number(qs<HTMLInputElement>("#customerHealthInput")?.value || 72))),
    nextReminder: qs<HTMLInputElement>("#customerReminderInput")?.value || "明天 10:00",
    billingName: qs<HTMLInputElement>("#customerCompanyFullNameInput")?.value.trim() || company,
    billingAddress: qs<HTMLInputElement>("#customerBillingAddressInput")?.value.trim() || "",
    documentContact: qs<HTMLInputElement>("#customerDocumentContactInput")?.value.trim() || qs<HTMLInputElement>("#customerContactInput")?.value || "待维护",
    defaultPortDischarge: qs<HTMLInputElement>("#customerPortDischargeInput")?.value.trim() || "",
    defaultIncoterm: qs<HTMLInputElement>("#customerIncotermInput")?.value.trim() || "",
    defaultPaymentTerm: qs<HTMLInputElement>("#customerPaymentTermInput")?.value.trim() || ""
  };
  try {
    const result = await api<{ customer: Customer }>(editingId ? `/api/customers/${editingId}` : "/api/customers", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
  if (editingId) {
    state.customers = state.customers.map((customer) => customer.id === result.customer.id ? result.customer : customer);
  } else {
    state.customers.unshift(result.customer);
  }
  state.selectedCustomerId = result.customer.id;
  renderCustomers(state.customers);
  if (editingId) {
    if (qs<HTMLElement>(".view.active")?.id === "customer-detail") {
      renderCustomerDetailPage(result.customer);
    } else {
      renderCustomerDrawer(result.customer);
      openCustomerDrawer();
    }
  }
  void refreshDashboardOnly();
  closeModal();
  toast(editingId ? "客户已保存" : "客户已新增");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  }
}

export async function bulkDeleteCustomers() {
  const ids = state.selectedCustomerIds.filter((id) => state.customers.some((customer) => customer.id === id));
  if (!ids.length) {
    toast("请先勾选要删除的客户", "error");
    return;
  }
  const names = state.customers.filter((customer) => ids.includes(customer.id)).map((customer) => customer.company);
  if (!await confirmAction({
    title: `批量删除 ${ids.length} 个客户`,
    message: "客户及其关联业务数据将被永久删除。",
    detail: `${names.slice(0, 6).join("、")}${names.length > 6 ? `等 ${ids.length} 个` : ""}`,
    consequences: ["客户资料和跟进记录会被删除", "关联商机和待办会同步清理", "此操作无法撤销"],
    confirmLabel: `删除 ${ids.length} 个客户`,
    verificationText: String(ids.length)
  })) return;
  const button = qs<HTMLButtonElement>("#customers [data-bulk-delete-customers]");
  try {
    setButtonPending(button, true, "批量删除", `正在删除 ${ids.length} 个`);
    const result = await api<{ deleted: Customer[]; customers: Customer[] }>("/api/customers/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    state.customers = result.customers;
    state.selectedCustomerIds = [];
    state.selectedCustomerId = state.customers.find((customer) => customer.id === state.selectedCustomerId)?.id || state.customers[0]?.id || null;
    renderCustomers(state.customers);
    void refreshDashboardOnly();
    toast(`已批量删除 ${result.deleted.length} 个客户`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量删除客户失败", "error");
  } finally {
    setButtonPending(button, false, "批量删除", "删除中");
  }
}

export function addFollowRecord(customer: Customer) {
  openModal(`新增跟进 · ${customer.company}`, `
    <div class="form-grid">
      <label class="form-field"><span>跟进方式</span><select id="customerFollowType"><option value="call">电话</option><option value="email">邮件</option><option value="whatsapp">WhatsApp</option><option value="wechat">微信</option><option value="meeting">会议</option><option value="note">备注</option></select></label>
      <div class="form-field"><label>下次提醒</label><input id="customerFollowNext" value="${escapeHtml(customer.nextReminder || "明天 10:00")}"></div>
      <div class="form-field full"><label>沟通结果与下一步</label><textarea id="customerFollowContent" placeholder="记录客户反馈、关键需求、承诺事项与下一动作"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveCustomerFollowButton">保存跟进</button>`);
  qs("#saveCustomerFollowButton")?.addEventListener("click", () => void saveCustomerFollow(customer.id));
  qs<HTMLTextAreaElement>("#customerFollowContent")?.focus();
}

async function saveCustomerFollow(customerId: string) {
  const content = qs<HTMLTextAreaElement>("#customerFollowContent")?.value.trim() || "";
  if (!content) {
    toast("请填写本次沟通结果", "error");
    return;
  }
  const button = qs<HTMLButtonElement>("#saveCustomerFollowButton");
  try {
    if (button) { button.disabled = true; button.textContent = "保存中"; }
    const result = await api<{ customer: Customer }>(`/api/customers/${customerId}/activities`, {
      method: "POST",
      body: JSON.stringify({
        type: qs<HTMLSelectElement>("#customerFollowType")?.value || "note",
        content,
        nextReminder: qs<HTMLInputElement>("#customerFollowNext")?.value.trim() || ""
      })
    });
    state.customers = state.customers.map((customer) => customer.id === customerId ? result.customer : customer);
    renderCustomers(state.customers);
    if (qs<HTMLElement>("#customer-detail")?.classList.contains("active")) {
      renderCustomerDetailPage(result.customer);
    } else {
      renderCustomerDrawer(result.customer);
    }
    closeModal();
    toast(`已记录 ${result.customer.company} 的跟进动作`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存跟进失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "保存跟进"; }
  }
}

export async function syncOcrLead(button: HTMLButtonElement) {
  const fields = collectOcrFields();
  if (!fields.company?.trim()) {
    toast("请先确认公司名，再同步到线索", "error");
    return;
  }
  const syncButtons = qsa<HTMLButtonElement>("#ocrSyncTopButton, #ocrSyncButton");
  syncButtons.forEach((item) => { item.disabled = true; item.textContent = "同步中"; });
  try {
    await api(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/recognize`, {
      method: "POST",
      body: JSON.stringify(fields)
    });
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/sync-lead`, { method: "POST" });
    state.ocrJob = result.job;
    await reloadLeads();
    renderOcr(result.job);
    syncButtons.forEach((item) => { item.textContent = "已同步"; });
    const targetRow = qsa<HTMLElement>("#business-card .sync-row").at(2);
    if (targetRow) targetRow.innerHTML = `<span>目标模块</span><b>线索中心 / 当前账号范围</b>${badge("已同步", "green")}`;
    toast("OCR 线索已同步");
  } catch (error) {
    syncButtons.forEach((item) => { item.disabled = false; item.textContent = item === button ? "重新同步" : item.id === "ocrSyncTopButton" ? "同步到线索" : "确认同步"; });
    toast(error instanceof Error ? error.message : "同步失败", "error");
  }
}

export function reportMoneyText(rows: ReportMoneyRow[]) {
  return rows.length
    ? rows.map((row) => `${row.currency} ${Number(row.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(" / ")
    : "暂无金额";
}

export function reportMoneyHtml(rows: ReportMoneyRow[], tag = "b") {
  return rows.length
    ? rows.map((row) => `<${tag}>${escapeHtml(row.currency)} ${Number(row.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</${tag}>`).join("")
    : `<span class="report-empty">暂无金额</span>`;
}
