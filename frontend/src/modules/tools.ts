/**
 * 名片 OCR、AI 配置。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { state } from "../prototype-api";
import { type AiModelConfig, type OcrJob } from "./models";
import { loadLeadProviders } from "./dashboard";
import { syncLeadFinderStartState } from "./prospecting";
import { aiProviderPresets, badge, escapeHtml, ocrBatchJobs, qs, qsa } from "./shared";
import { api, toast } from "./ui";
import { reloadLeads } from "./leads";
import { renderLeadFinder } from "./lead-sources";

let ocrLocalPreviewUrl = "";
let ocrPreviewRevision = 0;
let ocrBusy = false;
let ocrBatchRunning = false;

export function renderOcr(job: OcrJob) {
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
  const cards = qs<HTMLElement>("#business-card .ocr-fields");
  if (!cards) return;
  cards.innerHTML = Object.entries(mapping).map(([key, label]) => `<div class="field-card"><input type="checkbox" checked data-ocr-field="${escapeHtml(key)}"><div><label>${label}</label><input type="text" value="${escapeHtml(fields[key])}"></div></div>`).join("");
  const statusRows = qsa<HTMLElement>("#business-card .sync-row");
  const hasRecognizedFields = Object.values(fields).some((value) => String(value || "").trim());
  const effectiveStatus = !job.hasImage && !hasRecognizedFields ? "waiting" : job.status;
  const statusLabel = effectiveStatus === "synced"
    ? "已同步"
    : effectiveStatus === "recognized"
      ? "识别完成"
      : effectiveStatus === "failed"
        ? "识别失败"
      : effectiveStatus === "uploaded"
        ? "已加载，待识别"
        : "等待名片";
  if (statusRows[0]) statusRows[0].innerHTML = `<span>识别状态</span><b>${statusLabel}</b>${badge(job.confidence > 0 ? `${job.confidence}% 置信度` : "--", job.confidence > 0 ? "green" : "")}`;
  const currentTask = qs<HTMLElement>("#ocrCurrentTaskValue");
  const recognizedFields = qs<HTMLElement>("#ocrRecognizedFieldsValue");
  const confidence = qs<HTMLElement>("#ocrConfidenceValue");
  const syncState = qs<HTMLElement>("#ocrSyncStateValue");
  if (currentTask) currentTask.textContent = effectiveStatus === "synced" ? "已同步" : hasRecognizedFields ? "已识别" : job.hasImage ? "待识别" : "待上传";
  if (recognizedFields) recognizedFields.textContent = String(Object.values(fields).filter((value) => String(value || "").trim()).length);
  if (confidence) confidence.textContent = `${job.confidence}%`;
  if (syncState) syncState.textContent = effectiveStatus === "synced" ? "已同步" : "未同步";
  const uploadBadge = qs<HTMLElement>("#ocrUploadBadge");
  if (uploadBadge) uploadBadge.textContent = job.hasImage ? "名片已安全加载" : "等待加载名片";
  const removeButton = qs<HTMLButtonElement>("#ocrRemoveButton");
  if (removeButton) removeButton.hidden = !job.hasImage;
  const recognizeButton = qs<HTMLButtonElement>("#ocrRecognizeButton");
  if (recognizeButton) recognizeButton.disabled = ocrBusy || !job.hasImage;
  const card = qs<HTMLElement>("#ocrPreviewCard");
  if (card) {
    const imageSource = ocrLocalPreviewUrl || (job.imageUrl ? `${job.imageUrl}?v=${ocrPreviewRevision}` : "");
    card.innerHTML = imageSource
      ? `<img src="${escapeHtml(imageSource)}" alt="已加载的名片图片">`
      : `<div class="ocr-card-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5a2 2 0 0 1 2-2h2M16 3h2a2 2 0 0 1 2 2v2M20 17v2a2 2 0 0 1-2 2h-2M8 21H6a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/></svg><h2>尚未加载名片</h2><p>支持 PNG、JPG、WebP，单张不超过 2 MB</p></div>`;
  }
  const hint = qs<HTMLElement>("#ocrRecognitionHint");
  if (hint && !hint.classList.contains("error")) {
    hint.textContent = (effectiveStatus === "recognized" || effectiveStatus === "synced") && hasRecognizedFields
      ? "识别结果可人工修正，勾选需要同步的字段"
      : job.hasImage
        ? "可重新识别，或直接人工填写右侧字段"
        : "图片将由当前账号配置的视觉模型识别";
  }
  const mappingRows = qsa<HTMLTableRowElement>("#business-card .matrix-grid .mini-table tbody tr").slice(0, 4);
  const mappingStates = [
    Boolean(fields.company?.trim()),
    Boolean(fields.contact?.trim() || fields.title?.trim()),
    Boolean(fields.email?.trim() || fields.phone?.trim() || fields.whatsapp?.trim() || fields.wechat?.trim()),
    Boolean(fields.country?.trim() || fields.city?.trim())
  ];
  mappingRows.forEach((row, index) => {
    const cell = row.lastElementChild as HTMLElement | null;
    if (cell) cell.innerHTML = badge(mappingStates[index] ? "已识别" : "待补充", mappingStates[index] ? "green" : "");
  });
}

function setOcrHint(message: string, error = false) {
  const hint = qs<HTMLElement>("#ocrRecognitionHint");
  if (!hint) return;
  hint.textContent = message;
  hint.classList.toggle("error", error);
}

function setOcrBusy(busy: boolean, phase: "upload" | "recognize" = "recognize") {
  ocrBusy = busy;
  const loadButton = qs<HTMLButtonElement>("#ocrLoadButton");
  const recognizeButton = qs<HTMLButtonElement>("#ocrRecognizeButton");
  const removeButton = qs<HTMLButtonElement>("#ocrRemoveButton");
  const fileInput = qs<HTMLInputElement>("#ocrFileInput");
  if (loadButton) {
    loadButton.disabled = busy;
    loadButton.textContent = busy && phase === "upload" ? "加载中" : "加载名片";
  }
  if (recognizeButton) {
    recognizeButton.disabled = busy || !state.ocrJob?.hasImage;
    recognizeButton.textContent = busy && phase === "recognize" ? "识别中" : "重新识别";
  }
  if (removeButton) removeButton.disabled = busy;
  if (fileInput) fileInput.disabled = busy;
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("名片图片读取失败"));
    reader.readAsDataURL(file);
  });
}

export function activeOcrJobId() {
  return state.ocrJob?.id || "current";
}

function ocrBatchStatusLabel(job: OcrJob) {
  if (job.status === "synced") return "已同步";
  if (job.status === "recognized") return "识别完成";
  if (job.status === "failed") return "失败";
  if (job.status === "processing") return "识别中";
  if (job.status === "uploaded") return "已上传";
  if (job.status === "uploading") return "上传中";
  return "排队中";
}

function renderOcrBatch() {
  const total = ocrBatchJobs.length;
  const completed = ocrBatchJobs.filter((job) => ["recognized", "synced", "failed"].includes(job.status)).length;
  const failed = ocrBatchJobs.filter((job) => job.status === "failed").length;
  const synced = ocrBatchJobs.filter((job) => job.status === "synced").length;
  const setText = (id: string, value: string | number) => { const node = qs<HTMLElement>(id); if (node) node.textContent = String(value); };
  setText("#ocrBatchTotal", total);
  setText("#ocrBatchCompleted", completed);
  setText("#ocrBatchFailed", failed);
  setText("#ocrBatchSynced", synced);
  const progress = qs<HTMLElement>("#ocrBatchProgressBar");
  if (progress) progress.style.width = `${total ? Math.round(completed / total * 100) : 0}%`;
  const retry = qs<HTMLButtonElement>("#ocrBatchRetryButton");
  const sync = qs<HTMLButtonElement>("#ocrBatchSyncButton");
  const clear = qs<HTMLButtonElement>("#ocrBatchClearButton");
  if (retry) retry.disabled = ocrBatchRunning || !ocrBatchJobs.some((job) => job.status === "failed" && job.hasImage);
  if (sync) sync.disabled = ocrBatchRunning || !ocrBatchJobs.some((job) => job.status === "recognized");
  if (clear) clear.disabled = ocrBatchRunning || !total;
  const list = qs<HTMLElement>("#ocrBatchList");
  if (!list) return;
  if (!ocrBatchJobs.length) {
    list.innerHTML = `<div class="ocr-batch-empty">选择一个包含名片图片的文件夹开始批量处理</div>`;
    return;
  }
  list.innerHTML = `<div class="ocr-batch-row ocr-batch-header"><span></span><span>文件</span><span>状态</span><span>识别结果</span><span>置信度</span><span>操作</span></div>` + ocrBatchJobs.map((job) => {
    const fields = job.fields || {};
    const company = fields.company || "未识别公司";
    const contact = [fields.contact, fields.title].filter(Boolean).join(" · ") || job.errorMessage || "等待处理";
    const stateClass = job.status === "failed" ? "failed" : job.status === "recognized" ? "recognized" : job.status === "synced" ? "synced" : ["processing", "uploading"].includes(job.status) ? "processing" : "";
    const retryButton = job.status === "failed" && job.hasImage ? `<button class="btn" type="button" data-ocr-batch-retry="${escapeHtml(job.id)}">重试</button>` : "";
    const syncButton = job.status === "recognized" ? `<button class="btn primary" type="button" data-ocr-batch-sync="${escapeHtml(job.id)}">同步</button>` : "";
    return `<div class="ocr-batch-row">
      <input type="checkbox" data-ocr-batch-select="${escapeHtml(job.id)}" ${job.status === "recognized" ? "checked" : ""} aria-label="选择 ${escapeHtml(job.sourceFileName || job.id)}">
      <div class="ocr-batch-file" title="${escapeHtml(job.sourceFileName || job.id)}"><b>${escapeHtml(job.sourceFileName || job.id)}</b><small>${escapeHtml(job.batchId || "批量任务")}</small></div>
      <span class="ocr-batch-state ${stateClass}">${ocrBatchStatusLabel(job)}</span>
      <div class="ocr-batch-result" title="${escapeHtml(job.errorMessage || contact)}"><b>${escapeHtml(company)}</b><small>${escapeHtml(contact)}</small></div>
      <span>${job.confidence ? `${job.confidence}%` : "--"}</span>
      <div class="ocr-batch-actions"><button class="btn" type="button" data-ocr-batch-view="${escapeHtml(job.id)}">查看</button>${retryButton}${syncButton}</div>
    </div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-ocr-batch-view]", list).forEach((button) => button.addEventListener("click", () => {
    const job = ocrBatchJobs.find((item) => item.id === button.dataset.ocrBatchView);
    if (!job) return;
    state.ocrJob = job;
    ocrLocalPreviewUrl = "";
    ocrPreviewRevision += 1;
    renderOcr(job);
    qs<HTMLElement>("#ocrPreviewCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  qsa<HTMLButtonElement>("[data-ocr-batch-retry]", list).forEach((button) => button.addEventListener("click", () => void retryOcrBatchJob(button.dataset.ocrBatchRetry || "")));
  qsa<HTMLButtonElement>("[data-ocr-batch-sync]", list).forEach((button) => button.addEventListener("click", () => void syncOcrBatchJob(button.dataset.ocrBatchSync || "")));
}

async function processOcrBatchJob(job: OcrJob, file?: File) {
  const update = (changes: Partial<OcrJob>) => {
    const index = ocrBatchJobs.findIndex((item) => item.id === job.id);
    if (index >= 0) ocrBatchJobs[index] = { ...ocrBatchJobs[index], ...changes };
    renderOcrBatch();
  };
  try {
    if (file) {
      update({ status: "uploading", errorMessage: "" });
      const image = await fileAsDataUrl(file);
      const upload = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(job.id)}/image`, {
        method: "POST",
        body: JSON.stringify({ image, mime: file.type, fileName: file.webkitRelativePath || file.name })
      });
      update({ ...upload.job, status: "processing" });
    } else {
      update({ status: "processing", errorMessage: "" });
    }
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(job.id)}/recognize-image`, { method: "POST", body: "{}" });
    update(result.job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片识别失败";
    update({ status: "failed", errorMessage: message });
  }
}

async function retryOcrBatchJob(id: string) {
  const job = ocrBatchJobs.find((item) => item.id === id);
  if (!job || !job.hasImage || ocrBatchRunning) return;
  ocrBatchRunning = true;
  try { await processOcrBatchJob(job); }
  finally { ocrBatchRunning = false; renderOcrBatch(); }
}

async function syncOcrBatchJob(id: string) {
  const job = ocrBatchJobs.find((item) => item.id === id);
  if (!job || job.status !== "recognized") return;
  try {
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(id)}/sync-lead`, { method: "POST" });
    Object.assign(job, result.job);
    await reloadLeads();
    renderOcrBatch();
  } catch (error) { toast(error instanceof Error ? error.message : "同步线索失败", "error"); }
}

async function requestOcrImageRecognition() {
  const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/recognize-image`, {
    method: "POST",
    body: "{}"
  });
  state.ocrJob = result.job;
  setOcrHint("识别结果可人工修正，勾选需要同步的字段");
  renderOcr(result.job);
  return result.job;
}

export async function loadOcrCard(file: File) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    toast("只支持 PNG、JPG 或 WebP 名片图片", "error");
    return;
  }
  if (!file.size || file.size > 2 * 1024 * 1024) {
    toast("名片图片大小必须在 2 MB 以内", "error");
    return;
  }
  setOcrBusy(true, "upload");
  setOcrHint("正在安全加载名片图片");
  if (ocrLocalPreviewUrl) URL.revokeObjectURL(ocrLocalPreviewUrl);
  ocrLocalPreviewUrl = URL.createObjectURL(file);
  let uploadCompleted = false;
  try {
    const image = await fileAsDataUrl(file);
    const uploadResult = await api<{ job: OcrJob; message: string }>("/api/tools/ocr/jobs/current/image", {
      method: "POST",
      body: JSON.stringify({ image, mime: file.type, fileName: file.name })
    });
    uploadCompleted = true;
    state.ocrJob = uploadResult.job;
    ocrPreviewRevision += 1;
    renderOcr(uploadResult.job);
    setOcrBusy(true, "recognize");
    setOcrHint("名片已加载，正在调用视觉模型识别");
    await requestOcrImageRecognition();
    toast("名片识别完成", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片加载或识别失败";
    if (!uploadCompleted) {
      URL.revokeObjectURL(ocrLocalPreviewUrl);
      ocrLocalPreviewUrl = "";
      if (state.ocrJob) renderOcr(state.ocrJob);
    }
    setOcrHint(`${message}；可人工填写字段后同步`, true);
    toast(message, "error");
  } finally {
    setOcrBusy(false);
    const input = qs<HTMLInputElement>("#ocrFileInput");
    if (input) input.value = "";
  }
}

export async function recognizeOcrImage() {
  if (!state.ocrJob?.hasImage) {
    toast("请先加载一张名片图片", "error");
    return;
  }
  setOcrBusy(true, "recognize");
  setOcrHint("正在重新识别名片");
  try {
    await requestOcrImageRecognition();
    toast("名片重新识别完成", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "名片识别失败";
    setOcrHint(`${message}；可人工填写字段后同步`, true);
    toast(message, "error");
  } finally {
    setOcrBusy(false);
  }
}

export async function removeOcrCard() {
  if (!state.ocrJob?.hasImage || ocrBusy) return;
  setOcrBusy(true, "upload");
  try {
    const result = await api<{ job: OcrJob }>(`/api/tools/ocr/jobs/${encodeURIComponent(activeOcrJobId())}/image`, { method: "DELETE" });
    if (ocrLocalPreviewUrl) URL.revokeObjectURL(ocrLocalPreviewUrl);
    ocrLocalPreviewUrl = "";
    state.ocrJob = result.job;
    setOcrHint("图片将由当前账号配置的视觉模型识别");
    renderOcr(result.job);
    toast("名片已移除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "移除名片失败", "error");
  } finally {
    setOcrBusy(false);
  }
}

export function collectOcrFields() {
  const fields: Record<string, string> = {};
  qsa<HTMLInputElement>("#business-card .field-card input[data-ocr-field]").forEach((checkbox) => {
    if (!checkbox.checked) return;
    const key = checkbox.dataset.ocrField;
    const input = checkbox.parentElement?.querySelector<HTMLInputElement>("input[type='text']");
    if (key && input) fields[key] = input.value;
  });
  return fields;
}

let aiTestingActive = false;
export function renderAiConfig(config: AiModelConfig | null) {
  const selected = state.aiDraftMode ? null : (state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || config || state.aiConfigs[0] || null);
  config = selected;
  if (!state.aiDraftMode) {
    state.selectedAiConfigId = selected?.id || null;
    if (selected) state.aiConfig = selected;
  }
  const name = qs<HTMLInputElement>("#aiConfigName");
  const baseUrl = qs<HTMLInputElement>("#aiBaseUrlInput");
  const model = qs<HTMLInputElement>("#aiModelInput");
  const apiKey = qs<HTMLInputElement>("#aiApiKeyInput");
  const enabled = qs<HTMLInputElement>("#aiEnabledInput");
  const badgeNode = qs<HTMLElement>("#aiConfigBadge");
  const gptName = qs<HTMLInputElement>("#gptConfigName");
  const gptBaseUrl = qs<HTMLInputElement>("#gptBaseUrlInput");
  const gptModel = qs<HTMLInputElement>("#gptModelInput");
  const gptApiKey = qs<HTMLInputElement>("#gptApiKeyInput");
  const gptEnabled = qs<HTMLSelectElement>("#gptEnabledSelect");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const temperatureInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const gptBadge = qs<HTMLElement>("#gptConfigBadge");
  const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
  const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
  const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
  const gptWebSearchStatus = qs<HTMLElement>("#gptWebSearchStatus");
  const gptState = qs<HTMLElement>("#gptConfigState");
  const gptSub = qs<HTMLElement>("#gptConfigSub");
  const gptModelState = qs<HTMLElement>("#gptModelState");
  const providerState = qs<HTMLElement>("#gptProviderState");
  const protocolState = qs<HTMLElement>("#gptProtocolState");
  const useState = qs<HTMLElement>("#gptUseState");
  const countText = qs<HTMLElement>("#aiConfigCountText");
  const list = qs<HTMLElement>("#aiConfigList");
  const modeAlert = qs<HTMLElement>("#aiConfigModeAlert");
  const deleteButton = qs<HTMLButtonElement>("#aiDeleteConfigButton");
  const toggleButton = qs<HTMLButtonElement>("#aiToggleEnabledButton");
  const draftMode = state.aiDraftMode;
  const defaultName = "";
  const defaultBaseUrl = "";
  const defaultModel = "";
  const provider = draftMode ? (providerSelect?.value || "openai") : (config?.provider || "openai");
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  const protocol = draftMode ? ((protocolSelect?.value as AiModelConfig["protocol"]) || preset.protocol) : (config?.protocol || preset.protocol);
  const ready = Boolean(config?.enabled && config?.hasApiKey);
  const tested = config?.lastTestStatus === "passed";
  const failed = config?.lastTestStatus === "failed";
  const webSearchStatus = config?.webSearchStatus || "untested";
  const webSearchReady = webSearchStatus === "passed";
  const webSearchUnsupported = webSearchStatus === "unsupported";
  const webSearchFailed = webSearchStatus === "failed";
  const useFlags = {
    leadFinder: config?.useLeadFinder ?? true,
    websiteParse: false,
    scoring: config?.useScoring ?? true,
    emailDraft: config?.useEmailDraft ?? true,
    exam: config?.useExam ?? false
  };
  const useCount = Object.values(useFlags).filter(Boolean).length;
  if (countText) countText.textContent = `${state.aiConfigs.length} 个配置实例`;
  if (list) {
    const draftRow = state.aiDraftMode ? `
      <button class="ai-instance-row active is-draft" type="button" data-ai-draft-row>
        <span><b>未保存的新配置</b></span>
        <em>${badge("新增", "amber")}</em>
      </button>
    ` : "";
    const savedRows = state.aiConfigs.map((item) => {
      const itemPreset = aiProviderPresets[item.provider] || aiProviderPresets.custom;
      const itemUseCount = [item.useLeadFinder, item.useWebsiteParse, item.useScoring, item.useEmailDraft, item.useExam].filter(Boolean).length;
      const active = !state.aiDraftMode && item.id === state.selectedAiConfigId;
      return `
        <button class="ai-instance-row ${active ? "active" : ""}" type="button" data-ai-config-id="${escapeHtml(item.id)}">
          <span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(itemPreset.label)} · ${escapeHtml(item.model)} · ${itemUseCount} 个用途</small></span>
          <em>${badge(item.enabled ? "启用" : "停用", item.enabled ? "green" : "gray")}${badge(item.hasApiKey ? "有Key" : "缺Key", item.hasApiKey ? "green" : "amber")}${item.useLeadFinder ? badge(item.webSearchStatus === "passed" ? "官网联网已验证" : item.webSearchStatus === "unsupported" ? "需官网搜索 API" : "官网联网待测", item.webSearchStatus === "passed" ? "green" : item.webSearchStatus === "failed" ? "red" : "amber") : ""}</em>
        </button>
      `;
    }).join("");
    list.innerHTML = draftRow || savedRows ? `${draftRow}${savedRows}` : `<div class="empty-cell">暂无配置</div>`;
    qsa<HTMLButtonElement>("#aiConfigList [data-ai-config-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.aiDraftMode = false;
        state.pendingAiDeleteId = null;
        state.selectedAiConfigId = button.dataset.aiConfigId || null;
        renderAiConfig(state.aiConfigs.find((item) => item.id === state.selectedAiConfigId) || null);
      });
    });
  }
  if (modeAlert) {
    modeAlert.innerHTML = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id
      ? `<b>确认删除</b><span>将删除“${escapeHtml(config.name)}”，再次点击“确认删除”才会执行。</span>`
      : state.aiDraftMode
      ? `<b>新增配置</b>`
      : config
        ? `<b>编辑配置</b><span>${escapeHtml(config.name)}</span>`
        : `<b>暂无配置</b>`;
  }
  if (deleteButton) {
    deleteButton.disabled = state.aiDraftMode || !config;
    deleteButton.textContent = state.pendingAiDeleteId && state.pendingAiDeleteId === config?.id ? "确认删除" : "删除当前";
  }
  if (toggleButton) {
    toggleButton.disabled = state.aiDraftMode || !config;
    toggleButton.textContent = config?.enabled ? "停用当前" : "启用当前";
  }
  if (name && !draftMode) name.value = config?.name || defaultName;
  if (baseUrl && !draftMode) baseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (model && !draftMode) model.value = config?.model || defaultModel;
  if (apiKey && !draftMode) {
    apiKey.value = config?.apiKey || "";
    apiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅后端持久化";
  }
  if (enabled && !draftMode) enabled.checked = Boolean(config?.enabled);
  if (badgeNode) {
    badgeNode.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    badgeNode.textContent = ready ? `AI已启用 · ${config?.model}` : config?.enabled ? "来源归纳 · 缺少API Key" : "来源归纳";
  }
  if (gptName && !draftMode) gptName.value = config?.name || defaultName;
  if (gptBaseUrl && !draftMode) gptBaseUrl.value = config?.baseUrl || defaultBaseUrl;
  if (gptModel && !draftMode) gptModel.value = config?.model || defaultModel;
  if (providerSelect && !draftMode) providerSelect.value = provider;
  if (protocolSelect && !draftMode) protocolSelect.value = protocol;
  if (temperatureInput && !draftMode) temperatureInput.value = String(config?.temperature ?? 0.1);
  if (gptApiKey && !draftMode) {
    gptApiKey.value = config?.apiKey || "";
    gptApiKey.placeholder = config?.hasApiKey ? "已保存，重新填写可覆盖" : "保存后仅显示末四位";
  }
  if (gptEnabled && !draftMode) gptEnabled.value = config?.enabled === false ? "false" : "true";
  if (gptBadge) {
    gptBadge.className = `badge ${ready ? "green" : config?.enabled ? "amber" : ""}`;
    gptBadge.textContent = ready ? "当前" : config?.enabled ? "缺Key" : "当前";
  }
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => {
    const active = card.dataset.aiProvider === provider;
    card.classList.toggle("active", active);
    const badgeNodeInCard = card.querySelector<HTMLElement>(".badge");
    if (badgeNodeInCard) {
      badgeNodeInCard.className = `badge ${active ? "green" : "gray"}`;
      badgeNodeInCard.textContent = active ? "当前" : (card.dataset.aiProvider === "anthropic" || card.dataset.aiProvider === "gemini" ? "原生" : "兼容");
    }
  });
  if (gptConnectionBadge && !aiTestingActive) {
    gptConnectionBadge.className = `badge ${tested && (!config?.useLeadFinder || webSearchReady) ? "green" : failed || webSearchFailed ? "red" : ready ? "amber" : ""}`;
    gptConnectionBadge.textContent = tested && (!config?.useLeadFinder || webSearchReady)
      ? "连接与联网通过"
      : webSearchUnsupported
        ? tested ? "普通 AI 通过" : "模型不支持联网"
        : webSearchFailed
          ? "联网测试失败"
          : failed
            ? "连接失败"
            : ready
              ? "待测试联网能力"
              : "未启用";
  }
  if (gptConnectionTitle && !aiTestingActive) gptConnectionTitle.textContent = tested && (!config?.useLeadFinder || webSearchReady)
    ? "AI 与官网联网测试通过"
    : webSearchUnsupported
      ? tested ? "普通 AI 通过，官网需搜索 API" : "当前模型不能确认官网"
      : webSearchFailed
        ? "普通 AI 可用，但官网联网未通过"
        : failed
          ? "AI 连接测试失败"
          : ready
            ? "等待官网联网测试"
            : config?.enabled
              ? "缺少 API Key"
              : "AI 未启用";
  if (gptConnectionText && !aiTestingActive) gptConnectionText.textContent = config?.lastTestMessage || (ready ? `当前模型：${config?.model} · ${useCount} 个业务模块` : "");
  if (gptWebSearchStatus) {
    const citationCount = Number(config?.webSearchCitationCount || 0);
    gptWebSearchStatus.className = `ai-web-search-status ${webSearchReady ? "is-ready" : webSearchFailed ? "is-blocked" : "is-pending"}`;
    gptWebSearchStatus.textContent = webSearchReady
      ? `官网发现：Web Search 已验证${citationCount ? ` · 最近 ${citationCount} 条引用` : ""}`
      : webSearchUnsupported
        ? "官网发现：当前模型不支持原生 Web Search；配置 Brave、Serper、SerpApi 或 Google Places 后可继续自动搜客"
        : webSearchFailed
          ? "官网发现：Web Search 失败，不会采信模型猜测的网址"
          : config?.useLeadFinder
            ? "官网发现：请先测试 Web Search，自动搜客才会启动"
            : "官网发现：未启用自动获客，暂不要求 Web Search";
  }
  if (gptState) gptState.textContent = ready ? "已启用" : config?.enabled ? "待补Key" : "未启用";
  if (gptSub) gptSub.textContent = tested ? "最近测试通过" : ready ? "可测试连接和调用" : "等待 API Key";
  if (gptModelState) gptModelState.textContent = config?.model || defaultModel;
  if (providerState) providerState.textContent = preset.label;
  if (protocolState) protocolState.textContent = protocol === "anthropic" ? "Anthropic Messages" : protocol === "gemini" ? "Gemini generateContent" : "OpenAI兼容协议";
  if (useState) useState.textContent = `${useCount} 个模块`;
  [
    ["#aiUseLeadFinder", useFlags.leadFinder],
    ["#aiUseWebsiteParse", useFlags.websiteParse],
    ["#aiUseScoring", useFlags.scoring],
    ["#aiUseEmailDraft", useFlags.emailDraft],
    ["#aiUseExam", useFlags.exam]
  ].forEach(([selector, checked]) => {
    const input = qs<HTMLInputElement>(String(selector));
    if (input && !draftMode) input.checked = Boolean(checked);
  });
  Object.entries(useFlags).forEach(([key, on]) => {
    const row = qs<HTMLElement>(`[data-ai-use-row="${key}"]`);
    const stateBadge = row?.querySelector<HTMLElement>(".badge");
    if (stateBadge) {
      stateBadge.className = `badge ${ready && on ? "green" : on ? "amber" : "gray"}`;
      stateBadge.textContent = ready && on ? "已启用" : on ? "待Key" : "关闭";
    }
  });
}

function collectAiConfigPayload() {
  const activeView = qs<HTMLElement>(".view.active")?.id;
  const useGptPage = activeView === "ai-config" || Boolean(qs<HTMLInputElement>("#gptConfigName")?.matches(":focus"));
  if (useGptPage) {
    return {
      id: state.selectedAiConfigId || undefined,
      provider: qs<HTMLSelectElement>("#gptProviderSelect")?.value || "openai",
      protocol: qs<HTMLSelectElement>("#gptProtocolSelect")?.value || "openai-compatible",
      name: qs<HTMLInputElement>("#gptConfigName")?.value.trim() || "",
      baseUrl: qs<HTMLInputElement>("#gptBaseUrlInput")?.value.trim() || "",
      model: qs<HTMLInputElement>("#gptModelInput")?.value.trim() || "",
      apiKey: qs<HTMLInputElement>("#gptApiKeyInput")?.value.trim() || "",
      enabled: qs<HTMLSelectElement>("#gptEnabledSelect")?.value !== "false",
      temperature: Number(qs<HTMLInputElement>("#gptTemperatureInput")?.value || 0.1),
      useLeadFinder: Boolean(qs<HTMLInputElement>("#aiUseLeadFinder")?.checked),
      useWebsiteParse: false,
      useScoring: Boolean(qs<HTMLInputElement>("#aiUseScoring")?.checked),
      useEmailDraft: Boolean(qs<HTMLInputElement>("#aiUseEmailDraft")?.checked),
      useExam: Boolean(qs<HTMLInputElement>("#aiUseExam")?.checked)
    };
  }
  return {
    id: state.selectedAiConfigId || state.aiConfig?.id || undefined,
    provider: state.aiConfig?.provider || "openai",
    protocol: state.aiConfig?.protocol || "openai-compatible",
    name: qs<HTMLInputElement>("#aiConfigName")?.value.trim() || "获客归纳模型",
    baseUrl: qs<HTMLInputElement>("#aiBaseUrlInput")?.value.trim() || "https://api.openai.com/v1",
    model: qs<HTMLInputElement>("#aiModelInput")?.value.trim() || "gpt-4o-mini",
    apiKey: qs<HTMLInputElement>("#aiApiKeyInput")?.value.trim() || "",
    enabled: Boolean(qs<HTMLInputElement>("#aiEnabledInput")?.checked),
    temperature: state.aiConfig?.temperature ?? 0.1,
    useLeadFinder: state.aiConfig?.useLeadFinder ?? true,
    useWebsiteParse: false,
    useScoring: state.aiConfig?.useScoring ?? true,
    useEmailDraft: state.aiConfig?.useEmailDraft ?? true,
    useExam: state.aiConfig?.useExam ?? false
  };
}

export function applyAiProviderPreset(provider: string) {
  const preset = aiProviderPresets[provider] || aiProviderPresets.custom;
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = state.aiDraftMode ? "" : preset.name;
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = state.aiDraftMode ? "" : preset.model;
  qsa<HTMLElement>("[data-ai-provider]").forEach((card) => card.classList.toggle("active", card.dataset.aiProvider === provider));
}

export function newAiConfigDraft(provider = "openai") {
  const preset = aiProviderPresets[provider] || aiProviderPresets.openai;
  state.aiDraftMode = true;
  state.selectedAiConfigId = null;
  state.pendingAiDeleteId = null;
  const nameInput = qs<HTMLInputElement>("#gptConfigName");
  const apiKeyInput = qs<HTMLInputElement>("#gptApiKeyInput");
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  const tempInput = qs<HTMLInputElement>("#gptTemperatureInput");
  const providerSelect = qs<HTMLSelectElement>("#gptProviderSelect");
  const protocolSelect = qs<HTMLSelectElement>("#gptProtocolSelect");
  const baseInput = qs<HTMLInputElement>("#gptBaseUrlInput");
  const modelInput = qs<HTMLInputElement>("#gptModelInput");
  if (providerSelect) providerSelect.value = provider in aiProviderPresets ? provider : "custom";
  if (protocolSelect) protocolSelect.value = preset.protocol;
  if (nameInput) nameInput.value = "";
  if (baseInput) baseInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = "";
  if (apiKeyInput) {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "新配置请填写 API Key";
  }
  if (enabledSelect) enabledSelect.value = "false";
  if (tempInput) tempInput.value = "0.1";
  ["#aiUseWebsiteParse", "#aiUseScoring", "#aiUseEmailDraft"].forEach((selector) => {
    const input = qs<HTMLInputElement>(selector);
    if (input) input.checked = false;
  });
  const leadFinder = qs<HTMLInputElement>("#aiUseLeadFinder");
  if (leadFinder) leadFinder.checked = true;
  const exam = qs<HTMLInputElement>("#aiUseExam");
  if (exam) exam.checked = false;
  renderAiConfig(null);
}

export async function deleteAiConfig(button?: HTMLButtonElement) {
  if (!state.selectedAiConfigId) {
    toast("请先选择要删除的配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  if (state.pendingAiDeleteId !== current.id) {
    state.pendingAiDeleteId = current.id;
    renderAiConfig(current);
    return;
  }
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "删除中";
  }
  try {
    const result = await api<{ config: AiModelConfig | null; configs: AiModelConfig[] }>(`/api/tools/ai-config/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    state.aiConfigs = result.configs || [];
    state.aiConfig = result.config;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    state.selectedAiConfigId = result.config?.id || state.aiConfigs[0]?.id || null;
    renderAiConfig(state.aiConfig);
    await loadLeadProviders();
    renderLeadFinder(state.websiteOpportunities);
    toast(`已删除：${current.name}`);
  } catch (err) {
    state.pendingAiDeleteId = null;
    toast(err instanceof Error ? err.message : "删除失败，请重试", "error");
  } finally {
    if (button) {
      const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
      button.disabled = state.aiDraftMode || !selected;
      button.textContent = selected && state.pendingAiDeleteId === selected.id ? "确认删除" : (originalText === "确认删除" ? "删除当前" : originalText || "删除当前");
    }
  }
}

export async function toggleAiConfigEnabled(button?: HTMLButtonElement) {
  if (state.aiDraftMode || !state.selectedAiConfigId) {
    toast("请先保存或选择一个配置", "error");
    return;
  }
  const current = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  if (!current) return;
  const enabledSelect = qs<HTMLSelectElement>("#gptEnabledSelect");
  if (enabledSelect) enabledSelect.value = current.enabled ? "false" : "true";
  await saveAiConfig(button);
}

export async function saveAiConfig(button?: HTMLButtonElement, options: { silent?: boolean } = {}) {
  const originalText = button?.textContent || "";
  const payload = collectAiConfigPayload();
  const selected = state.aiConfigs.find((item) => item.id === state.selectedAiConfigId);
  const hasSubmittedKey = typeof payload.apiKey === "string" && payload.apiKey.length > 0 && !payload.apiKey.includes("****");
  if (!payload.name || !payload.baseUrl || !payload.model) {
    toast("请填写配置名称、Base URL 和模型名称", "error");
    return;
  }
  if (payload.enabled && !hasSubmittedKey && !selected?.hasApiKey) {
    toast("请先填写 API Key，再启用该配置", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "保存中";
  }
  try {
    const result = await api<{ config: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.aiConfig = result.config;
    state.aiConfigs = result.configs || state.aiConfigs.filter((item) => item.id !== result.config.id).concat(result.config);
    state.selectedAiConfigId = result.config.id;
    state.aiDraftMode = false;
    state.pendingAiDeleteId = null;
    renderAiConfig(result.config);
    await loadLeadProviders();
    renderLeadFinder(state.websiteOpportunities);
    syncLeadFinderStartState();
    if (!options.silent) toast(result.config.enabled ? `已保存并启用：${result.config.name}` : `已保存：${result.config.name}`);
  } finally {
    if (button) {
      button.disabled = false;
      if (button.id === "aiToggleEnabledButton") {
        button.textContent = state.aiConfig?.enabled ? "停用当前" : "启用当前";
      } else {
        button.textContent = originalText || "保存AI配置";
      }
    }
  }
}

export async function testAiConfig(button?: HTMLButtonElement) {
  const originalText = button?.textContent || "";
  const testHero = qs<HTMLElement>("#aiTestResultHero");
  const testBadge = qs<HTMLElement>("#gptConnectionBadge");
  const testTitle = qs<HTMLElement>("#gptConnectionTitle");
  const testText = qs<HTMLElement>("#gptConnectionText");
  // 立即进入“测试中”呼吸态，确保点击即有反馈（不依赖保存是否成功）
  aiTestingActive = true;
  if (button) {
    button.disabled = true;
    button.textContent = "测试中";
    button.classList.add("is-testing");
  }
  if (testHero) testHero.classList.add("is-testing");
  if (testBadge) { testBadge.className = "badge"; testBadge.textContent = "测试中…"; }
  if (testTitle) testTitle.textContent = "正在测试连接…";
  if (testText) testText.textContent = "正在向模型接口发起请求，请稍候";
  try {
    // 保存失败不阻断测试：测试接口会基于已保存配置或内存草稿校验
    await saveAiConfig(undefined, { silent: true }).catch(() => {});
    const result = await api<{ ok: boolean; message: string; config?: AiModelConfig; configs?: AiModelConfig[] }>("/api/tools/ai-config/test", {
      method: "POST",
      body: JSON.stringify({ id: state.selectedAiConfigId || undefined })
    });
    if (result.config) {
      state.aiConfig = result.config;
      state.aiConfigs = result.configs || state.aiConfigs.map((item) => item.id === result.config?.id ? result.config : item);
      state.selectedAiConfigId = result.config.id;
      renderAiConfig(result.config);
      await loadLeadProviders();
      renderLeadFinder(state.websiteOpportunities);
      syncLeadFinderStartState();
    }
    if (!result.config) {
      const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
      const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
      const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
      if (gptConnectionBadge) {
        gptConnectionBadge.className = `badge ${result.ok ? "green" : "red"}`;
        gptConnectionBadge.textContent = result.ok ? "连接通过" : "连接失败";
      }
      if (gptConnectionTitle) gptConnectionTitle.textContent = result.ok ? "AI 连接测试通过" : "AI 连接测试失败";
      if (gptConnectionText) gptConnectionText.textContent = result.message;
    }
    toast(result.message, result.ok ? "ok" : "error");
  } catch (err) {
    const gptConnectionBadge = qs<HTMLElement>("#gptConnectionBadge");
    const gptConnectionTitle = qs<HTMLElement>("#gptConnectionTitle");
    const gptConnectionText = qs<HTMLElement>("#gptConnectionText");
    const msg = err instanceof Error ? err.message : "测试失败";
    if (gptConnectionBadge) { gptConnectionBadge.className = "badge red"; gptConnectionBadge.textContent = "连接失败"; }
    if (gptConnectionTitle) gptConnectionTitle.textContent = "AI 连接测试失败";
    if (gptConnectionText) gptConnectionText.textContent = msg;
    toast(msg, "error");
  } finally {
    aiTestingActive = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-testing");
      button.textContent = originalText || "测试连接";
    }
    if (testHero) testHero.classList.remove("is-testing");
  }
}
