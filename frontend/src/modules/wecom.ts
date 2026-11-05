/**
 * 企业微信。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { state } from "../prototype-api";
import { type KnowledgeAsset, type WecomMessage } from "./models";
import { escapeHtml, qs, qsa } from "./shared";
import { api, toast } from "./ui";

export function renderWecom(messages: WecomMessage[]) {
  const chat = qs<HTMLElement>("#wecom .chat");
  if (chat) {
    chat.innerHTML = messages.length
      ? messages.map((message, index) => `<div class="bubble ${index % 2 ? "me" : ""}">${escapeHtml(message.summary)} ${message.status === "archived" ? "已归档" : "待归档"}</div>`).join("")
      : `<div class="bubble">暂无可见企微会话摘要</div>`;
  }
  const metrics = qsa<HTMLElement>("#wecom .kpi");
  const archived = messages.filter((message) => message.status === "archived").length;
  const pending = messages.length - archived;
  const values = [
    { value: "--", note: "当前接口未提供绑定客户统计" },
    { value: String(pending), note: "待归档摘要" },
    { value: String(messages.length), note: `${archived} 条已归档` },
    { value: "--", note: "当前接口未提供授权状态" }
  ];
  metrics.forEach((metric, index) => {
    const value = values[index];
    const strong = metric.querySelector("strong");
    const note = metric.querySelector("p");
    if (strong && value) strong.textContent = value.value;
    if (note && value) note.textContent = value.note;
  });
}

export async function syncWecomMessages() {
  const pending = state.wecomMessages.filter((message) => message.status !== "archived");
  for (const message of pending) {
    const result = await api<{ message: WecomMessage }>(`/api/wecom/messages/${message.id}/archive`, { method: "POST" });
    Object.assign(message, result.message);
  }
  renderWecom(state.wecomMessages);
  toast(pending.length ? `已同步 ${pending.length} 条企微摘要` : "企微摘要已是最新");
}

export function knowledgeAssetTypeText(type?: string) {
  const labels: Record<string, string> = { pdf: "PDF", word: "Word", excel: "Excel", image: "图片", video: "视频", archive: "压缩", link: "网页", other: "文件" };
  return labels[type || "other"] || "文件";
}

export function knowledgeSourceText(type?: string) {
  if (type === "baidu_share") return "百度网盘";
  if (type === "external_url") return "外部链接";
  return "待补链接";
}

export function knowledgeStatusText(status: string) {
  return status === "published" ? "已发布" : status === "review" ? "待审核" : "草稿";
}

export function knowledgeAssetIcon(asset: KnowledgeAsset) {
  return asset.sourceType === "baidu_share" ? "BD" : knowledgeAssetTypeText(asset.fileType).slice(0, 4).toUpperCase();
}

export function knowledgeFilteredAssets(assets: KnowledgeAsset[]) {
  const keyword = state.knowledgeSearch.trim().toLowerCase();
  return assets.filter((asset) => {
    const searchable = [asset.title, asset.category, asset.description, ...(asset.tags || [])].join(" ").toLowerCase();
    return (!keyword || searchable.includes(keyword))
      && (state.knowledgeCategoryFilter === "all" || asset.category === state.knowledgeCategoryFilter)
      && (state.knowledgeSourceFilter === "all" || (asset.sourceType || "legacy") === state.knowledgeSourceFilter)
      && (state.knowledgeStatusFilter === "all" || asset.status === state.knowledgeStatusFilter)
      && (state.knowledgeTypeFilter === "all" || (asset.fileType || "other") === state.knowledgeTypeFilter);
  });
}
