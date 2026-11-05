/**
 * 数据库导入与维护。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { type MysqlDumpBatch } from "../mysql-dump-import";
import {
  appendDatabaseLocalEvent, databaseCurrentJob, databaseLocalEvents, databaseLogFollow, databaseMaintenanceMode,
  mysqlImportRunning, mysqlImportSelection, renderDatabaseHistory
} from "../prototype-api";
import { type AccessControlOverview, type AccessControlPage, type AccessControlScope } from "./models";
import {
  type DatabaseMaintenanceJob, type DatabaseMaintenanceStatus, type DatabaseTableStat, databaseJobStatusLabel,
  databaseJobTypeLabel, formatFileSize, mysqlImportHeaders, setMysqlImportProgress
} from "./exams";
import { escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { hasIamCapability, viewPermissionRequirements } from "./auth";

export let databaseMaintenanceStatus: DatabaseMaintenanceStatus | null = null;
export let databaseMaintenanceJobs: DatabaseMaintenanceJob[] = [];

function databaseJobProgress(job: DatabaseMaintenanceJob) {
  if (job.type === "backup") return { processed: job.processedTables || 0, total: job.totalTables || 0 };
  return { processed: job.processedRows || 0, total: job.totalRows || 0 };
}

function renderDatabaseCapability() {
  const status = databaseMaintenanceStatus;
  const storeReady = status?.store === "mysql";
  const storeState = qs<HTMLElement>("#databaseStoreState");
  const storeMeta = qs<HTMLElement>("#databaseStoreMeta");
  const backupPolicy = qs<HTMLElement>("#databaseBackupPolicy");
  const backupMeta = qs<HTMLElement>("#databaseBackupPolicyMeta");
  const policyTitle = qs<HTMLElement>("#databaseBackupPolicyTitle");
  const policyDescription = qs<HTMLElement>("#databaseBackupPolicyDescription");
  const policyBox = qs<HTMLElement>("#databaseBackupPolicyBox");
  const retention = qs<HTMLElement>("#databaseBackupRetention");
  if (storeState) storeState.textContent = storeReady ? "连接正常" : status ? "非 MySQL 模式" : "正在检查";
  if (storeMeta) storeMeta.textContent = storeReady ? "当前业务数据使用 MySQL 持久化" : "数据库维护需要 MySQL 持久化模式";
  const backupEnabled = Boolean(status?.backup.enabled);
  if (backupPolicy) backupPolicy.textContent = backupEnabled ? "允许本地备份" : status ? "禁止本地备份" : "正在检查";
  if (backupMeta) backupMeta.textContent = backupEnabled ? `自动保留 ${status?.backup.retentionDays || 0} 天` : status?.backup.reason || "读取部署配置";
  if (policyTitle) policyTitle.textContent = backupEnabled ? "服务器允许创建本地备份" : "服务器已禁止本地备份";
  if (policyDescription) policyDescription.textContent = backupEnabled ? "备份将压缩保存，并按配置自动清理" : "部署者需要设置 MYSQL_LOCAL_BACKUP_ENABLED=true 才能使用";
  policyBox?.classList.toggle("is-blocked", !backupEnabled);
  if (retention) retention.textContent = backupEnabled ? `${status?.backup.retentionDays || 0} 天` : "未启用";
  const backupStart = qs<HTMLButtonElement>("#databaseBackupStart");
  if (backupStart) {
    backupStart.disabled = !backupEnabled || Boolean(databaseCurrentJob && ["queued", "running"].includes(databaseCurrentJob.status));
    backupStart.title = backupEnabled ? "创建压缩数据库备份" : "需要在部署配置中开启 MYSQL_LOCAL_BACKUP_ENABLED";
  }
  const latest = status?.latest;
  const latestTitle = qs<HTMLElement>("#databaseLatestTask");
  const latestMeta = qs<HTMLElement>("#databaseLatestTaskMeta");
  if (latestTitle) latestTitle.textContent = latest ? `${databaseJobTypeLabel(latest.type)} · ${databaseJobStatusLabel(latest.status)}` : "暂无任务";
  if (latestMeta) latestMeta.textContent = latest ? new Date(latest.createdAt).toLocaleString("zh-CN", { hour12: false }) : "迁移与备份记录";
}

function renderDatabaseMode() {
  qsa<HTMLButtonElement>("[data-database-mode]").forEach((button) => button.classList.toggle("active", button.dataset.databaseMode === databaseMaintenanceMode));
  qs<HTMLElement>("#databaseMigrationControls")?.classList.toggle("is-hidden", databaseMaintenanceMode !== "migration");
  qs<HTMLElement>("#databaseBackupControls")?.classList.toggle("is-hidden", databaseMaintenanceMode !== "backup");
  qs<HTMLButtonElement>("#mysqlImportStart")?.classList.toggle("is-hidden", databaseMaintenanceMode !== "migration");
  qs<HTMLButtonElement>("#databaseBackupStart")?.classList.toggle("is-hidden", databaseMaintenanceMode !== "backup");
  renderDatabaseCapability();
}

function databaseTableEntries() {
  if (databaseCurrentJob && Object.keys(databaseCurrentJob.tableStats || {}).length) return Object.entries(databaseCurrentJob.tableStats);
  return Object.entries(mysqlImportSelection?.plan.tableRows || {}).map(([table, total]) => [table, { total }] as [string, DatabaseTableStat]);
}

function renderDatabaseTableProgress() {
  const list = qs<HTMLElement>("#mysqlImportTableList");
  if (!list) return;
  const entries = databaseTableEntries();
  const job = databaseCurrentJob;
  const meta = qs<HTMLElement>("#databaseTableProgressMeta");
  if (meta) meta.textContent = `${job?.processedTables || 0} / ${job?.totalTables || entries.length}`;
  list.innerHTML = entries.length ? entries.map(([table, stat]) => {
    const total = Number(stat.total ?? stat.rows ?? 0);
    const imported = Number(stat.imported || 0);
    const skipped = Number(stat.skipped || 0);
    const failed = Number(stat.failed || 0);
    const handled = imported + skipped + failed;
    const status = stat.status || (job?.currentTable === table && job.status === "running" ? "running" : handled && handled >= total ? "completed" : "pending");
    const progress = total ? Math.min(100, Math.round(handled / total * 100)) : status === "completed" ? 100 : 0;
    return `<div class="database-table-row ${job?.currentTable === table && job.status === "running" ? "is-current" : ""}">
      <b title="${escapeHtml(table)}">${escapeHtml(table)}</b>
      <span class="database-table-state is-${status}"><i></i>${status === "running" ? "进行中" : status === "completed" ? "完成" : status === "failed" ? "失败" : "等待"}</span>
      <span>${progress}%</span><span>${total.toLocaleString()}</span><span>${imported.toLocaleString()}</span><span>${skipped.toLocaleString()}</span><span>${failed.toLocaleString()}</span>
    </div>`;
  }).join("") : `<div class="empty-cell">暂无任务数据</div>`;
}

function databaseVisibleEvents() {
  const remote = databaseCurrentJob?.events || [];
  const values = [...databaseLocalEvents, ...remote];
  return [...new Map(values.map((event) => [event.id, event])).values()].sort((left, right) => left.at.localeCompare(right.at));
}

export function renderDatabaseStream() {
  const stream = qs<HTMLElement>("#databaseStreamLog");
  if (!stream) return;
  const events = databaseVisibleEvents();
  stream.innerHTML = events.length ? events.map((event) => `<div class="database-stream-line is-${event.level}"><time>${new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}</time><em>${escapeHtml(event.table || event.stage)}</em><span>${escapeHtml(event.message)}</span></div>`).join("") : `<div class="database-stream-empty">任务开始后将在这里持续输出执行过程</div>`;
  if (databaseLogFollow) stream.scrollTop = stream.scrollHeight;
  const follow = qs<HTMLButtonElement>("#databaseLogFollow");
  if (follow) follow.textContent = databaseLogFollow ? "暂停滚动" : "继续滚动";
}

function renderDatabaseExecution() {
  const job = databaseCurrentJob;
  const title = qs<HTMLElement>("#databaseExecutionTitle");
  const meta = qs<HTMLElement>("#databaseExecutionMeta");
  const eyebrow = qs<HTMLElement>("#databaseExecutionEyebrow");
  const status = qs<HTMLElement>("#databaseExecutionStatus");
  if (job) {
    if (eyebrow) eyebrow.textContent = databaseJobTypeLabel(job.type);
    if (title) title.textContent = job.fileName || `${databaseJobTypeLabel(job.type)}任务`;
    if (meta) meta.textContent = `${job.phase || "准备中"}${job.currentTable ? ` · 当前 ${job.currentTable}` : ""} · ${new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false })}`;
    if (status) {
      status.className = `database-run-status is-${job.status === "queued" ? "running" : job.status}`;
      status.innerHTML = `<i></i>${databaseJobStatusLabel(job.status)}`;
    }
    const progress = databaseJobProgress(job);
    setMysqlImportProgress(progress.processed, progress.total, job.errorMessage || (job.status === "completed" ? "任务执行完成" : job.currentTable ? `正在处理 ${job.currentTable}` : job.phase), !progress.total && ["queued", "running"].includes(job.status));
  } else {
    if (eyebrow) eyebrow.textContent = "任务执行";
    if (title) title.textContent = mysqlImportSelection ? mysqlImportSelection.file.name : "等待开始";
    if (meta) meta.textContent = mysqlImportSelection ? `${mysqlImportSelection.plan.rowCount.toLocaleString()} 条记录等待迁移` : "选择迁移文件或切换到备份";
    if (status) {
      status.className = "database-run-status is-idle";
      status.innerHTML = "<i></i>等待任务";
    }
    setMysqlImportProgress(0, mysqlImportSelection?.plan.rowCount || 0, mysqlImportSelection ? "文件解析完成" : "等待任务");
  }
  renderDatabaseTableProgress();
  renderDatabaseStream();
  const cancel = qs<HTMLButtonElement>("#databaseTaskCancel");
  const running = Boolean(job && ["queued", "running"].includes(job.status));
  if (cancel) cancel.classList.toggle("is-hidden", !running);
}

export function renderMysqlImport() {
  const selection = mysqlImportSelection;
  const fileName = qs<HTMLElement>("#mysqlImportFileName");
  const fileMeta = qs<HTMLElement>("#mysqlImportFileMeta");
  const tableCount = qs<HTMLElement>("#mysqlImportTableCount");
  const rowCount = qs<HTMLElement>("#mysqlImportRowCount");
  const appliedCount = qs<HTMLElement>("#mysqlImportAppliedCount");
  const skippedCount = qs<HTMLElement>("#mysqlImportSkippedCount");
  const list = qs<HTMLElement>("#mysqlImportTableList");
  const start = qs<HTMLButtonElement>("#mysqlImportStart");
  if (fileName) fileName.textContent = selection?.file.name || "选择 MySQL 文件";
  if (fileMeta) fileMeta.textContent = selection
    ? `${formatFileSize(selection.file.size)} · ${selection.plan.rowCount.toLocaleString()} 条记录`
    : ".sql / .sql.gz · 文件仅在浏览器解析";
  if (tableCount) tableCount.textContent = String(Object.keys(selection?.plan.tableRows || {}).length);
  if (rowCount) rowCount.textContent = (selection?.plan.rowCount || 0).toLocaleString();
  if (appliedCount) appliedCount.textContent = Number(databaseCurrentJob?.importedRows || 0).toLocaleString();
  if (skippedCount) skippedCount.textContent = Number(databaseCurrentJob?.skippedRows || 0).toLocaleString();
  if (start) start.disabled = !selection || mysqlImportRunning || Boolean(databaseCurrentJob && ["queued", "running"].includes(databaseCurrentJob.status));
  void list;
  renderDatabaseMode();
  renderDatabaseExecution();
  renderDatabaseHistory();
}

export async function refreshDatabaseMaintenance() {
  const canManage = hasIamCapability("database.maintain");
  if (!canManage) return;
  const badgeNode = qs<HTMLElement>("#databaseMaintenanceState");
  try {
    const [status, history] = await Promise.all([
      api<DatabaseMaintenanceStatus>("/api/system/database-maintenance/status"),
      api<{ jobs: DatabaseMaintenanceJob[] }>("/api/system/database-maintenance/jobs?limit=40")
    ]);
    databaseMaintenanceStatus = status;
    databaseMaintenanceJobs = history.jobs;
    if (badgeNode) {
      badgeNode.textContent = status.store === "mysql" ? "MySQL 正常" : "不可用";
      badgeNode.className = `badge ${status.store === "mysql" ? "green" : "amber"}`;
    }
    renderMysqlImport();
  } catch (error) {
    if (badgeNode) {
      badgeNode.textContent = "不可用";
      badgeNode.className = "badge red";
    }
    appendDatabaseLocalEvent("connection", error instanceof Error ? error.message : "数据库维护状态读取失败", "error");
  }
}

export function refreshMysqlImportStatus() {
  return refreshDatabaseMaintenance();
}

export function fitBatchToSchema(
  batch: MysqlDumpBatch,
  tables: Record<string, { columns: string[]; primaryKeys: string[] }>
) {
  const target = tables[batch.table];
  if (!target) return batch;
  const indexes = batch.columns
    .map((column, index) => target.columns.includes(column) ? index : -1)
    .filter((index) => index >= 0);
  if (!indexes.length) return null;
  return {
    table: batch.table,
    columns: indexes.map((index) => batch.columns[index]),
    rows: batch.rows.map((row) => indexes.map((index) => row[index]))
  };
}

export function splitLargeMysqlImportBatch(batch: MysqlDumpBatch): MysqlDumpBatch[] {
  if (JSON.stringify(batch).length < 1_500_000 || batch.rows.length === 1) return [batch];
  const middle = Math.ceil(batch.rows.length / 2);
  return [
    ...splitLargeMysqlImportBatch({ ...batch, rows: batch.rows.slice(0, middle) }),
    ...splitLargeMysqlImportBatch({ ...batch, rows: batch.rows.slice(middle) })
  ];
}

export async function waitForMysqlImportRestart() {
  await new Promise((resolve) => window.setTimeout(resolve, 2200));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // The production service is restarting.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  toast("数据库已迁移，请刷新页面", "error");
}

export function databaseJobEndpoint(job: DatabaseMaintenanceJob) {
  return job.type === "backup"
    ? `/api/system/database-backups/jobs/${encodeURIComponent(job.id)}`
    : `/api/system/database-import/jobs/${encodeURIComponent(job.id)}`;
}

export async function downloadDatabaseBackup(id: string) {
  try {
    const response = await fetch(`/api/system/database-backups/jobs/${encodeURIComponent(id)}/download`, { credentials: "same-origin", headers: mysqlImportHeaders() });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "备份下载失败" }));
      throw new Error(body.message || "备份下载失败");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = databaseMaintenanceJobs.find((job) => job.id === id)?.fileName || "goodjob-database.sql.gz";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    toast(error instanceof Error ? error.message : "备份下载失败", "error");
  }
}

export function databaseLogText() {
  return databaseVisibleEvents().map((event) => `${event.at}\t${event.level}\t${event.table || event.stage}\t${event.message}`).join("\n");
}

export function downloadDatabaseLog() {
  const blob = new Blob([databaseLogText()], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `goodjob-database-task-${databaseCurrentJob?.id || "local"}.log`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export const accessControlScopeText: Record<AccessControlScope, string> = {
  none: "未授权",
  self: "本人",
  org_unit: "本组织",
  org_subtree: "本组织及下级",
  tenant: "当前公司",
  public_pool: "客户公池",
  platform: "平台"
};

export function accessControlScopeBadge(scope: AccessControlScope) {
  return `<span class="ac-scope-chip ${scope}">${accessControlScopeText[scope]}</span>`;
}

export interface AccessControlUiModule {
  id: string;
  group: string;
  name: string;
  summary: string;
  views: string[];
  permissionCodes: string[];
  edition: string;
}

export const accessControlUiModules: AccessControlUiModule[] = [
  {
    id: "workspace",
    group: "基础工作",
    name: "经营工作台",
    summary: "首页经营概览、待办状态和快捷入口。",
    views: ["dashboard"],
    permissionCodes: ["workspace.dashboard.read", "workspace.dashboard.manage"],
    edition: "基础界面"
  },
  {
    id: "customer-growth",
    group: "客户增长",
    name: "线索与客户",
    summary: "线索、未成交客户、已成交客户和客户公池。",
    views: ["leads", "customers", "customer-pool"],
    permissionCodes: ["lead.read", "lead.create", "lead.update", "lead.assign", "customer.read", "customer.create", "customer.update", "customer.pool.claim"],
    edition: "销售界面"
  },
  {
    id: "prospect",
    group: "客户增长",
    name: "自动搜客",
    summary: "搜客任务、候选清洗、官网与联系方式补全。",
    views: ["lead-finder", "prospect-list"],
    permissionCodes: ["prospect.read", "prospect.execute"],
    edition: "增长界面"
  },
  {
    id: "deal-document",
    group: "成交交付",
    name: "商机与单据",
    summary: "商机推进、报价单、PI、CI 和报价历史。",
    views: ["pipeline", "documents"],
    permissionCodes: ["deal.read", "deal.create", "deal.update", "deal.quote.create", "document.read", "document.manage"],
    edition: "业务界面"
  },
  {
    id: "shipment",
    group: "成交交付",
    name: "发货与全球航线",
    summary: "发货跟踪、运输节点和全球航线地图。",
    views: ["shipments", "global-map"],
    permissionCodes: ["shipment.read", "shipment.manage"],
    edition: "交付界面"
  },
  {
    id: "collaboration",
    group: "协作提醒",
    name: "跟进与站内协作",
    summary: "跟进提醒、日报、消息通知和客户通信。",
    views: ["reminders", "daily-reports", "inbox", "whatsapp", "email-return-flow"],
    permissionCodes: ["reminder.read", "reminder.manage", "daily_report.read", "daily_report.create", "message.read", "message.send", "communication.read", "communication.send"],
    edition: "协作界面"
  },
  {
    id: "reporting",
    group: "经营资料",
    name: "经营资料库",
    summary: "产品、报表、排行、问题清单、案例和备忘录。",
    views: ["products", "reports", "leaderboard", "problems", "cases", "memos"],
    permissionCodes: ["product.read", "product.manage", "report.read", "report.export"],
    edition: "经营界面"
  },
  {
    id: "agent-integration",
    group: "自动化",
    name: "AI 与集成中心",
    summary: "Agent、Agent Skills、集成中心和本地 Runner。",
    views: ["ai-agent", "agent-skills", "integration-center"],
    permissionCodes: ["agent.use", "agent.manage", "integration.read", "integration.connect", "integration.execute", "integration.manage"],
    edition: "自动化界面"
  },
  {
    id: "training",
    group: "培训知识",
    name: "资料与考试",
    summary: "资料维护、在线考试、题库和销售训练。",
    views: ["knowledge", "exam", "question-bank", "sales-distillation"],
    permissionCodes: ["training.read", "training.manage"],
    edition: "知识界面"
  },
  {
    id: "approval",
    group: "流程控制",
    name: "审批中心",
    summary: "审批任务、流程画布和审批业务流转。",
    views: ["approval-center", "approval-workflows"],
    permissionCodes: ["approval.read", "approval.task.act", "approval.workflow.manage"],
    edition: "流程界面"
  },
  {
    id: "system",
    group: "系统治理",
    name: "组织权限与系统配置",
    summary: "成员、组织、角色、授权、审计和系统设置。",
    views: ["member-management", "organization-structure", "role-management", "ui-access", "member-authorization", "permission-audit", "settings", "database-maintenance"],
    permissionCodes: ["member.read", "member.manage", "org.read", "org.manage", "role.read", "role.manage", "permission.assign", "audit.read", "system.settings.manage", "database.maintain"],
    edition: "管理界面"
  }
];

export function accessControlModulePermissions(overview: AccessControlOverview, module: AccessControlUiModule) {
  const byCode = new Map(overview.permissions.map((permission) => [permission.code, permission]));
  return module.permissionCodes.map((code) => byCode.get(code)).filter(Boolean) as AccessControlOverview["permissions"];
}

export function accessControlSuggestedScope(role: AccessControlOverview["roles"][number], permission: AccessControlOverview["permissions"][number]): AccessControlScope {
  const fallbackScopes: AccessControlScope[] = ["self", "org_subtree", "tenant", "public_pool"];
  const scopes = permission.scopeModes?.length ? permission.scopeModes : fallbackScopes;
  if (role.code === "admin" && scopes.includes("tenant")) return "tenant";
  if (role.code === "manager" && scopes.includes("org_subtree")) return "org_subtree";
  if (scopes.includes("self")) return "self";
  if (scopes.includes("public_pool")) return "public_pool";
  return scopes[0] || "self";
}

export function accessControlModuleState(
  overview: AccessControlOverview,
  role: AccessControlOverview["roles"][number],
  module: AccessControlUiModule
) {
  const permissions = accessControlModulePermissions(overview, module);
  const granted = permissions.filter((permission) => (permission.grants[role.id] || "none") !== "none");
  const missing = module.permissionCodes.length - permissions.length;
  const readPermissions = permissions.filter((permission) => /\.(read|use)$/u.test(permission.code));
  const visible = readPermissions.some((permission) => (permission.grants[role.id] || "none") !== "none")
    || permissions.some((permission) => viewPermissionRequirements[module.views[0] || ""] === permission.code && (permission.grants[role.id] || "none") !== "none");
  const protectedBaseline = role.is_protected
    ? permissions.filter((permission) => Boolean(permission.protectedScopes?.[role.id]))
    : [];
  return {
    permissions,
    grantedCount: granted.length,
    missing,
    visible,
    protectedBaseline,
    closeLocked: protectedBaseline.length > 0,
    status: granted.length === 0 ? "closed" : granted.length === permissions.length && missing === 0 ? "open" : "partial"
  };
}

export function accessControlPermissionVersion(permissions: AccessControlOverview["permissions"]) {
  const versions = [...new Set(permissions.map((permission) => permission.introducedVersion || "").filter(Boolean))];
  return versions.length <= 1 ? versions[0] || "当前版本" : `${versions[0]} 等 ${versions.length} 个版本`;
}

export function activeAccessControlPage(): AccessControlPage {
  return (qs<HTMLElement>(".iam-view.active")?.dataset.iamPage as AccessControlPage | undefined) || "members";
}

export function activeAccessControlRoot() {
  return qs<HTMLElement>(".iam-view.active .ac-root");
}

export function accessControlLoading() {
  const root = activeAccessControlRoot();
  if (!root) return;
  root.innerHTML = `<div class="ac-loading-shell" aria-label="正在加载组织与权限">
    <div class="ac-loading-line wide"></div><div class="ac-loading-line"></div>
    <div class="ac-loading-workbench"></div>
  </div>`;
}
