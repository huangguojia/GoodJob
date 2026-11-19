/**
 * 文件中心。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { confirmAction, openModal } from "../prototype-api";
import { cookieValue, escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { loadOrders, openOrderDetail, ordDownloadFile, ordFileSize, ordPreviewFile } from "./orders";

// ---------------------------------------------------------------------------
// 文件中心（M3–M6）：台账 / 回收站 / 分享 / 审计 / 打包 / 巡检
// ---------------------------------------------------------------------------

type FileCenterTab = "active" | "recycled" | "shares" | "audit";

interface FileCenterItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  ownerId: string;
  ownerName?: string;
  status: "active" | "recycled";
  legalHold?: boolean;
  deriveStatus?: string;
  deriveError?: string;
  createdAt: string;
  referenceCount?: number;
  isCurrent?: boolean;
  versionGroupId?: string;
  visibility?: string;
  previewable?: boolean;
}

interface FileCenterShare {
  id: string;
  fileId: string;
  fileName?: string;
  /** 关联文件的真实状态；文件已删除时为空串，此时链接点开是 410 */
  fileStatus?: string;
  mode: "preview" | "download";
  url: string;
  expiresAt: string;
  maxViews: number;
  viewCount: number;
  remainingViews: number;
  watermarkText: string;
  hasPassword: boolean;
  revokedAt: string;
  createdAt: string;
}

interface FileCenterAuditRow {
  id: number;
  fileId: string;
  /** 后端按 fileId 回填；文件已彻底删除时为空，前端回退显示 fileId */
  fileName?: string;
  userId: string;
  userName?: string;
  action: string;
  ip: string;
  at: string;
}

const fileCenterState = {
  tab: "active" as FileCenterTab,
  items: [] as FileCenterItem[],
  shares: [] as FileCenterShare[],
  audit: [] as FileCenterAuditRow[],
  auditTotal: 0,
  total: 0,
  page: 0,
  pageSize: 50,
  q: "",
  ownerId: "",
  orphans: false,
  deriveFailed: false,
  selected: new Set<string>(),
  loading: false,
  summary: null as null | { total: number; bytes: number; recycled: number; deriveFailed: number; orphanCount: number },
  disk: null as null | { total: number; free: number },
  derive: null as null | { pending: number; running: number; capabilities?: Record<string, string> }
};

function fcDate(iso: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).slice(2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fcRelative(iso: string) {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

function fcDeriveTag(item: FileCenterItem) {
  if (item.deriveStatus === "processing") return `<span class="fc-tag is-amber">转换中</span>`;
  // 只有「必需的派生件」失败才会把文件标成 failed（PDF 缩略图失败不算），
  // 所以这里就是「这个文件现在打不开」，文案不能再写「需转换」——它已经转过了、失败了
  if (item.deriveStatus === "failed") return `<span class="fc-tag is-rose" title="${escapeHtml(item.deriveError || "转换失败")}">转换失败</span>`;
  return "";
}

function fcStatusTag(item: FileCenterItem) {
  if (item.status === "recycled") return `<span class="fc-tag is-amber">回收站</span>`;
  if (item.legalHold) return `<span class="fc-tag is-rose">合规保留</span>`;
  // 被新版本取代的文件仍然是 active，但「在用」会让用户以为订单挂的是它
  if (item.isCurrent === false) return `<span class="fc-tag">历史版本</span>`;
  return `<span class="fc-tag is-green">在用</span>`;
}

function fileCenterSelectedIds() {
  return [...fileCenterState.selected];
}

export async function loadFileCenter() {
  const root = qs<HTMLElement>("#file-center");
  if (!root) return;
  if (fileCenterState.loading) return;
  fileCenterState.loading = true;
  try {
    if (fileCenterState.tab === "shares") {
      const data = await api<{ items: FileCenterShare[] }>("/api/shares");
      fileCenterState.shares = data.items || [];
    } else if (fileCenterState.tab === "audit") {
      const data = await api<{ total: number; items: FileCenterAuditRow[] }>("/api/files/audit?limit=100");
      fileCenterState.audit = data.items || [];
      fileCenterState.auditTotal = data.total || 0;
    } else {
      const params = new URLSearchParams({
        status: fileCenterState.tab,
        limit: String(fileCenterState.pageSize),
        offset: String(fileCenterState.page * fileCenterState.pageSize)
      });
      if (fileCenterState.q) params.set("q", fileCenterState.q);
      if (fileCenterState.ownerId) params.set("ownerId", fileCenterState.ownerId);
      if (fileCenterState.orphans) params.set("orphans", "1");
      if (fileCenterState.deriveFailed) params.set("deriveFailed", "1");
      const [list, dashboard] = await Promise.all([
        api<{ total: number; items: FileCenterItem[] }>(`/api/files?${params.toString()}`),
        api<{ summary: typeof fileCenterState.summary; disk: typeof fileCenterState.disk; derive: typeof fileCenterState.derive }>("/api/storage/dashboard")
      ]);
      fileCenterState.items = list.items || [];
      fileCenterState.total = list.total || 0;
      fileCenterState.summary = dashboard.summary;
      fileCenterState.disk = dashboard.disk;
      fileCenterState.derive = dashboard.derive;
      // 选择集只保留当前页仍存在的 id，否则翻页后「已选 3 个」会删到看不见的文件
      const alive = new Set(fileCenterState.items.map((item) => item.id));
      fileCenterState.selected = new Set([...fileCenterState.selected].filter((id) => alive.has(id)));
    }
    renderFileCenter();
  } catch (error) {
    toast(error instanceof Error ? error.message : "文件中心加载失败", "error");
  } finally {
    fileCenterState.loading = false;
  }
}

function renderFileCenter() {
  const metrics = qs<HTMLElement>("#fcMetrics");
  if (metrics) {
    const summary = fileCenterState.summary;
    const disk = fileCenterState.disk;
    const diskText = disk ? `可用 ${ordFileSize(disk.free)} / 共 ${ordFileSize(disk.total)}` : "磁盘信息不可用";
    metrics.innerHTML = `
      <div class="fc-metric"><span>文件总数</span><b>${summary ? summary.total : "—"}</b><small>在用 ${summary ? Math.max(0, summary.total - summary.recycled) : "—"} · 回收站 ${summary ? summary.recycled : "—"}</small></div>
      <div class="fc-metric"><span>回收站</span><b>${summary ? summary.recycled : "—"}</b><small>可在回收站恢复</small></div>
      <div class="fc-metric${summary && summary.deriveFailed > 0 ? " is-alert is-clickable" : ""}" ${summary && summary.deriveFailed > 0 ? "data-fc-metric-failed=\"1\" title=\"点击只看转换失败的文件\"" : ""}><span>转换失败</span><b>${summary ? summary.deriveFailed : "—"}</b><small>失败仍可下载原件</small></div>
      <div class="fc-metric"><span>磁盘</span><b>${disk ? Math.round((disk.free / Math.max(1, disk.total)) * 100) + "%" : "—"}</b><small>${diskText}</small></div>`;
  }

  qsa<HTMLElement>("#fcTabs button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.fcTab === fileCenterState.tab);
  });
  const tools = qs<HTMLElement>("#fcTools");
  if (tools) tools.hidden = fileCenterState.tab === "shares" || fileCenterState.tab === "audit";
  const bulk = qs<HTMLElement>("#fcBulkBar");
  const selectedCount = fileCenterState.selected.size;
  if (bulk) {
    bulk.hidden = selectedCount === 0 || fileCenterState.tab === "shares" || fileCenterState.tab === "audit";
    const counter = qs<HTMLElement>("#fcBulkCount");
    if (counter) counter.textContent = String(selectedCount);
    const recycleButton = qs<HTMLElement>("#fcBulkRecycle");
    const restoreButton = qs<HTMLElement>("#fcBulkRestore");
    const deleteButton = qs<HTMLElement>("#fcBulkDelete");
    if (recycleButton) recycleButton.hidden = fileCenterState.tab === "recycled";
    if (restoreButton) restoreButton.hidden = fileCenterState.tab !== "recycled";
    if (deleteButton) deleteButton.hidden = fileCenterState.tab !== "recycled";
  }
  const zipButton = qs<HTMLButtonElement>("#fcZipButton");
  if (zipButton) zipButton.disabled = selectedCount === 0;

  renderFileCenterBody();
  renderFileCenterPager();
}

function renderFileCenterBody() {
  const body = qs<HTMLElement>("#fcBody");
  if (!body) return;

  if (fileCenterState.tab === "shares") {
    if (!fileCenterState.shares.length) {
      body.innerHTML = `<div class="fc-empty">还没有对外分享过文件。在文件行点「分享」即可生成带水印的外链。</div>`;
      return;
    }
    body.innerHTML = `<table class="fc-table">
      <thead><tr><th></th><th>文件</th><th>模式</th><th>访问</th><th>有效期</th><th>状态</th><th>创建</th><th>操作</th></tr></thead>
      <tbody>${fileCenterState.shares.map((share) => {
        const expired = Boolean(share.expiresAt) && new Date(share.expiresAt).getTime() <= Date.now();
        const exhausted = share.maxViews > 0 && share.viewCount >= share.maxViews;
        // 顺序即优先级：已撤销 > 文件已删除 > 已过期 > 次数用尽 > 有效
        const state = share.revokedAt ? "已撤销"
          : share.fileStatus !== "active" ? "文件已删除"
          : expired ? "已过期"
          : exhausted ? "次数用尽" : "有效";
        const tone = state === "有效" ? "is-green" : state === "文件已删除" ? "is-rose" : "is-amber";
        return `<tr>
          <td></td>
          <td><div class="fc-name" title="${escapeHtml(share.fileName || share.fileId)}"><b>${escapeHtml(share.fileName || "（文件已删除）")}</b>${share.hasPassword ? `<span class="fc-tag">密码</span>` : ""}</div></td>
          <td>${share.mode === "download" ? "可下载" : "仅预览"}</td>
          <td>${share.viewCount}${share.maxViews > 0 ? ` / ${share.maxViews}` : ""}</td>
          <td>${share.expiresAt ? fcDate(share.expiresAt) : "长期"}</td>
          <td><span class="fc-tag ${tone}">${state}</span></td>
          <td>${fcDate(share.createdAt)}</td>
          <td><div class="fc-actions">
            <button type="button" data-fc-copy-share="${escapeHtml(share.url)}" ${state === "有效" ? "" : "disabled"}>复制链接</button>
            <button type="button" data-fc-open-share="${escapeHtml(share.url)}" ${state === "有效" ? "" : "disabled"}>打开</button>
            <button type="button" class="is-danger" data-fc-revoke-share="${escapeHtml(share.id)}" ${share.revokedAt ? "disabled" : ""}>撤销</button>
          </div></td>
        </tr>`;
      }).join("")}</tbody></table>`;
    return;
  }

  if (fileCenterState.tab === "audit") {
    if (!fileCenterState.audit.length) {
      body.innerHTML = `<div class="fc-empty">暂无访问记录，或当前账号不是管理员（审计日志仅管理员可查）。</div>`;
      return;
    }
    const labels: Record<string, string> = {
      preview: "预览", raw: "下载", share: "创建分享", share_view: "分享访问", share_download: "分享下载",
      unshare: "撤销分享", recycle: "移入回收站", restore: "恢复", purge: "彻底删除",
      version: "上传版本", promote: "切换版本", zip: "打包下载", merge: "合并", hold: "设置保留", unhold: "解除保留"
    };
    body.innerHTML = `<table class="fc-table fc-audit">
      <thead><tr><th></th><th>时间</th><th>操作人</th><th>动作</th><th>文件</th><th>IP</th></tr></thead>
      <tbody>${fileCenterState.audit.map((row) => `<tr>
        <td></td>
        <td title="${escapeHtml(row.at)}">${fcDate(row.at)} ${fcRelative(row.at)}</td>
        <td>${escapeHtml(row.userName || (row.userId ? row.userId : "外部访客"))}</td>
        <td>${escapeHtml(labels[row.action] || row.action)}</td>
        <td title="${escapeHtml(row.fileName || row.fileId || "")}">${escapeHtml(row.fileName || row.fileId || "—")}</td>
        <td>${escapeHtml(row.ip || "—")}</td>
      </tr>`).join("")}</tbody></table>`;
    return;
  }

  if (!fileCenterState.items.length) {
    body.innerHTML = `<div class="fc-empty">${fileCenterState.tab === "recycled" ? "回收站是空的。" : "还没有上传过文件。订单详情的「相关文件」里可以上传。"}</div>`;
    return;
  }

  body.innerHTML = `<table class="fc-table">
    <thead><tr>
      <th><input type="checkbox" id="fcPickAll" /></th>
      <th>文件</th><th>归属</th><th>关联</th><th>大小</th><th>状态</th><th>上传</th><th>操作</th>
    </tr></thead>
    <tbody>${fileCenterState.items.map((item) => {
      const checked = fileCenterState.selected.has(item.id);
      const canShare = item.status === "active";
      const actionButtons = item.status === "recycled"
        ? `<button type="button" data-fc-restore="${item.id}">恢复</button>
           <button type="button" class="is-danger" data-fc-delete="${item.id}">彻底删除</button>`
        : `<button type="button" data-fc-preview="${item.id}" ${item.previewable ? "" : `disabled title="该格式不支持在线预览，可下载后查看"`}>预览</button>
           <button type="button" data-fc-download="${item.id}">下载</button>
           <button type="button" data-fc-share="${item.id}" ${canShare ? "" : "disabled"}>分享</button>
           <button type="button" data-fc-versions="${item.id}">版本</button>
           <button type="button" class="is-danger" data-fc-recycle="${item.id}" ${item.legalHold ? `disabled title="合规保留期内不能删除"` : ""}>移入回收站</button>`;
      return `<tr>
        <td><input type="checkbox" data-fc-pick="${item.id}" ${checked ? "checked" : ""} /></td>
        <td><div class="fc-name"><b title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</b>${fcDeriveTag(item)}</div></td>
        <td>${escapeHtml(item.ownerName || "—")}</td>
        <td>${item.referenceCount ? `${item.referenceCount} 处` : `<span class="fc-row-share">无关联</span>`}</td>
        <td>${ordFileSize(item.size)}</td>
        <td>${fcStatusTag(item)}</td>
        <td title="${escapeHtml(item.createdAt)}">${fcDate(item.createdAt)}</td>
        <td><div class="fc-actions">${actionButtons}</div></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

function renderFileCenterPager() {
  const pager = qs<HTMLElement>("#fcPager");
  if (!pager) return;
  const show = fileCenterState.tab === "active" || fileCenterState.tab === "recycled";
  pager.hidden = !show;
  if (!show) return;
  const pages = Math.max(1, Math.ceil(fileCenterState.total / fileCenterState.pageSize));
  const text = qs<HTMLElement>("#fcPagerText");
  if (text) text.textContent = `共 ${fileCenterState.total} 个 · 第 ${fileCenterState.page + 1}/${pages} 页`;
  const prev = qs<HTMLButtonElement>("#fcPrevPage");
  const next = qs<HTMLButtonElement>("#fcNextPage");
  if (prev) prev.disabled = fileCenterState.page <= 0;
  if (next) next.disabled = fileCenterState.page + 1 >= pages;
}

export function bindFileCenterEvents() {
  const root = qs<HTMLElement>("#file-center");
  if (!root) return;
  // 用事件委托：列表每次都整块重画，逐个 addEventListener 会在第二次渲染后全部失效
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-fc-tab]");
    if (tab?.dataset.fcTab) {
      fileCenterState.tab = tab.dataset.fcTab as FileCenterTab;
      fileCenterState.page = 0;
      fileCenterState.selected.clear();
      void loadFileCenter();
      return;
    }
    const pick = target.closest<HTMLInputElement>("[data-fc-pick]");
    if (pick?.dataset.fcPick) {
      if (pick.checked) fileCenterState.selected.add(pick.dataset.fcPick);
      else fileCenterState.selected.delete(pick.dataset.fcPick);
      renderFileCenter();
      return;
    }
    // dataset 的键从 kebab 属性名推导（data-fc-open-share → fcOpenShare），
    // 这里逐个写明：用正则拼 dataset 键会在大小写上出错，且出错时是静默的（点了没反应）
    const preview = target.closest<HTMLElement>("[data-fc-preview]")?.dataset.fcPreview;
    if (preview) return void ordPreviewFile(preview);
    const download = target.closest<HTMLElement>("[data-fc-download]")?.dataset.fcDownload;
    if (download) return ordDownloadFile(download);
    const share = target.closest<HTMLElement>("[data-fc-share]")?.dataset.fcShare;
    if (share) return void openFileShareModal(share);
    const versions = target.closest<HTMLElement>("[data-fc-versions]")?.dataset.fcVersions;
    if (versions) return void openFileVersionsModal(versions);
    const recycle = target.closest<HTMLElement>("[data-fc-recycle]")?.dataset.fcRecycle;
    if (recycle) return void batchFileAction("recycle", [recycle], "移入回收站");
    const restore = target.closest<HTMLElement>("[data-fc-restore]")?.dataset.fcRestore;
    if (restore) return void batchFileAction("restore", [restore], "恢复");
    const purge = target.closest<HTMLElement>("[data-fc-delete]")?.dataset.fcDelete;
    if (purge) return void batchFileAction("delete", [purge], "彻底删除");
    const revoke = target.closest<HTMLElement>("[data-fc-revoke-share]")?.dataset.fcRevokeShare;
    if (revoke) return void revokeFileShare(revoke);
    const copyUrl = target.closest<HTMLElement>("[data-fc-copy-share]")?.dataset.fcCopyShare;
    if (copyUrl) {
      void navigator.clipboard?.writeText(copyUrl).then(() => toast("链接已复制"), () => toast("复制失败，请手动选中", "error"));
      return;
    }
    const openUrl = target.closest<HTMLElement>("[data-fc-open-share]")?.dataset.fcOpenShare;
    if (openUrl) return void window.open(openUrl, "_blank", "noopener");
    if (target.closest("#fcPickAll")) {
      const all = qs<HTMLInputElement>("#fcPickAll");
      if (all?.checked) fileCenterState.items.forEach((item) => fileCenterState.selected.add(item.id));
      else fileCenterState.selected.clear();
      renderFileCenter();
      return;
    }
    if (target.closest("#fcBulkClear")) {
      fileCenterState.selected.clear();
      renderFileCenter();
      return;
    }
    if (target.closest("#fcBulkRecycle")) return void batchFileAction("recycle", fileCenterSelectedIds(), "移入回收站");
    if (target.closest("#fcBulkRestore")) return void batchFileAction("restore", fileCenterSelectedIds(), "恢复");
    if (target.closest("#fcBulkDelete")) return void batchFileAction("delete", fileCenterSelectedIds(), "彻底删除");
    if (target.closest("#fcPrevPage")) {
      fileCenterState.page = Math.max(0, fileCenterState.page - 1);
      return void loadFileCenter();
    }
    if (target.closest("#fcNextPage")) {
      fileCenterState.page += 1;
      return void loadFileCenter();
    }
    if (target.closest("#fcZipButton")) return void zipSelectedFiles();
    if (target.closest("#fcRefreshButton")) return void loadFileCenter();
    if (target.closest("#fcVerifyButton")) return void runStorageVerify();
    if (target.closest("#fcStorageButton")) return void openStorageSettingsModal();
  });

  let searchTimer = 0;
  qs<HTMLInputElement>("#fcSearchInput")?.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value.trim();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      fileCenterState.q = value;
      fileCenterState.page = 0;
      void loadFileCenter();
    }, 300);
  });
  qs<HTMLSelectElement>("#fcOwnerSelect")?.addEventListener("change", (event) => {
    fileCenterState.ownerId = (event.target as HTMLSelectElement).value;
    fileCenterState.page = 0;
    void loadFileCenter();
  });
  qs<HTMLInputElement>("#fcOrphanOnly")?.addEventListener("change", (event) => {
    fileCenterState.orphans = (event.target as HTMLInputElement).checked;
    fileCenterState.page = 0;
    void loadFileCenter();
  });
  qs<HTMLInputElement>("#fcDeriveFailedOnly")?.addEventListener("change", (event) => {
    fileCenterState.deriveFailed = (event.target as HTMLInputElement).checked;
    fileCenterState.page = 0;
    void loadFileCenter();
  });

  // 文件中心自身上传：不绑定订单，落到默认空间；8MB 以上走分片，断网可续。
  // kind 固定 other——归属哪个订单是后续「关联」动作，不该在上传时强绑。
  const uploadOne = async (file: File, onProgress: (percent: number) => void) => {
    const csrf = cookieValue("gj_csrf");
    const base: Record<string, string> = csrf ? { "x-csrf-token": csrf } : {};
    const token = crypto.randomUUID();
    if (file.size <= 8 * 1024 * 1024) {
      onProgress(5);
      const res = await fetch("/api/files?kind=other", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...base,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-type": file.type || "application/octet-stream",
          "x-client-token": token
        },
        body: file
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { message?: string });
        throw new Error(body.message || `上传失败（HTTP ${res.status}）`);
      }
      onProgress(100);
      return;
    }
    onProgress(1);
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const startRes = await fetch("/api/files/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: { ...base, "content-type": "application/json" },
      body: JSON.stringify({ fileName: file.name, size: file.size, sha256, clientToken: token, kind: "other" })
    });
    const started = (await startRes.json().catch(() => ({}))) as {
      message?: string;
      file?: unknown;
      session?: { id: string; chunkSize: number; totalChunks: number; received?: number[] };
    };
    if (!startRes.ok) throw new Error(started.message || `创建上传会话失败（HTTP ${startRes.status}）`);
    if (started.file) {
      onProgress(100);
      return;
    }
    const session = started.session;
    if (!session) throw new Error("上传会话无效，请重试");
    const received = new Set(session.received || []);
    for (let index = 0; index < session.totalChunks; index += 1) {
      if (received.has(index)) continue;
      const begin = index * session.chunkSize;
      const chunk = file.slice(begin, Math.min(file.size, begin + session.chunkSize));
      const res = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/chunks/${index}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { ...base, "content-type": "application/octet-stream" },
        body: chunk
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { message?: string });
        throw new Error(body.message || `第 ${index + 1} 片上传失败`);
      }
      onProgress(Math.round(((index + 1) / session.totalChunks) * 100));
    }
    const doneRes = await fetch(`/api/files/uploads/${encodeURIComponent(session.id)}/complete`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...base, "content-type": "application/json" },
      body: "{}"
    });
    if (!doneRes.ok) {
      const body = await doneRes.json().catch(() => ({}) as { message?: string });
      throw new Error(body.message || `拼装失败（HTTP ${doneRes.status}）`);
    }
    onProgress(100);
  };

  qs<HTMLButtonElement>("#fcUploadButton")?.addEventListener("click", () => {
    qs<HTMLInputElement>("#fcUploadInput")?.click();
  });
  qs<HTMLInputElement>("#fcUploadInput")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    // 清空 input：同一个文件再选一次仍能触发 change
    input.value = "";
    if (!files.length) return;
    void (async () => {
      const button = qs<HTMLButtonElement>("#fcUploadButton");
      const usable = files.filter((file) => file.size <= 100 * 1024 * 1024);
      const skipped = files.length - usable.length;
      if (!usable.length) {
        toast("单个文件不能超过 100MB", "error");
        return;
      }
      if (button) {
        button.disabled = true;
        button.textContent = `上传中 0/${usable.length}…`;
      }
      let ok = 0;
      const errors: string[] = [];
      for (const [index, file] of usable.entries()) {
        try {
          await uploadOne(file, (percent) => {
            // 进度写回按钮本身：上传是个长动作，没有反馈用户会连点
            if (button) button.textContent = `上传中 ${index + 1}/${usable.length} · ${percent}%`;
          });
          ok += 1;
        } catch (error) {
          errors.push(`${file.name}：${error instanceof Error ? error.message : "上传失败"}`);
        }
      }
      if (button) {
        button.disabled = false;
        button.textContent = "上传文件";
      }
      fileCenterState.page = 0;
      await loadFileCenter();
      if (errors.length) toast(`成功 ${ok} 个，失败 ${errors.length} 个。${errors[0]}`, "error");
      else toast(`已上传 ${ok} 个文件${skipped ? `，${skipped} 个超过 100MB 已跳过` : ""}`);
    })();
  });
  // 指标卡「转换失败」直接跳到筛选结果：只给数字不给入口，用户不知道该看哪几个文件
  qs<HTMLElement>("#fcMetrics")?.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest("[data-fc-metric-failed]")) return;
    fileCenterState.deriveFailed = true;
    fileCenterState.page = 0;
    if (fileCenterState.tab !== "active") fileCenterState.tab = "active";
    const checkbox = qs<HTMLInputElement>("#fcDeriveFailedOnly");
    if (checkbox) checkbox.checked = true;
    void loadFileCenter();
  });
}

async function batchFileAction(action: "recycle" | "restore" | "delete", ids: string[], label: string) {
  if (!ids.length) return;
  const confirmed = await confirmAction({
    title: `${label} ${ids.length} 个文件`,
    message: action === "delete"
      ? "彻底删除无法恢复，且只对已在回收站、没有任何引用的文件生效。"
      : action === "recycle"
        ? "文件会进入回收站，30 天内可以恢复；处于合规保留期的文件不会被处理。"
        : "文件会回到原来的位置。",
    confirmLabel: label
  });
  if (!confirmed) return;
  try {
    const result = await api<{ okCount: number; failCount: number; results?: Array<{ message: string }> }>("/api/files/batch", {
      method: "POST",
      body: JSON.stringify({ action, ids: ids.slice(0, 50) })
    });
    if (result.failCount > 0) {
      const first = result.results?.find((item) => item.message)?.message || "部分文件未处理";
      toast(`${label}：成功 ${result.okCount} 个，失败 ${result.failCount} 个（${first}）`, "error");
    } else {
      toast(`已${label} ${result.okCount} 个文件`);
    }
    fileCenterState.selected.clear();
    await loadFileCenter();
  } catch (error) {
    toast(error instanceof Error ? error.message : `${label}失败`, "error");
  }
}

async function revokeFileShare(shareId: string) {
  const confirmed = await confirmAction({ title: "撤销分享链接", message: "撤销后外部访问立刻失效，且不能恢复。", confirmLabel: "撤销" });
  if (!confirmed) return;
  try {
    await api(`/api/share-links/${encodeURIComponent(shareId)}`, { method: "DELETE" });
    toast("分享链接已撤销");
    await loadFileCenter();
  } catch (error) {
    toast(error instanceof Error ? error.message : "撤销失败", "error");
  }
}

function zipSelectedFiles() {
  const ids = fileCenterSelectedIds();
  if (!ids.length) return;
  // 打包要经过 POST + 权限逐条判定，不能直接用 <a>：先发请求再触发下载
  void (async () => {
    try {
      const csrfToken = cookieValue("gj_csrf");
      const response = await fetch("/api/files/zip", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        body: JSON.stringify({ ids: ids.slice(0, 50) })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "打包失败" }));
        throw new Error(body.message || `打包失败（HTTP ${response.status}）`);
      }
      const skipped = Number(response.headers.get("x-skipped-count") || 0);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `GoodJob-文件包-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(skipped ? `已打包 ${ids.length - skipped} 个，${skipped} 个无权访问已跳过` : `已打包 ${ids.length} 个文件`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "打包失败", "error");
    }
  })();
}

async function runStorageVerify() {
  try {
    const result = await api<{ checked: number; problems: Array<{ name: string; problem: string }>; ok: boolean }>("/api/storage/verify", {
      method: "POST",
      body: JSON.stringify({ limit: 50 })
    });
    if (result.ok) {
      toast(`已巡检 ${result.checked} 个文件，未发现异常`);
      return;
    }
    openModal(
      "完整性巡检发现问题",
      `<p>已巡检 ${result.checked} 个文件，发现 ${result.problems.length} 个异常：</p>
       <ul style="margin:10px 0 0 18px;font-size:13px;line-height:1.8">
         ${result.problems.slice(0, 30).map((item) => `<li><b>${escapeHtml(item.name)}</b>：${escapeHtml(item.problem)}</li>`).join("")}
       </ul>`,
      `<button type="button" class="btn primary" data-modal-close>知道了</button>`
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : "巡检失败", "error");
  }
}

async function openStorageSettingsModal() {
  try {
    const dashboard = await api<{
      root: string;
      autoPurgeEnabled: boolean;
      summary: { total: number; bytes: number };
      disk: { total: number; free: number } | null;
      derive?: {
        pending: number;
        running: number;
        capabilities?: {
          platform?: string;
          libreoffice: string;
          sips: string;
          magick?: string;
          qlmanage: string;
          pdftoppm: string;
        };
      };
    }>("/api/storage/dashboard");
    // 预览能力必须可见：否则 Office/HEIC 转换全失败时，用户只看到「转换失败」，
    // 不知道是文件坏了还是服务器缺组件。
    const caps = dashboard.derive?.capabilities;
    // 安装指引必须跟着**服务器**的平台走，不能一律给 macOS 的 brew：
    // 项目要开源，Windows / Linux 部署同样是正当用法，给错命令比不给更浪费时间。
    const platform = caps?.platform || "darwin";
    const platformName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
    const installHints = platform === "win32"
      ? {
        office: "winget install TheDocumentFoundation.LibreOffice（或 deploy\\install-libreoffice.ps1）",
        heic: "winget install ImageMagick.ImageMagick",
        pdf: "winget install oschwartz10612.Poppler"
      }
      : platform === "linux"
        ? {
          office: "apt install libreoffice-writer libreoffice-impress libreoffice-calc",
          heic: "apt install imagemagick",
          pdf: "apt install poppler-utils"
        }
        : {
          office: "brew install --cask libreoffice",
          heic: "macOS 自带 sips",
          pdf: "brew install poppler"
        };
    const capRow = (label: string, ready: boolean, install: string) => `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:3px 0">
        <span style="color:#41536b">${label}</span>
        <span style="font-size:12px;color:${ready ? "var(--green)" : "var(--amber)"}">
          ${ready ? "可用" : `缺少组件${install ? ` · <span style="color:#94a3b6">${escapeHtml(install)}</span>` : ""}`}
        </span>
      </div>`;
    const capabilityBlock = caps
      ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <div style="font-size:12px;font-weight:600;color:#41536b;margin-bottom:6px">在线预览能力 <span style="font-weight:400;color:#94a3b6">· 服务器 ${platformName}</span></div>
          ${capRow("Office / WPS 文档", Boolean(caps.libreoffice), installHints.office)}
          ${capRow("HEIC 照片", Boolean(caps.sips || caps.magick), installHints.heic)}
          ${capRow("PDF 缩略图", Boolean(caps.qlmanage || caps.pdftoppm || caps.magick), installHints.pdf)}
          <div style="margin-top:8px;font-size:11.5px;color:#94a3b6">
            转换队列：${dashboard.derive?.running || 0} 个进行中、${dashboard.derive?.pending || 0} 个排队。
            装完组件要重启后端才生效。缺 PDF 缩略图不影响正文预览，只是列表里没有小图。
          </div>
        </div>`
      : "";
    openModal(
      "存储设置",
      `<div style="font-size:13px;line-height:1.9">
        <div><span style="color:#6b7d94">存储根目录</span><div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all">${escapeHtml(dashboard.root)}</div></div>
        <div style="margin-top:10px"><span style="color:#6b7d94">已用容量</span> ${ordFileSize(dashboard.summary.bytes)} / ${dashboard.summary.total} 个文件</div>
        <div style="margin-top:6px"><span style="color:#6b7d94">磁盘</span> ${dashboard.disk ? `可用 ${ordFileSize(dashboard.disk.free)}（共 ${ordFileSize(dashboard.disk.total)}）` : "不可用"}</div>
        ${capabilityBlock}
        <div style="margin-top:14px;color:#94a3b6;font-size:12px">改根目录属于运维操作，需要在服务器上改 GOODJOB_FILE_ROOT 并重启后端；界面只读展示，避免一次误点让全公司文件全部失效。</div>
      </div>`,
      `<button type="button" class="btn primary" data-modal-close>关闭</button>`,
      { description: "以下为只读信息；预览能力显示「缺少组件」时，按提示装好并重启后端。" }
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : "读取存储设置失败", "error");
  }
}

export async function openFileShareModal(fileId: string) {
  const defaultWatermark = `GoodJob · ${new Date().toISOString().slice(0, 10)}`;
  openModal(
    "分享文件",
    `<div class="form-field"><label>查看方式</label>
      <select id="fcShareMode">
        <option value="preview">仅预览（带水印，不给原件）</option>
        <option value="download">允许下载（PDF 会烧入水印）</option>
      </select>
    </div>
    <div class="form-field"><label>有效期</label>
      <select id="fcShareExpiry">
        <option value="24">1 天</option>
        <option value="168" selected>7 天</option>
        <option value="720">30 天</option>
        <option value="0">长期有效</option>
      </select>
    </div>
    <div class="form-field"><label>最多查看次数（0 = 不限）</label>
      <input id="fcShareMaxViews" type="number" min="0" max="10000" value="0" />
    </div>
    <div class="form-field"><label>访问密码（可留空）</label>
      <input id="fcSharePassword" type="text" maxlength="64" placeholder="留空则拿到链接即可查看" />
    </div>
    <div class="form-field"><label>水印文字</label>
      <input id="fcShareWatermark" type="text" maxlength="120" value="${escapeHtml(defaultWatermark)}" />
    </div>
    <div id="fcShareResult" hidden>
      <div class="form-field"><label>分享链接</label>
        <div class="fc-share-url"><input id="fcShareUrl" readonly /><button type="button" class="btn" id="fcShareCopy">复制</button></div>
      </div>
      <div style="font-size:12px;color:#94a3b6;line-height:1.7">链接一旦生成即可被外部访问。撤销后立即失效，已发出去的链接不会被收回。</div>
    </div>`,
    `<button type="button" class="btn" data-modal-close>关闭</button>
     <button type="button" class="btn primary" id="fcShareCreate">生成链接</button>`
  );
  const createButton = qs<HTMLButtonElement>("#fcShareCreate");
  createButton?.addEventListener("click", async () => {
    if (createButton.disabled) return;
    createButton.disabled = true;
    createButton.textContent = "生成中…";
    try {
      const hours = Number(qs<HTMLSelectElement>("#fcShareExpiry")?.value || "168");
      const payload = {
        mode: qs<HTMLSelectElement>("#fcShareMode")?.value || "preview",
        expiresInHours: hours > 0 ? hours : undefined,
        maxViews: Number(qs<HTMLInputElement>("#fcShareMaxViews")?.value || "0") || 0,
        password: qs<HTMLInputElement>("#fcSharePassword")?.value.trim() || "",
        watermarkText: qs<HTMLInputElement>("#fcShareWatermark")?.value.trim() || ""
      };
      const result = await api<{ share: FileCenterShare }>(`/api/files/${encodeURIComponent(fileId)}/shares`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const urlInput = qs<HTMLInputElement>("#fcShareUrl");
      if (urlInput) urlInput.value = result.share.url;
      const box = qs<HTMLElement>("#fcShareResult");
      if (box) box.hidden = false;
      createButton.textContent = "再生成一条";
      toast("分享链接已生成");
      if (fileCenterState.tab === "shares") void loadFileCenter();
    } catch (error) {
      toast(error instanceof Error ? error.message : "生成分享链接失败", "error");
      createButton.textContent = "生成链接";
    } finally {
      createButton.disabled = false;
    }
  });
  qs<HTMLButtonElement>("#fcShareCopy")?.addEventListener("click", () => {
    const url = qs<HTMLInputElement>("#fcShareUrl")?.value || "";
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => toast("链接已复制"), () => toast("复制失败，请手动选中", "error"));
  });
}

export async function openFileVersionsModal(fileId: string) {
  openModal(
    "文件版本",
    `<div id="fcVersionList"><div class="fc-empty">正在加载…</div></div>
     <div style="margin-top:14px;border-top:1px solid var(--line-soft);padding-top:12px">
       <label class="btn" for="fcVersionInput" style="display:inline-flex;align-items:center;cursor:pointer">上传新版本</label>
       <input id="fcVersionInput" type="file" style="display:none" />
       <div style="font-size:12px;color:#94a3b6;margin-top:8px;line-height:1.7">新版本会成为当前版本，但不会自动替换已关联订单里的旧版本 —— 需要让订单改用新版时，在这里点「设为当前」。</div>
     </div>`,
    `<button type="button" class="btn primary" data-modal-close>关闭</button>`
  );

  const paint = async () => {
    const host = qs<HTMLElement>("#fcVersionList");
    if (!host) return;
    try {
      const data = await api<{ currentId: string; items: Array<{ id: string; name: string; size: number; createdAt: string; isCurrent: boolean; status: string }> }>(
        `/api/files/${encodeURIComponent(fileId)}/versions`
      );
      host.innerHTML = data.items.map((item, index) => `<div class="od-file-row" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-soft)">
        <span class="fc-tag${item.isCurrent ? " is-green" : ""}">${item.isCurrent ? "当前" : `v${data.items.length - index}`}</span>
        <span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.name)}</span>
        <span style="font-size:12px;color:#94a3b6;white-space:nowrap">${ordFileSize(item.size)} · ${fcDate(item.createdAt)}</span>
        <button type="button" class="btn" data-fc-version-preview="${item.id}">预览</button>
        ${item.isCurrent ? "" : `<button type="button" class="btn" data-fc-version-promote="${item.id}">设为当前</button>`}
      </div>`).join("");
      qsa<HTMLElement>("[data-fc-version-preview]").forEach((button) => {
        button.addEventListener("click", () => ordPreviewFile(button.dataset.fcVersionPreview || ""));
      });
      qsa<HTMLElement>("[data-fc-version-promote]").forEach((button) => {
        button.addEventListener("click", async () => {
          const target = button.dataset.fcVersionPromote || "";
          const confirmed = await confirmAction({
            title: "设为当前版本",
            message: "同组的其它版本会变成历史版本。是否同时让已关联的订单等业务改用这一版？",
            confirmLabel: "设为当前并迁移引用"
          });
          if (!confirmed) return;
          try {
            await api(`/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(target)}/promote`, {
              method: "POST",
              body: JSON.stringify({ migrateReferences: true })
            });
            toast("已切换当前版本");
            await paint();
            void loadFileCenter();
          } catch (error) {
            toast(error instanceof Error ? error.message : "切换失败", "error");
          }
        });
      });
    } catch (error) {
      host.innerHTML = `<div class="fc-empty">${escapeHtml(error instanceof Error ? error.message : "版本加载失败")}</div>`;
    }
  };
  void paint();

  qs<HTMLInputElement>("#fcVersionInput")?.addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const csrfToken = cookieValue("gj_csrf");
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/versions`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
        },
        body: file
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "上传失败" }));
        throw new Error(body.message || `上传失败（HTTP ${response.status}）`);
      }
      toast("新版本已上传");
      await paint();
      void loadFileCenter();
    } catch (error) {
      toast(error instanceof Error ? error.message : "上传新版本失败", "error");
    } finally {
      input.value = "";
    }
  });
}

export async function ordUnlinkFile(orderId: string, fileId: string) {  const confirmed = await confirmAction({
    title: "移除文件关联",
    message: "只解除订单与这份资料的关联，不会删除文件中心里的原文件。",
    confirmLabel: "移除关联"
  });
  if (!confirmed) return;
  try {
    await api(`/api/orders/${orderId}/files/${fileId}`, { method: "DELETE", body: "{}" });
    toast("已移除关联");
    void openOrderDetail(orderId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "移除失败", "error");
  }
}

export async function ordAddNote(orderId: string) {
  const input = qs<HTMLInputElement>("#ordNoteInput");
  const content = input?.value.trim() || "";
  if (!content) return;
  try {
    await api(`/api/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ content }) });
    if (input) input.value = "";
    toast("已记录");
    void openOrderDetail(orderId);
  } catch (error) {
    toast(error instanceof Error ? error.message : "记录失败", "error");
  }
}

export async function ordBackfill() {
  try {
    const preview = await api<{ dryRun: boolean; total: number; preview: Array<{ title: string; customerName: string }> }>(
      "/api/orders/backfill",
      { method: "POST", body: JSON.stringify({ dryRun: true }) }
    );
    if (!preview.total) {
      toast("没有需要补建的成交商机");
      return;
    }
    const confirmed = await confirmAction({
      title: "补建历史订单",
      message: `有 ${preview.total} 笔已成交商机还没有订单，将按成交时间顺序补建。`,
      consequences: ["补建单标记为「历史补建」，不改商机阶段", "不写客户跟进记录，不影响业绩考核", "补建后仍可正常推进与挂文件"],
      detail: preview.preview.slice(0, 6).map((item) => `${item.customerName} · ${item.title}`).join("；"),
      confirmLabel: `补建 ${preview.total} 张`
    });
    if (!confirmed) return;
    const result = await api<{ created: number; skipped: number }>("/api/orders/backfill", {
      method: "POST",
      body: JSON.stringify({ dryRun: false })
    });
    toast(`已补建 ${result.created} 张订单${result.skipped ? `，跳过 ${result.skipped} 张` : ""}`);
    void loadOrders();
  } catch (error) {
    toast(error instanceof Error ? error.message : "补建失败", "error");
  }
}
