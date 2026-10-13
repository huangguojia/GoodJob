/**
 * 设置页端到端自查：真打开 src/options.html，确认**页面能用**（不白屏、控件齐全、
 * 「对比测速」真的会去逐个测模型）。
 *
 * 为什么单独一份：`parity.test.mjs` 只能静态校验「el("x") 引的 id 在 html 里存在」，
 * 挡不住「render() 里读了个不存在的字段 → 整页白屏」这类错误。而设置页是用户唯一能改
 * 模型 / 填 Key / 测速的地方，白屏等于功能全废。
 *
 * 手法：仓库根起一个 http.server，headless Chrome 打开 page，用
 * `Page.addScriptToEvaluateOnNewDocument` **在页面脚本执行之前**把 `chrome.*` 换成薄桩，
 * 这样 options.js 自带的加载路径就能真跑一遍（不需要事后重新 import）。
 *
 * ⚠️ **不给 Chrome 加 `--user-data-dir`**（与 `e2e-agent` / `e2e-extension` 同一条戒律）：
 *   那两份脚本都写着「指定自定义档目录 → http(s) 导航永久卡住」。2026-10-12 这份脚本
 *   也撞到过一次同款死法：`Page.frameStartedLoading` 之后什么都不再发生 ——
 *   请求发出去了、http server 一次都没收到、CSS/JS 一个都不请求，
 *   `Page.navigate` 与 `Runtime.evaluate` 双双 20 秒超时，退出码 1。
 *   ⚠️ **但别把这句读成"已定位到 flag"**：事后我把 `--user-data-dir` 加回去连跑 4 次全绿
 *   （`/tmp` 与 `~/Library` 两种档目录各试过），说明那次卡死是**偶发**的，
 *   这个 flag 只是"有嫌疑"，不足以单独致病。我也不确定真凶是什么
 *   （当时试过 `--no-proxy-server`、换档目录位置，都没救回来；磁盘、进程数都正常）。
 *   所以这里的处理是**防御性**的：照抄另两份脚本的既定戒律，而且本页实测不依赖档目录
 *   （不读 localStorage/sessionStorage，设置全部来自 CDP 注入的 `chrome.storage` 桩）——
 *   去掉它几乎没有代价。真凶没找到这件事本身，就是下面 `stage` + 看门狗存在的理由。
 *   → 代价：与另两份 e2e **共用 Chrome for Testing 的默认档**，所以三份 e2e **不要并发跑**
 *     （同一档目录只允许一个实例，第二个会转发给第一个然后自己退出，调试端口根本不会打开）。
 *
 * 跑法：
 *   CHROME_SHELL="<Chrome 可执行文件>" node tests/e2e-options.mjs --tag=run1
 *
 * 全程只连本机 http server，不碰真实 WhatsApp、不碰 CRM、不发任何真实请求。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const flags = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/u, "").split("=");
    return [key, value === undefined ? true : value];
  })
);

const CDP_PORT = Number(flags.cdpPort || 9533);
const HTTP_PORT = Number(flags.httpPort || 8793);
const TAG = String(flags.tag || "run");
const OUTDIR = path.resolve(String(flags.outdir || "/tmp/gj-options-shots"));

const results = [];
const log = (step) => process.stderr.write(`[options-e2e] ${new Date().toISOString().slice(11, 19)} ${step}\n`);

function record(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail ?? "").slice(0, 300) });
  log(`${pass ? "✓" : "✗"} ${name}${detail ? ` → ${String(detail).slice(0, 120)}` : ""}`);
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

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
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
    }
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
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
}

/**
 * 页面加载**之前**注入的桩。
 *
 * 走 `addScriptToEvaluateOnNewDocument` 而不是「加载完再补一个 chrome 对象」：
 * 后者第一次渲染必然按真实情况崩一遍（`chrome is not defined`），自检里就永远
 * 混着一条看不出真假的错误。
 */
function bootstrapSource() {
  const settings = {
    enabled: true,
    targetLang: "zh-CN",
    replyLang: "en",
    apiBase: "https://api.example.com/v1",
    apiKey: "sk-demo-not-a-real-key",
    model: "fast-model",
    composeTranslate: true,
    composeAuto: true,
    timeoutMs: 30000,
    firstTokenMs: 20000,
    stream: true,
    reasoningEffort: "minimal",
    maxTokens: 0,
    // 底座。显式写上（而不是靠 mergeSettings 补默认）—— 断言里要证明的是
    // 「下拉是从设置回填的」：`off` 是第一个选项，select 不动它就会停在 `off`，
    // 所以 "值是 mymemory" 这件事本身就是回填的证据。
    fastBase: "mymemory",
    fastBaseEmail: "",
    autoReply: {
      enabled: false,
      mode: "draft",
      language: "auto",
      dailyLimit: 20,
      minIntervalMinutes: 3,
      activeHoursStart: 0,
      activeHoursEnd: 0,
      confidenceThreshold: 0.5,
      guardrails: [],
      escalateKeywords: []
    },
    crm: { crmBaseUrl: "http://127.0.0.1:4188", pluginBaseUrl: "http://127.0.0.1:3100", email: "" }
  };

  return `(() => {
    const settings = ${JSON.stringify(settings)};
    window.__gjProbe = { benchCalls: 0, testedModels: [], listModelCalls: 0, probeBaseCalls: 0, probedDraft: null };

    window.chrome = {
      storage: {
        local: {
          get: async () => ({ gj_translator_settings: settings, gj_crm_session: null }),
          set: async (patch) => {
            window.__gjProbe.setWrites = (window.__gjProbe.setWrites || 0) + 1;
            window.__gjProbe.lastWrite = patch;
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        id: "mock-extension-id",
        lastError: null,
        sendMessage(message, callback) {
          const type = message && message.type;
          let reply = { ok: true };
          if (type === "crmStatus") {
            reply = {
              ok: true,
              session: { loggedIn: false, email: "", expired: true },
              engine: {
                ok: true,
                engine: {
                  available: false,
                  binary: "",
                  version: "",
                  reason: "设置页自检未接引擎",
                  models: [],
                  efforts: [],
                  skillsDirs: "",
                  skills: [],
                  autoReplySkill: "goodjob-auto-reply",
                  resourceScoutSkill: "goodjob-resource-scout"
                }
              }
            };
          }
          if (type === "listModels") {
            // 「拉取清单」走它。名字刻意用中性词 —— 桩里写真实模型名会让人
            // 以为"扩展认识某个具体模型"，而它其实只认接口返回的那份清单。
            window.__gjProbe.listModelCalls += 1;
            reply = {
              ok: true,
              models: ["fast-model", "slow-model", "tiny-model"],
              endpoint: "https://api.example.com/v1/models",
              totalMs: 120
            };
          }
          if (type === "testConnection") {
            const model = (message.draft && message.draft.model) || "unknown";
            window.__gjProbe.benchCalls += 1;
            window.__gjProbe.testedModels.push(model);
            // 故意让两个模型耗时不同，好证明「对比测速」报的是各自真实的数
            reply = {
              ok: true,
              totalMs: model.includes("fast") ? 1300 : 2200,
              text: "可以确认定制包装的交货周期吗？",
              model,
              streamed: true
            };
          }
          if (type === "probeFastBase") {
            // 「测一次底座」走它。给一个**能判分的秒数**（1.2 秒），好证明设置页报的是
            // 实测秒数、并会据此下结论（底座 ≤3 秒才算「够快」，与 AI 那套分档不同）。
            window.__gjProbe.probeBaseCalls += 1;
            window.__gjProbe.probedDraft = message.draft || null;
            reply = {
              ok: true,
              totalMs: 1200,
              text: "¿Puede confirmar el plazo de entrega?",
              base: "mymemory"
            };
          }
          if (typeof callback === "function") {
            callback(reply);
            return;
          }
          return Promise.resolve(reply);
        },
        getURL(p) { return p; },
        onMessage: { addListener() {} }
      },
      permissions: { contains: async () => true, request: async () => true },
      tabs: {
        // 两种形式都要支持：只给回调时，\`const [tab] = await query()\` 会炸，渲染停半路
        query(query, callback) {
          const tabs = [{ id: 1, url: "https://web.whatsapp.com/" }];
          if (typeof callback === "function") { callback(tabs); return; }
          return Promise.resolve(tabs);
        },
        create() {},
        sendMessage() {}
      }
    };
  })();`;
}

/* ---------------- 起环境 ---------------- */

fs.mkdirSync(OUTDIR, { recursive: true });
const chromePath = pickChrome();
const pythonPath = pickPython();

// 卡在哪一阶段要说得出来 —— 之前只有一个大 try/catch，超时后只报「通过 0 / 1」，
// 完全看不出是 Chrome 没起来、导航卡住、还是页面渲染挂了。
let stage = "起静态服务";
let finished = false;

const server = spawn(pythonPath, ["-m", "http.server", String(HTTP_PORT), "--bind", "127.0.0.1"], {
  cwd: REPO_ROOT,
  stdio: "ignore"
});
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--in-process-gpu",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    // ⚠️ 这里**不许**出现 --user-data-dir（见文件头：加了 http 导航永久卡住）。
    // 共用 Chrome for Testing 默认档 → 与另两份 e2e 别并发跑。
    `--remote-debugging-port=${CDP_PORT}`,
    "--window-size=1280,900",
    "about:blank"
  ],
  { stdio: "ignore" }
);

const cleanup = () => {
  if (finished) return;
  finished = true;
  try { chrome.kill("SIGKILL"); } catch {}
  try { server.kill("SIGKILL"); } catch {}
};
process.on("exit", cleanup);

// 看门狗：正常全程 5 秒内跑完。卡住时宁可报出来，也别让调用方挂死在那儿。
setTimeout(() => {
  record("看门狗（90 秒）", false, `卡在「${stage}」阶段`);
  cleanup();
  printReport();
  process.exit(1);
}, 90000);

let cdp = null;
try {
  stage = "起 Chrome 并连上 CDP";
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(300);
  }
  if (!up) throw new Error("Chrome CDP 没起来");

  let target = null;
  try {
    target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  } catch {}
  if (!target?.webSocketDebuggerUrl) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((item) => item.type === "page");
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("拿不到页面 target");

  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const consoleErrors = [];
  const exceptions = [];
  cdp.socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        consoleErrors.push((message.params.args || []).map((a) => a.value || a.description || "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params?.exceptionDetails?.exception?.description || "页面异常");
      }
    } catch {}
  });

  // 关键：桩必须在页面脚本之前就位
  stage = "注入 chrome 桩并导航到设置页";
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource() });
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${HTTP_PORT}/whatsapp-web-translator/src/options.html`
  });

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "页面内脚本抛错");
    return result.result?.value;
  };

  // 等 options.js 真跑完一轮 render
  stage = "等 options.js 跑完 render";
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    ready = await evaluate(`document.getElementById("model")?.value === "fast-model"`);
    if (ready) break;
    await sleep(250);
  }
  record("options.js 跑完 render（模型值从设置回填成功）", ready === true, String(ready));

  stage = "校验控件与文案";
  const state = await evaluate(`(() => {
    const reasoning = document.getElementById("reasoningEffort");
    return {
      bodyLength: document.body.innerHTML.length,
      title: document.title,
      reasoningOptions: reasoning ? [...reasoning.options].map((o) => o.value) : null,
      reasoningValue: reasoning ? reasoning.value : null,
      modelValue: document.getElementById("model")?.value ?? null,
      apiBaseValue: document.getElementById("apiBase")?.value ?? null,
      benchButton: Boolean(document.getElementById("bench")),
      benchOut: Boolean(document.getElementById("benchOut")),
      hintMentionsReasoning: document.body.textContent.includes("推理型模型"),
      hintMentionsBench: document.body.textContent.includes("对比测速"),
      // 提速说明必须**承认调参有天花板**，并把用户推向底座那张卡 ——
      // 以前这里写的是「超过 5 秒就很差」，而这条线路实测最快也要 10.3 秒，等于在误导。
      hintMentionsSpeed: document.body.textContent.includes("别指望靠调参"),
      hintMentionsListModels: document.body.textContent.includes("拉取清单"),
      listButton: Boolean(document.getElementById("listModels")),
      listBox: Boolean(document.getElementById("modelList"))
    };
  })()`);

  record("整页渲染出来了（不是白屏）", state.bodyLength > 3000, `bodyLength=${state.bodyLength}`);
  record(
    "推理强度下拉有完整的五档，且从设置回填",
    JSON.stringify(state.reasoningOptions) === JSON.stringify(["", "minimal", "low", "medium", "high"]) &&
      state.reasoningValue === "minimal",
    JSON.stringify(state.reasoningOptions) + " / " + state.reasoningValue
  );
  record("API 地址与模型都从设置回填", state.apiBaseValue === "https://api.example.com/v1" && state.modelValue === "fast-model", `${state.apiBaseValue} / ${state.modelValue}`);
  record("有「对比测速」按钮与输出位", state.benchButton === true && state.benchOut === true, "");
  record(
    "有「拉取清单」按钮与清单容器（模型名不该只能手输）",
    state.listButton === true && state.listBox === true,
    `button=${state.listButton} box=${state.listBox}`
  );
  record(
    "说明文字直接点名「模型选错」这一主因，承认调参有天花板，并把人推向快速底座",
    state.hintMentionsReasoning && state.hintMentionsBench && state.hintMentionsSpeed,
    ""
  );
  record(
    "说明文字劝导「先拉清单别手输」（这次事故的正解就写在这儿）",
    state.hintMentionsListModels,
    ""
  );

  // 真点一次「拉取清单」：应该把清单渲染成一排可点标签，点一下就填进模型框
  stage = "点「拉取清单」并点选一个模型";
  const listFlow = await evaluate(`(async () => {
    const input = document.getElementById("model");
    input.value = "";
    document.getElementById("listModels").click();
    await new Promise((r) => setTimeout(r, 500));
    const box = document.getElementById("modelList");
    const buttons = [...box.querySelectorAll("button")];
    const snapshot = {
      hidden: box.hidden,
      labels: buttons.map((b) => b.textContent),
      note: box.textContent,
      listCalls: window.__gjProbe.listModelCalls
    };
    if (buttons[1]) buttons[1].click();
    await new Promise((r) => setTimeout(r, 100));
    return { ...snapshot, inputValue: input.value };
  })()`);

  record(
    "点「拉取清单」真的去拉了，并把清单渲染成可点标签",
    listFlow.listCalls === 1 &&
      listFlow.hidden === false &&
      listFlow.labels.length === 3 &&
      listFlow.labels.includes("fast-model") &&
      listFlow.note.includes("共 3 个"),
    JSON.stringify({ calls: listFlow.listCalls, hidden: listFlow.hidden, labels: listFlow.labels })
  );
  record(
    "点一个标签就把模型名填进「模型」框（用户不必再手输）",
    listFlow.inputValue === "slow-model",
    listFlow.inputValue
  );

  // 真点一次：模型框里放两个，看它是不是逐个测并各自报秒数
  stage = "点「对比测速」";
  const bench = await evaluate(`(async () => {
    const input = document.getElementById("model");
    input.value = "fast-model, slow-model";
    document.getElementById("bench").click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      benchOut: document.getElementById("benchOut").textContent,
      calls: window.__gjProbe.benchCalls,
      tested: window.__gjProbe.testedModels
    };
  })()`);

  record(
    "点「对比测速」真的逐个去测了（不是只测第一个）",
    bench.calls === 2 && bench.tested.includes("fast-model") && bench.tested.includes("slow-model"),
    JSON.stringify(bench.tested)
  );
  record(
    "测速结果按模型分别报出秒数",
    /fast-model：1\.3 秒/u.test(bench.benchOut) && /slow-model：2\.2 秒/u.test(bench.benchOut),
    bench.benchOut
  );

  // ---- 「测试连接」绝不能把一串模型名当一个 model 发出去 ----
  // 真实踩过的坑：模型框里逗号连着的多个名字被整个塞进请求的 model 字段发给上游。
  // 正确行为 = 检测到多个名字就转给「对比测速」逐个发，每次只带一个。
  stage = "多模型时点「测试连接」";
  const singleTest = await evaluate(`(async () => {
    const probe = window.__gjProbe;
    const before = probe.benchCalls;
    const testedBefore = probe.testedModels.length;
    document.getElementById("model").value = "fast-model, slow-model";
    document.getElementById("test").click();
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = probe.testedModels.slice(testedBefore);
    return {
      callsAdded: probe.benchCalls - before,
      fresh,
      joinedLeaked: fresh.some((m) => /[，,]/u.test(m)),
      status: document.getElementById("status").textContent
    };
  })()`);

  record(
    "「测试连接」在多模型时转成逐个测（不是把整串塞进一个请求）",
    singleTest.callsAdded === 2 && !singleTest.joinedLeaked,
    `新增 ${singleTest.callsAdded} 次、发送过的 model=${JSON.stringify(singleTest.fresh)}`
  );

  // ---- 「保存」绝不能把一串模型名存进设置 ----
  // 存进去的后果：之后每一次真翻译都带着 "a,b,c" 去打上游 —— 秒 404 且用户看不出原因。
  stage = "多模型时点「保存」";
  const saveMulti = await evaluate(`(async () => {
    const probe = window.__gjProbe;
    const writesBefore = probe.setWrites || 0;
    document.getElementById("model").value = "fast-model, slow-model";
    document.getElementById("save").click();
    await new Promise((r) => setTimeout(r, 800));
    return {
      writesAdded: (probe.setWrites || 0) - writesBefore,
      // 真正要盯的不变量：落进 storage 的 model 永远不是逗号连着的一串
      //（写入可能是 loadSettings 的 schema 迁移干的，所以数次数没用，要看内容）
      storedModel: probe.lastWrite && probe.lastWrite.gj_translator_settings
        ? probe.lastWrite.gj_translator_settings.model
        : null,
      status: document.getElementById("status").textContent
    };
  })()`);

  record(
    "「保存」在多模型时拒绝落盘（提示挑定一个，而不是把整串存进去）",
    saveMulti.status.includes("挑定一个") && !/[，,]/u.test(String(saveMulti.storedModel || ",")),
    `落盘的 model=${JSON.stringify(saveMulti.storedModel)} / 状态：「${saveMulti.status}」`
  );

  // ---- 快速底座卡片 ----
  // 为什么要量 getBoundingClientRect：项目里有一条被真实踩过的教训 ——
  // **「DOM 存在」不等于「看得见」**。元素可以存在、`getElementById` 拿得到，
  // 却因为（注入的元素没挂上类名 → 样式表匹配不上）掉回文档流，变成一条飘在视口外的白条。
  // 只看 `Boolean(el("fastBase"))` 这种断言全绿，而用户什么都看不见。
  stage = "校验「快速底座」卡片可见且可用";
  const cardState = await evaluate(`(() => {
    const select = document.getElementById("fastBase");
    const card = select && select.closest("section.card");
    if (!card) return { found: false };
    const box = card.getBoundingClientRect();
    const probe = document.getElementById("probeFastBase");
    return {
      found: true,
      title: (card.querySelector("h2")?.textContent || "").trim(),
      width: Math.round(box.width),
      height: Math.round(box.height),
      options: select ? [...select.options].map((o) => o.value) : null,
      value: select ? select.value : null,
      note: document.getElementById("fastBaseNote")?.textContent || "",
      probeDisabled: probe ? probe.disabled : null,
      mentionsThirdParty: card.textContent.includes("第三方机器翻译服务"),
      mentionsCeiling: card.textContent.includes("10.3 秒") && card.textContent.includes("66.4 秒"),
      mentionsDraftOnly: card.textContent.includes("机译只当初稿")
    };
  })()`);

  record(
    "「快速底座」卡片真的在（不是白屏里少了一块）",
    cardState.found === true && cardState.title.includes("快速底座"),
    cardState.title
  );
  record(
    "底座卡片渲染后**真的有尺寸**（宽 >300、高 >100；宽度为 0 = 被样式表打回文档流的空块）",
    cardState.found === true && cardState.width > 300 && cardState.height > 100,
    `宽=${cardState.width} 高=${cardState.height}`
  );
  record(
    "底座下拉 = [off, mymemory]，且值从设置回填（不动它只会停在第一项 off）",
    JSON.stringify(cardState.options) === JSON.stringify(["off", "mymemory"]) && cardState.value === "mymemory",
    JSON.stringify(cardState.options) + " / " + cardState.value
  );
  record(
    "选中项有对应的人话说明（选项名本身说不清取舍：快 vs 隐私）",
    cardState.note.length > 10,
    cardState.note.slice(0, 60)
  );
  record(
    "底座卡片把隐私代价写在脸上（点名第三方机翻，并给出实测天花板与「只当初稿」的定位）",
    cardState.mentionsThirdParty && cardState.mentionsCeiling && cardState.mentionsDraftOnly,
    `第三方=${cardState.mentionsThirdParty} 天花板=${cardState.mentionsCeiling} 初稿=${cardState.mentionsDraftOnly}`
  );
  record("底座开着时「测一次底座」可点", cardState.probeDisabled === false, `disabled=${cardState.probeDisabled}`);

  stage = "点「测一次底座」";
  const probeFlow = await evaluate(`(async () => {
    document.getElementById("probeFastBase").click();
    await new Promise((r) => setTimeout(r, 600));
    const out = document.getElementById("fastBaseOut");
    return {
      calls: window.__gjProbe.probeBaseCalls,
      draft: window.__gjProbe.probedDraft,
      out: out.textContent,
      cls: out.className,
      disabled: document.getElementById("probeFastBase").disabled
    };
  })()`);
  record(
    "点「测一次底座」真的把当前表单值（含邮箱）发去探测，并按**实测秒数**下结论",
    probeFlow.calls === 1 &&
      probeFlow.draft?.fastBase === "mymemory" &&
      /1\.2 秒/u.test(probeFlow.out) &&
      probeFlow.cls.includes("ok"),
    `${probeFlow.calls} 次 / ${probeFlow.out}`
  );
  record("探测结束后按钮重新可点（否则这个按钮一辈子只能按一次）", probeFlow.disabled === false, `disabled=${probeFlow.disabled}`);

  stage = "把底座切到「关闭」";
  const offFlow = await evaluate(`(() => {
    const select = document.getElementById("fastBase");
    select.value = "off";
    select.dispatchEvent(new Event("change"));
    return {
      probeDisabled: document.getElementById("probeFastBase").disabled,
      out: document.getElementById("fastBaseOut").textContent,
      note: document.getElementById("fastBaseNote").textContent
    };
  })()`);
  record(
    "切到「关闭」后「测一次底座」被禁用（关着还能测，会让人以为关了也生效）",
    offFlow.probeDisabled === true,
    `disabled=${offFlow.probeDisabled}`
  );
  record(
    "切到「关闭」时清掉上一次的探测结果（不留一条过期的「够快」）",
    offFlow.out === "",
    JSON.stringify(offFlow.out)
  );
  record("切到「关闭」时说明也跟着换成「关闭」口径", offFlow.note !== cardState.note, offFlow.note.slice(0, 60));

  record("零未捕获异常", exceptions.length === 0, exceptions[0] || "");
  record("零 console.error", consoleErrors.length === 0, consoleErrors[0] || "");

  // 截图留证（视口调高一点，好把「模型 + 推理强度 + 说明 + 对比测速结果」一起收进来）
  stage = "截图留证";
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 1250,
    deviceScaleFactor: 1,
    mobile: false
  });
  await evaluate(`(() => {
    const node = document.getElementById("model");
    if (node) node.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await sleep(400);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(OUTDIR, `options-${TAG}.png`);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  log(`截图：${shotPath}`);
} catch (error) {
  record(
    "设置页自查执行完成",
    false,
    `卡在「${stage}」阶段：${error instanceof Error ? error.message : String(error)}`
  );
} finally {
  cleanup();
}

/** 函数声明（会提升），看门狗那条路径也要用。返回失败条数。 */
function printReport() {
  const failed = results.filter((item) => !item.pass);
  console.log(`\n设置页自查：通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length) {
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` → ${item.detail}` : ""}`);
  }
  return failed.length;
}

process.exit(printReport() ? 1 : 0);