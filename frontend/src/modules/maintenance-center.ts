/**
 * 客户维护中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, currentMaintenanceMatrixRows, maintenanceMatrixPreset, renderMaintenanceMatrix, state } from "../prototype-api";
import {
  type CustomerMaintenanceFinding, type CustomerMaintenanceFindingsView, type CustomerMaintenancePreview,
  type CustomerMaintenanceWatch
} from "./models";
import { refreshDashboardOnly, renderTodos, updateTodoChips } from "./dashboard";
import { escapeHtml, qs, qsa } from "./shared";
import { maintenanceMatrixPresets, maintenancePriorityText, maintenanceReasonLabels, readMaintenanceMatrixInputs } from "./sales-training";
import { api, setButtonPending, toast } from "./ui";
import { formatDateTime } from "./deals";

function renderMaintenanceWatchList() {
  const host = qs<HTMLElement>("#maintenanceWatchList");
  if (!host) return;
  const watches = state.customerMaintenanceWatches;
  if (!watches.length) {
    host.innerHTML = `<div class="mt-empty">还没有守护策略。可以先点右上角「预检命中」看看当前条件会命中多少客户，再用下方的等级矩阵一键创建。</div>`;
    return;
  }
  host.innerHTML = watches.map((watch) => {
    const statusText = watch.status === "active" ? "运行中" : watch.status === "paused" ? "已暂停" : watch.status === "error" ? "受阻" : "已取消";
    const condition = `每 ${watch.rules.intervalHours} 小时 · ${watch.rules.inactivityDays} 天未跟进 · 健康度 < ${watch.rules.healthBelow} · 覆盖 ${watch.rules.grades.join("/") || "全部等级"}`;
    const found = state.maintenanceFindings[watch.id];
    const actions = watch.status === "cancelled"
      ? `<button class="btn" data-maintenance-action="run" data-watch="${escapeHtml(watch.id)}" type="button">立即巡检</button><button class="btn" data-maintenance-action="findings" data-watch="${escapeHtml(watch.id)}" type="button">查看命中</button>`
      : `${watch.status === "active"
          ? `<button class="btn" data-maintenance-action="pause" data-watch="${escapeHtml(watch.id)}" type="button">暂停</button>`
          : `<button class="btn" data-maintenance-action="resume" data-watch="${escapeHtml(watch.id)}" type="button">继续</button>`}
         <button class="btn" data-maintenance-action="run" data-watch="${escapeHtml(watch.id)}" type="button">立即巡检</button>
         <button class="btn" data-maintenance-action="findings" data-watch="${escapeHtml(watch.id)}" type="button">查看命中</button>
         <button class="btn" data-maintenance-action="cancel" data-watch="${escapeHtml(watch.id)}" type="button">取消</button>`;
    return `<article class="mt-watch">
      <div class="mt-watch-head">
        <div>
          <h3><span class="mt-dot ${watch.status}"></span>${escapeHtml(watch.name)}</h3>
          <p>${escapeHtml(condition)} · ${statusText}${watch.status === "active" && watch.nextRunAt ? ` · 下次巡检 ${escapeHtml(formatDateTime(watch.nextRunAt))}` : ""}</p>
          ${watch.lastError ? `<p style="color:#d64545">上次失败：${escapeHtml(watch.lastError)}</p>` : ""}
        </div>
        <div class="mt-watch-actions">${actions}</div>
      </div>
      <div class="mt-watch-stats">
        <span class="mt-stat">上次命中 <b>${watch.lastMatchedCount}</b></span>
        <span class="mt-stat">建待办 <b>${watch.lastCreatedCount}</b></span>
        <span class="mt-stat">跳过 <b>${watch.lastSkippedCount}</b></span>
        <span class="mt-stat">累计建待办 <b>${watch.totalCreatedCount}</b></span>
        ${found ? `<span class="mt-stat">队列中 <b>${found.todos.filter((item) => !item.done).length}</b></span>` : ""}
        <span class="mt-stat">上次巡检 ${watch.lastRunAt ? escapeHtml(formatDateTime(watch.lastRunAt)) : "尚未执行"}</span>
      </div>
      <p style="margin:9px 0 0;color:#728099;font-size:10px">「跳过」= 该状况已经建过待办，指纹未变就不再重复打扰（幂等去重），不是系统漏掉了。</p>
    </article>`;
  }).join("");
  qsa<HTMLButtonElement>("#maintenanceWatchList [data-maintenance-action]").forEach((button) => {
    button.addEventListener("click", () => void maintenanceActionFromUi(button.dataset.watch || "", button.dataset.maintenanceAction || "", button));
  });
}

function renderMaintenanceFindings() {
  const host = qs<HTMLElement>("#maintenanceFindings");
  if (!host) return;
  const view = state.maintenanceActiveWatchId ? state.maintenanceFindings[state.maintenanceActiveWatchId] : undefined;
  if (!view) {
    host.innerHTML = `<div class="mt-empty">选择一个守护策略并点「查看命中」，或者先执行一次「立即巡检」。</div>`;
    return;
  }
  if (!view.findings.length) {
    host.innerHTML = `<div class="mt-empty">「${escapeHtml(view.name)}」最近一次巡检没有命中任何客户。</div>`;
    return;
  }
  host.innerHTML = `<table>
    <thead><tr><th>优先级</th><th>客户</th><th>命中原因</th><th>建议动作</th><th>状态</th></tr></thead>
    <tbody>${view.findings.map((finding) => {
      const todo = view.todos.find((item) => item.triggerKey && item.triggerKey === finding.triggerKey);
      const action = finding.playbookAction
        ? `<span class="mt-action">${escapeHtml(finding.playbookName ? `${finding.playbookName} 的打法：` : "")}${escapeHtml(finding.playbookAction)}</span>`
        : `<span class="mt-action none">未匹配到打法 · 仅记录</span>`;
      return `<tr>
        <td><i class="mt-pri ${escapeHtml(finding.priority)}"></i>${escapeHtml(maintenancePriorityText[finding.priority] || finding.priority)}</td>
        <td>${escapeHtml(finding.customerName)}</td>
        <td class="mt-reason">${escapeHtml(finding.reason)}<br><small>${escapeHtml(finding.reasonCodes.map((code) => maintenanceReasonLabels[code] || code).join(" · "))}</small></td>
        <td>${action}</td>
        <td>${todo ? (todo.done ? "待办已完成" : "已建待办") : "已跳过"}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

function renderMaintenanceOutput() {
  const host = qs<HTMLElement>("#maintenanceOutput");
  if (!host) return;
  const todos = Object.values(state.maintenanceFindings)
    .flatMap((view) => view.todos)
    .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""))
    .slice(0, 50);
  if (!todos.length) {
    host.innerHTML = `<div class="mt-empty">暂无自动维护待办。执行一次「立即巡检」后，这里会列出机器为你准备的跟进事项。</div>`;
    return;
  }
  host.innerHTML = todos.map((todo) => `<div class="mt-output-row ${todo.done ? "done" : ""}">
    <span class="mt-badge">自动维护</span>
    <div class="mt-output-main"><b>${escapeHtml(todo.title)}</b><small>${escapeHtml(todo.related || "")}${todo.dueAt ? ` · 计划 ${escapeHtml(todo.dueAt)}` : ""}</small></div>
    <span>${todo.done ? "已完成" : escapeHtml(maintenancePriorityText[todo.priority] || "")}</span>
  </div>`).join("");
}

function renderMaintenanceCenter() {
  readMaintenanceMatrixInputs();
  const summary = qs<HTMLElement>("#maintenanceSummary");
  if (summary) {
    const watches = state.customerMaintenanceWatches;
    const cards: Array<[string, string]> = [
      ["运行中的守护策略", String(watches.filter((item) => item.status === "active").length)],
      ["上次巡检命中", String(watches.reduce((sum, item) => sum + (item.lastMatchedCount || 0), 0))],
      ["上次创建待办", String(watches.reduce((sum, item) => sum + (item.lastCreatedCount || 0), 0))],
      ["上次幂等跳过", String(watches.reduce((sum, item) => sum + (item.lastSkippedCount || 0), 0))]
    ];
    summary.innerHTML = cards.map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join("");
  }
  renderMaintenanceWatchList();
  renderMaintenanceFindings();
  renderMaintenanceMatrix();
  renderMaintenanceOutput();
}

export async function loadMaintenanceCenter() {
  const host = qs<HTMLElement>("#maintenanceWatchList");
  if (host) host.innerHTML = `<div class="mt-empty">正在读取守护策略…</div>`;
  try {
    const result = await api<{ watches: CustomerMaintenanceWatch[] }>("/api/agent/customer-maintenance?limit=100");
    state.customerMaintenanceWatches = result.watches || [];
    const views = await Promise.all(state.customerMaintenanceWatches.map(async (watch) => {
      try {
        return await api<CustomerMaintenanceFindingsView>(`/api/agent/customer-maintenance/${encodeURIComponent(watch.id)}/findings?limit=50`);
      } catch {
        return null;
      }
    }));
    state.maintenanceFindings = {};
    views.forEach((view) => { if (view) state.maintenanceFindings[view.watchId] = view; });
    const preferred = state.customerMaintenanceWatches.find((item) => (item.lastFindings || []).length)
      || state.customerMaintenanceWatches[0];
    if (!state.maintenanceActiveWatchId || !state.customerMaintenanceWatches.some((item) => item.id === state.maintenanceActiveWatchId)) {
      state.maintenanceActiveWatchId = preferred?.id || "";
    }
    renderMaintenanceCenter();
  } catch (error) {
    renderMaintenanceCenter();
    toast(error instanceof Error ? error.message : "自动维护中心加载失败", "error");
  }
}

async function maintenanceActionFromUi(watchId: string, action: string, button: HTMLButtonElement) {
  if (!watchId || !action || button.disabled) return;
  if (action === "findings") {
    state.maintenanceActiveWatchId = watchId;
    renderMaintenanceFindings();
    return;
  }
  const idleLabel = action === "pause" ? "暂停" : action === "resume" ? "继续" : action === "cancel" ? "取消" : "立即巡检";
  try {
    if (action === "run") {
      setButtonPending(button, true, idleLabel, "巡检中…");
      const result = await api<{ watch: CustomerMaintenanceWatch; findings: CustomerMaintenanceFinding[]; created: unknown[]; skippedCount: number }>(
        `/api/agent/customer-maintenance/${encodeURIComponent(watchId)}/run`,
        { method: "POST" }
      );
      state.maintenanceActiveWatchId = watchId;
      toast(`巡检完成：命中 ${result.findings.length} 项，创建 ${result.created.length} 个待办，跳过 ${result.skippedCount} 项`);
      await loadMaintenanceCenter();
      await refreshDashboardOnly();
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      return;
    }
    if (action === "pause" || action === "resume" || action === "cancel") {
      if (action === "cancel" && !window.confirm("取消后该守护策略不再巡检，已经产生的待办会保留。确认取消？")) return;
      setButtonPending(button, true, idleLabel, "处理中…");
      await api<{ watch: CustomerMaintenanceWatch }>(
        `/api/agent/customer-maintenance/${encodeURIComponent(watchId)}/${action}`,
        { method: "POST" }
      );
      toast(action === "pause" ? "守护策略已暂停" : action === "resume" ? "守护策略已继续" : "守护策略已取消");
      await loadMaintenanceCenter();
      return;
    }
  } catch (error) {
    setButtonPending(button, false, idleLabel, idleLabel);
    toast(error instanceof Error ? error.message : "操作失败", "error");
  }
}

async function previewMaintenanceFromUi(button: HTMLButtonElement) {
  readMaintenanceMatrixInputs();
  const host = qs<HTMLElement>("#maintenancePreviewResult");
  const rules = { ...currentMaintenanceMatrixRows()[0] };
  const payload = {
    intervalHours: rules.intervalHours,
    inactivityDays: rules.inactivityDays,
    healthBelow: rules.healthBelow,
    grades: ["A", "B", "C", "D"] as Array<"A" | "B" | "C" | "D">,
    maxTodosPerRun: 10
  };
  setButtonPending(button, true, "预检命中", "预检中…");
  try {
    const result = await api<CustomerMaintenancePreview>("/api/agent/customer-maintenance/preview", {
      method: "POST",
      body: JSON.stringify({ rules: payload })
    });
    state.maintenancePreview = result;
    if (host) {
      host.hidden = false;
      host.innerHTML = `<h3>预检结果（不写入任何数据）</h3>
        <p>按「A 级」那一行的阈值（${payload.intervalHours} 小时巡检 / ${payload.inactivityDays} 天未跟进 / 健康度 &lt; ${payload.healthBelow}，全等级）扫描：命中 <b>${result.matchedCount}</b> 个客户，单次最多会创建 <b>${result.creatableCount}</b> 个待办。</p>
        ${result.findings.length ? `<ul>${result.findings.map((item) => `<li>${escapeHtml(item.customerName)} · ${escapeHtml(item.reason)}${item.playbookAction ? ` · 打法：${escapeHtml(item.playbookAction)}` : ""}</li>`).join("")}</ul>` : `<p>当前条件没有命中客户。</p>`}`;
    }
    toast(`预检完成：命中 ${result.matchedCount} 个客户`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "预检失败", "error");
  } finally {
    setButtonPending(button, false, "预检命中", "预检命中");
  }
}

async function applyMaintenanceMatrixFromUi(button: HTMLButtonElement) {
  readMaintenanceMatrixInputs();
  const rows = currentMaintenanceMatrixRows();
  if (!rows.length) {
    toast("当前矩阵没有可创建的行", "error");
    return;
  }
  setButtonPending(button, true, "按矩阵创建守护策略", "创建中…");
  let created = 0;
  const skipped: string[] = [];
  try {
    for (const row of rows) {
      const existing = state.customerMaintenanceWatches.find((watch) =>
        watch.status !== "cancelled"
        && watch.rules.grades.length === row.grades.length
        && row.grades.every((grade) => watch.rules.grades.includes(grade))
      );
      if (existing) {
        skipped.push(`${row.label}（已存在「${existing.name}」）`);
        continue;
      }
      const result = await api<{ watch: CustomerMaintenanceWatch }>("/api/agent/customer-maintenance", {
        method: "POST",
        body: JSON.stringify({
          name: `${maintenanceMatrixPresets[maintenanceMatrixPreset].label} · ${row.label}客户守护`,
          rules: {
            intervalHours: row.intervalHours,
            inactivityDays: row.inactivityDays,
            healthBelow: row.healthBelow,
            includeOverdueReminder: true,
            includeMissingNextAction: true,
            grades: row.grades,
            maxTodosPerRun: row.maxTodosPerRun
          }
        })
      });
      state.customerMaintenanceWatches = [result.watch, ...state.customerMaintenanceWatches];
      created += 1;
    }
    toast(created
      ? `已创建 ${created} 个守护策略${skipped.length ? `；跳过 ${skipped.length} 个：${skipped.join("、")}` : ""}`
      : `没有新建策略：${skipped.join("、") || "无需创建"}`);
    await loadMaintenanceCenter();
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建守护策略失败", "error");
  } finally {
    setButtonPending(button, false, "按矩阵创建守护策略", "按矩阵创建守护策略");
  }
}

export function bindMaintenanceCenterEvents() {
  qs<HTMLButtonElement>("#maintenanceRefreshButton")?.addEventListener("click", () => void loadMaintenanceCenter());
  qs<HTMLButtonElement>("#maintenancePreviewButton")?.addEventListener("click", (event) => {
    void previewMaintenanceFromUi(event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#maintenanceApplyMatrixButton")?.addEventListener("click", (event) => {
    void applyMaintenanceMatrixFromUi(event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#maintenanceOpenTodoButton")?.addEventListener("click", () => {
    state.todoFilter = "maintenance";
    activateNavView("todo", () => {
      renderTodos(state.todos);
      updateTodoChips(state.todos);
    });
  });
}
