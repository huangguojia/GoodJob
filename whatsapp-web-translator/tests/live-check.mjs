#!/usr/bin/env node
/**
 * 真实链路自检 —— 拿**真实配置**打**真实上游**。
 *
 * ══ 为什么必须单独有这个文件 ══════════════════════════════════════════
 * 这个仓库原有的自检全是**桩**：`provider.test.mjs` 注入假 `fetchImpl`，
 * `e2e-*` 打的是本地 mock 服务。它们能证明「逻辑分支对」，但**在结构上**
 * 看不见任何真实世界的事实 —— 地址通不通、Key 有没有权限、**模型名在这条线路上
 * 到底存不存在**、真实要跑几秒。
 *
 * 这个盲区已经真实伤过一次：扩展里被填了一个该线路根本没有的模型名
 * （`gpt-4o-mini`），于是每一次请求都秒回 404 `model_not_found`，而 625 项单测 +
 * 187 项 parity + 122 项 e2e **全绿** —— 用户那边却一条译文都出不来。
 *
 * 所以这个脚本只做一件事：**把真实链路跑一遍，并说出真实数字**。
 * 它不是替代单测，而是补上单测结构上够不着的那一层。
 *
 * ══ 配置从哪来（按优先级） ════════════════════════════════════════════
 *   1. 环境变量 `GJ_API_BASE` / `GJ_API_KEY` / `GJ_MODEL`（CI 或临时试线路用）
 *   2. 本机 Chrome 里扩展的**实际设置**（`chrome.storage.local` 的 LevelDB）
 *   3. 都没有 → SKIP，退出码 0（**不算失败**，因为自检需要真实凭据）
 *
 * 用法：
 *   node tests/live-check.mjs
 *   GJ_API_BASE=https://... GJ_API_KEY=sk-... GJ_MODEL=xxx node tests/live-check.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isFastBaseEnabled, probeFastBase } from "../src/fast-base.js";
import { listModels, translateText } from "../src/provider.js";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  const mark = pass === "skip" ? "○" : pass ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? `\n    ${detail}` : ""}`);
}
function note(text) {
  console.log(`  · ${text}`);
}

/**
 * 从本机 Chrome 的扩展存储里捞真实设置。
 *
 * 不写死扩展 id —— 逐目录扫，谁的数据里有 `apiBase` 就是谁。这样换机器、
 * 换 id 都能用（也避免把本机 id 硬编码进仓库）。
 *
 * LevelDB 是二进制，但 chrome.storage 的值以**明文 JSON**落在 .log/.ldb 里，
 * 按 latin1 读出来再用正则抓字段即可（不需要引入 leveldb 解析库）。
 */
function readChromeSettings() {
  const root = path.join(
    homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Local Extension Settings"
  );
  if (!existsSync(root)) return null;

  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    let raw = "";
    try {
      for (const file of readdirSync(dir)) {
        if (/\.(log|ldb)$/u.test(file)) raw += readFileSync(path.join(dir, file), "latin1");
      }
    } catch {
      continue;
    }
    if (!raw.includes('"apiBase"')) continue;

    // 取**最后一次**写入的值（日志是追加的，最新在最后）
    //
    // ⚠️ 必须同时认**数字**与**字符串**。第一版只写了 `"field"\s*:\s*"([^"]*)"`，
    // 于是 `firstTokenMs` / `timeoutMs` 这种数字字段**从来就没被读到过**，
    // 一直被兜底值顶替 —— 结果这个"唯一看真实世界"的自检，把「用户存的是 8000」
    // 这件最重要的事给看漏了，还打印出一个像模像样的 20000。
    const grab = (field) => {
      const found = [...raw.matchAll(new RegExp(`"${field}"\\s*:\\s*(?:"([^"]*)"|([-\\d.]+))`, "gu"))];
      if (!found.length) return "";
      const last = found[found.length - 1];
      return last[1] !== undefined ? last[1] : last[2];
    };
    const apiBase = grab("apiBase");
    const apiKey = grab("apiKey");
    if (!apiBase || !apiKey) continue;

    return {
      apiBase,
      apiKey,
      model: grab("model"),
      firstTokenMs: Number(grab("firstTokenMs")) || 60_000,
      timeoutMs: Number(grab("timeoutMs")) || 120_000,
      fastBase: grab("fastBase"),
      source: `本机 Chrome 扩展设置（${entry}）`
    };
  }
  return null;
}

/* ---------- 取配置 ---------- */

let config = null;
if (process.env.GJ_API_BASE && process.env.GJ_API_KEY) {
  config = {
    apiBase: process.env.GJ_API_BASE,
    apiKey: process.env.GJ_API_KEY,
    model: process.env.GJ_MODEL || "",
    firstTokenMs: 20_000,
    timeoutMs: 30_000,
    source: "环境变量 GJ_API_BASE / GJ_API_KEY"
  };
} else {
  config = readChromeSettings();
}

console.log("真实链路自检（会真的发一次翻译请求，消耗极少量额度）\n");

if (!config) {
  console.log("○ SKIP —— 没有可用配置。");
  note("既没有 GJ_API_BASE / GJ_API_KEY 环境变量，也没能读到本机 Chrome 里扩展的设置。");
  note("真实链路自检需要真实凭据，跳过不算失败。");
  process.exit(0);
}

console.log(`配置来源：${config.source}`);
console.log(`  API 地址：${config.apiBase}`);
console.log(`  模型    ：${config.model || "（没填）"}`);
console.log(`  Key     ：长度 ${config.apiKey.length}（不打印内容）`);
console.log(`  超时    ：整体 ${config.timeoutMs / 1000}s / 首字 ${config.firstTokenMs / 1000}s\n`);

/**
 * ⚠️ 这条是**用户那次"翻译一直出不来"的真正病根**，所以单独立一条断言。
 *
 * 实测这条线路上 `gpt-5.5` 首字要 33~66 秒、`gpt-6.1-sol` 到过 65.8 秒。
 * 用户浏览器里存着 `firstTokenMs: 8000` —— 每一次翻译都在第 8 秒被判死，
 * 而代码里的默认值早就放宽到 60000 了。**光改默认值治不了存量用户**，
 * 所以这里要能把它显式喊出来（正常情况应该由 `settings.js::migrateSettings` 自动修好）。
 */
record(
  "首字超时阈值够宽（实测最慢模型首字 66 秒）",
  config.firstTokenMs >= 30_000,
  config.firstTokenMs >= 30_000
    ? ""
    : `只有 ${config.firstTokenMs / 1000}s —— 这条线路上的模型会在第 ${config.firstTokenMs / 1000} 秒被成片判死，\n` +
      "    现象就是「翻译一直不出来」。重载一次扩展即可（会自动迁移到 60s），或去设置页手动改。"
);
record(
  "整体超时阈值够宽（实测最慢模型总耗时 67.9 秒）",
  config.timeoutMs >= 90_000,
  config.timeoutMs >= 90_000 ? "" : `只有 ${config.timeoutMs / 1000}s，偏紧，建议 120s（重载扩展会自动迁移）`
);

if (!config.model) {
  record("模型名是否填了", false, "模型是空的，扩展不会发任何翻译请求");
}

/* ---------- 0) 快速底座：这条链路到底通不通、要几毫秒 ----------
 *
 * 放在最前面是因为它现在是**第一眼看到译文的那条路**：
 * AI 那条线路实测最快也要 10.3 秒出首字，用户实际感知的延迟由这一层决定。
 * 「底座通不通」只有在真网络上才能验，桩里怎么测都是绿的。
 */

const fastSettings = { fastBase: config.fastBase || "mymemory" };

if (!isFastBaseEnabled(fastSettings)) {
  record("快速底座", "skip", `设置里是「${config.fastBase || "（没读到）"}」，当前只用 AI 那条线路`);
} else {
  const probe = await probeFastBase(fastSettings);
  if (!probe.ok) {
    // 底座挂了不影响可用性（会自动回退 AI），但**速度就没了** —— 必须说出来
    record(
      "快速底座真实可用",
      false,
      `${probe.error}\n    底座不可用时扩展会自动回退到 AI，翻译仍然能用，但每次都要等 AI 那 10~70 秒。`
    );
  } else {
    const seconds = probe.totalMs / 1000;
    record("快速底座真实可用", true, `${seconds.toFixed(1)} 秒 · 译：${probe.text}`);
    record(
      "底座速度配得上「秒出初译」这个定位",
      seconds <= 3,
      seconds > 3 ? `${seconds.toFixed(1)} 秒偏慢 —— 初译会拖，考虑换成「关闭」只用 AI` : ""
    );
  }
}

/* ---------- 1) 拉模型清单 ---------- */

let models = null;
try {
  const listed = await listModels(config);
  models = listed.models;
  record("拉取模型清单（GET /models）", true, `这条线路共 ${models.length} 个模型，耗时 ${listed.totalMs}ms`);
  note(models.join("  "));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // 403/404 多半是"该站不开放 /models"，不是配置坏了 —— 与"Key 无效"必须分开说
  const notOpen = /\b(403|404)\b/u.test(message);
  record(
    "拉取模型清单（GET /models）",
    notOpen ? "skip" : false,
    notOpen
      ? `${message}\n    这个站可能不开放 /models 接口 —— 这条跳过，但下面「模型是否存在」也就无从校验了`
      : message
  );
}

/* ---------- 2) 配置的模型到底存不存在（**最容易静默失败的一条**） ---------- */

if (models) {
  const present = models.includes(config.model);
  record(
    `配置的模型「${config.model}」在这条线路上存在`,
    present,
    present
      ? ""
      : `不在清单里 —— 每次请求都会秒回 404 model_not_found，现象是"翻译完全没反应"。\n    这条线路可用的是：${models.join(", ")}`
  );
}

/* ---------- 3) 真的翻译一次 ---------- */

const SAMPLE = "Could you confirm the lead time for the customized packaging? And what is the MOQ?";

try {
  const result = await translateText(config, { text: SAMPLE, sourceLang: "en", targetLang: "zh-CN" });
  const seconds = result.totalMs / 1000;
  record("真实翻译一次", true, `${seconds.toFixed(1)} 秒（${result.streamed ? "流式" : "非流式"}）\n    译文：${result.text}`);

  note(seconds <= 3 ? "速度正常。" : seconds <= 8 ? "偏慢 —— 换个更轻的模型会明显改善。" : "很慢 —— 这个模型做翻译体验很差，建议换一个。");

  // 跟"判死阈值"对齐：不能出现"翻译能成，但被自家超时掐死"这种自相矛盾
  record(
    "耗时没有逼近自家超时线",
    result.totalMs < config.timeoutMs * 0.9,
    result.totalMs >= config.timeoutMs * 0.9
      ? `${seconds.toFixed(1)}s 已经贴近整体超时 ${config.timeoutMs / 1000}s —— 上游稍有波动就会开始成片失败`
      : ""
  );
} catch (error) {
  record("真实翻译一次", false, error instanceof Error ? error.message : String(error));
}

/* ---------- 汇总 ---------- */

const failed = results.filter((item) => item.pass === false);
const skipped = results.filter((item) => item.pass === "skip");
const total = results.length - skipped.length;

console.log(`\n真实链路自检：通过 ${total - failed.length} / ${total}${skipped.length ? `（跳过 ${skipped.length}）` : ""}`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.name}`);
  process.exit(1);
}
process.exit(0);
