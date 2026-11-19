/**
 * 资料库。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type KnowledgeAsset } from "./models";
import { ownerName, renderDashboardKnowledgePanels } from "./dashboard";
import { escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { formatDateTime } from "./deals";
import { knowledgeAssetIcon, knowledgeAssetTypeText, knowledgeFilteredAssets, knowledgeSourceText, knowledgeStatusText } from "./wecom";
import { ORD_STATUS_META, type OrdStatus, openOrderDetail, ordIdentity } from "./orders";

let editingKnowledgeAssetId: string | null = null;

export function renderKnowledge(assets: KnowledgeAsset[] = state.knowledgeAssets) {
  const all = assets;
  const filtered = knowledgeFilteredAssets(all);
  if (!state.selectedKnowledgeAssetId && filtered[0]) state.selectedKnowledgeAssetId = filtered[0].id;
  const metrics = qsa<HTMLElement>("#knowledgeMetrics b");
  if (metrics[0]) metrics[0].textContent = String(all.length);
  if (metrics[1]) metrics[1].textContent = String(all.filter((item) => item.status === "published").length);
  if (metrics[2]) metrics[2].textContent = String(all.filter((item) => item.sourceType === "baidu_share").length);
  if (metrics[3]) metrics[3].textContent = String(all.reduce((sum, item) => sum + (item.accessCount || 0), 0));

  const categories = new Map<string, number>();
  all.forEach((asset) => categories.set(asset.category || "未分类", (categories.get(asset.category || "未分类") || 0) + 1));
  const categoryList = qs<HTMLElement>("#knowledgeCategoryList");
  if (categoryList) {
    const categoryRows = [["all", "全部资料", all.length], ...[...categories.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")).map(([category, count]) => [category, category, count] as [string, string, number])];
    categoryList.innerHTML = categoryRows.map(([value, label, count]) => `<button type="button" class="${state.knowledgeCategoryFilter === value ? "active" : ""}" data-knowledge-category="${escapeHtml(value)}"><span>${escapeHtml(label)}</span><b>${count}</b></button>`).join("");
    qsa<HTMLButtonElement>("[data-knowledge-category]", categoryList).forEach((button) => button.addEventListener("click", () => {
      state.knowledgeCategoryFilter = button.dataset.knowledgeCategory || "all";
      renderKnowledge();
    }));
  }
  const categoryCount = qs<HTMLElement>("#knowledgeCategoryCount");
  if (categoryCount) categoryCount.textContent = `${categories.size} 个`;

  const list = qs<HTMLElement>("#knowledgeFileList");
  if (list) {
    list.innerHTML = filtered.length ? filtered.map((asset) => `<div class="file-table-row ${state.selectedKnowledgeAssetId === asset.id ? "selected" : ""}" data-knowledge-asset-id="${escapeHtml(asset.id)}">
      <div class="file-table-primary"><i class="file-type-mark">${escapeHtml(knowledgeAssetIcon(asset))}</i><div><b>${escapeHtml(asset.title)}</b><span>${escapeHtml(asset.category || "未分类")} · ${escapeHtml(asset.version || "v1")} · ${escapeHtml(ownerName(asset.ownerId))}${asset.linkedOrderCount ? ` · 关联 ${asset.linkedOrderCount} 单` : ""}</span></div></div>
      <div class="file-table-cell"><b>${escapeHtml(knowledgeSourceText(asset.sourceType))}</b><span>${escapeHtml(knowledgeAssetTypeText(asset.fileType))}</span></div>
      <div class="file-table-cell"><span class="file-status ${asset.status === "published" ? "published" : ""}">${escapeHtml(knowledgeStatusText(asset.status))}</span></div>
      <div class="file-table-cell"><b>${asset.accessCount || 0}</b><span>次访问</span></div>
    </div>`).join("") : `<div class="file-center-empty">${all.length ? "没有符合筛选条件的资料" : "还没有资料，先添加一个 URL"}</div>`;
    qsa<HTMLElement>("[data-knowledge-asset-id]", list).forEach((row) => row.addEventListener("click", () => {
      state.selectedKnowledgeAssetId = row.dataset.knowledgeAssetId || null;
      renderKnowledge();
    }));
  }
  renderKnowledgeDetail(all.find((asset) => asset.id === state.selectedKnowledgeAssetId) || filtered[0] || null);
}

function renderKnowledgeDetail(asset: KnowledgeAsset | null) {
  const panel = qs<HTMLElement>("#knowledgeDetail");
  if (!panel) return;
  if (!asset) {
    panel.innerHTML = `<div class="file-detail-empty">选择一项资料查看详情</div>`;
    return;
  }
  const canManage = hasIamCapability("training.manage");
  panel.innerHTML = `<div class="file-detail-head"><div><span>${escapeHtml(knowledgeSourceText(asset.sourceType))} · ${escapeHtml(knowledgeAssetTypeText(asset.fileType))}</span><h2>${escapeHtml(asset.title)}</h2></div><span class="file-status ${asset.status === "published" ? "published" : ""}">${escapeHtml(knowledgeStatusText(asset.status))}</span></div>
    <p class="file-detail-description">${escapeHtml(asset.description || "暂无资料说明")}</p>
    <dl class="file-detail-facts"><div><dt>版本</dt><dd>${escapeHtml(asset.version || "v1")}</dd></div><div><dt>维护人</dt><dd>${escapeHtml(ownerName(asset.ownerId))}</dd></div><div><dt>访问次数</dt><dd>${asset.accessCount || 0}</dd></div><div><dt>最后更新</dt><dd>${escapeHtml(formatDateTime(asset.updatedAt || asset.createdAt || ""))}</dd></div>${asset.sourceType === "baidu_share" ? `<div><dt>提取码</dt><dd>${escapeHtml(asset.shareCode || "未设置")}</dd></div>` : ""}</dl>
    <div class="file-detail-tags">${(asset.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") || "<span>暂无标签</span>"}</div>
    <div class="file-detail-linked"><b>关联订单</b>${asset.linkedOrders?.length
      ? `<div class="file-linked-orders">${asset.linkedOrders.map((order) => `<button type="button" class="file-linked-order" data-knowledge-order="${escapeHtml(order.id)}"><b>${escapeHtml(ordIdentity(order).primary)}</b><span>${escapeHtml(ORD_STATUS_META[order.status as OrdStatus]?.label || order.status)}</span></button>`).join("")}</div>`
      : `<span class="file-linked-empty">还没有订单引用这份资料</span>`}</div>
    <div class="file-detail-actions"><button class="btn primary" id="openKnowledgeAssetButton" type="button">打开资料</button>${canManage || asset.ownerId === state.user?.id ? `<button class="btn" id="editKnowledgeAssetButton" type="button">编辑</button><button class="btn" id="publishKnowledgeAssetButton" type="button" ${asset.status === "published" ? "disabled" : ""}>${asset.status === "published" ? "已发布" : "发布资料"}</button><button class="btn danger" id="deleteKnowledgeAssetButton" type="button">删除</button>` : ""}</div>`;
  qsa<HTMLElement>("[data-knowledge-order]", panel).forEach((node) =>
    node.addEventListener("click", () => {
      const orderId = node.dataset.knowledgeOrder || "";
      if (orderId) void openOrderDetail(orderId);
    })
  );
  qs<HTMLButtonElement>("#openKnowledgeAssetButton")?.addEventListener("click", () => void openKnowledgeAsset(asset));
  qs<HTMLButtonElement>("#editKnowledgeAssetButton")?.addEventListener("click", () => openKnowledgeModal(asset.id));
  qs<HTMLButtonElement>("#publishKnowledgeAssetButton")?.addEventListener("click", () => void publishAsset(asset.id));
  qs<HTMLButtonElement>("#deleteKnowledgeAssetButton")?.addEventListener("click", () => void deleteKnowledgeAsset(asset.id));
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
    renderDashboardKnowledgePanels();
    toast("资料已发布");
  } catch (error) {
    toast(error instanceof Error ? error.message : "发布失败", "error");
  }
}

export function openKnowledgeModal(assetId?: string) {
  editingKnowledgeAssetId = assetId || null;
  const asset = assetId ? state.knowledgeAssets.find((item) => item.id === assetId) : undefined;
  openModal(asset ? "编辑资料" : "添加资料", `
    <div class="form-grid">
      <div class="form-field full"><label>资料标题</label><input id="assetTitleInput" value="${escapeHtml(asset?.title || "")}" placeholder="例如：LED 灯具参数手册"></div>
      <div class="form-field"><label>资料类目</label><input id="assetCategoryInput" value="${escapeHtml(asset?.category || "产品知识")}" placeholder="产品知识 / 认证资料"></div>
      <div class="form-field"><label>版本</label><input id="assetVersionInput" value="${escapeHtml(asset?.version || "v1")}"></div>
      <div class="form-field full"><label>资料 URL</label><input id="assetSourceUrlInput" value="${escapeHtml(asset?.sourceUrl || "")}" placeholder="https://pan.baidu.com/s/... 或其他 HTTPS 地址"><div class="file-source-note">只保存链接，不在服务器下载文件。百度网盘分享链接可填写提取码。</div></div>
      <div class="form-field"><label>百度提取码</label><input id="assetShareCodeInput" value="${escapeHtml(asset?.shareCode || "")}" maxlength="64" placeholder="百度链接可填写"></div>
      <div class="form-field"><label>文件格式</label><select id="assetFileTypeInput">${["pdf","word","excel","image","video","archive","link","other"].map((type) => `<option value="${type}" ${asset?.fileType === type ? "selected" : ""}>${knowledgeAssetTypeText(type)}</option>`).join("")}</select></div>
      <div class="form-field full"><label>资料说明</label><textarea id="assetDescriptionInput" rows="3" placeholder="说明适用产品、客户场景或版本变更">${escapeHtml(asset?.description || "")}</textarea></div>
      <div class="form-field full"><label>标签</label><input id="assetTagsInput" value="${escapeHtml((asset?.tags || []).join(","))}" placeholder="产品参数, CE, 报价"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveAssetButton">${asset ? "保存修改" : "保存资料"}</button>`);
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs("#saveAssetButton")?.addEventListener("click", () => void saveAsset());
}

async function saveAsset() {
  const title = qs<HTMLInputElement>("#assetTitleInput")?.value.trim() || "";
  const sourceUrl = qs<HTMLInputElement>("#assetSourceUrlInput")?.value.trim() || "";
  if (!title || !sourceUrl) {
    toast("资料标题和 URL 均为必填", "error");
    return;
  }
  try {
    const payload = { title, category: qs<HTMLInputElement>("#assetCategoryInput")?.value.trim() || "产品知识", version: qs<HTMLInputElement>("#assetVersionInput")?.value.trim() || "v1", sourceUrl, shareCode: qs<HTMLInputElement>("#assetShareCodeInput")?.value.trim() || "", fileType: qs<HTMLSelectElement>("#assetFileTypeInput")?.value || "other", description: qs<HTMLTextAreaElement>("#assetDescriptionInput")?.value.trim() || "", tags: (qs<HTMLInputElement>("#assetTagsInput")?.value || "").split(",").map((tag) => tag.trim()).filter(Boolean) };
    const result = await api<{ asset: KnowledgeAsset }>(editingKnowledgeAssetId ? `/api/knowledge/assets/${editingKnowledgeAssetId}` : "/api/knowledge/assets", { method: editingKnowledgeAssetId ? "PATCH" : "POST", body: JSON.stringify(payload) });
    if (editingKnowledgeAssetId) {
      const target = state.knowledgeAssets.find((item) => item.id === editingKnowledgeAssetId);
      if (target) Object.assign(target, result.asset);
    } else state.knowledgeAssets.unshift(result.asset);
    state.selectedKnowledgeAssetId = result.asset.id;
    renderKnowledge();
    renderDashboardKnowledgePanels();
    editingKnowledgeAssetId = null;
    closeModal();
    toast("资料已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "资料保存失败", "error");
  }
}

export async function openKnowledgeAsset(asset: KnowledgeAsset) {
  const popup = window.open("", "_blank");
  if (popup) popup.opener = null;
  try {
    const result = await api<{ asset: KnowledgeAsset; access: { url: string; sourceType: string; shareCode: string } }>(`/api/knowledge/assets/${asset.id}/access`, { method: "POST", body: "{}" });
    Object.assign(asset, result.asset);
    renderKnowledge();
    if (result.access.shareCode && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(result.access.shareCode).catch(() => undefined);
      toast("资料已打开，提取码已复制");
    } else toast("资料已打开");
    if (popup) popup.location.href = result.access.url;
    else window.open(result.access.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    popup?.close();
    toast(error instanceof Error ? error.message : "资料打开失败", "error");
  }
}

async function deleteKnowledgeAsset(id: string) {
  const asset = state.knowledgeAssets.find((item) => item.id === id);
  if (!asset || !await confirmAction({ title: "删除资料", message: `确定删除「${asset.title}」吗？`, consequences: ["只删除 CRM 中的资料记录", "不会删除百度网盘或外部网站上的原文件"], confirmLabel: "删除资料", tone: "danger" })) return;
  try {
    await api(`/api/knowledge/assets/${id}`, { method: "DELETE", body: "{}" });
    state.knowledgeAssets = state.knowledgeAssets.filter((item) => item.id !== id);
    state.selectedKnowledgeAssetId = null;
    renderKnowledge();
    renderDashboardKnowledgePanels();
    toast("资料记录已删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "资料删除失败", "error");
  }
}

export async function refreshKnowledgeAssets(showToast = false) {
  try {
    const result = await api<{ assets: KnowledgeAsset[] }>("/api/knowledge/assets");
    state.knowledgeAssets = result.assets;
    if (state.selectedKnowledgeAssetId && !result.assets.some((item) => item.id === state.selectedKnowledgeAssetId)) state.selectedKnowledgeAssetId = null;
    renderKnowledge();
    renderDashboardKnowledgePanels();
    if (showToast) toast("文件中心已刷新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "文件中心刷新失败", "error");
  }
}
