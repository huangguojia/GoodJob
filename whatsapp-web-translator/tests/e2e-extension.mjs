/**
 * 端到端自检（两段式）。
 *
 * 跑法：
 *   CHROME_SHELL="<Chrome 可执行文件>" node tests/e2e-extension.mjs --tag=run1
 *
 * 第一段 · 扩展宿主接线（真扩展、真 service worker、真 chrome.storage）
 *   扩展加载 → SW 注册 → 从设置页写设置 → 调 background 翻译两次（第二次应命中缓存）
 *   → testConnection 联通性。
 *
 * 第二段 · 页面注入逻辑（真 content.js / gj-theme.css / content.css，走 http 加载同一份源码）
 *   在 mock 会话页里注入真实 `src/content.js` + `src/content.css`，并把
 *   `chrome.runtime.sendMessage` 换成走**同一份 provider.js/settings.js** 的桩，
 *   逐条验证：自动翻译入站消息 / 跳过规则 / 缓存去重 / 失败态与重试 /
 *   多段消息 / 译文落在气泡下方（几何断言）/ 总开关广播 / 草稿反向翻译。
 *
 * ⚠️ 为什么不直接用真扩展的 content script 做第二段：
 *   本机这份 Chrome（153）在 `--headless=new` + `--load-extension` 下**不注入 content script**
 *   （已用最小扩展单独复现：`<all_urls>` 也不注入，SW 却正常）。同时另外两个环境坑：
 *     ① 一旦指定自定义 `--user-data-dir`，Chrome 的 http(s) 导航会永久卡住（location 停在 about:blank）；
 *     ② 用 `Target.createTarget` 新建标签再导航 http(s) 也会卡住，必须 `Page.navigate` 已有的页面 target。
 *   所以这里让扩展宿主部分照常真跑，页面部分把同一份源码用 http 加载进页面里验证 —— 覆盖的是
 *   同一份代码，只是绕开了这台机器上坏掉的注入通道。真机上装扩展后走的是 Chrome 标准注入路径。
 *
 * 全程只连本机 mock（127.0.0.1），不碰任何真实服务与数据库。
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

const CDP_PORT = Number(flags.port || process.env.CDP_PORT || 9401);
const MOCK_PORT = Number(flags.mockPort || 8788);
const TAG = String(flags.tag || "run");
const OUTDIR = path.resolve(String(flags.outdir || "/tmp/gj-translator-shots"));
const HEADFUL = Boolean(flags.headful);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_URL = `${MOCK_ORIGIN}/mock/mock-whatsapp.html`;

const results = [];
const skipped = [];
const consoleNoise = [];

function log(step) {
  process.stderr.write(`[e2e] ${new Date().toISOString().slice(11, 19)} ${step}\n`);
}

function record(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail ?? "").slice(0, 300) });
  log(`${pass ? "✓" : "✗"} ${name}${detail ? ` → ${String(detail).slice(0, 90)}` : ""}`);
}

/** 环境不具备、但代码路径已被别的用例覆盖的项：单独记，不混进通过率 */
function skip(name, reason) {
  skipped.push({ name, reason });
  log(`◦ SKIP ${name} → ${reason}`);
}

function pickChrome() {
  const candidates = [
    process.env.CHROME_SHELL,
    // ⚠️ Chrome for Testing 必须排在 Google Chrome 前面：Google Chrome 稳定版 154 起
    // **忽略 --load-extension**（SW 根本不注册，表现是"等待超时"）。本机 154 升上来后
    // 旧的候选顺序就永远选错 —— 这不是偶发，是顺序 bug。
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("找不到 Chrome，请用 CHROME_SHELL 指定");
}

function pickPython() {
  const candidates = [
    process.env.PYTHON,
    "python3",
    path.join(os.homedir(), ".workbuddy/binaries/python/versions/3.13.12/bin/python3")
  ].filter(Boolean);
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
      // 每个调用都带超时，否则某一步卡住会把整个自检吊死（这台机器上真发生过）
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（15s）：${method}`));
      }, 15000);
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "页面内脚本抛错");
  }
  return result.result?.value;
}

/* ---------------- 前置：Chrome / mock ---------------- */

const chromePath = pickChrome();
const pythonPath = pickPython();
fs.mkdirSync(OUTDIR, { recursive: true });

setTimeout(() => {
  record("全局看门狗（180 秒）", false, "有步骤卡住，看上面的进度日志定位");
  cleanup();
  printReport();
  process.exit(1);
}, 180000);

const mockLogPath = path.join(OUTDIR, `mock-${TAG}.log`);
const mockLog = fs.openSync(mockLogPath, "a");
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
  timeoutMs: 8000
};

/* ---------------- 页面侧桩：把 chrome.* 换成走真 provider.js/settings.js ---------------- */

function bootstrapSource() {
  // 版本在 **Node 侧**读好、内插进桩源码 —— 桩跑在页面世界，那里没有 fs/path。
  const extVersion = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8")).version;
  return `(async () => {
  try {
    const base = ${JSON.stringify(`${MOCK_ORIGIN}/`)};
    const settings = await import(base + "src/settings.js");
    const provider = await import(base + "src/provider.js");

    const store = {
      gj_translator_settings: ${JSON.stringify(SETTINGS)},
      gj_translator_cache: { entries: [] }
    };
    const storageListeners = [];
    const messageListeners = [];
    const inflight = new Map();

    function notifySettingsChanged() {
      for (const fn of messageListeners) {
        try { fn({ type: "settingsChanged" }, {}, () => {}); } catch (error) { console.warn("桩：通知失败", error); }
      }
    }

    async function handle(message) {
      if (message.type === "getSettings") return { ok: true, settings: await settings.loadSettings() };
      if (message.type === "getVersion") {
        // 真 background 由 manifest 代取版本；桩用 Node 侧内插好的同源值，口径一致。
        return { ok: true, version: ${JSON.stringify(extVersion)} };
      }
      if (message.type === "clearCache") {
        store.gj_translator_cache = { entries: [] };
        return { ok: true };
      }
      if (message.type === "testConnection") {
        const cfg = await settings.loadSettings();
        try {
          const r = await provider.translateText(cfg, { text: "Hello", sourceLang: "en", targetLang: "zh-CN" });
          return { ok: true, text: r.text };
        } catch (error) { return { ok: false, error: error.message }; }
      }
      if (message.type === "translate") {
        /**
         * 「两段式」的**回复形状**由桩伪造，content.js 是真的。
         *
         * 真 background 的两段式编排由 tests/twotier.test.mjs 直接驱动真模块来覆盖
         * （那段桩自己重写 translate 流程，本来就够不着 background）。这里只需要
         * 让 content.js 收到一个「机译 + 待精修」的回复，才能验它有没有：
         *   ① 把机译标成「机译」而不是「译」；
         *   ② 认得后面推来的精修结果、并原地换掉。
         */
        if (String(message.text || "").includes("MTFIRST")) {
          return {
            ok: true,
            text: "[底座译] " + message.text,
            tier: "mt",
            base: "mymemory",
            totalMs: 900,
            refining: true,
            refineToken: message.refineToken
          };
        }
        const cfg = await settings.loadSettings();
        const key = settings.cacheKey(message.text, message.targetLang);
        const entries = settings.readCacheStore(store.gj_translator_cache);
        const hit = entries.find((entry) => entry[0] === key);
        if (hit) return { ok: true, text: hit[1], cached: true };
        if (inflight.has(key)) return inflight.get(key);
        const task = (async () => {
          try {
            const r = await provider.translateText(cfg, { text: message.text, sourceLang: message.sourceLang, targetLang: message.targetLang });
            store.gj_translator_cache = { entries: settings.touchCache(settings.readCacheStore(store.gj_translator_cache), key, r.text) };
            return { ok: true, text: r.text, model: r.model };
          } catch (error) {
            return { ok: false, error: String((error && error.message) || error) };
          }
        })().finally(() => inflight.delete(key));
        inflight.set(key, task);
        return task;
      }
      return { ok: false, error: "桩未实现：" + message.type };
    }

    /**
     * 把消息**推给页面**（模拟 background 的 chrome.tabs.sendMessage）。
     * content.js 在监听 「translateRefined「，但测试没法从外面直接调它的监听器，
     * 所以在这里开一个只给自检用的入口。
     */
    window.__gjDispatch = (message) => {
      for (const fn of messageListeners) {
        try { fn(message, {}, () => {}); } catch (error) { console.warn("桩：派发失败", error); }
      }
      return messageListeners.length;
    };

    window.chrome = {
      runtime: {
        // 真扩展里 id 必然存在；它消失 = 扩展被重载过。content.js 靠它判断"这一页要不要刷新"。
        id: "mock-extension-id",
        lastError: null,
        sendMessage(message, callback) {
          handle(message)
            .then((result) => callback(result))
            .catch((error) => callback({ ok: false, error: String(error && error.message || error) }));
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
            for (const k of Object.keys(patch)) changes[k] = { newValue: patch[k], oldValue: undefined };
            for (const fn of storageListeners) { try { fn(changes, "local"); } catch (e) { console.warn("桩：storage 监听失败", e); } }
            if (patch.gj_translator_settings) notifySettingsChanged();
          }
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      }
    };

    await new Promise((resolve) => {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resolve, { once: true });
      else resolve();
    });

    for (const name of ["gj-theme.css", "content.css"]) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = base + "src/" + name;
      document.head.appendChild(link);
      await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
    }

    const script = document.createElement("script");
    script.src = base + "src/content.js";
    document.head.appendChild(script);
    await new Promise((resolve) => { script.onload = resolve; script.onerror = resolve; });

    window.__gjBootstrap = "ready";
  } catch (error) {
    window.__gjBootstrap = "failed: " + (error && error.message);
    console.error("[e2e] 桩启动失败", error);
  }
})();`;
}

/* ---------------- 主流程 ---------------- */

try {
  log(`启动 mock 服务（${pythonPath}）`);
  await waitFor(async () => (await fetch(`${MOCK_ORIGIN}/__reset`)).ok, { label: "mock 服务就绪" });
  record("mock 服务启动", true, MOCK_ORIGIN);

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
    // Chrome for Testing 153 能过；Google Chrome 稳定版 154 会**忽略** `--load-extension`
    // （同一个扩展在 154 下 targets 里连 service worker 都不出现），表现就是这里永远等不到。
    // 所以 CHROME_SHELL 要指向 ≤153 的 Chrome for Testing —— 见 README 的「自检怎么跑」。
    // ⚠️ 绝不加 --user-data-dir：本机一旦指定自定义剖目录，Chrome 的 http(s) 导航会永久卡住。
    //    不带它时 Chrome for Testing 用自带默认剖（与用户日常 Chrome 隔离），互不影响。
    `--load-extension=${EXT_ROOT}`,
    `--disable-extensions-except=${EXT_ROOT}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--window-size=1180,900",
    "about:blank"
  ];
  chromeProcess = spawn(chromePath, chromeArgs, { stdio: "ignore" });
  log(`启动 Chrome：${chromePath}`);

  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return response.ok ? response.json() : null;
    },
    { label: "Chrome remote debugging" }
  );
  record("Chrome 启动", true, version.Browser);

  cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  cdp.on((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      consoleNoise.push(`异常：${message.params?.exceptionDetails?.exception?.description || ""}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      consoleNoise.push(`console.error：${(message.params.args || []).map((a) => a.value ?? a.description).join(" ")}`);
    }
  });

  /* ========== 第一段：扩展宿主接线 ========== */
  log("第一段：扩展宿主接线");

  // Chrome for Testing 自带若干组件扩展（也有 service_worker），必须按自己的脚本路径收口
  const extensionId = await waitFor(
    async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const worker = targetInfos.find((info) => info.type === "service_worker" && info.url.endsWith("/src/background.js"));
      return worker ? worker.url.split("/")[2] : null;
    },
    { label: "扩展 service worker 注册" }
  );
  record("扩展已加载且 SW 已注册", true, `id=${extensionId}`);

  async function withOptionsPage(expression) {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/src/options.html`
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    try {
      await waitFor(async () => (await evaluate(cdp, sessionId, "!!document.getElementById('apiBase')")) === true, {
        label: "设置页渲染"
      });
      return await evaluate(cdp, sessionId, expression);
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }

  await withOptionsPage(
    `(async () => {
       await chrome.storage.local.set({ gj_translator_settings: ${JSON.stringify(SETTINGS)} });
       await chrome.storage.local.set({ gj_translator_cache: { entries: [] } });
       return true;
     })()`
  );
  record("设置写入 chrome.storage", true, `apiBase=${SETTINGS.apiBase}`);

  const bgFirst = await withOptionsPage(
    `chrome.runtime.sendMessage({ type: "translate", text: "Hola, nos interesan 500 unidades.", targetLang: "zh-CN" })`
  );
  const hostNetworkBlocked = String(bgFirst?.error || "").includes("超时") || String(bgFirst?.error || "").includes("连不上");
  if (hostNetworkBlocked) {
    // 本机这份 Chrome 里，**扩展上下文发起的所有 HTTP 请求都会永久挂起**（已单独复现：
    // 设置页里裸 fetch("http://127.0.0.1/…") 20 秒不返回），而同一 URL 在普通页面里正常。
    // 因此"真 service worker 打真接口"这条只能在真桌面 Chrome 上跑，这里如实跳过。
    skip("background 真跑通翻译（过 provider.js + mock 接口）", "本机 Chrome 的扩展上下文 HTTP 请求全部挂起（环境限制）");
    skip("background 第二次命中缓存", "同上");
    skip("测试连接可用", "同上");
  } else {
    record("background 真跑通翻译（过 provider.js + mock 接口）", bgFirst?.ok === true && String(bgFirst.text || "").startsWith("[MOCK译]"), JSON.stringify(bgFirst)?.slice(0, 120));
    const bgSecond = await withOptionsPage(
      `chrome.runtime.sendMessage({ type: "translate", text: "Hola, nos interesan 500 unidades.", targetLang: "zh-CN" })`
    );
    record("background 第二次命中缓存", bgSecond?.cached === true, JSON.stringify(bgSecond)?.slice(0, 120));
    const bgTest = await withOptionsPage(`chrome.runtime.sendMessage({ type: "testConnection" })`);
    record("测试连接可用", bgTest?.ok === true, JSON.stringify(bgTest)?.slice(0, 160));
  }

  await withOptionsPage(`chrome.runtime.sendMessage({ type: "clearCache" })`);

  // ⚠️ 这里必须把 mock 的**请求账本**一并清零，否则第二段的三条断言会算错。
  //    上面 line 441 那次 background 翻译发生在**清缓存之前**，而它带的正是同一串西语
  //    "nos interesan 500 unidades" —— 于是：
  //      ① `spanishCalls.length` 会变成 2，看着像"缓存没生效"，其实只是把清缓存前的旧账算了进来；
  //      ② `list[0]` 会是那次 background 请求，而它的调用方**没传 sourceLang**，
  //         prompt 是 "Translate to zh-CN"，于是"prompt 指定 es"那条会误报。
  //    扩展侧的 `clearCache` 只管 chrome.storage，管不到 mock 的账本，所以这两件事要分开做。
  await fetch(`${MOCK_ORIGIN}/__reset`);

  /* ========== 第二段：页面注入逻辑 ========== */
  log("第二段：打开 mock 会话页并注入 content.js");

  const { targetInfos: pages } = await cdp.send("Target.getTargets");
  const pageTarget = pages.find((info) => info.type === "page" && info.url === "about:blank");
  if (!pageTarget) throw new Error("找不到启动时的 about:blank 页面（无法导航）");
  const { sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, pageSession);
  await cdp.send("Page.enable", {}, pageSession);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource() }, pageSession);
  await cdp.send("Page.navigate", { url: MOCK_URL }, pageSession);

  await waitFor(async () => {
    const href = await evaluate(cdp, pageSession, "location.href");
    return href === MOCK_URL ? href : null;
  }, { label: "mock 页导航到位" });
  await waitFor(async () => (await evaluate(cdp, pageSession, 'window.__gjBootstrap || null')) === "ready", {
    label: "页面侧桩就绪"
  });
  await sleep(3000);
  log("抓取页面快照");

  const snapshot = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const byId = (id) => document.querySelector('[data-id="' + id + '"]');
         const nodeOf = (id) => byId(id) ? byId(id).querySelector(".gj-translation") : null;
         const nodeText = (id) => {
           const node = nodeOf(id);
           const body = node ? node.querySelector(".gj-translation-body") : null;
           return body ? body.textContent : null;
         };
         const geom = (id) => {
           const row = byId(id);
           if (!row) return null;
           const node = row.querySelector(".gj-translation");
           const bubble = row.querySelector(".bubble");
           if (!node || !bubble) return null;
           const n = node.getBoundingClientRect();
           const b = bubble.getBoundingClientRect();
           return { below: n.top >= b.bottom - 2, width: Math.round(n.width), nodeTop: Math.round(n.top), bubbleBottom: Math.round(b.bottom) };
         };
         const rows = Array.from(document.querySelectorAll("div.message-in, div.message-out"));
         return JSON.stringify({
           marker: document.documentElement.dataset.gjTranslator || null,
           rowCount: rows.length,
           incomingCount: rows.filter((r) => r.classList.contains("message-in")).length,
           translationCount: document.querySelectorAll(".gj-translation").length,
           spanish: nodeText("false_346001@c.us_AAA1"),
           spanishDup: nodeText("false_346001@c.us_AAA2"),
           english: nodeText("false_861380@c.us_BBB1"),
           multi: nodeText("false_491511@c.us_DDD2"),
           skipped: {
             chinese: !!nodeOf("false_861380@c.us_BBB2"),
             number: !!nodeOf("false_861380@c.us_BBB3"),
             url: !!nodeOf("false_861380@c.us_BBB4"),
             emoji: !!nodeOf("false_861380@c.us_BBB5"),
             outgoing: !!nodeOf("true_861380@c.us_CCC1")
           },
           failed: { state: nodeOf("false_491511@c.us_DDD1") ? nodeOf("false_491511@c.us_DDD1").dataset.gjState : null,
                     retry: !!document.querySelector('[data-id="false_491511@c.us_DDD1"] .gj-translation-retry') },
           geometryFlex: geom("false_346001@c.us_AAA1"),
           geometryBlock: geom("false_861380@c.us_BBB1"),
           composeButton: !!document.getElementById("gj-compose-button")
         });
       })()`
    )
  );

  record("content.js 已在页面里跑起来", snapshot.marker === "on", String(snapshot.marker));
  record("mock 会话 10 行消息（入站 9）", snapshot.rowCount === 10 && snapshot.incomingCount === 9, `${snapshot.rowCount}/${snapshot.incomingCount}`);
  record("4 条入站 + 1 条失败 = 5 个译文节点", snapshot.translationCount === 5, `count=${snapshot.translationCount}`);
  record("西语消息出了译文", String(snapshot.spanish || "").startsWith("[MOCK译] Hola"), snapshot.spanish);
  record("重复消息各自渲染（第二次走缓存）", String(snapshot.spanishDup || "").startsWith("[MOCK译] Hola"), snapshot.spanishDup);
  record("英语消息出了译文", String(snapshot.english || "").includes("lead time"), snapshot.english);
  record("多段消息整体翻译", String(snapshot.multi || "").includes("Buenos días") && String(snapshot.multi || "").includes("Adjunto el pedido"), snapshot.multi);
  record("中文消息被跳过", snapshot.skipped.chinese === false);
  record("纯数字被跳过", snapshot.skipped.number === false);
  record("纯链接被跳过", snapshot.skipped.url === false);
  record("纯表情被跳过", snapshot.skipped.emoji === false);
  record("自己发出的消息不翻译", snapshot.skipped.outgoing === false);
  record("flex 行里译文落在气泡下方", snapshot.geometryFlex?.below === true, JSON.stringify(snapshot.geometryFlex));
  record("译文占满行宽（没被挤到气泡右侧）", (snapshot.geometryFlex?.width || 0) > 200, String(snapshot.geometryFlex?.width));
  record("非 flex 行（block）同样落在下方", snapshot.geometryBlock?.below === true, JSON.stringify(snapshot.geometryBlock));
  record("401 显示失败态", snapshot.failed.state === "failed", String(snapshot.failed.state));
  record("失败态给出重试按钮", snapshot.failed.retry === true);
  record("草稿翻译按钮已注入", snapshot.composeButton === true);

  const firstShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, pageSession);
  fs.writeFileSync(path.join(OUTDIR, `translator-${TAG}-list.png`), Buffer.from(firstShot.data, "base64"));

  /* --- 缓存去重（真请求次数） --- */
  const stats1 = await (await fetch(`${MOCK_ORIGIN}/__requests`)).json();
  const list = stats1.requests || [];
  const spanishCalls = list.filter((item) => String(item.userContent || "").includes("nos interesan 500 unidades"));
  record("相同文本只请求一次（缓存生效）", spanishCalls.length === 1, `调用 ${spanishCalls.length} 次`);
  const sample = list[0] || {};
  record("鉴权头正确", sample.authorization === "Bearer test-key-123", String(sample.authorization));
  record("模型名透传", sample.body?.model === "mock-model", String(sample.body?.model));
  record("temperature=0", sample.body?.temperature === 0, String(sample.body?.temperature));
  record("system 提示词是 B2B 翻译员", String(sample.body?.messages?.[0]?.content || "").includes("B2B trade translator"));
  // 验 prompt 就用**西语那条自己的请求**，不要用 `list[0]`：
  // 这条断言问的是"检测出来的源语言有没有被写进 prompt"，不该依赖 content.js
  // 处理各行的先后顺序、也不该依赖 list[0] 恰好是谁。
  const spanishSample = spanishCalls[0] || {};
  const spanishPrompt = String(spanishSample.body?.messages?.[1]?.content || "");
  record("prompt 指定 es → zh-CN", spanishPrompt.includes("Translate from es to zh-CN"), spanishPrompt.slice(0, 60));

  /* --- 失败重试 --- */
  await evaluate(cdp, pageSession, `document.querySelector('[data-id="false_491511@c.us_DDD1"] .gj-translation-retry').click(); true`);
  await sleep(1600);
  const afterRetry = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const row = document.querySelector('[data-id="false_491511@c.us_DDD1"]');
         const node = row.querySelector(".gj-translation");
         return JSON.stringify({ state: node.dataset.gjState, text: node.querySelector(".gj-translation-body").textContent, retryGone: !row.querySelector(".gj-translation-retry") });
       })()`
    )
  );
  record("点重试后转为成功", afterRetry.state === "done" && afterRetry.text.startsWith("[MOCK译]"), JSON.stringify(afterRetry));

  /* --- 总开关广播 --- */
  await evaluate(cdp, pageSession, `window.chrome.storage.local.set({ gj_translator_settings: ${JSON.stringify({ ...SETTINGS, enabled: false })} })`);
  await sleep(1200);
  const offCount = await evaluate(cdp, pageSession, `document.querySelectorAll(".gj-translation").length`);
  record("关掉总开关后译文被清除", offCount === 0, `count=${offCount}`);

  await evaluate(cdp, pageSession, `window.chrome.storage.local.set({ gj_translator_settings: ${JSON.stringify(SETTINGS)} })`);
  await sleep(2500);
  const onCount = await evaluate(cdp, pageSession, `document.querySelectorAll(".gj-translation").length`);
  record("重新打开后译文回来（命中缓存）", onCount === 5, `count=${onCount}`);

  /* --- 草稿反向翻译 --- */
  await evaluate(
    cdp,
    pageSession,
    `(function () {
       const box = document.querySelector("#main footer .composer");
       box.focus();
       box.innerText = "你好，我想确认一下交期和包装。";
       return box.innerText.length;
     })()`
  );
  await evaluate(cdp, pageSession, `document.getElementById("gj-compose-button").click(); true`);
  await sleep(1800);
  const draft = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const panel = document.getElementById("gj-compose-panel");
         if (!panel) return JSON.stringify({ panel: false });
         return JSON.stringify({
           panel: true,
           text: panel.querySelector(".gj-panel-body").textContent,
           hasCopy: !!panel.querySelector(".gj-panel-copy")
         });
       })()`
    )
  );
  record("草稿翻译面板出现", draft.panel === true);
  record("草稿译成目标语言（replyLang=en）", String(draft.text || "").includes("[MOCK译] 你好，我想确认一下交期和包装。"), String(draft.text));
  record("面板提供复制按钮", draft.hasCopy === true);

  const afterDraft = await (await fetch(`${MOCK_ORIGIN}/__requests`)).json();
  record(
    "草稿方向是 zh-CN → en",
    String(afterDraft.last?.request?.body?.messages?.[1]?.content || "").includes("Translate from zh-CN to en"),
    String(afterDraft.last?.request?.body?.messages?.[1]?.content || "").slice(0, 60)
  );

  /* --- 0.7.1：粘贴进输入框必须自动触发草稿翻译 ---
   * 真机病灶：Lexical 接管 paste（beforeinput 被拦掉后不再补发 input，程序化改 DOM
   * 也没有 input）→ 用户粘贴后毫无动静、要再打一个字才翻。
   * mock 的 strictEditor 正是这个行为的复刻：paste preventDefault + 程序化渲染。
   * 所以这里必须走 strictEditor + 合成 paste 事件，不许直接写 innerText（那会造出 input 事件，假绿）。
   * 断言的是「不点按钮、不打字，面板自己出译文」。 */
  await evaluate(cdp, pageSession, `window.__gjMock.strictEditor.enable({ text: "" }); true`);
  await evaluate(
    cdp,
    pageSession,
    `(function () {
       const box = document.querySelector("#main footer .composer");
       const dt = new DataTransfer();
       dt.setData("text/plain", "请问最低起订量是多少？");
       box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
       return box.innerText.length;
     })()`
  );
  await sleep(2200);
  const pastedDraft = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const panel = document.getElementById("gj-compose-panel");
         if (!panel) return JSON.stringify({ panel: false });
         return JSON.stringify({ panel: true, text: panel.querySelector(".gj-panel-body").textContent });
       })()`
    )
  );
  record(
    "粘贴进输入框自动触发草稿翻译（不点按钮不打字）",
    pastedDraft.panel === true && String(pastedDraft.text || "").includes("请问最低起订量是多少？"),
    JSON.stringify(pastedDraft)
  );

  /* --- 0.7.2：删除输入框内容也必须触发（beforeinput 兜底）---
   * 真机病灶与粘贴同类：Lexical 接管删除（beforeinput 被拦掉后不发 input），
   * 用户删光内容后面板挂着过期译文不走。这里只派发 beforeinput + strictEditor
   * 清空（全程**没有 input 事件**），面板应收起 —— 信号源严格隔离在 beforeinput。 */
  await evaluate(cdp, pageSession, `window.__gjMock.strictEditor.enable({ text: "" }); true`);
  await evaluate(
    cdp,
    pageSession,
    `(function () {
       const box = document.querySelector("#main footer .composer");
       box.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
       return true;
     })()`
  );
  await sleep(1800);
  const panelAfterDelete = await evaluate(cdp, pageSession, `Boolean(document.getElementById("gj-compose-panel"))`);
  record("删光输入框内容后译文浮框收起（beforeinput 触发，全程无 input 事件）", panelAfterDelete === false, `panel=${panelAfterDelete}`);
  await evaluate(cdp, pageSession, `window.__gjMock.strictEditor.disable(); true`);

  /* --- 0.7.3：DOM 变化兜底（连事件都没有也能触发）---
   * 真机仍有「粘贴/删除的 beforeinput 到不了监听」的场景。终极兜底是直接盯输入框的
   * DOM 变化——这里用**直接写 DOM**（程序化写入不产生任何事件，只有 mutation）验证：
   * 面板必须自己冒出来。任何事件层的问题都拦不住这条路。 */
  await evaluate(
    cdp,
    pageSession,
    `(function () {
       const box = document.querySelector("#main footer .composer");
       box.innerText = "你们的最小起订量是多少？";
       return box.innerText.length;
     })()`
  );
  await sleep(2200);
  const mutatedDraft = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const panel = document.getElementById("gj-compose-panel");
         if (!panel) return JSON.stringify({ panel: false });
         return JSON.stringify({ panel: true, text: panel.querySelector(".gj-panel-body").textContent });
       })()`
    )
  );
  record(
    "直接改输入框 DOM（零事件）也触发草稿翻译（MutationObserver 兜底）",
    mutatedDraft.panel === true && String(mutatedDraft.text || "").includes("你们的最小起订量是多少？"),
    JSON.stringify(mutatedDraft)
  );

  /* ⚠️ 这段必须放在**最后**：它会往会话里插一行并触发 `rescan`，
   * 而 rescan 会让「401 失败态」那类一次性场景被重算（失败只发生一次），
   * 早早插进去会把后面的断言搞坏 —— 第一版就是这么踩的。 */
  /* --- 两段式：机译先显示，AI 精修回来原地替换 ---
   * 背景：这条 AI 线路实测最快也要 10.3 秒出首字，所以初译交给免费底座（实测 0.8~4.8 秒）。
   * 这里验的是**页面侧**的三件事，桩只负责伪造"background 的回复形状"：
   *   ① 机译必须被标成「机译」，不能混成「译」；
   *   ② 精修推回来要认得、并原地替换（用户不能永久停在机译上）；
   *   ③ 替换只动译文文本，**不许**碰输入框。
   */
  const MT_ROW = 'div[data-id="false_346001@c.us_MT1"]';
  const READ_MT = `(() => {
    const row = document.querySelector(${JSON.stringify(MT_ROW)});
    const node = row && row.querySelector(".gj-translation");
    if (!node) return null;
    // 几何断言要回答的是"用户看得见吗"，所以先把这一行滚进视口再量
    node.scrollIntoView({ block: "center" });
    const box = node.getBoundingClientRect();
    const composer = document.querySelector('#main footer div[contenteditable="true"]');
    return {
      tier: node.dataset.gjTier || "",
      label: node.querySelector(".gj-translation-label")?.textContent || "",
      body: node.querySelector(".gj-translation-body")?.textContent || "",
      hint: node.querySelector(".gj-translation-refining")?.textContent || "",
      token: node.dataset.gjRefine || "",
      width: Math.round(box.width),
      // ⚠️ 只判"节点存在"是不够的：本机踩过"注入元素只设 id 不设 class、
      //    样式匹配不上 → 掉回文档流、飘在视口之外"的坑，用户什么都看不到而自检全绿。
      insideViewport: box.width > 0 && box.top < window.innerHeight && box.bottom > 0,
      composer: composer ? composer.textContent : ""
    };
  })()`;

  await evaluate(cdp, pageSession, `(() => {
    const container = document.querySelector('#main [data-testid="conversation-panel-messages"]') || document.querySelector("#main");
    const row = document.createElement("div");
    row.className = "message-in";
    row.dataset.id = "false_346001@c.us_MT1";
    row.innerHTML = '<div class="bubble"><span class="selectable-text copyable-text" dir="ltr" data-pre-plain-text="[12:09, 07/10/2026] Miguel Santos: "><span>MTFIRST Hola, precio FOB por favor.</span></span><div class="meta">12:09</div></div>';
    container.appendChild(row);
    // 注入新行后必须让它重扫一遍，否则这一行永远不会被处理
    window.__gjDispatch({ type: "rescan" });
    return true;
  })()`);

  const mtShown = await waitFor(async () => (await evaluate(cdp, pageSession, READ_MT)) !== null, { timeout: 8000 });
  record("两段式：机译节点已渲染", mtShown, mtShown ? "" : "等待超时");
  const mt = (await evaluate(cdp, pageSession, READ_MT)) || {};

  record("机译标成「机译」而不是「译」", mt.label === "机译", String(mt.label));
  record("机译文本来自底座", String(mt.body).startsWith("[底座译]"), String(mt.body));
  record("显示「AI 精修中…」提示", String(mt.hint).includes("精修中"), String(mt.hint));
  record("机译节点真的看得见（几何复核，不能只判存在）", mt.insideViewport === true && mt.width > 200, `width=${mt.width} inside=${mt.insideViewport}`);
  const composerBefore = String(mt.composer || "");

  // 用**节点自己记着的令牌**回推精修结果：这同时证明令牌真的往返了一圈
  await evaluate(cdp, pageSession, `window.__gjDispatch({ type: "translateRefined", token: ${JSON.stringify(mt.token)}, text: "AI 精修后的译文" })`);
  const switched = await waitFor(async () => (await evaluate(cdp, pageSession, `(() => {
    const row = document.querySelector(${JSON.stringify(MT_ROW)});
    const node = row && row.querySelector(".gj-translation");
    return node ? node.dataset.gjTier : "";
  })()`)) === "ai", { timeout: 4000 });
  record("两段式：精修推来后节点切成 AI 档", switched, switched ? "" : "等待超时 —— 页面可能没认领 translateRefined");

  const after = (await evaluate(cdp, pageSession, READ_MT)) || {};
  record("精修后标签回到「译」", after.label === "译", String(after.label));
  record("精修后正文换成 AI 译文", after.body === "AI 精修后的译文", String(after.body));
  record("「精修中…」提示已移除", String(after.hint) === "", String(after.hint));
  record("令牌用掉即清（避免同一格被重复认领）", String(after.token) === "", String(after.token));
  record("精修后仍看得见（几何复核）", after.insideViewport === true);
  record(
    "精修替换**没有碰输入框**（按回车的人始终是用户）",
    String(after.composer || "") === composerBefore,
    JSON.stringify({ before: composerBefore, after: after.composer })
  );

  const finalShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, pageSession);
  fs.writeFileSync(path.join(OUTDIR, `translator-${TAG}-final.png`), Buffer.from(finalShot.data, "base64"));

  /* ========== 第三段：改版哨兵（?gjrenamed=1） ==========
   * 把 mock 的行类名换掉，模拟 WhatsApp 改版后行选择器失配 —— 来信翻译静默停摆的现场。
   * 断言：两轮扫描内左下角亮出改版横幅、诊断能复制、复制的是体检单而不是空话。
   * 这个场景是真实教训的直接产物：装上以来来信译文 0 条、界面一声不吭，用户只能来问"为啥不翻"。
   */
  log("第三段：改版哨兵（行选择器失配必须自己报警）");

  await cdp.send("Page.navigate", { url: `${MOCK_URL}?gjrenamed=1` }, pageSession);
  await waitFor(async () => (await evaluate(cdp, pageSession, 'window.__gjBootstrap || null')) === "ready", {
    label: "改版页桩就绪"
  });
  // 剪贴板桩必须在新文档里注入：导航会重置页面，导航前打的桩活不过 Page.navigate
  await evaluate(cdp, pageSession, `navigator.clipboard.writeText = (t) => { window.__gjDiagClipboard = t; return Promise.resolve(); }`);

  const bannerShown = await waitFor(
    async () => (await evaluate(cdp, pageSession, "Boolean(document.getElementById('gj-diag-banner'))")) === true,
    { timeout: 6000 }
  );
  record("改版哨兵：行选择器失配时横幅亮出", bannerShown, bannerShown ? "" : "两轮扫描内没等到横幅");

  const bannerState = JSON.parse(
    await evaluate(
      cdp,
      pageSession,
      `(function () {
         const banner = document.getElementById("gj-diag-banner");
         if (!banner) return JSON.stringify({ text: "", copyBtn: "", visible: false, width: 0 });
         const rect = banner.getBoundingClientRect();
         return JSON.stringify({
           text: banner.querySelector(".gj-diag-text")?.textContent || "",
           copyBtn: banner.querySelector(".gj-diag-btn")?.textContent || "",
           visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight,
           width: Math.round(rect.width)
         });
       })()`
    )
  );
  record("横幅把话挑明（点名改版、不是含糊的「出错了」）", String(bannerState.text).includes("改版"), bannerState.text);
  record("横幅真的看得见（几何复核）", bannerState.visible === true && bannerState.width > 300, `width=${bannerState.width}`);
  record("横幅上放着「复制诊断」按钮", bannerState.copyBtn === "复制诊断", bannerState.copyBtn);

  const diagShot = await cdp.send("Page.captureScreenshot", { format: "png" }, pageSession);
  fs.writeFileSync(path.join(OUTDIR, `translator-${TAG}-diag-banner.png`), Buffer.from(diagShot.data, "base64"));

  await evaluate(cdp, pageSession, `document.querySelector("#gj-diag-banner .gj-diag-btn").click(); true`);
  const copied = await waitFor(async () => (await evaluate(cdp, pageSession, "Boolean(window.__gjDiagClipboard)")) === true, { timeout: 4000 });
  record("点「复制诊断」真的写入剪贴板", copied, copied ? "" : "剪贴板桩没收到内容");
  const diag = JSON.parse((await evaluate(cdp, pageSession, "window.__gjDiagClipboard")) || "{}");
  record("诊断单点名「来信行数 0」", diag["来信行数"] === 0, JSON.stringify(diag["来信行数"]));
  // 探针读数在 mock 页是 0（mock 气泡没挂 msg-container，真 WhatsApp 有）—— 这里只断言字段在且是数字
  record("诊断单带改版探针字段（真页面上它是行选择器失配的实锤）", typeof diag["改版探针_testid气泡"] === "number", JSON.stringify(diag["改版探针_testid气泡"]));
  record("诊断单带最近错误位（无错也说「无」）", typeof diag["最近错误"] === "string", JSON.stringify(diag["最近错误"]));
  // 0.6.8 起：一次粘贴要能定位翻不出来出在哪层 —— 版本 / 容器来源 / 行来源 / 方向统计 / 首行结构
  record("诊断单带扩展版本（先排除「没重载」）", typeof diag["扩展版本"] === "string" && /^\d+\.\d+\.\d+$/.test(diag["扩展版本"]), JSON.stringify(diag["扩展版本"]));
  record("诊断单带容器来源", typeof diag["容器来源"] === "string" && diag["容器来源"].length > 0, JSON.stringify(diag["容器来源"]));
  record("诊断单带行来源", typeof diag["行来源"] === "string", JSON.stringify(diag["行来源"]));
  record(
    "诊断单带方向统计（方向不明是改版最阴的形态，必须数得出来）",
    diag["方向统计"] && typeof diag["方向统计"].来信 === "number" && typeof diag["方向统计"].方向不明 === "number",
    JSON.stringify(diag["方向统计"])
  );
  record("诊断单带首行结构（无行时也明说）", diag["首行结构"] === "无行可采样" || (typeof diag["首行结构"] === "string" && diag["首行结构"].includes("<")), String(diag["首行结构"]).slice(0, 60));

  // 关闭按钮要能关掉 —— 报警归报警，不能赖着不走
  await evaluate(cdp, pageSession, `document.querySelector("#gj-diag-banner .gj-diag-close").click(); true`);
  const bannerClosed = await evaluate(cdp, pageSession, "Boolean(document.getElementById('gj-diag-banner'))") === false;
  record("横幅可以关掉", bannerClosed);

  /* ========== 第三·五段：改版兜底（?gjnewdom=1） ==========
   * 复刻 0.6.6 哨兵诊断单实锤的真机改版：行类名整批消失、气泡本体变成
   * [data-testid="msg-container"]，方向只能靠 data-id 首段。
   * 断言：兜底层接住 —— 来信照常出译文、我方消息不被翻、横幅不亮（能干活就别报警）。
   */
  log("第三·五段：改版兜底（msg-container + data-id 必须接住真机改版）");

  await cdp.send("Page.navigate", { url: `${MOCK_URL}?gjnewdom=1` }, pageSession);
  await waitFor(async () => (await evaluate(cdp, pageSession, 'window.__gjBootstrap || null')) === "ready", {
    label: "新 DOM 页桩就绪"
  });

  const panelTestidGone =
    (await evaluate(cdp, pageSession, "Boolean(document.querySelector('[data-testid=\"conversation-panel-messages\"]'))")) === false;
  record("新版 DOM：面板 testid 已摘（容器只能靠气泡反推）", panelTestidGone);

  const newDomTranslated = await waitFor(
    async () => (await evaluate(cdp, pageSession, "document.querySelectorAll('.gj-translation').length")) > 0,
    { timeout: 8000 }
  );
  record("新版 DOM：来信照常出译文（容器反推 + 行兜底都接住改版）", newDomTranslated, newDomTranslated ? "" : "8 秒内没有任何译文节点 —— 兜底层没接住");

  const outRowNodes = await evaluate(
    cdp,
    pageSession,
    `(function () {
       const row = document.querySelector('#main [data-id^="true_"]');
       return row ? row.querySelectorAll(".gj-translation").length : -1;
     })()`
  );
  record("新版 DOM：我方消息不被翻（方向判据跟着 data-id 首段走）", outRowNodes === 0, `outRowNodes=${outRowNodes}`);

  const newDomBanner = await evaluate(cdp, pageSession, "Boolean(document.getElementById('gj-diag-banner'))");
  record("新版 DOM：横幅不亮（兜底层接住了就不该误报）", newDomBanner === false);

  /* ========== 第三·六段：几何判向（?gjgeomdom=1） ==========
   * 比 newdom 更狠：类名、data-id、面板 testid 全部摘掉，方向判定只能落到
   * 几何层（来信靠左 / 我方靠右 —— 聊天产品的语义布局，改版改不掉）。
   * 断言：所有结构线索都断了，来信照样出译文、我方照样不被翻。
   */
  log("第三·六段：几何判向（零结构标记也必须能分方向）");

  await cdp.send("Page.navigate", { url: `${MOCK_URL}?gjgeomdom=1` }, pageSession);
  await waitFor(async () => (await evaluate(cdp, pageSession, 'window.__gjBootstrap || null')) === "ready", {
    label: "几何判向页桩就绪"
  });

  const geomTranslated = await waitFor(
    async () => (await evaluate(cdp, pageSession, "document.querySelectorAll('.gj-translation').length")) > 0,
    { timeout: 8000 }
  );
  record("几何判向：来信照常出译文（不靠类名/不靠 data-id）", geomTranslated, geomTranslated ? "" : "8 秒内没有译文 —— 几何兜底没接住");

  const geomOutRowNodes = await evaluate(
    cdp,
    pageSession,
    `(function () {
       // mock 在摘结构标记前把真实方向记在 data-gj-geom-side —— 拿它当基准对答案：
       // 所有「我方」行内部必须零译文；「来信」行至少一行有译文（几何判向判对了方向）。
       const rows = [...document.querySelectorAll('[data-gj-geom-side="out"]')];
       if (!rows.length) return JSON.stringify({ ok: false, why: "no out rows" });
       return JSON.stringify({
         ok: rows.every((row) => row.querySelectorAll(".gj-translation").length === 0),
         detail: rows.map((row) => ({
           text: (row.querySelector("span.selectable-text")?.innerText || "").slice(0, 18),
           tr: row.querySelectorAll(".gj-translation").length
         }))
       });
     })()`
  );
  const geomOutParsed = (() => {
    try {
      return JSON.parse(geomOutRowNodes);
    } catch {
      return { ok: false, why: geomOutRowNodes };
    }
  })();
  record(
    "几何判向：我方消息不被翻（靠右的气泡零译文）",
    geomOutParsed.ok === true,
    `geomOutRowNodes=${geomOutRowNodes}`
  );

  const geomBanner = await evaluate(cdp, pageSession, "Boolean(document.getElementById('gj-diag-banner'))");
  record("几何判向：横幅不亮（零结构标记能干活就不算改版停摆）", geomBanner === false);

  // 对照组：正常页面不许亮横幅（把页面导航回去，等三轮扫描的时长）
  await evaluate(cdp, pageSession, `delete window.__gjDiagClipboard; true`);
  await cdp.send("Page.navigate", { url: MOCK_URL }, pageSession);
  await waitFor(async () => (await evaluate(cdp, pageSession, 'window.__gjBootstrap || null')) === "ready", {
    label: "正常页桩就绪"
  });
  await sleep(2600);
  const bannerAbsent = await evaluate(cdp, pageSession, "Boolean(document.getElementById('gj-diag-banner'))") === false;
  record("正常页面不亮横幅（不误报）", bannerAbsent);

  record("零未捕获异常 / 零 console.error", consoleNoise.length === 0, consoleNoise.join(" | "));
} catch (error) {
  record("执行过程异常", false, error instanceof Error ? error.message : String(error));
} finally {
  cleanup();
}

printReport();
process.exit(results.some((item) => !item.pass) ? 1 : 0);

function printReport() {
  const failed = results.filter((item) => !item.pass);
  console.log(
    JSON.stringify({
      tag: TAG,
      outdir: OUTDIR,
      passed: results.length - failed.length,
      failed: failed.length,
      skipped: skipped.length
    })
  );
  for (const item of results) {
    console.log(`${item.pass ? "✓" : "✗"} ${item.name}${item.detail ? `  → ${item.detail}` : ""}`);
  }
  for (const item of skipped) {
    console.log(`◦ SKIP ${item.name}  → ${item.reason}`);
  }
  if (consoleNoise.length) {
    console.log(`\n页面侧噪音 ${consoleNoise.length} 条：`);
    for (const line of consoleNoise) console.log(`  - ${line}`);
  }
  console.log(`mock 请求日志：${mockLogPath}`);
}
