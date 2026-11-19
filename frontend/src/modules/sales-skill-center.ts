/**
 * 销售技能中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { state } from "../prototype-api";
import { badge, escapeHtml, qs, qsa } from "./shared";
import { loadAgentSkills } from "./agent";
import {
  activateSalesPlaybookFromUi, loadSalesDistillationWorkspace, pauseSalesPlaybookFromUi,
  publishSalesDistillationFromUi, salesTrainingMaturityLabel
} from "./sales-training";
import { hasIamCapability } from "./auth";

// ---------------------------------------------------------------------------
// W5 · 销售技能中心：内置技能 + 超级销售归拢视图
// ---------------------------------------------------------------------------

type SalesSkillCenterTab = "skills" | "sales";
let salesSkillCenterTab: SalesSkillCenterTab = "skills";

/** 解析 SKILL.md 的「执行流程 / 完成标准 / 失败恢复」三段 */
function skillInstructionsSections(instructions: string) {
  const wanted = ["执行流程", "完成标准", "失败恢复"];
  const sections: Array<{ title: string; items: string[] }> = [];
  for (const title of wanted) {
    const match = instructions.match(new RegExp(`##\\s*${title}[\\s\\S]*?(?=\\n##\\s|$)`, "u"));
    if (!match) continue;
    const items = match[0]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+[.、)]|^[-*•]/u.test(line))
      .map((line) => line.replace(/^\d+[.、)]\s*|^[-*•]\s*/u, ""))
      .filter(Boolean);
    sections.push({ title, items });
  }
  return sections;
}

function renderSalesSkillCenter() {
  const skillsButton = qs<HTMLButtonElement>("#sscTabSkillsButton");
  const salesButton = qs<HTMLButtonElement>("#sscTabSalesButton");
  const skillsPane = qs<HTMLElement>("#sscSkillsPane");
  const salesPane = qs<HTMLElement>("#sscSalesPane");
  if (!skillsButton || !salesButton || !skillsPane || !salesPane) return;
  skillsButton.classList.toggle("primary", salesSkillCenterTab === "skills");
  salesButton.classList.toggle("primary", salesSkillCenterTab === "sales");
  skillsPane.hidden = salesSkillCenterTab !== "skills";
  salesPane.hidden = salesSkillCenterTab !== "sales";
  if (salesSkillCenterTab === "skills") renderSalesSkillCenterSkills();
  else renderSalesSkillCenterSales();
}

function renderSalesSkillCenterSkills() {
  const box = qs<HTMLElement>("#sscSkillCards");
  if (!box) return;
  const systemSkills = state.agentSkills.filter((skill) => skill.resourceKind !== "download");
  if (!systemSkills.length) {
    box.innerHTML = `<div class="empty-cell">技能目录为空，请点击刷新。</div>`;
    return;
  }
  box.innerHTML = systemSkills.map((skill) => {
    const sections = skillInstructionsSections(skill.instructions || "");
    return `<article class="ssc-card">
      <div class="ssc-card-head"><h3>${escapeHtml(skill.name)}</h3><small>V${escapeHtml(skill.version)} · ${escapeHtml(skill.category)}</small></div>
      <div>${badge(skill.status === "active" ? "启用" : skill.status, skill.status === "active" ? "green" : "gray")} <small>${(skill.toolRefs || []).length} 个依赖工具</small></div>
      <p>${escapeHtml(skill.description)}</p>
      <div class="ssc-tags">${(skill.triggers || []).slice(0, 5).map((trigger) => `<span class="ssc-tag">「${escapeHtml(trigger)}」</span>`).join("")}</div>
      ${sections.length ? `<details><summary>查看执行指引</summary>${sections.map((section) => `<section><h4>${escapeHtml(section.title)}</h4><ol>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>`).join("")}</details>` : ""}
    </article>`;
  }).join("");
}

function renderSalesSkillCenterSales() {
  const metricsBox = qs<HTMLElement>("#sscSalesMetrics");
  const box = qs<HTMLElement>("#sscSalesCards");
  if (!metricsBox || !box) return;
  const published = state.salesDistillations.filter((item) => item.status === "published");
  const totalApplications = state.salesPlaybookActivations.reduce((sum, item) => sum + (item.applicationCount || 0), 0);
  const totalTasks = state.salesPlaybookActivations.reduce((sum, item) => sum + (item.taskCount || 0), 0);
  const activeCount = state.salesPlaybookActivations.filter((item) => item.status === "active").length;
  metricsBox.innerHTML = `
    <div><span>已发布打法</span><b>${published.length}</b></div>
    <div><span>打法应用次数</span><b>${totalApplications}</b></div>
    <div><span>生成待办数</span><b>${totalTasks}</b></div>`;
  if (!published.length) {
    box.innerHTML = `<div class="empty-cell">暂无已发布打法。到「超级销售」页选择标杆销售做蒸馏与发布。</div>`;
    return;
  }
  const canPublish = hasIamCapability("training.manage");
  box.innerHTML = published.map((item) => {
    const activation = state.salesPlaybookActivations.find((entry) => entry.distillationId === item.id);
    const active = activation?.status === "active";
    const applyButton = active
      ? `<button class="btn" type="button" data-ssc-playbook-pause="${escapeHtml(activation!.id)}">停用当前打法</button>`
      : `<button class="btn primary" type="button" data-ssc-playbook-activate="${escapeHtml(item.id)}">应用到我的 Agent</button>`;
    return `<article class="ssc-card">
      <div class="ssc-card-head"><h3>${escapeHtml(item.sourceUserName)}</h3><small>${escapeHtml(item.maturity ? salesTrainingMaturityLabel(item.maturity) : "历史能力")} · ${item.sampleCount || 0} 样本 · 评测 ${item.evaluationScore || "-"}</small></div>
      <div class="ssc-sales-metrics" style="margin:0;border:none;background:none;grid-template-columns:repeat(3,minmax(0,1fr));">
        <div style="border:1px solid #e4eaf3;border-radius:8px;padding:8px 10px;"><span>应用次数</span><b style="font-size:14px;">${activation?.applicationCount || 0}</b></div>
        <div style="border:1px solid #e4eaf3;border-radius:8px;padding:8px 10px;"><span>生成待办</span><b style="font-size:14px;">${activation?.taskCount || 0}</b></div>
        <div style="border:1px solid #e4eaf3;border-radius:8px;padding:8px 10px;"><span>状态</span><b style="font-size:14px;">${active ? "应用中" : "未激活"}</b></div>
      </div>
      <div>${item.playbook.map((step) => `<div class="ssc-playbook-row"><b>${escapeHtml(step.stage)}</b><p>${escapeHtml(step.action)}</p></div>`).join("")}</div>
      <div class="head-actions">${canPublish && item.status !== "published" ? `<button class="btn" type="button" data-ssc-publish="${escapeHtml(item.id)}">发布</button>` : ""}${applyButton}</div>
    </article>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-ssc-playbook-activate]", box).forEach((button) => button.addEventListener("click", () => void activateSalesPlaybookFromUi(button.dataset.sscPlaybookActivate || "", button)));
  qsa<HTMLButtonElement>("[data-ssc-playbook-pause]", box).forEach((button) => button.addEventListener("click", () => void pauseSalesPlaybookFromUi(button.dataset.sscPlaybookPause || "", button)));
  qsa<HTMLButtonElement>("[data-ssc-publish]", box).forEach((button) => button.addEventListener("click", () => void publishSalesDistillationFromUi(button.dataset.sscPublish || "", button)));
}

export async function loadSalesSkillCenter() {
  salesSkillCenterTab = "skills";
  try {
    if (!state.agentSkills.length) await loadAgentSkills(false);
  } catch { /* 技能加载失败不阻塞 */ }
  void loadSalesDistillationWorkspace().catch(() => undefined);
  renderSalesSkillCenter();
}

export function bindSalesSkillCenterEvents() {
  qs<HTMLButtonElement>("#sscTabSkillsButton")?.addEventListener("click", () => { salesSkillCenterTab = "skills"; renderSalesSkillCenter(); });
  qs<HTMLButtonElement>("#sscTabSalesButton")?.addEventListener("click", () => { salesSkillCenterTab = "sales"; renderSalesSkillCenter(); });
  qs<HTMLButtonElement>("#sscRefreshButton")?.addEventListener("click", () => {
    state.agentSkills = [];
    void loadSalesSkillCenter();
  });
}
