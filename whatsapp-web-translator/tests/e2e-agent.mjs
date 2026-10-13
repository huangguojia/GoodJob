/**
 * 归档 · 学习 · 自动回复的端到端自检（独立于翻译的 e2e-extension.mjs，互不干扰）。
 *
 * 跑法：
 *   CHROME_SHELL="<Chrome 可执行文件>" node tests/e2e-agent.mjs --tag=run1
 *
 * 为什么单独一份：翻译那条链路已经有稳定的自检脚本，把新功能塞进去会让"改了归档却把翻译测试
 * 改坏"变成常态。这份只验新东西，且**只跑页面注入这一段** —— 因为本机这份 Chrome 在
 * `--headless=new` 下不加载 `--load-extension` 指定的扩展（已在 e2e-extension.mjs 里记录）。
 * 所以这里用 http 把**同一份源码**（archive/trainer/autoreply/agent.js）加载进页面，
 * 并把 `chrome.*` 换成薄桩。真机上跑的是 Chrome 标准注入路径，代码同一份。
 *
 * 全程只连本机 mock（127.0.0.1），不碰真实 WhatsApp、不碰数据库、不发任何真实消息。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");

const flags = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/u, "").split("=");
    return [key, value === undefined ? true : value];
  })
);

const CDP_PORT = Number(flags.cdpPort || 9522);
const MOCK_PORT = Number(flags.mockPort || 8799);
const TAG = String(flags.tag || "run");
const OUTDIR = path.resolve(String(flags.outdir || "/tmp/gj-agent-shots"));
const HEADFUL = Boolean(flags.headful);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_URL = `${MOCK_ORIGIN}/mock/mock-whatsapp.html`;

const results = [];
const consoleNoise = [];

function log(step) {
  process.stderr.write(`[agent-e2e] ${new Date().toISOString().slice(11, 19)} ${step}\n`);
}

function record(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail ?? "").slice(0, 300) });
  log(`${pass ? "✓" : "✗"} ${name}${detail ? ` → ${String(detail).slice(0, 100)}` : ""}`);
}

function pickChrome() {
  const candidates = [
    process.env.CHROME_SHELL,
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("找不到 Chrome，请用 CHROME_SHELL 指定");
}

function pickPython() {
  const candidates = [process.env.PYTHON, "python3", path.join(os.homedir(), ".workbuddy/binaries/python/versions/3.13.12/bin/python3")].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("找不到 python3");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 15000, interval = 200, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}${lastError ? `（最后错误：${lastError.message}）` : ""}`);
}

/* ---------------- 极简 CDP 客户端 ---------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`CDP 连接失败：${url}`)), { once: true });
    });
    const client = new Cdp(socket);
    socket.addEventListener("message", (event) => client.dispatch(String(event.data)));
    return client;
  }

  dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（20s）：${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "页面内脚本抛错");
  return result.result?.value;
}

/* ---------------- 页面桩 ---------------- */

const SETTINGS = {
  enabled: true,
  targetLang: "zh-CN",
  replyLang: "en",
  apiBase: `${MOCK_ORIGIN}/v1`,
  apiKey: "test-key-123",
  model: "mock-model",
  // 显式关掉：默认值是 mymemory，e2e 绝不许打真实第三方服务
  fastBase: "off",
  composeTranslate: true,
  composeAuto: true,
  timeoutMs: 8000,
  autoReply: {
    enabled: false,
    mode: "draft",
    language: "auto",
    dailyLimit: 20,
    // 0/0 = 全天；0 分钟间隔 = 不限频。自检要跟运行时刻无关，否则半夜跑必挂。
    minIntervalMinutes: 0,
    activeHoursStart: 0,
    activeHoursEnd: 0,
    confidenceThreshold: 0.5,
    guardrails: [],
    escalateKeywords: []
  }
};

function bootstrapSource() {
  return `(async () => {
  try {
    const base = ${JSON.stringify(`${MOCK_ORIGIN}/`)};
    const store = {
      gj_translator_settings: ${JSON.stringify(SETTINGS)},
      gj_translator_cache: { entries: [] },
      gj_reply_corpus: null,
      gj_reply_profile: null,
      gj_auto_reply_ledger: null
    };
    const messageListeners = [];
    const storageListeners = [];
    /** 翻译请求留痕：用来证明"草稿带 quick（不重试）、来信不带"，以及"点了重试真的又发了一次"。 */
    const translateCalls = [];
    /** 置 true 后所有翻译请求都以"超时"失败 —— 用来验失败态到底长什么样。 */
    let failTranslate = false;

    function notifySettingsChanged() {
      for (const fn of messageListeners) {
        try { fn({ type: "settingsChanged" }, {}, () => {}); } catch (error) { console.warn("桩：通知失败", error); }
      }
    }

    function mergeAutoReply(patch) {
      const current = store.gj_translator_settings || {};
      const autoReply = { ...(current.autoReply || {}), ...(patch || {}) };
      store.gj_translator_settings = { ...current, autoReply };
      for (const fn of storageListeners) {
        try { fn({ gj_translator_settings: { newValue: store.gj_translator_settings } }, "local"); } catch {}
      }
      notifySettingsChanged();
      return autoReply;
    }

    /*
     * 调用留痕。右侧那一列的动作全在页面里发生，只有把**真的发出去的请求**记下来，
     * 才能证明"点了「复制链接」才去取链接"这种纪律 —— 光看界面看不出有没有偷偷预取。
     */
    const crmCalls = [];

    // background 侧的桩：只实现 agent.js 真正会用到的那几个指令
    async function handle(message) {
      if (message.type === "getSettings") return { ok: true, settings: store.gj_translator_settings };
      if (message.type === "setAutoReply") return { ok: true, autoReply: mergeAutoReply(message.patch) };
      if (message.type === "translate") {
        translateCalls.push({ text: message.text, targetLang: message.targetLang, quick: message.quick === true });
        // 翻译由 e2e-extension.mjs 负责验；这里给个静态答复，保证翻译脚本不报错。
        if (failTranslate) return { ok: false, error: "翻译超时（20 秒）" };
        return { ok: true, text: "[MOCK译] " + message.text };
      }
      if (message.type === "clearCache") { store.gj_translator_cache = { entries: [] }; return { ok: true }; }
      if (message.type === "crmStatus") return crmStatusStub();
      if (message.type === "crmCompose") { crmCalls.push({ type: "crmCompose", payload: message.payload }); return crmComposeStub(message.payload); }
      if (message.type === "crmSuggest") { crmCalls.push({ type: "crmSuggest", payload: message.payload }); return crmSuggestStub(message.payload); }
      if (message.type === "crmResources") { crmCalls.push({ type: "crmResources", payload: message.payload }); return crmResourcesStub(); }
      if (message.type === "crmReveal") { crmCalls.push({ type: "crmReveal", payload: message.payload }); return crmRevealStub(message.payload); }
      if (message.type === "crmFeedback") { crmCalls.push({ type: "crmFeedback", payload: message.payload }); return { ok: true }; }
      if (message.type === "crmTrainingImport") {
        crmCalls.push({ type: "crmTrainingImport", payload: message.payload });
        const payload = message.payload || {};
        return {
          ok: true,
          result: {
            profile: { id: "trn_stub" },
            updated: true,
            // created 回读 payload（样本数 + 护栏数）：payload 没真的送对，这里就对不上。
            library: { created: (payload.examples?.length ?? 0) + (payload.guardrails?.length ?? 0), skipped: 0 }
          }
        };
      }
      if (message.type === "openOptions") { crmCalls.push({ type: "openOptions" }); return { ok: true }; }
      return { ok: false, error: "桩未实现：" + message.type };
    }

    function crmStatusStub() {
      return {
        ok: true,
        session: { loggedIn: true, email: "ops@goodjob.test", expiresAt: Date.now() + 3600000, expiresInMinutes: 60, expired: false },
        engine: {
          ok: true,
          engine: {
            available: true,
            binary: "/opt/homebrew/bin/codebuddy",
            version: "9.9.9-stub",
            reason: "",
            defaultModel: "deepseek-v4.1-flash",
            models: ["deepseek-v4.1-flash"],
            efforts: ["low", "high"],
            skillsDirs: "<repo>/whatsapp-plugin/skills",
            // 两个技能都要在：只装一个时插件会**静默降档**，面板必须把缺的那个点出来。
            skills: ["goodjob-auto-reply", "goodjob-resource-scout"],
            autoReplySkill: "goodjob-auto-reply",
            resourceScoutSkill: "goodjob-resource-scout"
          }
        }
      };
    }

    /*
     * 两条通道的假数据。
     *
     * 判据是「页面上那段对话有没有真的被送出去」：回复正文里回读**入站原话**，
     * 资料卡的 why 里也回读客户名。只回一句固定文案的话，哪怕 messages 压根没发出去，
     * 测试照样全绿 —— 那测的就不是链路，是桩自己。
     *
     * 第一份资料故意带上 sourceUrl：真链路上这个字段**永远不下发**（延迟披露）。
     * 塞进来就是为了证明页面不会把它渲染出来、也不会落进 storage。
     */
    /*
     * 客户是谁**从送上来的 payload 里取**，不写死。
     * 写死就只能证明桩自己有条常量；从 payload 取，面板上出现「Miguel Santos」才等于
     * 证明了"页面上这个联系人真的被送出去了"。
     */
    function stubEvidence(payload) {
      const contact = (payload && payload.contact) || {};
      const byPhone = Boolean(String(contact.phone || "").trim());
      return {
        profile: null,
        library: { qa: 2, snippets: 1, policies: 0, forbidden: 1 },
        crm: {
          matchedBy: byPhone ? "phone" : "name",
          customer: String(contact.name || "未命名"),
          followUps: 3,
          quotes: 1,
          knowledge: [{ title: "MOQ 与交期政策" }],
          errors: []
        },
        sources: ["library", "crm_followup", "crm_quote", "knowledge", "resource"]
      };
    }

    function stubReply(payload) {
      const inbound = (payload && payload.messages || [])
        .filter((m) => m.direction === "inbound")
        .map((m) => m.body)
        .join(" | ");
      return {
        action: "reply",
        reply: "[CRM稿] " + inbound,
        engine: "cli",
        model: "deepseek-v4.1-flash",
        confidence: 0.91,
        blocked: false,
        reason: "",
        evidence: stubEvidence(payload)
      };
    }

    function stubResources() {
      return [
        {
          key: "file:11",
          sourceType: "file",
          id: "11",
          title: "不锈钢款 MOQ 与交期说明.pdf",
          fileType: "pdf",
          summary: "含 10 pcs 起订与 45 天交期",
          match: "strong",
          reasons: ["客户问到最小起订量"],
          hitTerms: ["MOQ"],
          why: "客户问的正是起订量与交期",
          suggestedLine: "Our MOQ for the stainless version is 10 pcs, lead time 45 days.",
          score: 92.5,
          hasExternalLink: true,
          sourceUrl: "https://leak.example.test/should-never-reach-page.pdf"
        },
        {
          key: "knowledge:21",
          sourceType: "knowledge",
          id: "21",
          title: "MOQ 与交期政策",
          fileType: "",
          summary: "标准款 50 pcs / 不锈钢款 10 pcs",
          match: "medium",
          reasons: ["知识库命中"],
          hitTerms: ["MOQ", "交期"],
          why: "",
          suggestedLine: "",
          score: 61,
          hasExternalLink: false
        }
      ];
    }

    function crmSuggestStub(payload) {
      return {
        ok: true,
        result: {
          reply: stubReply(payload),
          resources: stubResources(),
          curatorNote: "优先发第一份：客户问的就是它",
          warnings: [],
          curated: true,
          model: "deepseek-v4.1-flash",
          tookMs: 12
        }
      };
    }

    // 只要资料（快）：形状与 suggest 的 resources 一致，**没有 reply**。
    function crmResourcesStub() {
      return { ok: true, result: { resources: stubResources(), warnings: [], tookMs: 5 } };
    }

    // 只要回复（不推资料）：产物形状与 suggest 里的 reply 一致。
    function crmComposeStub(payload) {
      return { ok: true, result: stubReply(payload) };
    }

    /*
     * reveal 的返回形状**必须和真实链路一致**：pluginJson 把插件的响应体再包一层，
     * 于是扩展拿到的是「外层 ok + result + 插件自己的 ok/access」。
     * 少包一层不会报错 —— agent.js 会把它当成"暂时取不到链接"，表现得像网络抖了一下。
     * 这个坑本仓踩过一次，所以桩按真实形状写。
     */
    function crmRevealStub(payload) {
      if (!payload || !payload.sourceType || !payload.id) {
        return { ok: true, result: { ok: false, reason: "缺少资料标识" } };
      }
      if (payload.sourceType === "file") {
        return {
          ok: true,
          result: { ok: true, access: { kind: "external", url: "https://files.goodjob.test/moq-stainless-2026.pdf", shareCode: "a1b2" } }
        };
      }
      return { ok: true, result: { ok: true, access: { kind: "inline", content: "MOQ：标准款 50 pcs，不锈钢款 10 pcs。" } } };
    }

    window.chrome = {
      runtime: {
        // 真扩展里 id 必然存在；它消失 = 扩展被重载过。content.js 靠它判断"这一页要不要刷新"。
        id: "mock-extension-id",
        lastError: null,
        sendMessage(message, callback) {
          const done = typeof callback === "function" ? callback : () => {};
          handle(message).then(done).catch((error) => done({ ok: false, error: String((error && error.message) || error) }));
        },
        onMessage: { addListener(fn) { messageListeners.push(fn); } },
        getURL: (p) => base + p
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: store[key] };
            const out = {};
            for (const k of key || []) out[k] = store[k];
            return out;
          },
          async set(patch) {
            Object.assign(store, patch);
            const changes = {};
            for (const k of Object.keys(patch)) changes[k] = { newValue: patch[k] };
            for (const fn of storageListeners) { try { fn(changes, "local"); } catch {} }
            if (patch.gj_translator_settings) notifySettingsChanged();
          }
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      },
      tabs: { query(_q, cb) { cb([]); } }
    };

    // 自检专用的"往页面脚本里发消息"通道：模拟 background → content script 的投递
    window.__gjTest = {
      deliver(message) {
        return new Promise((resolve) => {
          let settled = false;
          const done = (value) => { if (!settled) { settled = true; resolve(value ?? { ok: false, error: "无响应" }); } };
          for (const fn of messageListeners) {
            try { fn(message, {}, done); } catch (error) { done({ ok: false, error: String(error) }); }
          }
          setTimeout(() => done({ ok: false, error: "页面脚本没有响应" }), 12000);
        });
      },
      /** 改自动回复设置走的是 background（内容脚本 → SW），不是页面内投递 —— 别混。 */
      setAutoReply(patch) {
        return new Promise((resolve) => window.chrome.runtime.sendMessage({ type: "setAutoReply", patch }, resolve));
      },
      /** 右侧那一列到底朝后台发过哪些请求 —— 「只在你点了才取链接」这类纪律只能靠它证明。 */
      crmCalls() { return crmCalls.slice(); },
      /** 把留痕清零，便于"这一段只该发生这些调用"的精确断言。 */
      resetCalls() { crmCalls.length = 0; return true; },
      read(key) { return store[key]; },
      settings() { return store.gj_translator_settings; },
      /** 让之后的翻译请求都以"上游超时"失败 */
      failTranslate(on) { failTranslate = !!on; return failTranslate; },
      translateCalls() { return translateCalls.slice(); },
      resetTranslateCalls() { translateCalls.length = 0; return true; }
    };

    await new Promise((resolve) => {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resolve, { once: true });
      else resolve();
    });

    // 顺序与 manifest 的 content_scripts[].css 一致：设计令牌在最前，后面两个文件引它的变量。
    for (const name of ["gj-theme.css", "content.css", "agent.css"]) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = base + "src/" + name;
      document.head.appendChild(link);
      await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
    }
    for (const name of ["content.js", "agent.js"]) {
      const script = document.createElement("script");
      script.src = base + "src/" + name;
      document.head.appendChild(script);
      await new Promise((resolve) => { script.onload = resolve; script.onerror = resolve; });
    }
    window.__gjBootstrap = "ready";
  } catch (error) {
    window.__gjBootstrap = "failed: " + (error && error.message);
    console.error("[agent-e2e] 桩启动失败", error);
  }
})();`;
}

/* ---------------- 主流程 ---------------- */

const chromePath = pickChrome();
const pythonPath = pickPython();
fs.mkdirSync(OUTDIR, { recursive: true });

setTimeout(() => {
  record("全局看门狗（150 秒）", false, "有步骤卡住，看上面的进度日志定位");
  cleanup();
  printReport();
  process.exit(1);
}, 150000);

const mockLog = fs.openSync(path.join(OUTDIR, `mock-${TAG}.log`), "a");
const mockProcess = spawn(pythonPath, [path.join(EXT_ROOT, "mock", "mock-server.py"), String(MOCK_PORT)], {
  cwd: EXT_ROOT,
  stdio: ["ignore", mockLog, mockLog]
});

let chromeProcess = null;
let cdp = null;

function cleanup() {
  for (const child of [chromeProcess, mockProcess]) {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* 忽略 */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function printReport() {
  const failed = results.filter((item) => !item.pass);
  console.log(`\n=== 归档 / 训练 / 自动回复 自检（tag=${TAG}）===`);
  for (const item of results) console.log(`${item.pass ? "✓" : "✗"} ${item.name}${item.detail ? ` → ${item.detail}` : ""}`);
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
  if (consoleNoise.length) {
    console.log(`\n控制台噪音 ${consoleNoise.length} 条（前 8 条）：`);
    for (const line of consoleNoise.slice(0, 8)) console.log(`  · ${line}`);
  }
  if (failed.length) {
    console.log("\n失败项：");
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` → ${item.detail}` : ""}`);
  }
}

try {
  log(`启动 mock 服务（${pythonPath}）`);
  await waitFor(async () => (await fetch(`${MOCK_ORIGIN}/__reset`)).ok, { label: "mock 服务就绪" });

  const chromeArgs = [
    ...(HEADFUL ? [] : ["--headless=new"]),
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--in-process-gpu",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    // ⚠️ 绝不加 --user-data-dir：本机一旦指定自定义剖目录，http(s) 导航会永久卡住。
    `--remote-debugging-port=${CDP_PORT}`,
    "--window-size=1280,900",
    "about:blank"
  ];
  chromeProcess = spawn(chromePath, chromeArgs, { stdio: "ignore" });

  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return response.ok ? response.json() : null;
    },
    { label: "Chrome remote debugging" }
  );
  log(`Chrome ${version.Browser}`);

  cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  cdp.on((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      consoleNoise.push(`异常：${message.params?.exceptionDetails?.exception?.description || ""}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      consoleNoise.push(`console.error：${(message.params.args || []).map((a) => a.value ?? a.description).join(" ")}`);
    }
  });

  const { targetInfos } = await cdp.send("Target.getTargets");
  const pageTarget = targetInfos.find((info) => info.type === "page" && info.url === "about:blank");
  if (!pageTarget) throw new Error("找不到启动时的 about:blank 页面");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource() }, sessionId);
  await cdp.send("Page.navigate", { url: MOCK_URL }, sessionId);

  await waitFor(async () => ((await evaluate(cdp, sessionId, "location.href")) === MOCK_URL ? true : null), { label: "mock 页导航到位" });
  await waitFor(async () => ((await evaluate(cdp, sessionId, "window.__gjBootstrap || null")) === "ready" ? true : null), { label: "页面桩就绪" });
  await waitFor(async () => ((await evaluate(cdp, sessionId, "document.documentElement.dataset.gjAgent || null")) === "on" ? true : null), {
    label: "agent.js 已运行"
  });
  record("agent.js 在页面里跑起来", true);

  /* ---------- 翻译链路 ----------
     用户报的"翻译毫无反应"，在页面上表现为「什么也没多出来」——
     分不清是脚本没注入、没找到对话区、还是消息选择器失效。
     所以这三条断言不用眼睛看，直接问页面脚本要数字。 */

  record(
    "翻译脚本也真的跑起来了（documentElement 有 gjTranslator 标记）",
    (await evaluate(cdp, sessionId, "document.documentElement.dataset.gjTranslator || ''")) === "on"
  );

  const statsProbe = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "stats" })`);
  record(
    "翻译自检报出这一页的实况（容器 / 消息行 / 客户消息）",
    statsProbe?.ok === true && statsProbe.injected === true && statsProbe.rows > 0 && statsProbe.inbound > 0,
    JSON.stringify(statsProbe)?.slice(0, 240)
  );
  record(
    "自检带齐诊断位（testIdRows / composeButton / lastError）",
    typeof statsProbe?.testIdRows === "number" &&
      typeof statsProbe?.composeButton === "boolean" &&
      typeof statsProbe?.lastError === "string",
    JSON.stringify(statsProbe)?.slice(0, 240)
  );
  record(
    "自检报得出「处理中 / 卡住」的条数（「页面没反应」的指纹）",
    typeof statsProbe?.pending === "number" && typeof statsProbe?.stalled === "number",
    JSON.stringify({ pending: statsProbe?.pending, stalled: statsProbe?.stalled })
  );

  // 等真的渲染出译文条 —— 这是「注入 → 扫描 → 请求 → 回填」整条链路唯一的端到端证据。
  let translatedProbe = null;
  for (let i = 0; i < 8; i += 1) {
    translatedProbe = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "stats" })`);
    if (!translatedProbe?.ok) break; // 脚本没响应就别耗到看门狗
    if ((translatedProbe.nodes ?? 0) > 0) break;
    await sleep(250);
  }
  record(
    "客户来信真的生成了译文条（端到端跑通）",
    (translatedProbe?.nodes ?? 0) > 0,
    `nodes=${translatedProbe?.nodes} rows=${translatedProbe?.rows} inbound=${translatedProbe?.inbound} skipped=${translatedProbe?.skipped} lastError=${translatedProbe?.lastError}`
  );

  /* ---------- 卡住的行不能就这么算了 ----------
     真实事故：一条客户英文消息空着十几个小时，页面上既没有译文、也没有报错。
     原因是它被标成 pending 之后请求没回来（MV3 后台被回收，回调永远不来），
     而 `pending` 当时是个死判据 —— 这一行从此永久沉默。
     这里把行手工做成"卡了一分钟"的样子，看扫描会不会自己把它捡回来。 */

  await evaluate(cdp, sessionId, `window.__gjTest.resetTranslateCalls()`);

  const stallSetup = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const node = document.querySelector(".gj-translation");
       const row = node ? node.parentElement : null;
       if (!row) return { ok: false, why: "页面上没有已翻译的样板行" };
       row.dataset.gjProbeRow = "stalled";
       node.remove();                                          // 模拟节点被 WhatsApp 重渲染清掉
       row.dataset.gjStatus = "pending";
       row.dataset.gjPendingAt = String(Date.now() - 60000);   // 已经卡了一分钟
       const ping = document.createElement("span");            // 制造一次 DOM 变化，让 observer 排一次扫描
       document.body.appendChild(ping);
       ping.remove();
       return { ok: true, text: (row.innerText || "").slice(0, 40) };
     })()`
  );
  await sleep(1400);

  const stallAfter = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const row = document.querySelector('[data-gj-probe-row="stalled"]');
       const node = row ? row.querySelector(".gj-translation") : null;
       return {
         status: row ? row.dataset.gjStatus || "" : "",
         revived: Boolean(node),
         body: node ? node.textContent.slice(0, 40) : ""
       };
     })()`
  );
  record(
    "卡了一分钟的行会被自动捡回来重译（不再永久沉默、也不再一声不吭）",
    stallSetup?.ok === true && stallAfter?.revived === true && stallAfter?.status !== "pending",
    JSON.stringify({ setup: stallSetup, after: stallAfter })
  );
  const stallCalls = await evaluate(cdp, sessionId, `window.__gjTest.translateCalls()`);
  record(
    "来信的翻译请求不带 quick（带 quick 的只有草稿，草稿才不重试）",
    Array.isArray(stallCalls) && stallCalls.length > 0 && stallCalls.every((call) => call.quick !== true),
    JSON.stringify(stallCalls)?.slice(0, 200)
  );

  // 反向：**正在途中**的 pending 不该被抢跑，否则同一句话会被反复请求
  const freshSetup = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const row = document.querySelector('[data-gj-probe-row="stalled"]');
       if (!row) return { ok: false };
       row.querySelector(".gj-translation")?.remove();
       row.dataset.gjStatus = "pending";
       row.dataset.gjPendingAt = String(Date.now());   // 刚发出去
       const ping = document.createElement("span");
       document.body.appendChild(ping);
       ping.remove();
       return { ok: true };
     })()`
  );
  await sleep(1400);
  const freshAfter = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const row = document.querySelector('[data-gj-probe-row="stalled"]');
       return { status: row ? row.dataset.gjStatus || "" : "", node: Boolean(row && row.querySelector(".gj-translation")) };
     })()`
  );
  record(
    "刚发出去的请求不会被抢跑（在途的 pending 照旧等着）",
    freshSetup?.ok === true && freshAfter?.status === "pending" && freshAfter?.node === false,
    JSON.stringify(freshAfter)
  );
  // 收尾：把这一行恢复成正常状态，别把后面的断言带偏
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const row = document.querySelector('[data-gj-probe-row="stalled"]');
       if (row) { delete row.dataset.gjStatus; delete row.dataset.gjPendingAt; row.dataset.gjProbeRow = "done"; }
       const ping = document.createElement("span");
       document.body.appendChild(ping);
       ping.remove();
       return true;
     })()`
  );
  await sleep(1400);

  /* ---------- 草稿自动翻译：打中文 → 右侧浮框 → 一键替换 ----------
     每条断言都对应一个用户能看见的行为，而不是内部状态：
     打字停顿 → 浮框自己冒出来 → 两个按钮可用 → 点替换后输入框真的变成外文。 */

  const composeSnippet = "请报 500 件的 FOB 价格";

  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const box = document.querySelector("#main footer .composer");
       box.focus();
       box.textContent = ${JSON.stringify(composeSnippet)};
       // 真实打字会发一个 input 事件；自动翻译就是靠它起计时的（捕获阶段委托在 document 上）
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "价" }));
       return true;
     })()`
  );

  // AUTO_DELAY 是 900ms，再加一次桩往返
  await sleep(1500);

  const draftPanelState = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       if (!p) return { exists: false };
       const r = p.getBoundingClientRect();
       const q = (sel) => p.querySelector(sel);
       const copy = q(".gj-panel-copy");
       const replace = q(".gj-panel-replace");
       const send = q(".gj-panel-send");
       return {
         exists: true,
         state: p.dataset.gjState || "",
         title: q(".gj-panel-title") ? q(".gj-panel-title").textContent : "",
         body: q(".gj-panel-body") ? q(".gj-panel-body").textContent : "",
         copyIsIcon: copy ? copy.getAttribute("aria-label") === "复制译文" : false,
         replaceLabel: replace ? replace.textContent : "",
         sendLabel: send ? send.textContent : "",
         copyDisabled: copy ? copy.disabled : null,
         replaceDisabled: replace ? replace.disabled : null,
         sendDisabled: send ? send.disabled : null,
         rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
         viewport: { w: window.innerWidth, h: window.innerHeight },
         inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
         onRightSide: r.left > window.innerWidth / 2
       };
     })()`
  );

  record(
    "输入框里打中文后，译文浮框自动出现（全程没点任何按钮）",
    draftPanelState?.exists === true,
    JSON.stringify(draftPanelState)?.slice(0, 220)
  );
  record("浮框已拿到译文（不是停在「翻译中…」）", draftPanelState?.state === "done" && String(draftPanelState?.body || "").includes("[MOCK译]"), `${draftPanelState?.state} / ${String(draftPanelState?.body || "").slice(0, 60)}`);
  record("浮框标题标出目标语言是英语（replyLang）", String(draftPanelState?.title || "").includes("英语"), draftPanelState?.title);
  record(
    "浮框在页面右侧、且完整落在视口内（不会被挤到屏幕外）",
    draftPanelState?.onRightSide === true && draftPanelState?.inViewport === true,
    JSON.stringify({ rect: draftPanelState?.rect, viewport: draftPanelState?.viewport, onRightSide: draftPanelState?.onRightSide })
  );
  record(
    "「替换到输入框」与「替换并发送」两个按钮都在、都可用；复制已收成右上角图标",
    draftPanelState?.replaceLabel === "替换到输入框" &&
      draftPanelState?.sendLabel === "替换并发送" &&
      draftPanelState?.copyIsIcon === true &&
      draftPanelState?.copyDisabled === false &&
      draftPanelState?.replaceDisabled === false &&
      draftPanelState?.sendDisabled === false,
    JSON.stringify({ copyIcon: draftPanelState?.copyIsIcon, replace: draftPanelState?.replaceLabel, send: draftPanelState?.sendLabel, cd: draftPanelState?.copyDisabled, rd: draftPanelState?.replaceDisabled, sd: draftPanelState?.sendDisabled })
  );

  const draftShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `compose-panel-${TAG}.png`), Buffer.from(draftShot.data, "base64"));

  /* 点「替换并发送」—— 一键到底：译文写进输入框（读回确认）后立刻自动发送。
     发送判据与扩展同款：输入框被清空 + mock 的 sentCount 涨了。 */
  const sentBeforeReplace = await evaluate(cdp, sessionId, `window.__gjMock.sentCount`);
  await evaluate(cdp, sessionId, `document.querySelector("#gj-compose-panel .gj-panel-send").click(); true`);
  await sleep(1200);
  const afterReplace = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const composer = document.querySelector("#main footer .composer");
       const outs = document.querySelectorAll("#main .message-out");
       const p = document.getElementById("gj-compose-panel");
       return {
         composer: composer ? (composer.innerText || composer.textContent || "") : "",
         sentCount: window.__gjMock.sentCount,
         lastOut: outs.length ? outs[outs.length - 1].textContent : "",
         panelState: p ? p.dataset.gjState || "" : "",
         panelTitle: p && p.querySelector(".gj-panel-title") ? p.querySelector(".gj-panel-title").textContent : ""
       };
     })()`
  );
  record(
    "点「替换并发送」后，消息**真的发出去了**（sentCount +1，最后一条我方消息就是译文）",
    Number(afterReplace?.sentCount) === Number(sentBeforeReplace) + 1 &&
      String(afterReplace?.lastOut || "").includes("[MOCK译]"),
    JSON.stringify({ before: sentBeforeReplace, after: afterReplace?.sentCount, lastOut: String(afterReplace?.lastOut || "").slice(0, 60) })
  );
  record(
    "发送后输入框被清空，浮框亮「已发送」（不是「填好了等回车」）",
    !String(afterReplace?.composer || "").trim() &&
      afterReplace?.panelState === "sent" &&
      afterReplace?.panelTitle === "已发送",
    JSON.stringify({ composer: String(afterReplace?.composer || "").slice(0, 40), state: afterReplace?.panelState, title: afterReplace?.panelTitle })
  );

  // 「已发送」反馈停留一拍后浮框自动收场（不用人动手关）
  await sleep(1700);
  const settled = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       return { state: p ? p.dataset.gjState || "" : "", exists: Boolean(p) };
     })()`
  );
  record(
    "「已发送」反馈停留一拍后浮框自动收场",
    settled?.exists === false,
    JSON.stringify(settled)
  );

  // 清空输入框 → 浮框该自己收起来，别挂着一份过期译文
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const box = document.querySelector("#main footer .composer");
       box.textContent = "";
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
       return true;
     })()`
  );
  await sleep(1400);
  record(
    "清空输入框后浮框自动收起",
    (await evaluate(cdp, sessionId, `Boolean(document.getElementById("gj-compose-panel"))`)) === false
  );

  /* ---------- 上游超时：浮框不能只是变灰 ----------
     截图里那个浮框写着「翻译超时（20 秒）」，两个按钮全是灰的 ——
     用户既看不懂发生了什么，也做不到"再试一次"。 */

  await evaluate(cdp, sessionId, `window.__gjTest.failTranslate(true)`);
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const box = document.querySelector("#main footer .composer");
       box.focus();
       box.textContent = "麻烦再确认一下交期";
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "期" }));
       return true;
     })()`
  );
  await sleep(1500);

  const failedPanel = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       if (!p) return { exists: false };
       const replace = p.querySelector(".gj-panel-replace");
       const copy = p.querySelector(".gj-panel-copy");
       return {
         exists: true,
         state: p.dataset.gjState || "",
         body: p.querySelector(".gj-panel-body").textContent,
         replaceLabel: replace ? replace.textContent : "",
         replaceDisabled: replace ? replace.disabled : null,
         copyDisabled: copy ? copy.disabled : null
       };
     })()`
  );
  record(
    "上游超时后浮框直说「超时」（不是空白、也不是永远的「翻译中…」）",
    failedPanel?.exists === true && failedPanel?.state === "failed" && /超时/.test(String(failedPanel?.body || "")),
    JSON.stringify(failedPanel)
  );
  record(
    "失败时「替换到输入框」变成「重试」而且可点（原来两个按钮全灰，用户只能干等）",
    failedPanel?.replaceLabel === "重试" && failedPanel?.replaceDisabled === false,
    JSON.stringify({ label: failedPanel?.replaceLabel, disabled: failedPanel?.replaceDisabled })
  );
  record("失败时右上角复制图标是禁用的（没有译文可复制）", failedPanel?.copyDisabled === true);

  // 点「重试」必须真的再发一次请求，而不是只把按钮标签改回来
  await evaluate(cdp, sessionId, `window.__gjTest.resetTranslateCalls()`);
  await evaluate(cdp, sessionId, `document.getElementById("gj-compose-panel").querySelector(".gj-panel-replace").click(); true`);
  await sleep(1300);
  const retryOutcome = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       return {
         calls: window.__gjTest.translateCalls(),
         state: p ? p.dataset.gjState || "" : "",
         body: p ? p.querySelector(".gj-panel-body").textContent : ""
       };
     })()`
  );
  record(
    "点「重试」真的又发了一次翻译请求（不是只把标签改回去）",
    Array.isArray(retryOutcome?.calls) &&
      retryOutcome.calls.length >= 1 &&
      String(retryOutcome.calls[0]?.text || "").includes("交期"),
    JSON.stringify(retryOutcome)?.slice(0, 220)
  );
  record(
    "草稿的请求带 quick 标记（草稿不重试 —— 用户正盯着看，宁可早说超时）",
    Array.isArray(retryOutcome?.calls) && retryOutcome.calls.length > 0 && retryOutcome.calls.every((call) => call.quick === true),
    JSON.stringify(retryOutcome?.calls)?.slice(0, 180)
  );

  // 收尾：桩恢复成正常，别把后面的断言带偏
  await evaluate(cdp, sessionId, `window.__gjTest.failTranslate(false)`);
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const box = document.querySelector("#main footer .composer");
       box.textContent = "";
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
       return true;
     })()`
  );
  await sleep(400);

  // mock 页默认停在会话 A（翻译用的素材）；归档/训练的素材在会话 B，先切过去。
  await evaluate(cdp, sessionId, `window.__gjMock.switchTo("b"); true`);
  await sleep(500);
  record("已切换到训练用会话 B", (await evaluate(cdp, sessionId, "window.__gjMock.current")) === "b");

  /* ---------- 归档当前会话 ---------- */

  const archiveCurrent = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:archive", scope: "current", format: "jsonl", learn: true })`);
  record("归档当前会话成功", archiveCurrent?.ok === true, JSON.stringify(archiveCurrent)?.slice(0, 180));

  const download = await evaluate(cdp, sessionId, "window.__gjAgentTest.lastDownload");
  record("触发了归档文件下载", Boolean(download?.fileName), JSON.stringify(download)?.slice(0, 120));
  record("文件名是 jsonl", String(download?.fileName || "").endsWith(".jsonl"), download?.fileName);

  const jsonlLine = JSON.parse(String(download?.content || "{}").split("\n")[0] || "{}");
  record("归档里带上了联系人", jsonlLine.contactName === "Ana Torres", jsonlLine.contactName);
  record("归档里带上了号码", jsonlLine.contactPhone === "+492222333", jsonlLine.contactPhone);
  record("归档里带上了会话 id", jsonlLine.conversationId === "wa:492222333@c.us", jsonlLine.conversationId);
  record("归档消息数与 DOM 一致（5 条）", jsonlLine.messageCount === 5, String(jsonlLine.messageCount));
  record(
    "归档保留双向消息（customer/agent）",
    jsonlLine.messages.filter((m) => m.role === "customer").length === 3 && jsonlLine.messages.filter((m) => m.role === "agent").length === 2,
    JSON.stringify(jsonlLine.messages.map((m) => m.role))
  );
  record("归档带上了真实时间戳（来自 data-pre-plain-text）", jsonlLine.messages[0].at === "2026-10-08T09:10:00.000Z", jsonlLine.messages[0].at);
  // EEE4 是 `<br>` 换行的跨行回复：归档必须原样留一个 \n，既不能压成一行，也不能多出空行。
  record(
    "归档保住跨行正文（一个换行，不多不少）",
    jsonlLine.messages[3].content === "MOQ for the stainless version is 10 pcs.\nWould you like me to prepare a PI for 10 pcs?",
    JSON.stringify(jsonlLine.messages[3].content)
  );

  const profile = await evaluate(cdp, sessionId, "window.__gjTest.read('gj_reply_profile')");
  record("学习产出了训练档案", profile?.status === "ready", JSON.stringify(profile)?.slice(0, 160));
  record("档案抽到 2 组问答", profile?.examples?.length === 2, String(profile?.examples?.length));
  record("档案标注了 language", Array.isArray(profile?.languages) && profile.languages.includes("es"), JSON.stringify(profile?.languages));
  record("档案自带出厂护栏", (profile?.guardrails?.length ?? 0) >= 4, String(profile?.guardrails?.length));

  const corpus = await evaluate(cdp, sessionId, "window.__gjTest.read('gj_reply_corpus')");
  record("本地语料摘要已落库", (corpus?.exchanges?.length ?? 0) === 2, String(corpus?.exchanges?.length));
  record(
    "语料不含归档全文（只存摘要）",
    !Array.isArray(corpus?.messages) && typeof corpus?.messages === "number" && JSON.stringify(corpus).length < 4000,
    `messages=${Array.isArray(corpus?.messages) ? "数组(错)" : typeof corpus?.messages} bytes=${JSON.stringify(corpus).length}`
  );

  /* ---------- 状态接口 ---------- */

  const status = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:status" })`);
  record("状态接口报告当前会话", status?.contact?.contactName === "Ana Torres", status?.contact?.contactName);
  record("状态接口带出档案摘要", status?.profile?.samples === 2, JSON.stringify(status?.profile)?.slice(0, 120));

  /* ---------- 推送训练档案到 CRM ---------- */

  /*
   * 走**真按钮**：面板 → 折叠区 → 「推送到 CRM」。只有点真按钮才能同时证明
   * 「按钮在」「profile 从 state 里取到了」「payload 真的送出去」三件事。
   * created 是按 payload 现算的（样本数 + 护栏数），payload 没送对断言必红。
   */
  await evaluate(cdp, sessionId, "window.__gjTest.resetCalls()");
  const pushProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       let panel = document.getElementById("gj-agent-panel");
       if (!panel) {
         document.getElementById("gj-agent-button")?.click();
         await new Promise((resolve) => setTimeout(resolve, 300));
         panel = document.getElementById("gj-agent-panel");
       }
       if (!panel) return { ok: false, error: "面板不在" };
       const details = panel.querySelector("details.gj-agent-more");
       if (!details) return { ok: false, error: "折叠区不在" };
       details.open = true;
       await new Promise((resolve) => setTimeout(resolve, 120));
       const push = [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").includes("推送到 CRM"));
       if (!push) return { ok: false, error: "推送按钮不在", buttons: [...panel.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 24) };
       push.click();
       await new Promise((resolve) => setTimeout(resolve, 500));
       const note = panel.textContent || "";
       return { ok: true, noteHasPushed: note.includes("已推送到 CRM"), note: note.slice(0, 220) };
     })()`
  );
  const pushCalls = (await evaluate(cdp, sessionId, "window.__gjTest.crmCalls()")).filter((c) => c.type === "crmTrainingImport");
  record("面板上有「推送到 CRM」按钮且点了有反应", pushProbe?.ok === true, JSON.stringify(pushProbe)?.slice(0, 240));
  const pushPayload = pushCalls[0]?.payload;
  record("推送请求真的发出（带档案名）", pushPayload?.name === "Web 会话档案", JSON.stringify(pushPayload)?.slice(0, 160));
  record("推送的是问答样本（payload 有 examples）", (pushPayload?.examples?.length ?? 0) === 2, String(pushPayload?.examples?.length));
  record("护栏一并提供", (pushPayload?.guardrails?.length ?? 0) > 0, JSON.stringify(pushPayload?.guardrails)?.slice(0, 120));
  record("note 报告入库结果（created = 样本数 + 护栏数）", pushProbe?.noteHasPushed === true && String(pushProbe?.note || "").includes("3"), String(pushProbe?.note || "").slice(0, 160));

  /* ---------- 草稿模式：填输入框但不发送 ---------- */

  await evaluate(cdp, sessionId, `window.__gjTest.setAutoReply({ enabled: true, mode: "draft" })`);
  await sleep(400);
  const sentBefore = await evaluate(cdp, sessionId, "window.__gjMock.sentCount");

  const draftRun = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:replyNow" })`);
  record("草稿模式产出了回复", draftRun?.decision?.action === "reply", JSON.stringify(draftRun?.decision)?.slice(0, 200));
  record("草稿用的是历史原话", String(draftRun?.decision?.body || "").includes("45 days"), String(draftRun?.decision?.body || "").slice(0, 90));
  record("草稿置信度达门槛", Number(draftRun?.decision?.confidence) >= 0.5, String(draftRun?.decision?.confidence));

  const composerText = await evaluate(cdp, sessionId, "(document.querySelector('#main footer .composer') || {}).textContent || ''");
  record("回复已填入输入框", String(composerText).includes("45 days"), String(composerText).slice(0, 90));

  const sentAfterDraft = await evaluate(cdp, sessionId, "window.__gjMock.sentCount");
  record("草稿模式**没有**发送任何消息", sentAfterDraft === sentBefore, `${sentBefore} → ${sentAfterDraft}`);

  const noteNode = await evaluate(
    cdp,
    sessionId,
    `(function(){ const n = document.querySelector(".gj-reply-note"); return n ? { state: n.dataset.gjState, text: n.textContent } : null; })()`
  );
  record("页面上标注了回复建议", noteNode?.state === "draft", JSON.stringify(noteNode)?.slice(0, 160));

  /* ---------- 全自动模式：填完并真的发出 ---------- */

  await evaluate(cdp, sessionId, `document.querySelector('#main footer .composer').textContent = ""; true`);
  await evaluate(cdp, sessionId, `window.__gjTest.setAutoReply({ enabled: true, mode: "auto" })`);
  await sleep(400);

  const autoRun = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:replyNow" })`);
  record("全自动模式产出回复", autoRun?.decision?.action === "reply" && autoRun?.decision?.mode === "auto", JSON.stringify(autoRun?.decision)?.slice(0, 160));
  await sleep(300);

  const sentAfterAuto = await evaluate(cdp, sessionId, "window.__gjMock.sentCount");
  record("全自动模式真的发出了消息", sentAfterAuto === sentBefore + 1, `${sentBefore} → ${sentAfterAuto}`);

  const ledger = await evaluate(cdp, sessionId, "window.__gjTest.read('gj_auto_reply_ledger')");
  record("发送计入当日账本", ledger?.sentToday === 1, JSON.stringify(ledger));

  /* ---------- 转人工：不生成、不发送 ---------- */

  await evaluate(
    cdp,
    sessionId,
    `(function(){
       const box = document.querySelector('[data-testid="conversation-panel-messages"]');
       const row = document.createElement("div");
       row.className = "message-in";
       row.setAttribute("data-id", "false_492222333@c.us_ESC1");
       const bubble = document.createElement("div");
       bubble.className = "bubble";
       const span = document.createElement("span");
       span.className = "selectable-text copyable-text";
       span.setAttribute("data-pre-plain-text", "[10:30, 08/10/2026] Ana Torres: ");
       span.textContent = "我要投诉，你们的货有问题，我要退款";
       bubble.appendChild(span);
       row.appendChild(bubble);
       box.appendChild(row);
       return true;
     })()`
  );
  await sleep(300);
  const sentBeforeEscalate = await evaluate(cdp, sessionId, "window.__gjMock.sentCount");
  const escalateRun = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:replyNow" })`);
  await sleep(300);
  const sentAfterEscalate = await evaluate(cdp, sessionId, "window.__gjMock.sentCount");
  record("投诉消息被转人工", escalateRun?.decision?.action === "skip" && String(escalateRun?.decision?.reason || "").includes("投诉"), JSON.stringify(escalateRun?.decision)?.slice(0, 160));
  record("转人工时不发送", sentAfterEscalate === sentBeforeEscalate, `${sentBeforeEscalate} → ${sentAfterEscalate}`);

  /* ---------- 归档全部会话 ---------- */

  await evaluate(cdp, sessionId, `window.__gjTest.setAutoReply({ enabled: false, mode: "draft" })`);
  await evaluate(cdp, sessionId, `window.__gjMock.switchTo("a"); true`);
  await sleep(500);
  const archiveAll = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:archive", scope: "all", format: "txt", learn: false })`);
  record("归档全部会话成功", archiveAll?.ok === true, JSON.stringify(archiveAll)?.slice(0, 200));
  const allDownload = await evaluate(cdp, sessionId, "window.__gjAgentTest.lastDownload");
  record("全部归档用 txt 格式", String(allDownload?.fileName || "").endsWith(".txt"), allDownload?.fileName);
  record("全部归档覆盖两个会话", String(allDownload?.content || "").split("# 会话").length - 1 === 2, String(String(allDownload?.content || "").split("# 会话").length - 1));
  record(
    "txt 是插件可解析的 `[dd/mm/yyyy, hh:mm] 发送人: 正文` 格式",
    /\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\] [^:]+: /u.test(String(allDownload?.content || "")),
    String(allDownload?.content || "").split("\n").find((line) => line.startsWith("["))?.slice(0, 70)
  );
  const allTxtLines = String(allDownload?.content || "").split("\n");
  record(
    "跨行正文在 txt 里作为独立续行输出（插件的并回逻辑认得）",
    allTxtLines.includes("Would you like me to prepare a PI for 10 pcs?"),
    allTxtLines.find((line) => line.startsWith("Would you")) || "未找到续行"
  );
  record("归档后恢复了原来的会话", (await evaluate(cdp, sessionId, "window.__gjMock.current")) === "a", await evaluate(cdp, sessionId, "window.__gjMock.current"));

  /* ---------- 导出训练包 ---------- */

  const exported = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:exportProfile" })`);
  record("导出训练包成功", exported?.ok === true, JSON.stringify(exported)?.slice(0, 160));
  const kit = await evaluate(cdp, sessionId, "window.__gjAgentTest.lastDownload");
  record("训练包是 markdown", String(kit?.fileName || "").endsWith(".md"), kit?.fileName);
  record(
    "训练包含问答对与政策",
    String(kit?.content || "").includes("## 标准问答对") && String(kit?.content || "").includes("## 政策（必须遵守）")
  );

  /* ---------- 页面悬浮球与面板 ---------- */

  /*
   * 面板是**开关**，而且 `replyLatest()` 每次都会主动 `renderPanel(true)` 把结果弹出来
   * （只有自动扫描路径才不弹，避免自己跳出来打断人）。所以这里不能假设"点一下就是开" ——
   * 先归零：有就点掉，再点开，断言与之前步骤留下的状态无关。
   */
  const panelState = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const log = { errors: [] };
       const onError = (event) => log.errors.push(String(event.message || event.error || event));
       window.addEventListener("error", onError);
       const btn = document.getElementById("gj-agent-button");
       const hadButton = Boolean(btn);
       const panelOf = () => document.getElementById("gj-agent-panel");
       const stateOf = (node) => {
         if (!node) return { exists: false };
         const r = node.getBoundingClientRect();
         const full = node.textContent || "";
         return {
           exists: true,
           open: node.dataset.gjOpen || "",
           top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
           width: Math.round(r.width), height: Math.round(r.height),
           viewport: window.innerHeight,
           inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1,
           // 全文里的关键内容单独报成布尔位：截断过的那 200 字看不到折叠区里的东西
           hasProfile: full.includes("训练档案"),
           text: full.slice(0, 200)
         };
       };

       if (panelOf()) { btn?.click(); await new Promise((resolve) => setTimeout(resolve, 80)); }
       const closed = stateOf(panelOf());
       // 关闭后再开：这一段只该发生"铺快资料"这一次请求，留痕归零好做精确断言。
       window.__gjTest.resetCalls();

       btn?.click();
       await new Promise((resolve) => setTimeout(resolve, 260));
       const opened = stateOf(panelOf());

       window.removeEventListener("error", onError);
       return { hadButton, closed, opened, types: window.__gjTest.crmCalls().map((c) => c.type), ...log };
     })()`
  );
  record("悬浮球找到了", panelState?.hadButton === true);
  record("再点一下能把已打开的面板收起（它是个开关）", panelState?.closed?.exists === false, JSON.stringify(panelState?.closed)?.slice(0, 160));
  record(
    "点悬浮球能展开归档面板",
    panelState?.opened?.exists === true && panelState?.opened?.open === "1",
    JSON.stringify(panelState?.opened)?.slice(0, 200)
  );
  record("面板展开过程没有抛异常", (panelState?.errors?.length ?? 0) === 0, JSON.stringify(panelState?.errors));
  record(
    "面板完整落在视口内（没有因为缺 bottom 被挤到屏幕外）",
    panelState?.opened?.inViewport === true,
    JSON.stringify(panelState?.opened)?.slice(0, 200)
  );
  record(
    "归档 / 训练那块还在面板里（只是收进了折叠区）",
    panelState?.opened?.hasProfile === true,
    String(panelState?.opened?.text || "").slice(0, 90)
  );
  record(
    "展开这一刻只发生了一次快检索，没有别的请求",
    JSON.stringify(panelState?.types) === JSON.stringify(["crmResources"]),
    JSON.stringify(panelState?.types)
  );
  const panelShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `agent-panel-${TAG}.png`), Buffer.from(panelShot.data, "base64"));

  /* ---------- 右侧整列：布局 ---------- */

  /*
   * 用户要的是"右边完全开一整列"，不是浮层。区别是可量的：
   * 列必须**贴右上左下**（满高）、把 WhatsApp 根容器**推窄**（`#app` 的 margin-right），
   * 而且推出来的宽度要等于列自己的宽度 —— 否则消息区会被列压住一截。
   */
  const columnLayout = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const panel = document.getElementById("gj-agent-panel");
       if (!panel) return { exists: false };
       const r = panel.getBoundingClientRect();
       const app = document.querySelector("#app");
       return {
         exists: true,
         open: panel.dataset.gjOpen || "",
         collapsed: panel.dataset.gjCollapsed || "",
         rect: { top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) },
         viewport: { w: window.innerWidth, h: window.innerHeight },
         appMarginRight: app ? app.style.marginRight : "(无 #app)",
         appRight: app ? Math.round(app.getBoundingClientRect().right) : null,
         mode: document.documentElement.dataset.gjCol || "",
         colWidth: getComputedStyle(document.documentElement).getPropertyValue("--gj-col-w").trim(),
         hasResize: Boolean(panel.querySelector(".gj-agent-resize")),
         hasDetails: Boolean(panel.querySelector("details.gj-agent-more")),
         lockPadding: document.body.style.padding || ""
       };
     })()`
  );

  record("右侧整列已经开出来了", columnLayout?.exists === true && columnLayout?.open === "1", JSON.stringify(columnLayout)?.slice(0, 200));
  record(
    "整列是**满高贴右**的侧栏（top/right/bottom 三边都顶住）",
    columnLayout?.rect?.top === 0 &&
      columnLayout?.rect?.right === columnLayout?.viewport?.w &&
      columnLayout?.rect?.bottom === columnLayout?.viewport?.h,
    JSON.stringify({ rect: columnLayout?.rect, viewport: columnLayout?.viewport })
  );
  record(
    "整列把 WhatsApp 推窄（#app 的 margin-right 等于列宽），不是盖在消息上",
    columnLayout?.mode === "push" && columnLayout?.appMarginRight === columnLayout?.rect?.width + "px",
    `mode=${columnLayout?.mode} marginRight=${columnLayout?.appMarginRight} 列宽=${columnLayout?.rect?.width}`
  );
  record(
    "推窄之后聊天区右边缘正好停在列左边（没有一截被压住）",
    columnLayout?.appRight === columnLayout?.rect?.left,
    `#app.right=${columnLayout?.appRight} 列.left=${columnLayout?.rect?.left}`
  );
  record("整列宽度落在 320–720 之间", (columnLayout?.rect?.width ?? 0) >= 320 && (columnLayout?.rect?.width ?? 0) <= 720, String(columnLayout?.rect?.width));
  record("左边缘有可拖拽的把手", columnLayout?.hasResize === true);
  record("归档 / 训练 / 本地自动回复收进了折叠区（不再和新内容抢注意力）", columnLayout?.hasDetails === true);
  record(
    "给 WhatsApp 留位用的是 #app 的 margin，没有去动 body padding",
    String(columnLayout?.lockPadding || "") === "",
    String(columnLayout?.lockPadding || "")
  );

  /* ---------- 打开列就先铺一层「快」资料 ---------- */

  /*
   * 展开一列**不该**等于"替我起一个几十秒的 CLI 任务"。设计口径是：
   * 打开先用 `/resources/search` 秒回一批资料把内容铺出来，出稿那件事留给
   * "真的换了会话"和用户自己点。这一段同时盯着"有没有偷偷跑出稿"。
   */
  let prefillProbe = null;
  for (let i = 0; i < 25; i += 1) {
    prefillProbe = await evaluate(
      cdp,
      sessionId,
      `(function(){
         const panel = document.getElementById("gj-agent-panel");
         const calls = window.__gjTest.crmCalls();
         return {
           cards: panel ? panel.querySelectorAll(".gj-agent-res").length : 0,
           titles: panel ? [...panel.querySelectorAll(".gj-agent-res-title")].map((n) => n.textContent) : [],
           types: calls.map((c) => c.type),
           colState: document.documentElement.dataset.gjColState || "",
           statusText: panel && panel.querySelector(".gj-agent-col-status-title") ? panel.querySelector(".gj-agent-col-status-title").textContent : "",
           replyBlock: panel && panel.querySelector(".gj-agent-block .gj-agent-empty") ? panel.querySelector(".gj-agent-block .gj-agent-empty").textContent : ""
         };
       })()`
    );
    if ((prefillProbe?.cards ?? 0) > 0) break;
    await sleep(150);
  }

  record(
    "打开整列后自动铺出了资料卡（没让用户对着空面板等出稿）",
    (prefillProbe?.cards ?? 0) === 2,
    JSON.stringify({ cards: prefillProbe?.cards, titles: prefillProbe?.titles, status: prefillProbe?.statusText })
  );
  record(
    "铺初值走的是快检索通道，**没有**顺手跑一轮几十秒的出稿",
    JSON.stringify(prefillProbe?.types) === JSON.stringify(["crmResources"]),
    JSON.stringify(prefillProbe?.types)
  );
  record(
    "只取了资料这一轮，回复区如实说明是「没让模型出稿」（而不是说「依据不足」）",
    String(prefillProbe?.replyBlock || "").includes("只取了资料"),
    String(prefillProbe?.replyBlock || "").slice(0, 120)
  );

  /* ---------- 「只要回复（不推资料）」：另一条通道 ---------- */

  const composeProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const log = { errors: [] };
       const onError = (event) => log.errors.push(String(event.message || event));
       window.addEventListener("error", onError);
       const panel = () => document.getElementById("gj-agent-panel");
       const text = (node) => (node ? node.textContent || "" : "");
       const buttonOf = (label) => [...panel().querySelectorAll("button")].find((node) => (node.textContent || "").includes(label));

       const sentBefore = window.__gjMock.sentCount;
       buttonOf("只要回复（不推资料）").click();
       // 桩是同步返回的，但整条链路至少要走一轮 microtask + 一次重绘
       await new Promise((resolve) => setTimeout(resolve, 900));

       const card = text(panel().querySelector(".gj-agent-reply")).slice(0, 800);
       const evidence = text(panel().querySelector(".gj-agent-evidence")).slice(0, 400);
       const badges = [...panel().querySelectorAll(".gj-agent-badge")].map((node) => node.textContent);

       const composer = document.querySelector("#main footer .composer");
       buttonOf("填进输入框")?.click();
       await new Promise((resolve) => setTimeout(resolve, 200));

       window.removeEventListener("error", onError);
       return {
         card, evidence, badges,
         resourceCards: panel().querySelectorAll(".gj-agent-res").length,
         composerText: composer ? composer.textContent || "" : "",
         sentBefore, sentAfter: window.__gjMock.sentCount,
         types: window.__gjTest.crmCalls().map((c) => c.type),
         ...log
       };
     })()`
  );

  record(
    "草稿里带着页面上那段客户原话（证明对话真的被送出去了）",
    String(composeProbe?.card || "").includes("[CRM稿]") && String(composeProbe?.card || "").includes("nos interesan 500 unidades"),
    String(composeProbe?.card || "").slice(0, 200)
  );
  record("草稿标出引擎与模型", String(composeProbe?.card || "").includes("cli") && String(composeProbe?.card || "").includes("deepseek-v4.1-flash"), String(composeProbe?.card || "").slice(160, 320));
  record(
    "来源徽章把「这条回复凭什么」摆出来（训练库 / CRM 跟进 / 历史报价 / 知识库 / 资料推荐）",
    ["训练库", "CRM 跟进", "历史报价", "知识库", "资料推荐"].every((label) => (composeProbe?.badges || []).includes(label)),
    JSON.stringify(composeProbe?.badges)
  );
  record(
    "依据写明按号码匹配到哪个客户、跟进与报价各几条",
    String(composeProbe?.evidence || "").includes("按号码") && String(composeProbe?.evidence || "").includes("Miguel Santos"),
    String(composeProbe?.evidence || "").slice(0, 220)
  );
  record(
    "「只要回复」这条通道真的打的是 crmCompose",
    composeProbe?.types?.includes("crmCompose") === true,
    JSON.stringify(composeProbe?.types)
  );
  record(
    "「只要回复（不推资料）」不清掉已经铺好的资料（两块内容互不覆盖）",
    (composeProbe?.resourceCards ?? 0) === 2,
    String(composeProbe?.resourceCards)
  );
  record("「填进输入框」把 CRM 草稿写进了输入框", String(composeProbe?.composerText || "").includes("[CRM稿]"), String(composeProbe?.composerText || "").slice(0, 90));
  record("这条链路**不**替你发送任何消息", composeProbe?.sentAfter === composeProbe?.sentBefore, `${composeProbe?.sentBefore} → ${composeProbe?.sentAfter}`);
  record("整列这一路没有抛异常", (composeProbe?.errors?.length ?? 0) === 0, JSON.stringify(composeProbe?.errors));

  const columnShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `agent-column-${TAG}.png`), Buffer.from(columnShot.data, "base64"));

  /* ---------- 真实外链：只在你点了才取，且永远不进页面 ---------- */

  /*
   * 全系统的硬纪律：列表/推荐接口**永不下发**地址，只有 `reveal` 在鉴权后返回一份。
   * 这里连"桩里故意塞进来的 sourceUrl"一起盯着 —— 它必须从没出现在 DOM 上，
   * 那说明界面手里根本没有这个字段（否则早晚有一次改动会顺手渲染出来）。
   *
   * 两条路都要覆盖，因为两条路的表现差别很大：
   *   A. 剪贴板能用 → 地址只进内存，页面上不出现；按钮变「已复制」并报出提取码。
   *   B. 剪贴板被挡 → 必须**真的把地址摆出来**给用户全选。只提示"请手动复制"而页面上
   *      什么都没有，比直接报错更糟 —— headless Chrome 走的就是这一条。
   * 剪贴板权限没法在 headless 里手工授予，所以直接替换 `navigator.clipboard` 把两条路走通。
   */
  const revealProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const panel = () => document.getElementById("gj-agent-panel");
       const fileCard = () => panel().querySelector('.gj-agent-res[data-gj-res="file"]');
       const html = () => document.documentElement.innerHTML;
       const note = () => (panel().querySelector(".gj-agent-note") || {}).textContent || "";
       const manualField = () => panel().querySelector(".gj-agent-manual-url");
       const setClipboard = (behavior) => {
         Object.defineProperty(navigator, "clipboard", {
           configurable: true,
           value: { writeText: behavior === "ok" ? async () => {} : async () => { throw new Error("剪贴板被挡"); } }
         });
       };

       const before = {
         types: window.__gjTest.crmCalls().map((c) => c.type),
         realUrlOnPage: html().includes("files.goodjob.test"),
         leakUrlOnPage: html().includes("leak.example.test"),
         manualFieldPresent: Boolean(manualField())
       };

       /* ---- A. 剪贴板可用 ---- */
       setClipboard("ok");
       // 按位置点第一个动作按钮：成功后它就改叫「已复制」了，按文案找第二次会找不到。
       const primary = () => fileCard().querySelectorAll("button")[0];
       primary().click();
       await new Promise((resolve) => setTimeout(resolve, 400));
       const okPath = {
         labels: [...fileCard().querySelectorAll("button")].map((node) => node.textContent),
         note: note(),
         realUrlOnPage: html().includes("files.goodjob.test"),
         manualFieldPresent: Boolean(manualField())
       };

       /* ---- B. 剪贴板被挡：同一个按钮再点一次（地址已经在内存里，不会再打一次网络）---- */
       setClipboard("fail");
       primary().click();
       await new Promise((resolve) => setTimeout(resolve, 400));
       const field = manualField();
       const failPath = {
         labels: [...fileCard().querySelectorAll("button")].map((node) => node.textContent),
         note: note(),
         manualValue: field ? field.value : "",
         manualReadOnly: field ? field.readOnly : null,
         manualVisible: Boolean(field) && field.getBoundingClientRect().height > 0
       };

       const calls = window.__gjTest.crmCalls();
       return {
         before, okPath, failPath,
         revealPayload: (calls.filter((c) => c.type === "crmReveal").slice(-1)[0] || {}).payload,
         revealCount: calls.filter((c) => c.type === "crmReveal").length,
         leakUrlOnPage: html().includes("leak.example.test"),
         revealed: window.__gjAgentTest.column.revealed,
         manualKey: window.__gjAgentTest.column.manualKey
       };
     })()`
  );

  record(
    "点之前后台**一次**都没被问过链接（不预取），页面上也没有地址",
    revealProbe?.before?.types?.includes("crmReveal") === false &&
      revealProbe?.before?.realUrlOnPage === false &&
      revealProbe?.before?.manualFieldPresent === false,
    JSON.stringify(revealProbe?.before)
  );
  record(
    "reveal 带上这份资料的标识与来源",
    revealProbe?.revealPayload?.sourceType === "file" && revealProbe?.revealPayload?.id === "11",
    JSON.stringify(revealProbe?.revealPayload)
  );
  record(
    "剪贴板能用时：按钮变「已复制」，并把提取码告诉用户",
    (revealProbe?.okPath?.labels || []).includes("已复制") && String(revealProbe?.okPath?.note || "").includes("a1b2"),
    JSON.stringify({ labels: revealProbe?.okPath?.labels, note: String(revealProbe?.okPath?.note || "").slice(0, 120) })
  );
  record(
    "剪贴板能用时：真实地址只进内存，**没有**被渲染进页面",
    revealProbe?.okPath?.realUrlOnPage === false && revealProbe?.okPath?.manualFieldPresent === false,
    JSON.stringify(revealProbe?.okPath)
  );
  record(
    "剪贴板被挡时：地址**真的摆出来了**（只读框、可全选），不是只说一句「请手动复制」",
    revealProbe?.failPath?.manualVisible === true &&
      revealProbe?.failPath?.manualReadOnly === true &&
      revealProbe?.failPath?.manualValue === "https://files.goodjob.test/moq-stainless-2026.pdf",
    JSON.stringify(revealProbe?.failPath)
  );
  record(
    "剪贴板被挡时：如实说明是浏览器挡的，并把提取码一起给出来",
    String(revealProbe?.failPath?.note || "").includes("不让自动复制") && String(revealProbe?.failPath?.note || "").includes("a1b2"),
    String(revealProbe?.failPath?.note || "").slice(0, 140)
  );
  record(
    "再点一次不会再打一次 reveal（地址已在内存里）",
    revealProbe?.revealCount === 1,
    String(revealProbe?.revealCount)
  );
  record(
    "服务端万一带了地址字段，界面也拿不到（白名单投影挡住了）",
    revealProbe?.before?.leakUrlOnPage === false && revealProbe?.leakUrlOnPage === false,
    `before=${revealProbe?.before?.leakUrlOnPage} after=${revealProbe?.leakUrlOnPage}`
  );
  record(
    "内存里只记了「取过哪一份」（自检日志里不会出现真实地址）",
    JSON.stringify(revealProbe?.revealed) === JSON.stringify(["file:11"]) && revealProbe?.manualKey === "file:11",
    JSON.stringify({ revealed: revealProbe?.revealed, manualKey: revealProbe?.manualKey })
  );

  /* ---------- 内联正文 / 埋点 / 忽略 ---------- */

  const feedbackProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const panel = () => document.getElementById("gj-agent-panel");
       const cardOf = (type) => [...panel().querySelectorAll(".gj-agent-res")].find((node) => node.dataset.gjRes === type);
       const buttonIn = (card, label) => [...(card ? card.querySelectorAll("button") : [])].find((node) => (node.textContent || "").includes(label));
       const note = () => (panel().querySelector(".gj-agent-note") || {}).textContent || "";

       buttonIn(cardOf("knowledge"), "看正文").click();
       await new Promise((resolve) => setTimeout(resolve, 300));
       const inlineNote = note();
       const inlineNode = panel().querySelector(".gj-agent-manual-body");
       const inlineBody = inlineNode ? inlineNode.textContent : "";

       buttonIn(cardOf("knowledge"), "已发给客户").click();
       await new Promise((resolve) => setTimeout(resolve, 250));
       const sentNote = note();

       buttonIn(cardOf("file"), "没帮助").click();
       await new Promise((resolve) => setTimeout(resolve, 300));

       const calls = window.__gjTest.crmCalls();
       return {
         inlineNote, inlineBody, sentNote,
         fileCardGone: !cardOf("file"),
         knowledgeStillThere: Boolean(cardOf("knowledge")),
         feedback: calls.filter((c) => c.type === "crmFeedback").map((c) => (c.payload.items || [])[0]),
         revealCount: calls.filter((c) => c.type === "crmReveal").length,
         dismissed: window.__gjAgentTest.column.dismissed
       };
     })()`
  );

  record(
    "知识条目没有外链，点「看正文」把正文**真的贴在卡片里**（说清为什么没链接）",
    String(feedbackProbe?.inlineNote || "").includes("没有外链") && String(feedbackProbe?.inlineBody || "").includes("标准款 50 pcs"),
    JSON.stringify({ note: String(feedbackProbe?.inlineNote || "").slice(0, 90), body: String(feedbackProbe?.inlineBody || "").slice(0, 90) })
  );
  record(
    "「已发给客户」上报成 sent（埋点是学习信号，不是装饰）",
    feedbackProbe?.feedback?.some((item) => item && item.action === "sent") === true,
    JSON.stringify(feedbackProbe?.feedback)
  );
  record(
    "「没帮助」把这张卡从列表里摘掉并上报 dismissed",
    feedbackProbe?.fileCardGone === true && feedbackProbe?.feedback?.some((item) => item && item.action === "dismissed") === true,
    JSON.stringify({ gone: feedbackProbe?.fileCardGone, feedback: feedbackProbe?.feedback, dismissed: feedbackProbe?.dismissed })
  );
  record(
    "取链接一共只发生过两次（各是一份资料、各是用户点的）",
    feedbackProbe?.revealCount === 2,
    String(feedbackProbe?.revealCount)
  );
  record("反复点卡片没有抛异常", Boolean(feedbackProbe?.feedback), JSON.stringify(feedbackProbe)?.slice(0, 120));

  /* ---------- 「重新分析」：回复 + 资料一次给全 ---------- */

  const fullProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const panel = () => document.getElementById("gj-agent-panel");
       const buttonOf = (label) => [...panel().querySelectorAll("button")].find((node) => (node.textContent || "").includes(label));
       const sentBefore = window.__gjMock.sentCount;

       buttonOf("重新分析").click();
       await new Promise((resolve) => setTimeout(resolve, 1200));

       const suggestCalls = window.__gjTest.crmCalls().filter((c) => c.type === "crmSuggest");
       const last = suggestCalls.slice(-1)[0] || {};
       const payload = last.payload || {};
       return {
         count: suggestCalls.length,
         messages: (payload.messages || []).map((m) => m.direction + ":" + String(m.body).slice(0, 30)),
         contact: payload.contact,
         limit: payload.limit,
         hasReplyBlock: Boolean(panel().querySelector(".gj-agent-reply")),
         hasResourceBlock: panel().querySelectorAll(".gj-agent-res").length,
         blockTitles: [...panel().querySelectorAll(".gj-agent-block-title")].map((node) => node.textContent),
         sentBefore, sentAfter: window.__gjMock.sentCount
       };
     })()`
  );

  record(
    "「重新分析」走的是回复 + 资料那条通道（crmSuggest）",
    (fullProbe?.count ?? 0) >= 1,
    String(fullProbe?.count)
  );
  record(
    "送上去的就是页面上这段对话（有 inbound，且带原文片段）",
    (fullProbe?.messages || []).some((line) => String(line).startsWith("inbound:")) &&
      (fullProbe?.messages || []).some((line) => String(line).includes("nos interesan")),
    JSON.stringify(fullProbe?.messages)?.slice(0, 240)
  );
  record(
    "联系人姓名与号码一起送上去（CRM 侧靠它认客户）",
    String(fullProbe?.contact?.name || "").length > 0 && String(fullProbe?.contact?.phone || "").length > 0,
    JSON.stringify(fullProbe?.contact)
  );
  record("只要 5 份资料（面板一次给太多等于没推荐）", fullProbe?.limit === 5, String(fullProbe?.limit));
  record(
    "整列同时出现「推荐回复」与「相关文档」两块（用户要的就是这两块一起）",
    (fullProbe?.blockTitles || []).some((title) => String(title).includes("推荐回复")) &&
      (fullProbe?.blockTitles || []).some((title) => String(title).includes("相关文档")),
    JSON.stringify(fullProbe?.blockTitles)
  );
  record(
    "「没帮助」是用户的判断，刷新一轮不会把它忘掉",
    (fullProbe?.hasResourceBlock ?? 0) === 1,
    String(fullProbe?.hasResourceBlock)
  );
  record("重新分析这一路也**不**发送任何消息", fullProbe?.sentAfter === fullProbe?.sentBefore, `${fullProbe?.sentBefore} → ${fullProbe?.sentAfter}`);

  /* ---------- 折叠 / 展开 / 关闭归还空间 ---------- */

  const collapseProbe = await evaluate(
    cdp,
    sessionId,
    `(async function(){
       const panel = () => document.getElementById("gj-agent-panel");
       const app = document.querySelector("#app");
       const buttonOf = (label) => [...panel().querySelectorAll("button")].find((node) => (node.textContent || "").trim() === label);

       buttonOf("›").click();
       await new Promise((resolve) => setTimeout(resolve, 300));
       const collapsed = {
         flag: panel().dataset.gjCollapsed,
         rail: Boolean(panel().querySelector(".gj-agent-rail")),
         width: Math.round(panel().getBoundingClientRect().width),
         appMarginRight: app.style.marginRight,
         mode: document.documentElement.dataset.gjCol || ""
       };

       buttonOf("‹").click();
       await new Promise((resolve) => setTimeout(resolve, 300));
       const expanded = {
         flag: panel().dataset.gjCollapsed,
         width: Math.round(panel().getBoundingClientRect().width),
         appMarginRight: app.style.marginRight
       };

       buttonOf("×").click();
       await new Promise((resolve) => setTimeout(resolve, 300));
       return {
         collapsed, expanded,
         afterClose: { gone: !document.getElementById("gj-agent-panel"), appMarginRight: app.style.marginRight, mode: document.documentElement.dataset.gjCol || "" }
       };
     })()`
  );

  record(
    "能折叠成一条竖条（只剩标识，宽度收窄）",
    collapseProbe?.collapsed?.flag === "1" && collapseProbe?.collapsed?.rail === true && (collapseProbe?.collapsed?.width ?? 999) <= 60,
    JSON.stringify(collapseProbe?.collapsed)
  );
  record(
    "折叠时把推出来的空间还回去（页面不能一直窄着）",
    collapseProbe?.collapsed?.appMarginRight === "" && collapseProbe?.collapsed?.mode === "rail",
    JSON.stringify(collapseProbe?.collapsed)
  );
  record(
    "能再展开回整列并重新推窄",
    collapseProbe?.expanded?.flag === "0" &&
      (collapseProbe?.expanded?.width ?? 0) >= 320 &&
      collapseProbe?.expanded?.appMarginRight === collapseProbe?.expanded?.width + "px",
    JSON.stringify(collapseProbe?.expanded)
  );
  record(
    "关闭整列后页面宽度完全归还（用户会以为 WhatsApp 坏了的那种坑）",
    collapseProbe?.afterClose?.gone === true && collapseProbe?.afterClose?.appMarginRight === "" && collapseProbe?.afterClose?.mode === "",
    JSON.stringify(collapseProbe?.afterClose)
  );

  // 后续步骤（清空语料 / 结尾截图）都要面板处于已知状态：重新点开。
  await evaluate(cdp, sessionId, `document.getElementById("gj-agent-button")?.click(); true`);
  await sleep(300);

  /* ---------- 清空语料 ---------- */

  // 面板此时是开着的；先收起，保证最后那张"整页"截图是一张干净页面（不是半屏面板）。
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       if (document.getElementById("gj-agent-panel")) document.getElementById("gj-agent-button")?.click();
       return !document.getElementById("gj-agent-panel");
     })()`
  );

  const reset = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:reset" })`);
  record("清空语料可用", reset?.ok === true);
  record("清空后档案被移除", (await evaluate(cdp, sessionId, "window.__gjTest.read('gj_reply_profile')")) === null);
  const afterReset = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "agent:replyNow" })`);
  record("清空后不再自动回复", afterReset?.decision?.action === "skip", JSON.stringify(afterReset?.decision)?.slice(0, 140));

  /* ---------- 截图与控制台 ---------- */

  await evaluate(cdp, sessionId, `document.getElementById("gj-agent-button")?.click(); true`);
  await sleep(200);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `agent-${TAG}.png`), Buffer.from(shot.data, "base64"));

  /* ---------- 「替换到输入框」必须**真的**替换：拿一个顽固编辑器（Lexical 仿制）来验 ----------
   *
   * 用户报障原话：「点击一键替换，应该把对话框中的内容替换，而不是再确认。」
   * 真机上 WhatsApp 的输入框是 Lexical：它会把不认的改动吞掉或按自己的状态回滚，而
   * `document.execCommand` **照样返回 true**。旧实现只看这个返回值，于是界面显示
   * 「已替换到输入框」、输入框里一个字都没变。
   *
   * 普通的 contenteditable（前面那段用的就是）永远测不出这个毛病 —— 它什么都认。
   * 所以这里让 mock 页切到"只认粘贴"的顽固编辑器，验两件事：
   *   ① 原生插入被吞掉时，扩展能换一条路（合成粘贴）把译文真的写进去；
   *   ② 四条路都不通时，界面必须**说实话**，不许显示「已替换到输入框」。
   */

  await evaluate(
    cdp,
    sessionId,
    `(function(){
       document.getElementById("gj-compose-panel")?.remove();
       window.__gjMock.strictEditor.enable({ text: "请确认一下交期" });
       const box = document.querySelector("#main footer .composer");
       box.focus();
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "期" }));
       return true;
     })()`
  );
  await sleep(1700); // AUTO_DELAY 900ms + 桩往返

  const strictPanel = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       if (!p) return { exists: false };
       return {
         exists: true,
         state: p.dataset.gjState || "",
         body: p.querySelector(".gj-panel-body")?.textContent || ""
       };
     })()`
  );
  record(
    "顽固编辑器下，译文浮框照样自动弹出来",
    strictPanel?.exists === true && String(strictPanel?.body || "").includes("[MOCK译]"),
    JSON.stringify(strictPanel)?.slice(0, 160)
  );

  const sentBeforeStrict = await evaluate(cdp, sessionId, `window.__gjMock.sentCount`);
  await evaluate(cdp, sessionId, `document.querySelector("#gj-compose-panel .gj-panel-send").click(); true`);
  await sleep(1300);
  const strictAfter = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       const outs = document.querySelectorAll("#main .message-out");
       return {
         dom: document.querySelector("#main footer .composer").innerText || "",
         sentCount: window.__gjMock.sentCount,
         lastOut: outs.length ? outs[outs.length - 1].textContent : "",
         state: p ? p.dataset.gjState || "" : "",
         title: p ? p.querySelector(".gj-panel-title")?.textContent || "" : "",
         hint: p ? p.querySelector(".gj-panel-hint")?.textContent || "" : ""
       };
     })()
  `.trim()
  );
  record(
    "顽固编辑器吞掉原生插入时，扩展换一条路（合成粘贴）写进去并**直接发送**",
    Number(strictAfter?.sentCount) === Number(sentBeforeStrict) + 1 &&
      String(strictAfter?.lastOut || "").includes("[MOCK译]") &&
      !String(strictAfter?.dom || "").trim(),
    JSON.stringify({ before: sentBeforeStrict, after: strictAfter?.sentCount, dom: String(strictAfter?.dom || "").slice(0, 40), lastOut: String(strictAfter?.lastOut || "").slice(0, 50) })
  );
  record(
    "一键到底成功后浮框报「已发送」，不是让人再按一次回车",
    strictAfter?.state === "sent" && strictAfter?.title === "已发送" && /已替换并发送/u.test(String(strictAfter?.hint || "")),
    JSON.stringify({ state: strictAfter?.state, title: strictAfter?.title, hint: strictAfter?.hint })
  );

  const replacedShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `compose-replaced-${TAG}.png`), Buffer.from(replacedShot.data, "base64"));

  /* ② 连粘贴都不认的编辑器：必须报失败，而不是谎报「已替换到输入框」 */

  await evaluate(
    cdp,
    sessionId,
    `(function(){
       document.getElementById("gj-compose-panel")?.remove();
       window.__gjMock.strictEditor.disable();
       window.__gjMock.strictEditor.enable({ acceptPaste: false, text: "麻烦确认一下交期" });
       const box = document.querySelector("#main footer .composer");
       box.focus();
       box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "期" }));
       return true;
     })()`
  );
  await sleep(1700);
  await evaluate(cdp, sessionId, `document.querySelector("#gj-compose-panel .gj-panel-replace").click(); true`);
  await sleep(1000);
  const hostileAfter = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const p = document.getElementById("gj-compose-panel");
       return {
         dom: document.querySelector("#main footer .composer").innerText || "",
         state: p ? p.dataset.gjState || "" : "",
         title: p ? p.querySelector(".gj-panel-title")?.textContent || "" : "",
         hint: p ? p.querySelector(".gj-panel-hint")?.textContent || "" : ""
       };
     })()`
  );
  record(
    "⚠️ 四条路都不通时**不许谎报**：绝不能显示「已替换到输入框」（旧实现正是在这里骗人）",
    hostileAfter?.state !== "replaced" && hostileAfter?.title !== "已替换到输入框",
    JSON.stringify(hostileAfter)?.slice(0, 200)
  );
  record(
    "写不进去时照实说「没能写进输入框」，并把人引到右上角复制图标",
    /没能写进输入框/u.test(String(hostileAfter?.hint || "")) && /复制图标/u.test(String(hostileAfter?.hint || "")),
    String(hostileAfter?.hint || "")
  );
  record(
    "写不进去时输入框保持原样（不能被写坏）",
    String(hostileAfter?.dom || "").includes("麻烦确认一下交期"),
    String(hostileAfter?.dom || "").slice(0, 80)
  );

  // 收尾：把 mock 切回普通输入框，别把后面的断言带偏
  await evaluate(
    cdp,
    sessionId,
    `(function(){
       window.__gjMock.strictEditor.disable();
       document.getElementById("gj-compose-panel")?.remove();
       return true;
     })()`
  );

  /* ---------- 扩展重载后：旧页面必须自己说清楚，不能静默停摆 ---------- */

  /*
   * 真实世界里必然会发生的一幕：用户在扩展管理页点了「重新加载」，但 WhatsApp 这个
   * 标签页没刷新 —— 页面里那份脚本从此变成"孤儿"，翻译再也回不来，可页面看上去一切正常
   * （悬浮球还在、消息还在）。旧行为是静默停手，用户只能自己猜；现在必须变成看得见的一句话。
   */
  const staleBefore = await evaluate(cdp, sessionId, `Boolean(document.getElementById("gj-stale-banner"))`);
  const idBefore = await evaluate(cdp, sessionId, "Boolean(window.chrome.runtime.id)");
  await evaluate(cdp, sessionId, `(function(){ try { delete window.chrome.runtime.id; } catch {} return true; })()`);
  await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "rescan" })`);
  await sleep(700);
  const staleProbe = await evaluate(
    cdp,
    sessionId,
    `(function(){
       const el = document.getElementById("gj-stale-banner");
       if (!el) return null;
       const style = getComputedStyle(el);
       const rect = el.getBoundingClientRect();
       return {
         text: el.textContent,
         visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
         box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
         viewport: [innerWidth, innerHeight],
         zIndex: style.zIndex,
         insideViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth
       };
     })()`
  );
  record("截图之前页面上没有这条提示（证明是 id 消失之后才弹的）", staleBefore === false, String(staleBefore));
  record("桩里本来是有扩展 id 的（否则上一条测不出东西）", idBefore === true, String(idBefore));
  record(
    "扩展重载后，页面自己弹出「刷新一下（F5）」的提示（不再静默停摆）",
    // insideViewport 不能少：DOM 里有、但没样式飘到视口外，用户还是什么都看不到。
    Boolean(staleProbe) && /F5/.test(String(staleProbe.text)) && staleProbe.visible === true && staleProbe.insideViewport === true,
    JSON.stringify(staleProbe)
  );
  const staleStats = await evaluate(cdp, sessionId, `window.__gjTest.deliver({ type: "stats" })`);
  record("自检位也报告这一页需要刷新", staleStats?.needsReload === true, JSON.stringify(staleStats)?.slice(0, 200));

  const staleShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUTDIR, `agent-${TAG}-stale.png`), Buffer.from(staleShot.data, "base64"));

  record("零未捕获异常", consoleNoise.filter((line) => line.startsWith("异常")).length === 0, consoleNoise.filter((line) => line.startsWith("异常"))[0] || "");
  record("零 console.error", consoleNoise.filter((line) => line.startsWith("console.error")).length === 0, consoleNoise.filter((line) => line.startsWith("console.error"))[0] || "");
} catch (error) {
  record("自检主流程", false, error instanceof Error ? error.message : String(error));
} finally {
  cleanup();
  printReport();
  const failed = results.filter((item) => !item.pass);
  process.exit(failed.length ? 1 : 0);
}
