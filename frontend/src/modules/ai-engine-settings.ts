/**
 * AI 执行来源与团队系统设置。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { teamSystemSettings, teamSystemSettingsCanManage, tradeDocumentOcrProvider } from "../prototype-api";
import {
  type AiEngineCliModelOption, type AiEngineJobView, type AiEngineRunnerSummary, type Customer,
  type EmailEngineSource, type ResearchEngineSource, type TeamAiEngineSettings
} from "./models";
import { customerContactDetails } from "./customers";
import { escapeHtml, qs, qsa } from "./shared";
import { backgroundResearchSourceOverride, developmentEmailSourceOverride, openWhatsAppForContact } from "./development-email";
import { whatsAppEntryHref } from "./whatsapp";
import { api, setButtonPending, toast } from "./ui";
import { openModal } from "../prototype-api";
import { openCustomerModal } from "./customer-intake";

/** AI 执行来源设置（团队级）：默认背调来源、默认开发信来源、CLI 适配器/工作区/超时 */
let aiEngineSettings: TeamAiEngineSettings = {
  teamId: "", researchSource: "ai", emailSource: "ai", cliAdapter: "workbuddy",
  cliModel: "deepseek-v4.1-flash", cliEffort: "", codexModel: "gpt-5.6-sol", codexEffort: "",
  museModel: "muse-spark-1.3",
  cliWorkspace: "", cliTimeoutSeconds: 900, runnerId: "", updatedBy: "", updatedAt: ""
};
let aiEngineRunners: AiEngineRunnerSummary[] = [];
let aiEngineCliModels: AiEngineCliModelOption[] = [];
let aiEngineCliEfforts: string[] = [];
let aiEngineCliReady = false;
/** Codex CLI 的模型 / 档位清单（与 WorkBuddy 的命名互不相通，后端单独给） */
let aiEngineCodexModels: AiEngineCliModelOption[] = [];
let aiEngineCodexEfforts: string[] = [];
/** Muse Code（Meta）的模型清单：Muse 没有思考档位，只有模型 */
let aiEngineMuseModels: AiEngineCliModelOption[] = [];
/** 每个 CLI 当前是否有在线 Runner 可用 */
let aiEngineAdapterAvailability: Record<string, boolean> = {};
/**
 * 设置页里两个 CLI 各自的模型 / 档位草稿：切换「CLI 适配器」时只换下拉框内容，
 * 各自的值互不覆盖，保存时两份一起提交。
 */
let aiEngineCliDrafts: Record<string, { model: string; effort: string }> = {};
let aiEngineSettingsLoaded = false;

// ---------------------------------------------------------------------------
// AI 执行来源（背调 / 开发信由谁干）
// ---------------------------------------------------------------------------

const aiEngineSourceMeta: Record<string, { label: string; hint: string }> = {
  crm: { label: "CRM 本地分析", hint: "只用 CRM 已有资料与公开来源，不调用模型，永远可用" },
  ai: { label: "AI API", hint: "调用「AI 配置」里已启用的模型，按额度计费" },
  cli: { label: "本机 CLI", hint: "交给已配对的 WorkBuddy / Codex CLI 联网调研，需本机 Runner 在线" },
  template: { label: "规则模板", hint: "按开发阶段套用内置模板，不调用模型" }
};

export function aiEngineSourceLabelValue(source: string) {
  return aiEngineSourceMeta[source]?.label || source;
}

export function aiEngineSourceHint(source: string) {
  return aiEngineSourceMeta[source]?.hint || "";
}

export function engineSourceOptionsFor(kind: "research" | "email") {
  return kind === "research"
    ? (["crm", "ai", "cli"] as const)
    : (["template", "ai", "cli"] as const);
}

/** 实际生效的来源：本次覆盖 → 团队默认 → 兜底 */
export function effectiveResearchSource(): ResearchEngineSource {
  return (backgroundResearchSourceOverride || aiEngineSettings.researchSource || "ai") as ResearchEngineSource;
}

export function effectiveEmailSource(): EmailEngineSource {
  return (developmentEmailSourceOverride || aiEngineSettings.emailSource || "ai") as EmailEngineSource;
}

/** 页面内嵌的来源选择器（背调页 / 开发信页直接用，不走系统设置） */
export function engineSourceSelectHtml(id: string, kind: "research" | "email", current: string) {
  return `<select class="engine-source-select" id="${id}" title="${escapeHtml(aiEngineSourceHint(current))}">${
    engineSourceOptionsFor(kind)
      .map((value) => `<option value="${value}"${value === current ? " selected" : ""}>${escapeHtml(aiEngineSourceLabelValue(value))}</option>`)
      .join("")
  }</select>`;
}

function renderEngineSourcePicker(select: HTMLSelectElement | null, kind: "research" | "email", current: string) {
  if (!select) return;
  const options = engineSourceOptionsFor(kind);
  if (select.dataset.options !== options.join(",")) {
    select.dataset.options = options.join(",");
    select.innerHTML = options
      .map((value) => `<option value="${value}">${escapeHtml(aiEngineSourceLabelValue(value))}</option>`)
      .join("");
  }
  select.value = current;
  // CLI 没就绪时仍允许选中（可能是刚配好），但给出明确提示
  select.title = aiEngineSourceHint(current);
}

export async function loadAiEngineSettings() {
  const result = await api<{
    settings: TeamAiEngineSettings;
    canManage: boolean;
    runners: AiEngineRunnerSummary[];
    cliModels?: AiEngineCliModelOption[];
    cliEfforts?: string[];
    codexModels?: AiEngineCliModelOption[];
    codexEfforts?: string[];
    museModels?: AiEngineCliModelOption[];
    adapterAvailability?: Record<string, boolean>;
    cliReady: boolean;
  }>("/api/ai-engine/settings");
  aiEngineSettings = result.settings;
  aiEngineRunners = result.runners || [];
  aiEngineCliModels = result.cliModels || [];
  aiEngineCliEfforts = result.cliEfforts || [];
  aiEngineCliReady = Boolean(result.cliReady);
  aiEngineCodexModels = result.codexModels || [];
  aiEngineCodexEfforts = result.codexEfforts || [];
  aiEngineMuseModels = result.museModels || [];
  aiEngineAdapterAvailability = result.adapterAvailability || {};
  aiEngineSettingsLoaded = true;
  return result;
}

/** 保证设置已加载（背调页/开发信页可能在没进过系统设置的情况下直接用） */
export async function ensureAiEngineSettings() {
  if (aiEngineSettingsLoaded) return;
  try {
    await loadAiEngineSettings();
  } catch {
    // 后端未就绪时不要让背调/写信直接失败：按默认来源继续
  }
}

function renderAiEngineSettings() {
  renderEngineSourcePicker(qs<HTMLSelectElement>("#aiEngineResearchSource"), "research", aiEngineSettings.researchSource);
  renderEngineSourcePicker(qs<HTMLSelectElement>("#aiEngineEmailSource"), "email", aiEngineSettings.emailSource);
  const adapter = qs<HTMLSelectElement>("#aiEngineCliAdapter");
  if (adapter) adapter.value = aiEngineSettings.cliAdapter;
  aiEngineCliDrafts = {
    workbuddy: { model: aiEngineSettings.cliModel || "", effort: aiEngineSettings.cliEffort || "" },
    codex: { model: aiEngineSettings.codexModel ?? "gpt-5.6-sol", effort: aiEngineSettings.codexEffort ?? "" },
    muse: { model: aiEngineSettings.museModel ?? "muse-spark-1.3", effort: "" }
  };
  renderAiEngineCliProfileControls(aiEngineSettings.cliAdapter);
  if (adapter) {
    // 切换 CLI：先把当前下拉框的值记回原 CLI 的草稿，再换成新 CLI 的模型 / 档位清单
    adapter.dataset.current = aiEngineSettings.cliAdapter;
    adapter.onchange = () => {
      stashAiEngineCliDraft(adapter.dataset.current || aiEngineSettings.cliAdapter);
      adapter.dataset.current = adapter.value;
      renderAiEngineCliProfileControls(adapter.value);
      renderAiEngineCliStatus(adapter.value);
    };
  }
  const workspace = qs<HTMLInputElement>("#aiEngineCliWorkspace");
  if (workspace) workspace.value = aiEngineSettings.cliWorkspace || "";
  const timeout = qs<HTMLInputElement>("#aiEngineCliTimeout");
  if (timeout) timeout.value = String(Math.round((aiEngineSettings.cliTimeoutSeconds || 900) / 60));
  const runner = qs<HTMLSelectElement>("#aiEngineRunner");
  if (runner) {
    const options = [{ id: "", label: "自动选择在线的 Runner" }, ...aiEngineRunners.map((item) => ({
      id: item.id,
      label: `${item.displayName}${item.online ? "" : "（离线）"}`
    }))];
    runner.innerHTML = options.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
    runner.value = aiEngineSettings.runnerId || "";
  }
  renderAiEngineCliStatus(aiEngineSettings.cliAdapter);
  const disable = !teamSystemSettingsCanManage;
  ["#aiEngineResearchSource", "#aiEngineEmailSource", "#aiEngineCliAdapter", "#aiEngineCliModel", "#aiEngineCliEffort", "#aiEngineCliWorkspace", "#aiEngineCliTimeout", "#aiEngineRunner"]
    .forEach((selector) => { const node = qs<HTMLInputElement | HTMLSelectElement>(selector); if (node) node.disabled = disable; });
}

function aiEngineAdapterName(adapter: string) {
  return adapter === "codex" ? "Codex CLI" : adapter === "muse" ? "Muse Code" : "WorkBuddy CLI";
}

/** 把模型 / 档位下拉框的当前值记进指定 CLI 的草稿 */
function stashAiEngineCliDraft(adapter: string) {
  aiEngineCliDrafts[adapter] = {
    model: qs<HTMLSelectElement>("#aiEngineCliModel")?.value || "",
    effort: qs<HTMLSelectElement>("#aiEngineCliEffort")?.value || ""
  };
}

/**
 * 模型 / 思考档位下拉框按所选 CLI 渲染。
 * WorkBuddy：后端白名单 + 「跟随 CLI 默认（由当前账号决定）」；
 * Codex：Codex 模型清单（默认 gpt-5.6-sol）+ 「跟随本机 Codex 配置」；已保存的自定义模型名原样保留为一个选项。
 */
function renderAiEngineCliProfileControls(adapter: string) {
  const codex = adapter === "codex";
  const muse = adapter === "muse";
  const draft = aiEngineCliDrafts[adapter] || { model: "", effort: "" };
  const modelSelect = qs<HTMLSelectElement>("#aiEngineCliModel");
  if (modelSelect) {
    // WorkBuddy 的留空 = 不传 --model，由 CLI 按其**当前登录账号**的默认模型执行。
    // ⚠️ 不要写死默认值：实测同一台机器上，CLI 默认档会随 workbuddy switch 切换账号而变。
    const modelOptions = codex
      ? [
        { id: "", label: "跟随本机 Codex 配置（~/.codex/config.toml）", note: "不传 -m，由本机 Codex 配置里的默认模型执行" },
        ...aiEngineCodexModels.map((item) => ({ id: item.id, label: item.label, note: item.note }))
      ]
      : muse
        ? [
          { id: "", label: "跟随 Muse 账号默认", note: "不传 --model，由 muse CLI 当前登录账号/套餐的默认模型执行" },
          ...aiEngineMuseModels.map((item) => ({ id: item.id, label: item.label, note: item.note }))
        ]
        : [
          { id: "", label: "跟随 CLI 默认（由当前账号决定）", note: "不传 --model，由 CLI 按其当前登录账号的默认模型执行。该默认值会随账号/套餐变化，想要稳定效果请显式指定" },
          ...aiEngineCliModels.map((item) => ({ id: item.id, label: item.label, note: item.note }))
        ];
    if (draft.model && !modelOptions.some((item) => item.id === draft.model)) {
      modelOptions.push({ id: draft.model, label: `${draft.model}（已保存的自定义模型）`, note: "团队之前保存的模型名" });
    }
    modelSelect.innerHTML = modelOptions
      .map((item) => `<option value="${escapeHtml(item.id)}" title="${escapeHtml(item.note || "")}">${escapeHtml(item.label)}</option>`)
      .join("");
    modelSelect.value = draft.model;
    modelSelect.title = modelOptions.find((item) => item.id === draft.model)?.note || "";
  }
  const effortSelect = qs<HTMLSelectElement>("#aiEngineCliEffort");
  if (effortSelect) {
    // Muse 只有模型、没有思考档位参数：下拉框置灰并说明，避免用户以为设了会生效
    effortSelect.closest("label")?.toggleAttribute("hidden", muse);
    effortSelect.disabled = muse;
    const efforts = codex ? aiEngineCodexEfforts : muse ? [] : aiEngineCliEfforts;
    const effortOptions = muse
      ? [{ id: "", label: "Muse 无思考档位" }]
      : [
        { id: "", label: codex ? "跟随 Codex 默认" : "跟随 CLI 默认" },
        ...efforts.map((id) => ({ id, label: id }))
      ];
    effortSelect.innerHTML = effortOptions
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
      .join("");
    effortSelect.value = efforts.includes(draft.effort) ? draft.effort : "";
  }
}

/**
 * 就绪徽标：两个 CLI 都显示可用性。首选的没有在线 Runner、另一个有时，后端会自动改用另一个，
 * 这里如实说明，避免用户以为选了 Codex 却在用 WorkBuddy。
 */
function renderAiEngineCliStatus(adapter: string) {
  const status = qs<HTMLElement>("#aiEngineCliStatus");
  if (!status) return;
  const availability = (key: string) => aiEngineAdapterAvailability[key] ?? aiEngineRunners.some((item) => item.online && item.capabilities.includes(key));
  // 替补顺序与后端一致：WorkBuddy / Codex 互为第一替补，Muse 排在其后
  const fallbacks = (["workbuddy", "codex", "muse"] as const).filter((item) => item !== adapter);
  const chosen = availability(adapter) ? adapter : fallbacks.find((item) => availability(item)) || "";
  const preferredReady = Boolean(chosen);
  const runnerName = chosen ? aiEngineRunners.find((item) => item.online && item.capabilities.includes(chosen))?.displayName || "" : "";
  const draft = aiEngineCliDrafts[chosen || adapter] || { model: "", effort: "" };
  const modelLabel = draft.model
    || (chosen === "codex" ? "跟随本机 Codex 配置" : chosen === "muse" ? "跟随 Muse 账号默认" : "跟随 CLI 默认（由当前账号决定）");
  const all = (["workbuddy", "codex", "muse"] as const)
    .map((item) => `${aiEngineAdapterName(item)} ${availability(item) ? "可用" : "未检测到"}`)
    .join(" · ");
  if (preferredReady && chosen === adapter) {
    status.className = "badge green";
    status.textContent = `已就绪：${aiEngineAdapterName(adapter)} · ${runnerName} · 模型 ${modelLabel}（${all}）`;
  } else if (preferredReady) {
    status.className = "badge amber";
    status.textContent = `没有在线的 ${aiEngineAdapterName(adapter)}，将自动改用 ${aiEngineAdapterName(chosen)} · ${runnerName} · 模型 ${modelLabel}（${all}）`;
  } else {
    status.className = "badge amber";
    status.textContent = `未就绪：没有在线的 WorkBuddy / Codex / Muse。已有执行机就点下方「检测 CLI 连接并自动配置」排查；新电脑点「新增执行机」，把接入指令发给那台电脑的 WorkBuddy 自动配置`;
  }
}

// ── CLI 一键检测与自动配置（2026-11-17 用户明确）──────────────────────────────
// 痛点：AI 引擎存的 CLI 配置（适配器 / 工作目录 / Runner）和「本机实际能不能跑」是两回事，
// 链路断开（Runner 进程没跑、CLI 登录过期）时只能去集成中心翻任务日志。
// 「检测 CLI 连接」= 向执行机发一条最小探针任务（不调用任何工具，120 秒超时），
// 按任务终态判定链路健康；成功时把适配器 / 工作目录 / 执行机自动对齐到实测可用组合并保存。
// 「新增执行机」= 复用集成中心的配对码流程，把另一台电脑一条命令接入。
// BS 架构分工：浏览器在哪台电脑打开都行，CLI 任务永远在配对过的执行机上跑。

let aiEngineProbeInFlight = false;

function aiEnginePickProbeRunner(adapter: string): AiEngineRunnerSummary | null {
  const chosen = aiEngineSettings.runnerId ? aiEngineRunners.find((item) => item.id === aiEngineSettings.runnerId) : null;
  const pool = [chosen, ...aiEngineRunners].filter(Boolean) as AiEngineRunnerSummary[];
  return pool.find((item) => item.online && item.capabilities.includes(adapter)) || null;
}

function aiEngineProbeBadge(state: "pending" | "ok" | "warn" | "error", text: string) {
  const badge = qs<HTMLElement>("#aiEngineCliProbeResult");
  if (!badge) return;
  badge.hidden = false;
  badge.className = `badge ${state === "ok" ? "green" : state === "warn" ? "amber" : state === "error" ? "red" : ""}`;
  badge.textContent = text;
}

export function initAiEngineCliActions() {
  qs<HTMLButtonElement>("#aiEngineCliProbeButton")?.addEventListener("click", () => void probeAiEngineCli());
  qs<HTMLButtonElement>("#aiEngineAddRunnerButton")?.addEventListener("click", () => void openAiEngineRunnerPairing());
}

async function probeAiEngineCli() {
  if (!teamSystemSettingsCanManage) { toast("只有管理员能操作 CLI 配置", "error"); return; }
  if (aiEngineProbeInFlight) return;
  const adapter = qs<HTMLSelectElement>("#aiEngineCliAdapter")?.value || aiEngineSettings.cliAdapter;
  const runner = aiEnginePickProbeRunner(adapter);
  const probeButton = qs<HTMLButtonElement>("#aiEngineCliProbeButton");
  if (!runner) {
    aiEngineProbeBadge("warn", "没有在线且支持该 CLI 的执行机");
    toast("没有在线 Runner：在执行机的终端跑 goodjob-runner start，或点「新增执行机」用配对码接入一台电脑", "warn");
    return;
  }
  if (!runner.workspaces.length) {
    aiEngineProbeBadge("warn", `「${runner.displayName}」没有已授权目录`);
    toast("该执行机没有已授权目录：重新执行配对命令并带 --workspace 参数", "warn");
    return;
  }
  aiEngineProbeInFlight = true;
  if (probeButton) { probeButton.disabled = true; probeButton.textContent = "检测中…"; }
  aiEngineProbeBadge("pending", `正在通过「${runner.displayName}」探测 ${aiEngineAdapterName(adapter)}…`);
  const startedAt = Date.now();
  try {
    const created = (await api<{ data: { id: string } }>("/api/integrations/local-runner-tasks", {
      method: "POST",
      body: JSON.stringify({
        runnerId: runner.id,
        adapter,
        prompt: 'Reply ONLY a JSON object: {"ok": true}. Do not use any tools.',
        workspace: runner.workspaces[0],
        executionMode: "read_only",
        timeoutSeconds: 120
      })
    })).data;
    let status = "";
    let errorMessage = "";
    while (Date.now() - startedAt < 150_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      const detail = (await api<{ data: { task: { status: string; errorMessage: string } } }>(
        `/api/integrations/local-runner-tasks/${encodeURIComponent(created.id)}`)).data;
      status = detail.task.status;
      errorMessage = detail.task.errorMessage || "";
      if (["succeeded", "failed", "cancelled"].includes(status)) break;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (status === "succeeded") {
      const adapterSelect = qs<HTMLSelectElement>("#aiEngineCliAdapter");
      const workspaceInput = qs<HTMLInputElement>("#aiEngineCliWorkspace");
      const runnerSelect = qs<HTMLSelectElement>("#aiEngineRunner");
      if (adapterSelect) adapterSelect.value = adapter;
      if (workspaceInput) workspaceInput.value = runner.workspaces[0];
      if (runnerSelect) runnerSelect.value = runner.id;
      aiEngineProbeBadge("ok", `检测通过 · ${aiEngineAdapterName(adapter)} · ${runner.displayName} · ${elapsed}s`);
      toast(`CLI 链路健康（耗时 ${elapsed} 秒）：适配器、工作目录与执行机已自动对齐到实测可用组合并保存`, "success");
      await saveAiEngineSettings();
    } else if (status === "failed" && /authentication|required|未登录|登录|login/iu.test(errorMessage)) {
      aiEngineProbeBadge("error", `CLI 未登录 · ${runner.displayName}`);
      toast(`CLI 凭据失效：在 ${runner.displayName} 的终端运行 codebuddy 并输入 /login 重新登录（登录态只存本机）`, "error");
    } else if (["queued", "running", ""].includes(status)) {
      aiEngineProbeBadge("warn", `执行机没接单 · ${runner.displayName}`);
      toast(`探针 150 秒无人领取：${runner.displayName} 的 Runner 进程多半没在跑。终端执行 goodjob-runner start（装了 launchd 用 launchctl kickstart -k gui/$(id -u)/com.goodjob.local-runner.prod）`, "warn");
    } else {
      aiEngineProbeBadge("error", "检测失败");
      toast(`探针任务失败：${(errorMessage || "未知错误，到集成中心查看任务日志").slice(0, 180)}`, "error");
    }
  } catch (error) {
    aiEngineProbeBadge("error", "检测请求失败");
    toast(error instanceof Error ? error.message : "探针任务提交失败", "error");
  } finally {
    aiEngineProbeInFlight = false;
    if (probeButton) { probeButton.disabled = false; probeButton.textContent = "检测 CLI 连接并自动配置"; }
  }
}

async function openAiEngineRunnerPairing() {
  try {
    const result = await api<{ data: { pairingCode: string; expiresAt: string; command: string } }>(
      "/api/integrations/local-runners/pairings",
      { method: "POST", body: JSON.stringify({ deviceName: "我的电脑" }) });
    const pairing = result.data;
    const server = /--server\s+"([^"]*)"/.exec(pairing.command)?.[1] || "";
    const instruction = [
      "请把这台电脑配置成 GoodJob CRM 的执行机（Runner）并完成配对：",
      `服务器地址：${server}`,
      `配对码：${pairing.pairingCode}（${new Date(pairing.expiresAt).toLocaleString("zh-CN")} 前有效，只能用一次）`,
      "",
      "步骤：拉取/更新 GoodJob 代码仓库 → 在仓库根目录执行 npm install → npm run build --workspace @goodjob/local-runner → npm link --workspace @goodjob/local-runner → 安装 @tencent-ai/codebuddy-code 并引导我完成 /login 登录 → 执行 goodjob-runner pair --server " + server + " --code " + pairing.pairingCode + " --workspace <先问我用哪个目录> → goodjob-runner start 常驻启动 → goodjob-runner doctor 自检。完成后告诉我配对是否成功。"
    ].join("\n");
    openModal("让 WorkBuddy 配置这台电脑", `<div class="form-grid">
      <p>在<b>要接入的那台电脑</b>上打开 WorkBuddy，把下面这段指令整段粘贴发给它——安装 Runner、引导 CLI 登录、执行配对、启动自检全部由它代劳，不用手动敲命令。它执行完会自动出现在「指定 Runner」下拉框，不用刷新。</p>
      <label>接入指令（整段复制）</label>
      <pre style="white-space:pre-wrap;word-break:break-all;margin:0;padding:10px;border:1px solid var(--border,#d5d9e0);border-radius:6px;font-size:12px;line-height:1.6;">${escapeHtml(instruction)}</pre>
      <p class="hint">浏览器在哪台电脑打开都行——CRM 负责存配置、发任务，CLI 任务永远在配对过的执行机上跑；CLI 登录态只存那台电脑，不经过 CRM。WorkBuddy 配置完成后，回到这里点「检测 CLI 连接并自动配置」确认链路。</p>
    </div>`, `<button class="btn" data-modal-close type="button">关闭</button><button class="btn primary" id="aiEngineCopyPairCommand" type="button">复制接入指令</button>`);
    document.querySelector<HTMLButtonElement>("#aiEngineCopyPairCommand")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(instruction);
      toast("接入指令已复制，去那台电脑粘贴给 WorkBuddy", "success");
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : "配对码创建失败", "error");
  }
}

export async function saveAiEngineSettings(button?: HTMLButtonElement) {
  if (!teamSystemSettingsCanManage) return;
  const selectedAdapter = qs<HTMLSelectElement>("#aiEngineCliAdapter")?.value || aiEngineSettings.cliAdapter;
  stashAiEngineCliDraft(selectedAdapter);
  const payload = {
    researchSource: qs<HTMLSelectElement>("#aiEngineResearchSource")?.value || aiEngineSettings.researchSource,
    emailSource: qs<HTMLSelectElement>("#aiEngineEmailSource")?.value || aiEngineSettings.emailSource,
    cliAdapter: qs<HTMLSelectElement>("#aiEngineCliAdapter")?.value || aiEngineSettings.cliAdapter,
    // 两个 CLI 的模型 / 档位分开保存（下拉框里显示的是当前所选 CLI 的那一份）
    cliModel: aiEngineCliDrafts.workbuddy?.model ?? aiEngineSettings.cliModel,
    cliEffort: aiEngineCliDrafts.workbuddy?.effort ?? aiEngineSettings.cliEffort,
    codexModel: aiEngineCliDrafts.codex?.model ?? aiEngineSettings.codexModel ?? "gpt-5.6-sol",
    codexEffort: aiEngineCliDrafts.codex?.effort ?? aiEngineSettings.codexEffort ?? "",
    museModel: aiEngineCliDrafts.muse?.model ?? aiEngineSettings.museModel ?? "muse-spark-1.3",
    cliWorkspace: qs<HTMLInputElement>("#aiEngineCliWorkspace")?.value.trim() || "",
    cliTimeoutSeconds: Math.max(1, Math.round(Number(qs<HTMLInputElement>("#aiEngineCliTimeout")?.value || "15") || 15)) * 60,
    runnerId: qs<HTMLSelectElement>("#aiEngineRunner")?.value || ""
  };
  try {
    if (button) setButtonPending(button, true, "保存 AI 来源", "保存中");
    const result = await api<{ settings: TeamAiEngineSettings }>("/api/ai-engine/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    aiEngineSettings = result.settings;
    renderAiEngineSettings();
    toast(`AI 执行来源已保存：背调用「${aiEngineSourceLabelValue(result.settings.researchSource)}」，开发信用「${aiEngineSourceLabelValue(result.settings.emailSource)}」`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "AI 执行来源保存失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "保存 AI 来源", "保存中");
  }
}

// ── CLI 等待动画与动态轮播提醒（获客 / 背调 / 写信三处共用）────────────────────
// CLI 任务动辄 1-5 分钟：静态「执行中…」会让用户以为卡死。这里提供
// 轨道动画 + 按阶段轮换的提示文案 + 已等待秒数，让等待过程可感知。
const CLI_WAIT_COPY: Record<"search" | "research" | "email" | "tender", string[]> = {
  search: [
    "正在解析获客目标，圈定目标市场与客户画像…",
    "本机智能体正在联网检索公开企业名录与采购信息…",
    "交叉比对产品关键词、行业与地区，筛出候选…",
    "逐家核实官网与公开来源，剔除不可靠结果…",
    "整理证据并同步进候选清单，马上就好…"
  ],
  research: [
    "正在打开目标公司的官网与公开资料…",
    "交叉核对主体信息、产品线与销售渠道…",
    "评估合作机会、贸易信号与潜在风险…",
    "汇总来源做交叉核验，形成背调结论…"
  ],
  email: [
    "正在结合背调结论梳理切入角度…",
    "按当前开发阶段选择写作策略与语气…",
    "打磨主题行、正文与行动号召…",
    "发送前自检：长度、语气与合规…"
  ],
  tender: [
    "本机智能体正在检索海外公开招标与采购公告…",
    "逐条打开公告页核实：采购方、标的、截标时间…",
    "按主营产品过滤无关招标，只留高相关条目…",
    "汇总成今日竞标日报，马上就好…"
  ]
};

const cliWaitTimers = new Map<string, number>();

export function cliWaitPanelHtml(kind: keyof typeof CLI_WAIT_COPY, engineLabel = "本机 CLI"): string {
  return `<div class="cli-wait" data-cli-wait="${kind}" role="status" aria-live="polite">
    <span class="cli-wait-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="cli-wait-text">
      <b class="cli-wait-msg">${escapeHtml(CLI_WAIT_COPY[kind][0])}</b>
      <b class="cli-wait-found" hidden></b>
      <small>已等待 <em class="cli-wait-elapsed">0</em> 秒 · ${escapeHtml(engineLabel)} · 期间可切换其他页面，完成后结果会自动刷新</small>
    </span>
  </div>`;
}

export function startCliWaitTicker(kind: keyof typeof CLI_WAIT_COPY): void {
  if (cliWaitTimers.has(kind)) return;
  const startedAt = Date.now();
  const tick = () => {
    // 面板已随页面刷新消失 → 自行收尾，避免空转
    if (!document.querySelector(`.cli-wait[data-cli-wait="${kind}"]`)) {
      stopCliWaitTicker(kind);
      return;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    qsa<HTMLElement>(`.cli-wait[data-cli-wait="${kind}"] .cli-wait-elapsed`).forEach((node) => {
      node.textContent = String(elapsed);
    });
    // 文案按已等待时长轮换（每 3.6 秒一条，循环播放），换文案时重触发入场动画
    const copy = CLI_WAIT_COPY[kind];
    const message = copy[Math.floor(elapsed / 3.6) % copy.length];
    qsa<HTMLElement>(`.cli-wait[data-cli-wait="${kind}"] .cli-wait-msg`).forEach((node) => {
      if (node.textContent !== message) {
        node.textContent = message;
        node.style.animation = "none";
        void node.offsetHeight;
        node.style.animation = "";
      }
    });
  };
  tick();
  cliWaitTimers.set(kind, window.setInterval(tick, 1000));
}

export function stopCliWaitTicker(kind: keyof typeof CLI_WAIT_COPY): void {
  const timer = cliWaitTimers.get(kind);
  if (timer) window.clearInterval(timer);
  cliWaitTimers.delete(kind);
}

/**
 * 等一次引擎作业出结果。
 * 后端在同一个请求内会先等一小段，没等到就回 202；这里按作业号轮询到终态。
 */
export async function awaitAiEngineJob(job: AiEngineJobView, onTick?: (job: AiEngineJobView) => void): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30 * 60_000;
  let current = job;
  while (Date.now() < deadline) {
    const result = await api<{ engineJob: AiEngineJobView; pending: boolean; payload: Record<string, unknown> | null }>(
      `/api/ai-engine/jobs/${encodeURIComponent(current.id)}`
    );
    current = result.engineJob || current;
    onTick?.(current);
    if (!result.pending) {
      if (result.payload) return result.payload;
      throw new Error(current.errorMessage || "本机 CLI 执行失败，请到集成中心查看任务日志");
    }
  }
  throw new Error("本机 CLI 执行时间过长，请到「集成中心 · 本地 Runner」查看任务进度");
}

export function renderTeamSystemSettings() {
  const input = qs<HTMLInputElement>("#documentExcelApprovalSetting");
  const status = qs<HTMLElement>("#documentExcelApprovalStatus");
  if (input) {
    input.checked = teamSystemSettings.requireDocumentExcelApproval;
    input.disabled = !teamSystemSettingsCanManage;
  }
  if (status) {
    status.className = `badge ${teamSystemSettings.requireDocumentExcelApproval ? "amber" : "green"}`;
    status.textContent = teamSystemSettings.requireDocumentExcelApproval ? "已开启" : "默认关闭";
  }
  const provider = qs<HTMLSelectElement>("#tradeDocumentOcrProvider");
  const apiKey = qs<HTMLInputElement>("#tradeDocumentOcrApiKey");
  const secretKey = qs<HTMLInputElement>("#tradeDocumentOcrSecretKey");
  const model = qs<HTMLInputElement>("#tradeDocumentOcrModel");
  const enabled = qs<HTMLInputElement>("#tradeDocumentOcrEnabled");
  const providerStatus = qs<HTMLElement>("#tradeDocumentOcrProviderStatus");
  if (provider) provider.value = tradeDocumentOcrProvider.provider;
  if (apiKey) apiKey.placeholder = tradeDocumentOcrProvider.hasApiKey ? "已配置，留空保持不变" : "填写已申请的 API Key";
  if (secretKey) { secretKey.placeholder = tradeDocumentOcrProvider.hasSecretKey ? "已配置，留空保持不变" : "百度 OCR Secret Key"; secretKey.closest("label")?.toggleAttribute("hidden", tradeDocumentOcrProvider.provider !== "baidu"); }
  if (model) { model.value = tradeDocumentOcrProvider.model || "Qwen/Qwen2.5-VL-32B-Instruct"; model.closest("label")?.toggleAttribute("hidden", tradeDocumentOcrProvider.provider !== "siliconflow"); }
  if (enabled) enabled.checked = tradeDocumentOcrProvider.enabled;
  if (providerStatus) {
    providerStatus.className = `badge ${tradeDocumentOcrProvider.enabled ? "green" : "amber"}`;
    providerStatus.textContent = tradeDocumentOcrProvider.enabled ? `已启用：${tradeDocumentOcrProvider.provider === "baidu" ? "百度 OCR" : "硅基流动视觉"}` : "未启用，使用 AI 视觉模型";
  }
  renderAiEngineSettings();
}

export function launchCustomerContact(customer: Customer, channel: "email" | "phone" | "whatsapp" | "wechat") {
  const contacts = customerContactDetails(customer);
  if (channel === "email") {
    if (!contacts.email) {
      toast("请先补充客户邮箱，再发起邮件联系");
      openCustomerModal(customer);
      return;
    }
    window.location.href = `mailto:${contacts.email}?subject=${encodeURIComponent(`GoodJob CRM · ${customer.company}`)}`;
    return;
  }
  if (channel === "phone") {
    if (!contacts.phone) {
      toast("请先补充客户电话，再发起拨号");
      openCustomerModal(customer);
      return;
    }
    window.location.href = `tel:${contacts.phone.replace(/[^+\d]/g, "")}`;
    return;
  }
  if (channel === "whatsapp") {
    if (!whatsAppEntryHref(contacts.whatsapp)) {
      toast("请先补充可用的 WhatsApp 号码（含国家码），再发起联系");
      openCustomerModal(customer);
      return;
    }
    void openWhatsAppForContact({ phone: contacts.whatsapp, displayName: customer.contact || customer.company });
    return;
  }
  if (channel === "wechat") {
    if (!contacts.wechat) {
      toast("请先补充客户微信号，再发起微信联系");
      openCustomerModal(customer);
      return;
    }
    void navigator.clipboard?.writeText(contacts.wechat).then(() => {
      toast(`微信号 ${contacts.wechat} 已复制，去微信添加或搜索即可`);
    }).catch(() => {
      toast(`微信号：${contacts.wechat}（复制失败，请手动记录）`);
    });
    return;
  }
  toast("企业微信联系适配器已预留，通讯接口接入后可直接发起联系");
}
