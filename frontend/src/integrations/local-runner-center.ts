import {
  createIntegrationClient,
  type IntegrationRequest,
  type LocalRunner,
  type LocalRunnerAdapter,
  type LocalRunnerTask,
  type LocalRunnerTaskEvent
} from "./integration-api";

interface Dependencies {
  request: IntegrationRequest;
  toast(message: string, type?: "ok" | "error" | "success" | "warn" | "info"): void;
  openModal(title: string, body: string, foot: string): void;
  closeModal(): void;
  hasPermission(permissionCode: string): boolean;
}

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const labels: Record<string, string> = {
  queued: "等待本机", running: "执行中", cancelling: "正在停止", succeeded: "已完成", failed: "失败", cancelled: "已取消"
};

/** 适配器元数据：名称、短标签、CLI 字段与安装提示 */
const ADAPTERS: Array<{ id: LocalRunnerAdapter; name: string; badge: string; hint: string }> = [
  { id: "workbuddy", name: "WorkBuddy CLI", badge: "WORKBUDDY", hint: "WorkBuddy 桌面端自带的 codebuddy CLI" },
  { id: "codex", name: "Codex CLI", badge: "CODEX", hint: "独立安装的 Codex CLI（可带独立浏览器）" }
];

const adapterMeta = (adapter: string) => ADAPTERS.find((item) => item.id === adapter) || ADAPTERS[1];
const adapterLabel = (adapter: string) => adapterMeta(adapter).name;
const adapterVersion = (runner: LocalRunner, adapter: LocalRunnerAdapter) =>
  adapter === "workbuddy" ? runner.workbuddyVersion : runner.codexVersion;

/** 设备卡片上展示的 CLI 摘要，例如 “WorkBuddy CLI 2.156.0 · Codex CLI 0.9.1” */
function runnerCliSummary(runner: LocalRunner) {
  const parts = ADAPTERS.filter((item) => runner.capabilities.includes(item.id))
    .map((item) => {
      const version = adapterVersion(runner, item.id);
      return version ? `${item.name} ${version}` : item.name;
    });
  return parts.length ? parts.join(" · ") : "未检测到 Codex / WorkBuddy CLI";
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char] || char));
}

function formatDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function basename(value: string) {
  return value.split(/[\\/]/u).filter(Boolean).at(-1) || value;
}

function formatDuration(startValue: string, endValue = "") {
  const start = new Date(startValue).getTime();
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}时 ${minutes}分 ${remainder}秒` : minutes ? `${minutes}分 ${remainder}秒` : `${remainder}秒`;
}

/** 超时上限的人类可读形式：86400 → “24 小时” */
function formatTimeout(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 1) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

const eventStageLabels: Record<string, string> = {
  session: "会话", analysis: "分析", command: "终端", tool: "工具", browser: "浏览器",
  search: "搜索", file: "文件", message: "回复", usage: "用量", system: "系统"
};

function eventStage(event: LocalRunnerTaskEvent) {
  const stage = typeof event.payload?.stage === "string" ? event.payload.stage : "system";
  return { stage, label: eventStageLabels[stage] || "进度" };
}

export function mountLocalRunnerCenter(root: HTMLElement, dependencies: Dependencies) {
  const panel = root.querySelector<HTMLElement>('[data-integration-panel="local-runner"]');
  const client = createIntegrationClient(dependencies.request);
  if (!panel) return { async refresh() {}, activate() {} };
  const one = <T extends Element>(selector: string, scope: ParentNode = panel) => scope.querySelector<T>(selector);
  let runners: LocalRunner[] = [];
  let tasks: LocalRunnerTask[] = [];
  let events: LocalRunnerTaskEvent[] = [];
  let selectedRunnerId = "";
  let selectedTaskId = "";
  let adapter: LocalRunnerAdapter | "" = "";
  let executionMode: "read_only" | "workspace_write" = "read_only";
  let loading: Promise<void> | null = null;
  let pollTimer = 0;

  const selectedRunner = () => runners.find((item) => item.id === selectedRunnerId) || runners.find((item) => item.online && item.status === "active") || runners[0];
  const selectedTask = () => tasks.find((item) => item.id === selectedTaskId) || tasks[0];
  /**
   * 解析实际要用的适配器：优先用户选择；不可用时回退到该设备已具备的能力。
   * WorkBuddy 优先于 Codex —— 本机同时具备两者时默认走 WorkBuddy CLI。
   */
  const resolvedAdapter = (runner: LocalRunner | undefined): LocalRunnerAdapter => {
    const available = ADAPTERS.map((item) => item.id).filter((id) => runner?.capabilities.includes(id));
    if (adapter && available.includes(adapter)) return adapter;
    return available.includes("workbuddy") ? "workbuddy" : available[0] || "codex";
  };

  const renderSummary = () => {
    const online = runners.filter((item) => item.online).length;
    const running = tasks.filter((item) => ["queued", "running", "cancelling"].includes(item.status)).length;
    const completed = tasks.filter((item) => item.status === "succeeded").length;
    const values = [online, runners.length, running, completed];
    panel.querySelectorAll<HTMLElement>("[data-runner-summary]").forEach((node, index) => { node.textContent = String(values[index] || 0); });
  };

  const renderRunners = () => {
    const list = one<HTMLElement>("#localRunnerDeviceList");
    if (!list) return;
    if (!runners.length) {
      list.innerHTML = `<div class="local-runner-empty"><b>还没有本地设备</b><span>创建配对码后，在需要执行 Codex / WorkBuddy CLI 的电脑上完成一次配对。</span></div>`;
      return;
    }
    list.innerHTML = runners.map((runner) => `<button type="button" class="local-runner-device ${runner.id === selectedRunner()?.id ? "selected" : ""}" data-local-runner-select="${escapeHtml(runner.id)}">
      <span class="local-runner-device-status ${runner.online ? "online" : ""}"></span>
      <span><b>${escapeHtml(runner.displayName)}</b><small>${escapeHtml(runner.online ? "在线" : runner.status === "revoked" ? "已解除" : `离线 · ${formatDate(runner.lastSeenAt)}`)}</small></span>
      <em>${escapeHtml(runnerCliSummary(runner))}</em>
    </button>`).join("");
    const revoke = one<HTMLButtonElement>("#localRunnerRevokeButton");
    if (revoke) revoke.hidden = !selectedRunner() || selectedRunner()?.status !== "active";
  };

  const renderComposer = () => {
    const runner = selectedRunner();
    const active = resolvedAdapter(runner);
    const select = one<HTMLSelectElement>("#localRunnerWorkspace");
    const submit = one<HTMLButtonElement>("#localRunnerSubmit");
    const identity = one<HTMLElement>("#localRunnerComposerIdentity");
    const badge = one<HTMLElement>("[data-local-runner-adapter-badge]");
    if (identity) identity.textContent = runner ? `${runner.online ? "在线" : "离线"} · ${runner.hostname || runner.displayName}` : "等待配对设备";
    if (badge) badge.textContent = adapterMeta(active).badge;
    const group = one<HTMLElement>("[data-runner-adapter-group]");
    if (group) {
      group.innerHTML = ADAPTERS.map((item) => {
        const supported = Boolean(runner?.capabilities.includes(item.id));
        const version = runner ? adapterVersion(runner, item.id) : "";
        const title = supported ? item.hint : `${item.name} 未在这台设备上检测到`;
        return `<button type="button" class="local-runner-adapter-option ${item.id === active ? "active" : ""}" data-runner-adapter="${item.id}" aria-pressed="${item.id === active}" ${supported ? "" : "disabled"} title="${escapeHtml(title)}"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(supported ? version || "已就绪" : "未检测到")}</small></button>`;
      }).join("");
    }
    if (select) {
      const previous = select.value;
      select.innerHTML = runner?.workspaces.length
        ? runner.workspaces.map((workspace) => `<option value="${escapeHtml(workspace)}">${escapeHtml(basename(workspace))} · ${escapeHtml(workspace)}</option>`).join("")
        : `<option value="">没有已授权目录</option>`;
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
      select.disabled = !runner?.online;
    }
    if (submit) submit.disabled = !runner?.online || !runner.capabilities.includes(active);
    panel.querySelectorAll<HTMLButtonElement>("[data-runner-mode]").forEach((button) => {
      const activeMode = button.dataset.runnerMode === executionMode;
      button.classList.toggle("active", activeMode);
      button.setAttribute("aria-pressed", String(activeMode));
    });
  };

  const renderTasks = () => {
    const list = one<HTMLElement>("#localRunnerTaskList");
    if (!list) return;
    if (!tasks.length) {
      list.innerHTML = `<div class="local-runner-empty compact"><b>暂无执行记录</b><span>提交的 Codex / WorkBuddy 任务会按时间排列。</span></div>`;
      return;
    }
    list.innerHTML = tasks.map((task) => `<button type="button" class="local-runner-task ${task.id === selectedTask()?.id ? "selected" : ""}" data-local-runner-task="${escapeHtml(task.id)}">
      <span class="local-runner-task-main"><b>${escapeHtml(task.prompt.slice(0, 72))}</b><small>${escapeHtml(adapterLabel(task.adapter))} · ${escapeHtml(basename(task.workspace))} · ${formatDate(task.createdAt)}</small></span>
      <span class="local-runner-task-status is-${escapeHtml(task.status)}">${escapeHtml(labels[task.status] || task.status)}</span>
    </button>`).join("");
  };

  const renderDetail = () => {
    const task = selectedTask();
    const detail = one<HTMLElement>("#localRunnerTaskDetail");
    if (!detail) return;
    if (!task) {
      detail.innerHTML = `<div class="local-runner-empty detail"><b>选择一条任务查看结果</b><span>运行进度、CLI 回复和错误原因会集中显示在这里。</span></div>`;
      return;
    }
    const previousTimeline = one<HTMLOListElement>(".local-runner-timeline", detail);
    const previousOutput = one<HTMLElement>(".local-runner-output", detail);
    const sameTask = detail.dataset.runnerTaskId === task.id;
    const timelineFollowing = !previousTimeline || previousTimeline.scrollHeight - previousTimeline.scrollTop - previousTimeline.clientHeight < 32;
    const outputFollowing = !previousOutput || previousOutput.scrollHeight - previousOutput.scrollTop - previousOutput.clientHeight < 32;
    const previousTimelineTop = previousTimeline?.scrollTop || 0;
    const previousOutputTop = previousOutput?.scrollTop || 0;
    const active = ["queued", "running", "cancelling"].includes(task.status);
    const liveOutput = events.filter((event) => event.eventType === "output" && event.payload?.stage === "message").map((event) => event.message).join("\n\n");
    const output = task.resultText || task.errorMessage || liveOutput || `等待 ${adapterLabel(task.adapter)} 返回内容...`;
    const eventRows = events.slice(-80).map((event) => {
      const meta = eventStage(event);
      return `<li class="is-${escapeHtml(event.eventType)} stage-${escapeHtml(meta.stage)}"><i></i><em>${escapeHtml(meta.label)}</em><span>${escapeHtml(event.message)}</span><time>${formatDate(event.createdAt)}</time></li>`;
    }).join("");
    const elapsedFrom = task.startedAt || task.createdAt;
    detail.innerHTML = `<header class="local-runner-detail-head">
      <div><span class="local-runner-task-status is-${escapeHtml(task.status)}">${escapeHtml(labels[task.status] || task.status)}</span>${active ? `<span class="local-runner-live"><i></i>实时同步中</span>` : ""}<h3>${escapeHtml(task.prompt)}</h3></div>
      ${["queued", "running"].includes(task.status) ? `<button class="btn" type="button" data-local-runner-cancel="${escapeHtml(task.id)}">停止</button>` : ""}
    </header>
    <div class="local-runner-detail-meta"><span>适配器 <b>${escapeHtml(adapterLabel(task.adapter))}</b></span><span>目录 <b>${escapeHtml(task.workspace)}</b></span><span>权限 <b>${task.executionMode === "workspace_write" ? "可修改工作区" : "只读分析"}</b></span><span>已运行 <b>${escapeHtml(formatDuration(elapsedFrom, task.finishedAt))}</b></span><span>时限 <b>${escapeHtml(formatTimeout(Number(task.timeoutSeconds)))}</b></span></div>
    <div class="local-runner-timeline-head"><b>执行过程</b><span>${events.length} 条实时记录</span></div>
    <ol class="local-runner-timeline">${eventRows || `<li><i></i><em>队列</em><span>任务已创建，等待本机领取</span><time>${formatDate(task.createdAt)}</time></li>`}</ol>
    <div class="local-runner-output-head"><b>${escapeHtml(active ? `${adapterLabel(task.adapter)} 实时回复` : `${adapterLabel(task.adapter)} 最终回复`)}</b>${task.codexThreadId ? `<span>会话 ${escapeHtml(task.codexThreadId)}</span>` : ""}</div>
    <pre class="local-runner-output">${escapeHtml(output)}</pre>
    ${task.outputTruncated ? `<p class="local-runner-output-note">输出超过保存上限，当前显示已截断。</p>` : ""}`;
    detail.dataset.runnerTaskId = task.id;
    const timeline = one<HTMLOListElement>(".local-runner-timeline", detail);
    const outputPanel = one<HTMLElement>(".local-runner-output", detail);
    if (timeline) timeline.scrollTop = !sameTask || timelineFollowing ? timeline.scrollHeight : previousTimelineTop;
    if (outputPanel) outputPanel.scrollTop = !sameTask || outputFollowing ? outputPanel.scrollHeight : previousOutputTop;
  };

  const render = () => {
    renderSummary();
    renderRunners();
    renderComposer();
    renderTasks();
    renderDetail();
  };

  const loadDetail = async (id: string) => {
    if (!id) { events = []; renderDetail(); return; }
    try {
      const detail = await client.localRunnerTask(id);
      const index = tasks.findIndex((item) => item.id === id);
      if (index >= 0) tasks[index] = detail.task;
      events = detail.events;
      renderTasks();
      renderDetail();
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "Runner 任务详情加载失败", "error");
    }
  };

  const schedulePolling = () => {
    window.clearTimeout(pollTimer);
    if (panel.hidden) return;
    pollTimer = window.setTimeout(() => void refresh(true), tasks.some((task) => !terminal.has(task.status)) ? 1_000 : 5_000);
  };

  const refresh = async (silent = false) => {
    if (loading) return loading;
    loading = (async () => {
      try {
        const [runnerResult, taskResult] = await Promise.all([client.localRunners(), client.localRunnerTasks()]);
        runners = runnerResult;
        tasks = taskResult;
        if (!runners.some((item) => item.id === selectedRunnerId)) selectedRunnerId = selectedRunner()?.id || "";
        if (!tasks.some((item) => item.id === selectedTaskId)) selectedTaskId = selectedTask()?.id || "";
        render();
        if (selectedTaskId) await loadDetail(selectedTaskId);
        schedulePolling();
      } catch (error) {
        if (!silent) dependencies.toast(error instanceof Error ? error.message : "本地 Runner 加载失败", "error");
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  const openPairing = () => {
    dependencies.openModal("配对本地 Runner", `<div class="form-grid local-runner-pair-form">
      <label>设备名称<input id="localRunnerPairName" maxlength="160" value="我的开发电脑" autocomplete="off"></label>
      <p class="hint">配对码在页面显示的时间前有效且只能使用一次。Runner 由本机主动连接 CRM，不需要开放本机端口，并会自动探测 Codex CLI 与 WorkBuddy CLI。</p>
    </div>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="localRunnerPairCreate" type="button">生成配对码</button>`);
    document.querySelector<HTMLButtonElement>("#localRunnerPairCreate")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const result = await client.createLocalRunnerPairing(document.querySelector<HTMLInputElement>("#localRunnerPairName")?.value.trim() || "我的电脑");
        dependencies.openModal("在本机完成配对", `<div class="local-runner-pair-result">
          <span>一次性配对码</span><strong>${escapeHtml(result.pairingCode)}</strong><small>${escapeHtml(formatDate(result.expiresAt))} 前有效</small>
          <label>在已安装 Runner 的终端执行</label><code>${escapeHtml(result.command)}</code>
          <p>把命令中的 <b>/path/to/workspace</b> 替换为允许 Codex / WorkBuddy CLI 操作的本机项目绝对路径。</p>
        </div>`, `<button class="btn" data-modal-close type="button">关闭</button><button class="btn primary" id="localRunnerCopyCommand" type="button">复制命令</button>`);
        document.querySelector<HTMLButtonElement>("#localRunnerCopyCommand")?.addEventListener("click", async () => {
          await navigator.clipboard.writeText(result.command);
          dependencies.toast("配对命令已复制", "success");
        });
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "配对码创建失败", "error");
      }
    });
  };

  one<HTMLButtonElement>("#localRunnerPairButton")?.addEventListener("click", openPairing);
  one<HTMLButtonElement>("#localRunnerRevokeButton")?.addEventListener("click", () => {
    const runner = selectedRunner();
    if (!runner) return;
    dependencies.openModal("解除本地设备", `<p>解除后，<strong>${escapeHtml(runner.displayName)}</strong> 的凭证立即失效，未完成任务会停止。</p>`, `<button class="btn" data-modal-close type="button">取消</button><button class="btn primary" id="localRunnerRevokeConfirm" type="button">确认解除</button>`);
    document.querySelector<HTMLButtonElement>("#localRunnerRevokeConfirm")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await client.revokeLocalRunner(runner.id);
        dependencies.closeModal();
        selectedRunnerId = "";
        dependencies.toast("本地设备已解除", "success");
        await refresh(true);
      } catch (error) {
        button.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "设备解除失败", "error");
      }
    });
  });
  panel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const runnerButton = target.closest<HTMLButtonElement>("[data-local-runner-select]");
    if (runnerButton) {
      selectedRunnerId = runnerButton.dataset.localRunnerSelect || "";
      render();
      return;
    }
    const taskButton = target.closest<HTMLButtonElement>("[data-local-runner-task]");
    if (taskButton) {
      selectedTaskId = taskButton.dataset.localRunnerTask || "";
      events = [];
      renderTasks();
      renderDetail();
      void loadDetail(selectedTaskId);
      return;
    }
    const adapterButton = target.closest<HTMLButtonElement>("[data-runner-adapter]");
    if (adapterButton) {
      const next = adapterButton.dataset.runnerAdapter;
      if (next === "workbuddy" || next === "codex") adapter = next;
      renderComposer();
      return;
    }
    const modeButton = target.closest<HTMLButtonElement>("[data-runner-mode]");
    if (modeButton) {
      executionMode = modeButton.dataset.runnerMode === "workspace_write" ? "workspace_write" : "read_only";
      renderComposer();
      return;
    }
    const cancelButton = target.closest<HTMLButtonElement>("[data-local-runner-cancel]");
    if (cancelButton) {
      cancelButton.disabled = true;
      void client.cancelLocalRunnerTask(cancelButton.dataset.localRunnerCancel || "").then(() => refresh(true)).catch((error) => {
        cancelButton.disabled = false;
        dependencies.toast(error instanceof Error ? error.message : "任务停止失败", "error");
      });
    }
  });
  one<HTMLButtonElement>("#localRunnerSubmit")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const runner = selectedRunner();
    const prompt = one<HTMLTextAreaElement>("#localRunnerPrompt")?.value.trim() || "";
    const workspace = one<HTMLSelectElement>("#localRunnerWorkspace")?.value || "";
    const timeoutSeconds = Number(one<HTMLSelectElement>("#localRunnerTimeout")?.value || 600);
    if (!runner?.online) { dependencies.toast("请先启动本地 Runner", "warn"); return; }
    const activeAdapter = resolvedAdapter(runner);
    if (!runner.capabilities.includes(activeAdapter)) { dependencies.toast(`这台设备未检测到 ${adapterLabel(activeAdapter)}`, "warn"); return; }
    if (!prompt || !workspace) { dependencies.toast("请填写任务并选择工作目录", "warn"); return; }
    button.disabled = true;
    try {
      const task = await client.createLocalRunnerTask({ runnerId: runner.id, adapter: activeAdapter, prompt, workspace, executionMode, timeoutSeconds });
      selectedTaskId = task.id;
      const input = one<HTMLTextAreaElement>("#localRunnerPrompt");
      if (input) input.value = "";
      dependencies.toast(`任务已发送到本地 Runner（${adapterLabel(activeAdapter)}）`, "success");
      await refresh(true);
    } catch (error) {
      dependencies.toast(error instanceof Error ? error.message : "任务提交失败", "error");
    } finally {
      renderComposer();
    }
  });

  return { refresh, activate() { void refresh(true); } };
}
