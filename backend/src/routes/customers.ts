/**
 * 客户、供应商、客户情报、导入导出路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canSeeOwner, canSeePersonalData, hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { callAiModel, extractJsonObject } from "../ai-model-runtime.js";
import { parseCustomerIntakeResult } from "../customer-intake-parse.js";
import { OFFICE_BINARY_EXTENSIONS, officeDocumentToText, officeExtensionHint } from "../office-document-text.js";
import { aiEngineAdapterLabel, clampAiEngineTimeout, engineCliProfile, readTeamAiEngineSettings } from "../ai-engine-settings.js";
import { classifyEngineCliIssue, cliTaskDone, type EngineCliIssue, type EngineCliTaskSnapshot, engineRunnerOfflineIssue, engineRunnerQueueState, EngineUnavailableError, enqueueEngineCliTask, pickEngineRunner, readEngineCliTask, waitForEngineCliTask } from "../ai-engine-service.js";
import { getSupplierRepository, SupplierCodeConflictError, supplierDuplicateKey, type SupplierInput } from "../supplier-repository.js";
import { getFileRepository } from "../file-storage.js";
import { type Customer, type CustomerIntelligenceFieldKey, type SessionUser } from "../types.js";
import { getLocalRunnerService } from "../integrations/integration-runtime.js";
import { getStore } from "../store.js";
import { acceptCustomerIntelligence, rejectCustomerIntelligence } from "../customer-intelligence.js";
import { CustomerOwnershipError, isPublicCustomer } from "../customer-public-pool.js";
import {
  asyncRoute,
  currentMinuteText,
  customerGradeFromHealth,
  customerWithPipeline,
  entityDuplicateKey,
  findWritableCustomer,
  getAiConfig,
  ownedCustomersFor,
  uploadsDir
} from "../server-core.js";

function publicPoolCustomersFor(user: SessionUser) {
  if (isPlatformIdentity(user)) return [];
  return getStore().customers.filter((customer) =>
    customer.teamId === user.teamId && isPublicCustomer(customer)
  );
}

function customerPoolCounts(user: SessionUser) {
  return {
    mineCount: ownedCustomersFor(user).length,
    publicCount: publicPoolCustomersFor(user).length
  };
}

function sendCustomerOwnershipError(res: Response, error: unknown) {
  if (error instanceof CustomerOwnershipError) {
    res.status(error.status).json({ message: error.message, errorCode: error.code });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 新增客户 · 客户资料文件识别（本机 CLI）
//
// 用户上传名片 / 合同 / 询盘邮件 / 表格等资料，交给本机 Runner 上的 CLI 读取文件，
// 抽取客户字段回填「新增客户」表单。这里只做「识别 + 回填」：
//   - 不自动保存客户：最终仍由用户在弹窗里核对后点「保存客户」；
//   - 提示词里明确禁止编造联系方式，识别不到必须留空；
//   - 文件落在 Runner 已授权的工作目录内，CLI 以只读方式读取。
// （本地文件只有本机 CLI 能读，因此这条链路固定走 CLI，不跟随团队引擎来源设置。）
// ---------------------------------------------------------------------------
const CUSTOMER_INTAKE_MAX_BYTES = 12 * 1024 * 1024;

const CUSTOMER_INTAKE_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff",
  "txt", "md", "csv", "json", "eml", "html", "htm", "doc", "docx", "xls", "xlsx"
]);

/** 回填字段白名单与长度上限见 customer-intake-parse.ts（与解析归因放在一起，便于单测） */

const CUSTOMER_INTAKE_FIELD_HINTS: Array<[string, string]> = [
  ["company", "客户简称：公司名去掉 Co., Ltd. / GmbH / 有限公司 等后缀的短名（必填，识别不到填空字符串）"],
  ["companyFullName", "公司全名（报价、合同、单据优先使用的名称，保留原文写法）"],
  ["contact", "联系人姓名"],
  ["country", "国家或地区（用中文，例如 德国 / 越南 / 美国）"],
  ["phone", "电话（含国家区号）"],
  ["email", "邮箱"],
  ["whatsapp", "WhatsApp 号码（必须含国家码且以 + 开头，如 +4915112345678；不确定国家码就留空）"],
  ["wechat", "微信（微信号或绑定手机号）"],
  ["website", "官网地址"],
  ["source", "客户来源线索（例如展会名片、官网询盘、转介绍），无法判断填空字符串"],
  ["billingAddress", "账单地址（公司地址、城市、国家）"],
  ["contactRemark", "其它联系方式 / 渠道备注"],
  ["otherNotes", "其它说明：客户偏好、业务背景、注意事项，不超过 200 字"],
  ["defaultPortDischarge", "默认目的港"],
  ["defaultIncoterm", "默认贸易条款（FOB / CIF / DAP 等）"],
  ["defaultPaymentTerm", "默认付款条款"]
];

/** 识别暂存目录：优先放进 Runner 授权的工作目录，CLI 才能可靠读到文件 */
async function resolveCustomerIntakeDir(workspace: string) {
  const candidates = [
    workspace ? path.resolve(workspace, "uploads", "customer-intake") : "",
    path.join(uploadsDir, "customer-intake")
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      await mkdir(dir, { recursive: true });
      return dir;
    } catch {
      continue;
    }
  }
  throw Object.assign(new Error("无法创建客户资料暂存目录"), { status: 500 });
}

/**
 * CLI 快速模式标记（Runner 侧解析，见 goodjob-runner/src/workbuddy-adapter.ts）。
 *
 * 为什么要它：本机 CLI 是「编码 Agent」，默认参数下会为了理解字段含义去探索整个工作目录。
 * 2026-10-10 实测同一条提示词：默认参数 178 秒 / 53 次工具调用（还用了 Agent、WebFetch、Write），
 * 加上 effort=low + max-turns=6 + 禁用探索类工具后 **7.8–19.6 秒 / 1–3 次工具调用**，
 * 回填字段质量完全一致（9-10 项）。识别任务是纯文本抽取，绝不需要探索仓库。
 */
const CUSTOMER_INTAKE_CLI_DISALLOWED_TOOLS = [
  "Write", "Edit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "TodoWrite"
];

function customerIntakeCliProfileLine() {
  return `[[gj-cli-options ${JSON.stringify({
    effort: "low",
    maxTurns: 6,
    disallowedTools: CUSTOMER_INTAKE_CLI_DISALLOWED_TOOLS
  })}]]`;
}

function customerIntakePrompt(
  files: Array<{ name: string; readPath: string; converted?: boolean }>,
  options: { speedProfile?: boolean; adapter?: "workbuddy" | "codex" } = {}
) {
  const list = files
    .map((file) => `- ${file.readPath}（原始文件名：${file.name}${file.converted ? "，已由 CRM 从 Office 文档转为纯文本" : ""}）`)
    .join("\n");
  const fields = CUSTOMER_INTAKE_FIELD_HINTS.map(([key, hint]) => `    "${key}": "${hint}"`).join(",\n");
  return [
    ...(options.speedProfile ? [customerIntakeCliProfileLine()] : []),
    "你是外贸 CRM 的客户资料录入助手。这是一次**纯文本抽取**任务，不是代码任务。",
    "",
    ...(options.adapter === "codex"
      ? [
        // Codex 没有 Read / Glob / Grep 这些 WorkBuddy 工具名；用不依赖工具名的等价约束
        `请读取下面这${files.length > 1 ? "些" : "个"}由用户上传到本机的文件（只读，不要修改、重命名或删除任何文件）：`,
        list,
        "",
        "严格约束（必须遵守）：",
        "- 只读取上面列出的文件；不要浏览、列出或搜索工作目录里的其它文件，不要联网，不要写任何文件。",
        "- 读完文件后立刻按下面的 JSON 结构输出答案，不要再做任何探索。"
      ]
      : [
        `请用 Read 工具读取下面这${files.length > 1 ? "些" : "个"}由用户上传到本机的文件（只读，不要修改、重命名或删除任何文件）：`,
        list,
        "",
        "严格约束（必须遵守）：",
        "- 只允许使用 Read 工具；禁止探索工作目录或仓库（不要 Glob / Grep / Bash / Agent / WebFetch / WebSearch），不要写任何文件。",
        "- 最多调用 2 次工具。读完文件后立刻按下面的 JSON 结构输出答案，不要再做任何探索。"
      ]),
    "- 文件内容不足时字段留空并写进 warnings，不要通过其它途径补全。",
    "",
    "任务：把文件里真实出现的「客户（公司）」信息提取出来，供 CRM 的「新增客户」表单自动回填。",
    "",
    "硬性要求：",
    "1. 只使用文件里真实出现的信息。识别不到的字段一律填空字符串，绝不猜测、绝不编造邮箱 / 电话 / WhatsApp / 地址。",
    "2. 同一字段在多个文件里冲突时，采用信息最完整的那条，并在 warnings 里说明冲突。",
    "3. whatsapp 必须含国家码且以 + 开头；文件里只有本地号码又无法确定国家码时留空。",
    "4. 图片或扫描件请直接识别图像内容；某个文件打不开或解析不了，就写进 warnings 后继续处理其它文件，不要中断。",
    "",
    "输出纪律（最重要，违反即整次识别作废）：",
    "1. 你的整个回复必须**以 { 开头、以 } 结尾**，中间**只有这一个 JSON 对象**。",
    "2. 禁止任何解释、开场白、结语，禁止 markdown 代码块（不要写 ``` ），禁止在 JSON 前后加任何字符。",
    "3. **即使一个字段都没有抽到，也必须原样输出下面这个完整结构**：字段留空字符串、confidence 填 0、warnings 写清原因。绝对不允许只回一句说明文字或只回「无法识别」。",
    "4. JSON 语法符号一律使用英文半角：{ } [ ] : , 以及英文双引号 \" \"；不要写全角符号（：，｛｝），不要写成 Python 字典或 JS 对象。",
    "5. 字符串值内部**不要出现英文双引号**（需要引用原文时用「」），**不要出现换行**；一句话写完，需要分隔就用中文分号。",
    "6. 读不出来 / 打不开 / 是二进制格式的文件，把「文件名 + 具体原因」写进 warnings，其余字段照常留空，不要因此改变输出格式或中断。",
    "",
    "输出 JSON 结构：",
    "{",
    '  "fields": {',
    fields,
    "  },",
    '  "confidence": 0 到 1 之间的数字，表示整体识别置信度,',
    '  "warnings": ["需要人工核对的地方，最多 5 条"],',
    '  "summary": "一句话说明这批文件是什么资料、识别到了什么，不超过 80 字"',
    "}"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 识别链路：暂存 → 单任务批量识别 → 排队/故障如实上报
//
// 速度与体验（2026-10-10 本机实测，见自动化体检记录）：
//   1) CLI 自身执行只要 8-20 秒——前提是提示词带了工具纪律与快速模式标记；
//      默认参数下它会把自己当编码 Agent 去探索整个工作目录，实测 178 秒 / 53 次工具调用。
//   2) 真正的长等待来自「Runner 同时只执行一个任务」：实测有任务在队列里等了 107 秒，
//      而 CLI 真正跑只用了 21 秒。所以排队状态必须如实告诉用户，不能让人干等。
//   3) 多个文件合并成**一个** CLI 任务：原先一个文件一个任务，3 个文件要串行 3 次 CLI。
// ---------------------------------------------------------------------------
const CUSTOMER_INTAKE_MAX_FILES = 3;

/** 暂存文件存活上限：用户选了文件却一直没点识别时，半小时后自动清理 */
const CUSTOMER_INTAKE_STAGE_TTL_MS = 30 * 60 * 1000;

interface CustomerIntakeStagedFile {
  id: string;
  storagePath: string;
  /**
   * Office 文档（xls / xlsx / docx）转出来的纯文本路径。
   * CLI 的 Read 读不了二进制，所以交给它的其实一直是这个文本文件；
   * 没有这一项（图片、PDF、txt 等）时才直接读原件。
   */
  textPath?: string;
  name: string;
  mime: string;
  size: number;
  teamId: string;
  ownerId: string;
  createdAt: number;
  /** 转换成功时的一句话说明（「已由 CRM 从 Excel 转为文本」） */
  convertNote?: string;
  /** 转换失败时的可执行建议（怎么改文件格式再传） */
  convertError?: string;
}

const customerIntakeStaged = new Map<string, CustomerIntakeStagedFile>();

/** 任务号 → 该任务用到的文件（仅 id + 原名，任务结束后文件立即删除，这里只留展示用的名字） */
const customerIntakeTaskFiles = new Map<string, Array<{ id: string; name: string }>>();

/** 客户资料属于敏感数据：原件与转换出的文本都要删干净 */
async function removeCustomerIntakeStagedFile(file: CustomerIntakeStagedFile) {
  await rm(file.storagePath, { force: true }).catch(() => undefined);
  if (file.textPath) await rm(file.textPath, { force: true }).catch(() => undefined);
}

async function purgeCustomerIntakeStaging(nowMs = Date.now()) {
  for (const [id, file] of Array.from(customerIntakeStaged.entries())) {
    if (nowMs - file.createdAt < CUSTOMER_INTAKE_STAGE_TTL_MS) continue;
    customerIntakeStaged.delete(id);
    await removeCustomerIntakeStagedFile(file);
  }
}

/** 暂存文件名：ci_<uuid>.<扩展名>（原件与转换出的 .txt 都是这个形状） */
const CUSTOMER_INTAKE_STAGED_NAME = /^ci_[0-9a-f-]{8,}\.[a-z0-9]{1,8}$/u;

/** 孤儿扫描节流：同一个目录 5 分钟内不重复扫 */
const CUSTOMER_INTAKE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const customerIntakeSweptAt = new Map<string, number>();

/**
 * 清掉磁盘上的**孤儿**暂存文件。
 *
 * 暂存表是内存 Map，后端一重启就空了——磁盘上那些 ci_* 文件从此再也不会被 TTL 清掉，
 * 而它们装的是名片、合同、形式发票这类敏感资料，不该无声无息躺在磁盘上（本机实测就
 * 攒下过 5 个这样的残留）。这里扫描目录，只要文件不在当前暂存表里、又超过存活上限，就删。
 */
async function sweepCustomerIntakeOrphans(dir: string) {
  const now = Date.now();
  const last = customerIntakeSweptAt.get(dir) || 0;
  if (now - last < CUSTOMER_INTAKE_SWEEP_INTERVAL_MS) return;
  customerIntakeSweptAt.set(dir, now);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const live = new Set<string>();
  for (const file of customerIntakeStaged.values()) {
    live.add(path.resolve(file.storagePath));
    if (file.textPath) live.add(path.resolve(file.textPath));
  }
  for (const name of names) {
    if (!CUSTOMER_INTAKE_STAGED_NAME.test(name)) continue;
    const target = path.resolve(dir, name);
    if (live.has(target)) continue;
    try {
      const info = await stat(target);
      if (now - info.mtimeMs < CUSTOMER_INTAKE_STAGE_TTL_MS) continue;
    } catch {
      continue;
    }
    await rm(target, { force: true }).catch(() => undefined);
  }
}

/** 任务终态后立刻删掉客户资料原件：名片/合同属于敏感数据，不能长期躺在磁盘上 */
async function releaseCustomerIntakeFiles(ids: string[]) {
  for (const id of ids) {
    const file = customerIntakeStaged.get(id);
    if (!file) continue;
    customerIntakeStaged.delete(id);
    await removeCustomerIntakeStagedFile(file);
  }
}

function rememberCustomerIntakeTaskFiles(taskId: string, files: Array<{ id: string; name: string }>) {
  customerIntakeTaskFiles.set(taskId, files);
  while (customerIntakeTaskFiles.size > 200) {
    const oldest = customerIntakeTaskFiles.keys().next().value;
    if (oldest === undefined || oldest === taskId) break;
    customerIntakeTaskFiles.delete(oldest);
  }
}

async function finalizeCustomerIntakeTask(taskId: string) {
  const files = customerIntakeTaskFiles.get(taskId) || [];
  await releaseCustomerIntakeFiles(files.map((file) => file.id));
}

function elapsedSecondsSince(iso: string) {
  if (!iso) return 0;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : 0;
}

/** 从任务事件流里挑一句「现在在干什么」，让前端能显示实时步骤而不是干等 */
function engineTaskProgressText(snapshot: EngineCliTaskSnapshot) {
  const relevant = snapshot.events.filter((event) => ["status", "progress", "warning"].includes(event.eventType) && event.message.trim());
  const last = relevant[relevant.length - 1];
  return last ? last.message.replace(/\s+/gu, " ").trim().slice(0, 160) : "";
}

interface CustomerIntakeQueuePayload {
  queuedSeconds: number;
  runningSeconds: number;
  runnerOnline: boolean;
  busy: boolean;
}

function customerIntakeQueuePayload(
  snapshot: EngineCliTaskSnapshot,
  state: { runnerOnline: boolean; busy: boolean } | null
): CustomerIntakeQueuePayload {
  return {
    queuedSeconds: snapshot.status === "queued" ? elapsedSecondsSince(snapshot.queuedAt) : 0,
    runningSeconds: snapshot.status === "running" ? elapsedSecondsSince(snapshot.startedAt) : 0,
    runnerOnline: state ? state.runnerOnline : true,
    busy: Boolean(state?.busy)
  };
}

function customerIntakeResult(input: {
  pending: boolean;
  status: string;
  taskId: string;
  engine: string;
  fileNames: string[];
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  progress?: string;
  queue?: CustomerIntakeQueuePayload;
}) {
  // 归因分四种：解析出字段 / 解析成功但零字段 / 真解析不出 JSON / 什么都没返回。
  // 2026-10-10 实测事故：CLI 因为读不了二进制 .xls 而回了一个**合法**的空字段 JSON，
  // 旧逻辑只看「有没有字段」，于是报「返回内容不是可解析的 JSON」——结论与真实原因完全相反。
  // 结果能解析出字段就是可用结果，哪怕任务状态是 failed：
  //   CLI 已经完整输出了 JSON，却在收尾的 result 事件上报了一次上游错误（错误原文是个 MySQL
  //   死锁串），旧逻辑会把到手的结果整份丢掉、只在界面上留下「失败」。识别结果是要人核对后
  //   才落库的，这里宁可带着警告把字段填上去。
  const parsed = parseCustomerIntakeResult({
    resultText: input.resultText,
    status: input.status,
    outputTruncated: input.outputTruncated
  });
  const fields = parsed.fields;
  let warnings = parsed.warnings;
  const usable = parsed.usable;
  const salvaged = usable && input.status !== "succeeded";
  if (salvaged) {
    warnings = [
      `本机 CLI 在收尾时报了错（${(input.errorMessage || "未知原因").slice(0, 120)}），但识别结果已经完整拿到，请核对后使用`,
      ...warnings
    ];
  }
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.status);
  let diagnosis: EngineCliIssue | null = null;
  if (usable) {
    diagnosis = null;
  } else if (input.status === "failed") {
    diagnosis = classifyEngineCliIssue(input.errorMessage || "本机 CLI 任务失败", /codex/iu.test(input.engine) ? "codex" : "workbuddy");
  } else if (input.status === "cancelled") {
    diagnosis = {
      code: "cli_failed",
      title: "识别任务被中断",
      detail: "本机 CLI 任务没有跑完（被取消，或 Runner 在执行过程中重启）。",
      command: "确认本机 Runner 在运行后重新识别"
    };
  } else if (!terminal && input.queue && !input.queue.runnerOnline && input.queue.queuedSeconds >= 15) {
    diagnosis = engineRunnerOfflineIssue(
      `任务已排队 ${input.queue.queuedSeconds} 秒，但 Runner 的心跳已经断了：Runner 可能被关闭或重启了。`
    );
  }
  return {
    pending: input.pending,
    status: input.status,
    terminal,
    outcome: parsed.outcome,
    usable,
    salvaged,
    taskId: input.taskId,
    engine: input.engine,
    /** 兼容旧调用方：单文件时就是那个文件名 */
    fileName: input.fileNames[0] || "",
    fileNames: input.fileNames,
    fields,
    warnings,
    summary: parsed.summary,
    confidence: parsed.confidence,
    parseError: parsed.parseError,
    /** 解析成功但一个字段都没抽到时的如实说明（多半是文件本身读不出内容） */
    emptyReason: parsed.emptyReason,
    /** 原始返回片段，供「识别不到」时自查 */
    rawPreview: parsed.rawPreview,
    errorMessage: input.errorMessage,
    outputTruncated: input.outputTruncated,
    progress: input.progress || "",
    queue: input.queue || null,
    diagnosis
  };
}

// ---------------------------------------------------------------------------
// 供应商管理（仿「客户管理」的列表 / 新增 / 编辑 / 删除）
//
// 与客户的两点差异，都是刻意的：
//  ① 供应商是公司共享资产 —— 列表按团队取，不做「我的/公池」那套归属流转；
//  ② 独立表 + 独立仓库（不走 store.persistAll 的 92 张表全量重写），写入是单行 SQL。
// ---------------------------------------------------------------------------
const supplierInputSchema = z.object({
  code: z.string().trim().max(40).regex(/^[A-Za-z0-9._-]*$/u, "编码只能用字母、数字、点、下划线、连字符").optional(),
  company: z.string().trim().min(1, "请填写供应商名称").max(200),
  companyFullName: z.string().trim().max(200).optional(),
  country: z.string().trim().max(80).optional(),
  category: z.string().trim().max(300).optional(),
  contact: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(80).optional(),
  email: z.string().trim().max(160).optional(),
  wechat: z.string().trim().max(80).optional(),
  website: z.string().trim().max(255).optional(),
  address: z.string().trim().max(500).optional(),
  paymentTerm: z.string().trim().max(200).optional(),
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  grade: z.enum(["A", "B", "C", "D"]).optional(),
  status: z.enum(["active", "evaluating", "paused"]).optional(),
  source: z.string().trim().max(120).optional(),
  remark: z.string().max(2000).optional()
});

function findDuplicateCustomer(store: ReturnType<typeof getStore>, teamId: string, company: string, country: string, excludeId = "") {
  const key = entityDuplicateKey(company, country);
  return store.customers.find((item) =>
    item.id !== excludeId
    && item.teamId === teamId
    && entityDuplicateKey(item.company, item.country) === key
  );
}

export function registerCustomersRoutes(app: Express) {
  app.get("/api/customers", requireAuth, (req, res) => {
    const parsedScope = z.enum(["mine", "public", "team"]).safeParse(req.query.scope || "mine");
    if (!parsedScope.success) {
      res.status(400).json({ message: "客户范围参数无效" });
      return;
    }
    const scoped = parsedScope.data === "public"
      ? publicPoolCustomersFor(req.user!)
      : ownedCustomersFor(req.user!, parsedScope.data);
    res.json({
      customers: scoped.map((customer) => customerWithPipeline(customer, req.user!)),
      ...customerPoolCounts(req.user!)
    });
  });

  app.post("/api/customers", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      company: z.string().min(1),
      country: z.string().min(1).default("未知"),
      contact: z.string().min(1).default("待维护"),
      whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional().default(""),
      wechat: z.string().trim().max(100).optional().default(""),
      otherNotes: z.string().trim().max(2000).optional().default(""),
      stage: z.string().min(1).default("询盘"),
      amount: z.number().int().nonnegative().default(0),
      health: z.number().int().min(0).max(100).optional().default(72),
      source: z.string().trim().max(120).optional().default("手动新增"),
      companyFullName: z.string().trim().max(200).optional().default(""),
      grade: z.enum(["A", "B", "C", "D"]).optional().default("C"),
      lifecycleStatus: z.enum(["open", "won"]).optional().default("open"),
      billingName: z.string().optional().default(""),
      billingAddress: z.string().optional().default(""),
      documentContact: z.string().optional().default(""),
      contactRemark: z.string().max(500).optional().default(""),
      phone: z.string().optional().default(""),
      email: z.string().optional().default(""),
      website: z.string().optional().default(""),
      defaultPortDischarge: z.string().optional().default(""),
      defaultIncoterm: z.string().optional().default(""),
      defaultPaymentTerm: z.string().optional().default("")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    if (body.company.trim()) {
      const duplicate = findDuplicateCustomer(store, req.user!.teamId, body.company, body.country);
      if (duplicate) {
        res.status(409).json({
          message: `客户已存在：「${duplicate.company}」（${duplicate.country || "国家未知"}）已在客户列表中，不能重复添加`,
          errorCode: "CUSTOMER_DUPLICATE",
          existingId: duplicate.id
        });
        return;
      }
    }
    const companyFullName = body.companyFullName || body.billingName || body.company;
    const now = new Date().toISOString();
    const customer = {
      id: `c_${Date.now()}`,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      nextReminder: "明天 10:00",
      wecomBound: false,
      // lifecycleStatus 由 schema default("open") 提供：新增默认未成交，表单选了已成交则随 body 带入
      wonAt: body.lifecycleStatus === "won" ? now : undefined,
      ...body,
      companyFullName,
      billingName: body.billingName || companyFullName
    };
    store.customers.unshift(customer);
    await store.persist();
    res.json({ customer: customerWithPipeline(customer, req.user!) });
  }));

  /** 上传客户资料到本机暂存区（识别前的第一步；这一步就会暴露「Runner 没在跑」） */
  app.post("/api/customers/intake/files", requireAuth, express.raw({ type: "application/octet-stream", limit: CUSTOMER_INTAKE_MAX_BYTES }), asyncRoute(async (req, res) => {
    const encodedFileName = String(req.headers["x-file-name"] || "").trim();
    let fileName = "";
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      res.status(400).json({ message: "文件名编码无效" });
      return;
    }
    fileName = path.basename(fileName).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255);
    if (!fileName) {
      res.status(400).json({ message: "请选择要识别的客户资料文件" });
      return;
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) {
      res.status(400).json({ message: "文件内容为空，请重新选择" });
      return;
    }
    const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/u)?.[1] || "";
    if (!CUSTOMER_INTAKE_EXTENSIONS.has(extension)) {
      res.status(415).json({ message: `暂不支持 ${extension ? `.${extension}` : "该"} 文件；请上传 PDF、图片、Word / Excel、CSV 或文本资料` });
      return;
    }
    await purgeCustomerIntakeStaging();
    const mine = Array.from(customerIntakeStaged.values()).filter((file) => file.ownerId === req.user!.id);
    if (mine.length >= CUSTOMER_INTAKE_MAX_FILES) {
      res.status(400).json({ message: `一次最多识别 ${CUSTOMER_INTAKE_MAX_FILES} 个文件，请先识别或清空已选文件` });
      return;
    }
    const settings = await readTeamAiEngineSettings(req.user!.teamId);
    let choice;
    try {
      choice = await pickEngineRunner(req.user!, settings);
    } catch (error) {
      if (!(error instanceof EngineUnavailableError)) throw error;
      res.status(error.status).json({ message: error.message, diagnosis: engineRunnerOfflineIssue(error.message, error.code) });
      return;
    }
    const intakeDir = await resolveCustomerIntakeDir(choice.workspace);
    // 顺手清掉上次进程留下的残留资料（暂存表在内存里，重启后就成孤儿了）
    await sweepCustomerIntakeOrphans(intakeDir);
    const id = `cif_${randomUUID()}`;
    const storagePath = path.join(intakeDir, `ci_${randomUUID()}.${extension}`);
    await writeFile(storagePath, buffer, { flag: "wx" });
    // 二进制 Office 文档先转成纯文本：CLI 的 Read 对 .xls/.xlsx/.docx 只能拿到乱码，
    // 读到乱码必然回一个空字段的 JSON（2026-10-10 实测事故的根源），所以在这里就补上。
    // 转换失败**不阻断上传**：有些 .xls 其实是 HTML/XML 伪装的，CLI 直接读原件反而能读出来，
    // 所以仍把原件交给它，只在文件条目上说明「没能自动转换」。
    let textPath: string | undefined;
    let convertNote = "";
    let convertError = "";
    if (OFFICE_BINARY_EXTENSIONS.has(extension)) {
      const extracted = await officeDocumentToText(storagePath, extension);
      let written = "";
      if (extracted) {
        const candidate = path.join(intakeDir, `ci_${randomUUID()}.txt`);
        try {
          await writeFile(candidate, extracted.text, { flag: "wx" });
          written = candidate;
        } catch {
          written = "";
        }
      }
      if (written) {
        textPath = written;
        convertNote = extracted?.note || "已由 CRM 转为纯文本";
      } else {
        convertError = officeExtensionHint(extension);
      }
    }
    customerIntakeStaged.set(id, {
      id, storagePath, textPath: textPath || undefined, name: fileName,
      mime: String(req.headers["x-file-type"] || "application/octet-stream").trim().toLowerCase().slice(0, 120),
      size: buffer.length, teamId: req.user!.teamId, ownerId: req.user!.id, createdAt: Date.now(),
      convertNote: convertNote || undefined, convertError: convertError || undefined
    });
    res.status(201).json({
      fileId: id,
      name: fileName,
      size: buffer.length,
      converted: Boolean(textPath),
      convertNote,
      convertError,
      engine: `${aiEngineAdapterLabel(choice.adapter)}${choice.cliVersion ? ` ${choice.cliVersion}` : ""}`
    });
  }));

  /** 把已暂存的 1-3 个文件合并成**一个** CLI 任务识别 */
  app.post("/api/customers/intake/analyze", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      fileIds: z.array(z.string().trim().min(4).max(80)).min(1).max(CUSTOMER_INTAKE_MAX_FILES)
    }).strict().parse(req.body || {});
    const staged = body.fileIds.map((id) => customerIntakeStaged.get(id));
    const invalid = staged.some((file) => !file || file.ownerId !== req.user!.id || file.teamId !== req.user!.teamId);
    if (invalid) {
      res.status(409).json({ message: "文件已过期（超过 30 分钟或已识别过），请重新选择文件" });
      return;
    }
    const files = staged as CustomerIntakeStagedFile[];
    const settings = await readTeamAiEngineSettings(req.user!.teamId);
    let choice;
    try {
      choice = await pickEngineRunner(req.user!, settings);
    } catch (error) {
      if (!(error instanceof EngineUnavailableError)) throw error;
      res.status(error.status).json({ message: error.message, diagnosis: engineRunnerOfflineIssue(error.message, error.code) });
      return;
    }
    const enqueued = await enqueueEngineCliTask(
      req.user!,
      choice,
      customerIntakePrompt(
        files.map((file) => ({
          name: file.name,
          readPath: file.textPath || file.storagePath,
          converted: Boolean(file.textPath)
        })),
        // 两个 CLI 都带提速档位：Codex 只认其中的 effort（Runner 侧忽略 maxTurns / disallowedTools）
        { speedProfile: true, adapter: choice.adapter }
      ),
      clampAiEngineTimeout(settings.cliTimeoutSeconds),
      // 用户选的模型 / 档位优先于识别任务的默认 low：设置里写了就按设置来。
      // maxTurns 与 disallowedTools 由提示词自带，不受影响（那是「别探索仓库」的硬约束）。
      engineCliProfile(settings, choice.adapter)
    );
    rememberCustomerIntakeTaskFiles(enqueued.taskId, files.map((file) => ({ id: file.id, name: file.name })));
    const snapshot = await waitForEngineCliTask(req.user!, enqueued.taskId, 0);
    const status = snapshot?.status || "queued";
    const terminal = Boolean(snapshot) && cliTaskDone(status);
    const queueState = snapshot && !terminal ? await engineRunnerQueueState(req.user!, snapshot) : null;
    const payload = customerIntakeResult({
      pending: !terminal,
      status,
      taskId: enqueued.taskId,
      engine: enqueued.engine,
      fileNames: files.map((file) => file.name),
      resultText: snapshot?.resultText || "",
      errorMessage: snapshot?.errorMessage || "",
      outputTruncated: Boolean(snapshot?.outputTruncated),
      progress: snapshot ? engineTaskProgressText(snapshot) : "",
      queue: snapshot ? customerIntakeQueuePayload(snapshot, queueState) : undefined
    });
    if (terminal) await finalizeCustomerIntakeTask(enqueued.taskId);
    res.status(terminal ? 200 : 202).json(payload);
  }));

  app.get("/api/customers/intake/analyze/:taskId", requireAuth, asyncRoute(async (req, res) => {
    const taskId = String(req.params.taskId || "").trim();
    if (!/^lrt_[A-Za-z0-9_-]{4,80}$/u.test(taskId)) {
      res.status(400).json({ message: "识别任务号格式无效" });
      return;
    }
    const snapshot = await readEngineCliTask(req.user!, taskId);
    if (!snapshot) {
      res.status(404).json({ message: "识别任务不存在或已过期，请重新上传文件" });
      return;
    }
    const terminal = cliTaskDone(snapshot.status);
    const fileNames = (customerIntakeTaskFiles.get(taskId) || []).map((file) => file.name);
    // 排队超过 5 秒就带上排队实况：Runner 同时只跑一个任务，「排在别人后面」是慢的主因
    const queueState = !terminal && snapshot.status === "queued" && elapsedSecondsSince(snapshot.queuedAt) >= 5
      ? await engineRunnerQueueState(req.user!, snapshot)
      : null;
    const payload = customerIntakeResult({
      pending: !terminal,
      status: snapshot.status,
      taskId,
      engine: "",
      fileNames,
      resultText: snapshot.resultText || "",
      errorMessage: snapshot.errorMessage || "",
      outputTruncated: Boolean(snapshot.outputTruncated),
      progress: engineTaskProgressText(snapshot),
      queue: customerIntakeQueuePayload(snapshot, queueState)
    });
    if (terminal) await finalizeCustomerIntakeTask(taskId);
    res.json(payload);
  }));

  /**
   * 本机 CLI 健康检查：弹窗一打开就调它。
   * 目标是「在用户白等之前」把 CLI 连不上的原因讲清楚——Runner 没跑 / CLI 没登录 / 上次任务网络失败。
   */
  app.get("/api/customers/intake/health", requireAuth, asyncRoute(async (req, res) => {
    const settings = await readTeamAiEngineSettings(req.user!.teamId);
    const checkedAt = new Date().toISOString();
    let choice;
    try {
      choice = await pickEngineRunner(req.user!, settings);
    } catch (error) {
      const issue = error instanceof EngineUnavailableError
        ? engineRunnerOfflineIssue(error.message, error.code)
        : { code: "cli_failed" as const, title: "无法使用本机 CLI", detail: error instanceof Error ? error.message : "", command: "" };
      res.json({ ready: false, checkedAt, engine: "", adapter: "", runner: null, busy: null, lastFailure: null, issue });
      return;
    }
    const service = getLocalRunnerService();
    const briefs = service ? await service.taskBriefs(req.user!, choice.runnerId, 8) : [];
    const active = briefs.find((task) => task.status === "running" || task.status === "cancelling") || null;
    const queued = briefs.find((task) => task.status === "queued") || null;
    // 只报告「最近一次跑完的任务失败」：CLI 恢复后（下一次成功）这条提示会自动消失，
    // 免得拿几天前的一次偶发失败一直吓唬用户。
    const lastTerminal = briefs.find((task) => ["succeeded", "failed", "cancelled"].includes(task.status)) || null;
    const failed = lastTerminal && lastTerminal.status === "failed"
      && Date.now() - Date.parse(lastTerminal.createdAt) < 24 * 60 * 60 * 1000
      ? lastTerminal
      : null;
    const busyTask = active || queued;
    res.json({
      ready: true,
      checkedAt,
      engine: `${aiEngineAdapterLabel(choice.adapter)}${choice.cliVersion ? ` ${choice.cliVersion}` : ""}`,
      adapter: choice.adapter,
      runner: {
        id: choice.runnerId,
        displayName: choice.displayName,
        workspace: choice.workspace,
        cliVersion: choice.cliVersion,
        // 这台机器上报的最近一次 CLI 故障说明（账号切换 / CLI 重启 / 符号链接悬空）。
        // 界面用它解释"CLI 就绪但为什么这台机器少了某项能力"，不做任何自动修复。
        cliIssue: choice.cliIssue
      },
      busy: busyTask
        ? {
          taskId: busyTask.id,
          status: busyTask.status,
          label: busyTask.promptHead.replace(/^\[\[gj-cli-options[^\]]*\]\]\s*/u, "").slice(0, 60),
          elapsedSeconds: elapsedSecondsSince(busyTask.status === "queued" ? busyTask.createdAt : busyTask.startedAt || busyTask.createdAt)
        }
        : null,
      lastFailure: failed
        ? {
          taskId: failed.id,
          at: failed.createdAt,
          adapter: failed.adapter,
          ...classifyEngineCliIssue(failed.errorMessage, failed.adapter)
        }
        : null,
      issue: null
    });
  }));

  app.patch("/api/customers/:id", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      company: z.string().min(1).optional(),
      country: z.string().min(1).optional(),
      contact: z.string().min(1).optional(),
      whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional(),
      wechat: z.string().trim().max(100).optional(),
      otherNotes: z.string().trim().max(2000).optional(),
      stage: z.string().min(1).optional(),
      amount: z.number().int().nonnegative().optional(),
      health: z.number().int().min(0).max(100).optional(),
      source: z.string().trim().max(120).optional(),
      companyFullName: z.string().trim().max(200).optional(),
      grade: z.enum(["A", "B", "C", "D"]).optional(),
      lifecycleStatus: z.enum(["open", "won"]).optional(),
      nextReminder: z.string().min(1).optional(),
      wecomBound: z.boolean().optional(),
      billingName: z.string().optional(),
      billingAddress: z.string().optional(),
      documentContact: z.string().optional(),
      contactRemark: z.string().max(500).optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      defaultPortDischarge: z.string().optional(),
      defaultIncoterm: z.string().optional(),
      defaultPaymentTerm: z.string().optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const customer = findWritableCustomer(req.user!, req.params.id, res);
    if (!customer) return;
    const normalizedBody = { ...body } as Record<string, unknown>;
    if (body.companyFullName !== undefined) normalizedBody.billingName = body.companyFullName || customer.billingName || customer.company;
    else if (body.billingName !== undefined) normalizedBody.companyFullName = body.billingName || customer.companyFullName || customer.company;
    // 成交痕迹与状态保持一致：手动标记成交补 wonAt；改回未成交就清掉成交痕迹（wonByDealId 是商机锚点，跟着清）。
    if (body.lifecycleStatus === "won") {
      customer.wonAt ||= new Date().toISOString();
    } else if (body.lifecycleStatus === "open") {
      normalizedBody.wonAt = undefined;
      normalizedBody.wonByDealId = "";
    }
    Object.assign(customer, normalizedBody);
    await store.persist();
    res.json({ customer: customerWithPipeline(customer, req.user!) });
  }));

  app.post("/api/customers/:id/release", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      reason: z.string().trim().min(2).max(500),
      expectedVersion: z.number().int().nonnegative().optional()
    }).parse(req.body);
    const store = getStore();
    if (!store.mutateCustomerOwnership) {
      res.status(503).json({ message: "客户公池服务暂不可用" });
      return;
    }
    try {
      const customer = store.customers.find((item) => item.id === req.params.id);
      const result = await store.mutateCustomerOwnership({
        action: "release",
        customerId: req.params.id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        actorTeamId: req.user!.teamId,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
        occurredAt: new Date().toISOString(),
        authorization: {
          canRelease: hasIamPermission(req.user, "customer.pool.release") && Boolean(customer && canSeeOwner(req.user!, customer.ownerId, customer.teamId)),
          canClaim: hasIamPermission(req.user, "customer.pool.claim")
        }
      });
      res.json({
        customer: customerWithPipeline(result.customer, req.user!),
        event: result.event,
        cancelledTodoCount: result.cancelledTodoIds.length,
        ...customerPoolCounts(req.user!)
      });
    } catch (error) {
      if (!sendCustomerOwnershipError(res, error)) throw error;
    }
  }));

  app.post("/api/customers/:id/claim", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      expectedVersion: z.number().int().nonnegative().optional()
    }).parse(req.body || {});
    const store = getStore();
    if (!store.mutateCustomerOwnership) {
      res.status(503).json({ message: "客户公池服务暂不可用" });
      return;
    }
    try {
      const result = await store.mutateCustomerOwnership({
        action: "claim",
        customerId: req.params.id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        actorTeamId: req.user!.teamId,
        expectedVersion: body.expectedVersion,
        occurredAt: new Date().toISOString(),
        authorization: {
          canRelease: hasIamPermission(req.user, "customer.pool.release"),
          canClaim: hasIamPermission(req.user, "customer.pool.claim")
        }
      });
      res.json({
        customer: customerWithPipeline(result.customer, req.user!),
        event: result.event,
        ...customerPoolCounts(req.user!)
      });
    } catch (error) {
      if (!sendCustomerOwnershipError(res, error)) throw error;
    }
  }));

  app.post("/api/customers/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
    const body = schema.parse(req.body);
    const store = getStore();
    const ids = [...new Set(body.ids)];
    const deleted = store.customers.filter((customer) =>
      ids.includes(customer.id)
      && !isPublicCustomer(customer)
      && canSeeOwner(req.user!, customer.ownerId, customer.teamId)
    );
    if (!deleted.length) {
      res.status(404).json({ message: "未找到可删除的客户" });
      return;
    }
    const deletedIds = new Set(deleted.map((customer) => customer.id));
    const deletedNames = deleted.map((customer) => customer.company);
    store.customers = store.customers.filter((customer) => !deletedIds.has(customer.id));
    store.customerActivities = store.customerActivities.filter((activity) => !deletedIds.has(activity.customerId));
    store.customerIntelligenceSuggestions =
      store.customerIntelligenceSuggestions.filter(
        (suggestion) => !deletedIds.has(suggestion.customerId)
      );
    const deletedDealIds = new Set(store.deals.filter((deal) => deletedIds.has(deal.customerId)).map((deal) => deal.id));
    store.deals = store.deals.filter((deal) => !deletedIds.has(deal.customerId));
    store.dealEvents = store.dealEvents.filter((event) => !deletedDealIds.has(event.dealId));
    store.todos = store.todos.filter((todo) => {
      const currentUserTodo = canSeePersonalData(req.user!, todo.ownerId);
      const relatedToDeletedCustomer = deletedNames.some((name) => todo.related.includes(name) || todo.title.includes(name));
      return !currentUserTodo || !relatedToDeletedCustomer;
    });
    await store.persist();
    const customers = ownedCustomersFor(req.user!);
    res.json({ deleted, customers });
  }));

  app.get("/api/suppliers", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSupplierRepository();
    if (!repository) { res.status(503).json({ message: "供应商库不可用" }); return; }
    // 供应商是团队资产：按 teamId 取全量，不再按 ownerId 二次过滤
    // （否则创建人离职/停用后，他录入的供应商会从列表里整批消失）。
    const suppliers = await repository.list(req.user!.teamId);
    res.json({ suppliers });
  }));

  app.post("/api/suppliers", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSupplierRepository();
    if (!repository) { res.status(503).json({ message: "供应商库不可用" }); return; }
    const body = supplierInputSchema.parse(req.body);
    const existing = await repository.list(req.user!.teamId);
    const key = supplierDuplicateKey(body.company, body.country || "");
    const duplicate = existing.find((row) => supplierDuplicateKey(row.company, row.country) === key);
    if (duplicate) {
      res.status(409).json({
        message: `供应商已存在：「${duplicate.company}」（${duplicate.country || "国家未登记"}）已在供应商库里`,
        errorCode: "SUPPLIER_DUPLICATE",
        existingId: duplicate.id
      });
      return;
    }
    try {
      const supplier = await repository.create(req.user!.id, req.user!.teamId, {
        ...body,
        source: body.source || "手动新增"
      } satisfies SupplierInput);
      res.json({ supplier });
    } catch (error) {
      if (!(error instanceof SupplierCodeConflictError)) throw error;
      res.status(409).json({ message: error.message, errorCode: error.errorCode, supplierCode: error.supplierCode });
    }
  }));

  app.patch("/api/suppliers/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSupplierRepository();
    if (!repository) { res.status(503).json({ message: "供应商库不可用" }); return; }
    const body = supplierInputSchema.partial().parse(req.body);
    try {
      const supplier = await repository.update(req.user!.teamId, req.params.id, body);
      if (!supplier) { res.status(404).json({ message: "供应商不存在或无权访问" }); return; }
      res.json({ supplier });
    } catch (error) {
      if (!(error instanceof SupplierCodeConflictError)) throw error;
      res.status(409).json({ message: error.message, errorCode: error.errorCode, supplierCode: error.supplierCode });
    }
  }));

  app.post("/api/suppliers/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSupplierRepository();
    if (!repository) { res.status(503).json({ message: "供应商库不可用" }); return; }
    const body = z.object({ ids: z.array(z.string().trim().min(1)).min(1).max(200) }).parse(req.body);
    const deleted = await repository.removeMany(req.user!.teamId, body.ids);
    if (!deleted.length) { res.status(404).json({ message: "未找到可删除的供应商" }); return; }
    // 供应商没了，附件引用必须一起清：否则文件既没有归属对象、又因 referenceCount>0 删不掉
    const files = getFileRepository();
    if (files) {
      await Promise.all(deleted.map((id) => files.removeReferencesForEntity("supplier", id).catch(() => 0)));
    }
    res.json({ deleted, suppliers: await repository.list(req.user!.teamId) });
  }));

  app.post("/api/customers/:id/activities", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      type: z.enum(["call", "email", "whatsapp", "wechat", "meeting", "note"]),
      content: z.string().trim().min(1).max(2000),
      nextReminder: z.string().trim().max(100).optional().default("")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const customer = findWritableCustomer(req.user!, req.params.id, res);
    if (!customer) return;
    const activity = {
      id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      customerId: customer.id,
      type: body.type,
      content: body.content,
      operatorId: req.user!.id,
      nextReminder: body.nextReminder,
      createdAt: new Date().toISOString()
    };
    store.customerActivities.unshift(activity);
    if (body.nextReminder) customer.nextReminder = body.nextReminder;
    void store.persist().catch((err) => console.error("customer activity persist failed:", err));
    res.json({ activity, customer: customerWithPipeline(customer, req.user!) });
  }));

  /**
   * 编辑一条客户跟进记录（2026-10-14）。
   *
   * 为什么必须有这个接口：WhatsApp 自动同步会把对话摘要**自动**写进跟进历史，
   * 而 `customerActivities` 同时是业绩报表里 `followUpCount` 的数据源
   * （见 `/api/reports` 的 performance 分支）。机器写的摘要必然有不准的时候，
   * 人得能改 —— 没有这个接口，自动写入就是**不可逆**的。
   *
   * 留痕规则：`createdAt` 与 `operatorId` 是「谁在什么时候创建」的事实，**不可改写**；
   * 编辑只写 `updatedAt` / `editedBy`。这样「机器写的、人改过的」始终分得清。
   */
  app.patch("/api/customers/:id/activities/:activityId", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      content: z.string().trim().min(1).max(2000).optional(),
      type: z.enum(["call", "email", "whatsapp", "wechat", "meeting", "note"]).optional(),
      nextReminder: z.string().trim().max(100).optional()
    }).refine((value) => Object.keys(value).length > 0, { message: "至少要修改一个字段" });
    const body = schema.parse(req.body || {});
    const store = getStore();
    const customer = findWritableCustomer(req.user!, req.params.id, res);
    if (!customer) return;
    // 必须同时校验 activityId **属于** 这个客户：否则只要知道 id 就能跨客户改记录
    const activity = store.customerActivities.find(
      (item) => item.id === req.params.activityId && item.customerId === customer.id
    );
    if (!activity) {
      res.status(404).json({ message: "跟进记录不存在或不属于该客户" });
      return;
    }
    if (body.content !== undefined) activity.content = body.content;
    if (body.type !== undefined) activity.type = body.type;
    if (body.nextReminder !== undefined) {
      activity.nextReminder = body.nextReminder;
      if (body.nextReminder) customer.nextReminder = body.nextReminder;
    }
    activity.updatedAt = new Date().toISOString();
    activity.editedBy = req.user!.id;
    void store.persist().catch((err) => console.error("customer activity persist failed:", err));
    res.json({ activity, customer: customerWithPipeline(customer, req.user!) });
  }));

  /**
   * 撤销一条客户跟进记录（2026-10-14）。
   *
   * 这是自动同步的**安全网**：记录写错了客户、或整条都是噪音时，
   * 必须能干净地撤掉，而不是留一条改不干净的痕迹。
   * DELETE 在 Agent 契约里自动落到 `explicit_confirmation`，不需要手工登记。
   */
  app.delete("/api/customers/:id/activities/:activityId", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const customer = findWritableCustomer(req.user!, req.params.id, res);
    if (!customer) return;
    const index = store.customerActivities.findIndex(
      (item) => item.id === req.params.activityId && item.customerId === customer.id
    );
    if (index < 0) {
      res.status(404).json({ message: "跟进记录不存在或不属于该客户" });
      return;
    }
    const [removed] = store.customerActivities.splice(index, 1);
    void store.persist().catch((err) => console.error("customer activity persist failed:", err));
    res.json({ removed: removed.id, customer: customerWithPipeline(customer, req.user!) });
  }));

  app.post("/api/customers/:id/meeting-notes", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const customer = findWritableCustomer(req.user!, req.params.id, res);
    if (!customer) return;
    const transcript = String(req.body?.transcript || "").trim();
    if (!transcript) { res.status(400).json({ message: "转写内容为空" }); return; }

    const config = getAiConfig(req.user!, "emailDraft");
    if (!config || !config.apiKey) {
      const activity = {
        id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        customerId: customer.id,
        type: "meeting" as const,
        content: `会议转写记录：${transcript.slice(0, 500)}${transcript.length > 500 ? "..." : ""}`,
        operatorId: req.user!.id,
        nextReminder: "",
        createdAt: new Date().toISOString()
      };
      store.customerActivities.unshift(activity);
      await store.persist();
      res.json({ summary: "AI 未配置，已保存原始转写记录。", actionItems: [], keyPoints: [], activityId: activity.id });
      return;
    }

    const prompt = `你是一个专业的外贸会议纪要助手。请分析以下会议转写内容，生成结构化纪要。\n\n转写内容：\n${transcript.slice(0, 8000)}\n\n请返回 JSON 格式：\n{"summary":"200字以内的会议摘要","keyPoints":["关键要点1","关键要点2"],"actionItems":["待办事项1（需要具体可执行）","待办事项2"]}\n\n注意：actionItems 中每条应是一个具体的待办任务，15字以内。只返回 JSON，不要其他内容。`;
    try {
      const aiResult = await callAiModel(config, prompt, 10000);
      const parsed = extractJsonObject(aiResult) as { summary: string; keyPoints: string[]; actionItems: string[] } | null;
      const summary = parsed?.summary || "会议纪要生成失败，请查看原始转写。";
      const keyPoints = parsed?.keyPoints || [];
      const actionItems = parsed?.actionItems || [];

      const activity = {
        id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        customerId: customer.id,
        type: "meeting" as const,
        content: `【会议纪要】${summary}${keyPoints.length ? `\n关键要点：${keyPoints.join("；")}` : ""}`,
        operatorId: req.user!.id,
        nextReminder: "",
        createdAt: new Date().toISOString()
      };
      store.customerActivities.unshift(activity);

      for (const item of actionItems.slice(0, 5)) {
        const todo = {
          id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: item,
          type: "customer" as const,
          customerId: customer.id,
          ownerId: req.user!.id,
          teamId: req.user!.teamId,
          priority: "medium" as const,
          related: customer.company,
          done: false,
          dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          createdAt: new Date().toISOString()
        };
        store.todos.unshift(todo);
      }

      await store.persist();
      res.json({ summary, actionItems, keyPoints, activityId: activity.id });
    } catch (err) {
      const activity = {
        id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        customerId: customer.id,
        type: "meeting" as const,
        content: `会议转写记录：${transcript.slice(0, 500)}`,
        operatorId: req.user!.id,
        nextReminder: "",
        createdAt: new Date().toISOString()
      };
      store.customerActivities.unshift(activity);
      await store.persist();
      res.json({ summary: `AI 分析失败，已保存原始转写。错误：${String(err).slice(0, 100)}`, actionItems: [], keyPoints: [], activityId: activity.id });
    }
  }));

  app.get("/api/customers/:id/intelligence", requireAuth, (req, res) => {
    const store = getStore();
    const customer = store.customers.find((item) =>
      item.id === req.params.id
      && canSeeOwner(req.user!, item.ownerId, item.teamId)
    );
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    const suggestions = store.customerIntelligenceSuggestions
      .filter((item) =>
        item.teamId === customer.teamId
        && item.ownerId === customer.ownerId
        && item.customerId === customer.id
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    res.json({ suggestions });
  });

  app.post("/api/customer-intelligence/:id/accept", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      selectedFields: z.array(z.enum([
        "company",
        "country",
        "contact",
        "documentContact"
      ])).max(4).default([])
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const suggestion = store.customerIntelligenceSuggestions.find((item) =>
      item.id === req.params.id
      && item.teamId === req.user!.teamId
    );
    if (suggestion && !findWritableCustomer(req.user!, suggestion.customerId, res)) return;
    try {
      const result = acceptCustomerIntelligence(store, {
        suggestionId: req.params.id,
        teamId: req.user!.teamId,
        ownerId: req.user!.id,
        selectedFields: body.selectedFields as CustomerIntelligenceFieldKey[]
      });
      await store.persist();
      res.json({
        suggestion: result.suggestion,
        customer: customerWithPipeline(result.customer, req.user!)
      });
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "采纳客户情报失败"
      });
    }
  }));

  app.post("/api/customer-intelligence/:id/reject", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      reason: z.string().trim().max(500).optional().default("")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const suggestion = store.customerIntelligenceSuggestions.find((item) =>
      item.id === req.params.id
      && item.teamId === req.user!.teamId
    );
    if (suggestion && !findWritableCustomer(req.user!, suggestion.customerId, res)) return;
    try {
      const result = rejectCustomerIntelligence(store, {
        suggestionId: req.params.id,
        teamId: req.user!.teamId,
        ownerId: req.user!.id,
        reason: body.reason
      });
      await store.persist();
      res.json({
        suggestion: result.suggestion,
        customer: customerWithPipeline(result.customer, req.user!)
      });
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "忽略客户情报失败"
      });
    }
  }));

  app.get("/api/import-export/jobs", requireAuth, (req, res) => {
    const { importExportJobs } = getStore();
    const visibleOperatorIds = new Set(getStore().users
      .filter((user) => canSeeOwner(req.user!, user.id, user.teamId))
      .map((user) => user.id));
    const scoped = importExportJobs.filter((job) => visibleOperatorIds.has(job.operatorId));
    res.json({ jobs: scoped });
  });

  app.post("/api/import-export/jobs", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ name: z.string().min(1), type: z.enum(["import", "export"]), rows: z.number().int().nonnegative() });
    const store = getStore();
    const body = schema.parse(req.body);
    const job = { id: `io_${Date.now()}`, status: body.type === "export" ? "review" as const : "done" as const, operatorId: req.user!.id, createdAt: "刚刚", ...body };
    store.importExportJobs.unshift(job);
    await store.persist();
    res.json({ job });
  }));

  app.post("/api/import-export/customers/import", requireAuth, asyncRoute(async (req, res) => {
    const rowSchema = z.object({
      customerId: z.string().trim().max(64).optional().default(""),
      company: z.string().trim().min(1),
      country: z.string().trim().optional().default("未知"),
      contact: z.string().trim().optional().default("待维护"),
      whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional().default(""),
      stage: z.string().trim().optional().default("询盘"),
      amount: z.number().nonnegative().optional().default(0),
      health: z.number().int().min(0).max(100).optional().default(70),
      source: z.string().trim().max(120).optional().default("批量导入"),
      companyFullName: z.string().trim().max(200).optional().default(""),
      grade: z.enum(["A", "B", "C", "D"]).optional(),
      lifecycleStatus: z.enum(["open", "won"]).optional(),
      nextReminder: z.string().trim().optional().default("待跟进"),
      wecomBound: z.boolean().optional().default(false),
      billingName: z.string().trim().optional().default(""),
      billingAddress: z.string().trim().optional().default(""),
      documentContact: z.string().trim().optional().default(""),
      contactRemark: z.string().trim().max(500).optional().default(""),
      phone: z.string().trim().optional().default(""),
      email: z.string().trim().optional().default(""),
      website: z.string().trim().optional().default(""),
      defaultPortDischarge: z.string().trim().optional().default(""),
      defaultIncoterm: z.string().trim().optional().default(""),
      defaultPaymentTerm: z.string().trim().optional().default("")
    });
    const schema = z.object({ rows: z.array(rowSchema).min(1).max(2000), fileName: z.string().optional().default("客户导入") });
    const body = schema.parse(req.body);
    const store = getStore();
    const scopedCustomers = store.customers.filter((customer) => customer.ownerId === req.user!.id);
    let created = 0;
    let updated = 0;
    const imported: Customer[] = [];
    for (const row of body.rows) {
      const existing = (row.customerId
        ? scopedCustomers.find((customer) => customer.id === row.customerId)
        : undefined)
        || scopedCustomers.find((customer) => customer.company.trim().toLowerCase() === row.company.trim().toLowerCase());
      if (existing) {
        const importedFields: Partial<Customer> = {
          company: row.company || existing.company,
          country: row.country || existing.country,
          contact: row.contact || existing.contact,
          whatsapp: row.whatsapp || existing.whatsapp || "",
          stage: row.stage || existing.stage,
          amount: row.amount,
          health: row.health,
          source: row.source && row.source !== "批量导入" ? row.source : existing.source || row.source || "批量导入",
          companyFullName: row.companyFullName || row.billingName || existing.companyFullName || existing.billingName || row.company,
          billingName: row.companyFullName || row.billingName || existing.billingName || row.company,
          grade: row.grade || existing.grade || customerGradeFromHealth(row.health),
          nextReminder: row.nextReminder || existing.nextReminder,
          wecomBound: row.wecomBound,
          billingAddress: row.billingAddress || existing.billingAddress || "",
          documentContact: row.documentContact || existing.documentContact || row.contact,
          contactRemark: row.contactRemark || existing.contactRemark || "",
          phone: row.phone || existing.phone || "",
          email: row.email || existing.email || "",
          website: row.website || existing.website || "",
          defaultPortDischarge: row.defaultPortDischarge || existing.defaultPortDischarge || "",
          defaultIncoterm: row.defaultIncoterm || existing.defaultIncoterm || "",
          defaultPaymentTerm: row.defaultPaymentTerm || existing.defaultPaymentTerm || ""
        };
        if (row.lifecycleStatus === "won" || existing.lifecycleStatus !== "won") {
          importedFields.lifecycleStatus = row.lifecycleStatus;
        }
        Object.assign(existing, importedFields);
        imported.push(existing);
        updated += 1;
      } else {
        const customer: Customer = {
          id: `c_import_${Date.now()}_${created}_${Math.random().toString(16).slice(2, 8)}`,
          company: row.company,
          country: row.country || "未知",
          contact: row.contact || "待维护",
          whatsapp: row.whatsapp || "",
          ownerId: req.user!.id,
          teamId: req.user!.teamId,
          stage: row.stage || "询盘",
          amount: row.amount,
          health: row.health,
          source: row.source || "批量导入",
          lifecycleStatus: row.lifecycleStatus || "open",
          companyFullName: row.companyFullName || row.billingName || row.company,
          grade: row.grade || customerGradeFromHealth(row.health),
          nextReminder: row.nextReminder || "待跟进",
          wecomBound: row.wecomBound,
          billingName: row.companyFullName || row.billingName || row.company,
          billingAddress: row.billingAddress || "",
          documentContact: row.documentContact || row.contact || "待维护",
          contactRemark: row.contactRemark || "",
          phone: row.phone || "",
          email: row.email || "",
          website: row.website || "",
          defaultPortDischarge: row.defaultPortDischarge || "",
          defaultIncoterm: row.defaultIncoterm || "",
          defaultPaymentTerm: row.defaultPaymentTerm || ""
        };
        store.customers.unshift(customer);
        scopedCustomers.push(customer);
        imported.push(customer);
        created += 1;
      }
    }
    const job = {
      id: `io_customer_import_${Date.now()}`,
      name: `客户导入：${body.fileName}`,
      type: "import" as const,
      rows: body.rows.length,
      status: "done" as const,
      operatorId: req.user!.id,
      createdAt: currentMinuteText()
    };
    store.importExportJobs.unshift(job);
    await store.persist();
    const customers = store.customers
      .filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId))
      .map((customer) => customerWithPipeline(customer, req.user!));
    res.json({
      result: { created, updated, skipped: 0, total: body.rows.length },
      job,
      customers,
      imported: imported.map((customer) => customerWithPipeline(customer, req.user!))
    });
  }));

  app.post("/api/import-export/customers/export", requireAuth, asyncRoute(async (_req, res) => {
    const store = getStore();
    const customers = store.customers
      .filter((customer) => canSeeOwner(_req.user!, customer.ownerId, customer.teamId))
      .map((customer) => customerWithPipeline(customer, _req.user!));
    const job = {
      id: `io_customer_export_${Date.now()}`,
      name: "客户清单导出",
      type: "export" as const,
      rows: customers.length,
      status: "done" as const,
      operatorId: _req.user!.id,
      createdAt: currentMinuteText()
    };
    store.importExportJobs.unshift(job);
    await store.persist();
    res.json({ customers, job });
  }));
}
