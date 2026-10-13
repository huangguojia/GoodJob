/**
 * 副本一致性与清单完整性自检。
 *
 * 为什么需要它：content script 不能用 ESM，所以 `isChineseText` / `detectLanguage` 这些
 * 叶子函数在 `src/settings.js` 与 `src/content.js` 里**各存一份**。这个"两份"已经真实出过问题
 * （修了 settings.js，忘了 content.js → 页面上行为没变，单测却全绿）。
 * 这里把两份抠出来逐字比对，让"忘同步"变成一条会红的测试。
 *
 * 另外顺手校验 manifest 引用的文件都存在 —— 少一个文件扩展就整个加载不起来。
 * 跑法：node tests/parity.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

/**
 * 从源码里抠出 `function NAME(...) { ... }` 整块（按大括号配平），不做语义解析。
 * `async` 也要认 —— 不认的话 `composeFromCrm` 这种异步函数会抠不出来，
 * 断言就会变成"函数不存在"这种看不出真实原因的假红。
 *
 * ⚠️ 必须**先跳过参数表的右括号**。参数里有解构时（`{ quiet = false } = {}`），
 * 直接找第一个 `{` 会把参数当成函数体 —— 于是断言测的是一段四十个字符，
 * 无论函数体里写什么都全绿。这种假绿比红更费时间。
 */
function extractFunction(source, name) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "u");
  const match = pattern.exec(source);
  if (!match) return null;
  let index = match.index + match[0].length;
  let depth = 1;
  for (; index < source.length && depth > 0; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") depth -= 1;
  }
  const braceStart = source.indexOf("{", index);
  if (braceStart < 0) return null;
  let braces = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      braces += 1;
    } else if (ch === "}") {
      braces -= 1;
      if (braces === 0) return source.slice(braceStart, i + 1);
    }
  }
  return null;
}

/** 去掉注释与空白再比 —— 只约束代码，不约束两边的解释性注释各写各的。 */
function normalize(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    // 前一个字符不能是 `\`：源码里的 `https?:\/\/` 是转义写法，不该被当行注释切掉
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, "$1 ")
    .replace(/\s+/gu, " ")
    .trim();
}

/* ---------- 一、两份副本逐字一致 ---------- */

const SHARED_FUNCTIONS = [
  "isChineseText",
  "isTranslatable",
  "hasWord",
  "detectLanguage",
  "draftTarget",
  "shouldAutoTranslate"
];

const settingsSource = read("src/settings.js");
const contentSource = read("src/content.js");

for (const name of SHARED_FUNCTIONS) {
  const inSettings = extractFunction(settingsSource, name);
  const inContent = extractFunction(contentSource, name);
  check(`${name} 在 settings.js 里存在`, inSettings !== null);
  check(`${name} 在 content.js 里存在`, inContent !== null);
  if (!inSettings || !inContent) continue;
  check(
    `${name} 两份副本一致（去注释与空白后逐字相同）`,
    normalize(inSettings) === normalize(inContent),
    `settings=${normalize(inSettings).slice(0, 60)}… / content=${normalize(inContent).slice(0, 60)}…`
  );
}

/* ---------- 一·二、消息行定位的两层策略必须三处同步 ----------
 * content.js（内容脚本，不能用 ESM）、archive.js（ESM，归档/agent 用）各存一份
 * messageRows；autoreply.js 的 lastInboundRow 也是同策略。0.6.6 改版（行类名整批
 * 被换、只剩 msg-container + data-id）就是靠这层兜底接住的 —— 任何一份漏改，
 * 翻译/归档/智能回复就有一条路静默停摆，所以这里锁死兜底选择器三处都在。 */
{
  const fallbackSelector = '[data-testid="msg-container"]';
  const sources = [
    ["src/content.js", read("src/content.js")],
    ["src/archive.js", read("src/archive.js")],
    ["src/autoreply.js", read("src/autoreply.js")]
  ];
  for (const [file, source] of sources) {
    check(`${file} 的 messageRows/lastInboundRow 带改版兜底（${fallbackSelector}）`, source.includes(fallbackSelector));
  }
  // 双向判据只该出现在 messageRows/isIncomingRow 里（方向认不出时的默认值三处刻意不同：
  // 翻译层宁可不翻、归档层宁可算来信、lastInboundRow 只找来信），所以不锁逐字，只锁双向前缀。
  for (const file of ["src/content.js", "src/archive.js"]) {
    const source = read(file);
    check(`${file} 的方向判据认 data-id 首段（false_/true_ 前缀）`, source.includes('startsWith("false_")') && source.includes('startsWith("true_")'));
    // 0.6.9 终极兜底：结构标记（类名/data-id）全被改版摘掉时，方向还能靠
    // ① 发送状态图标（只在我方消息上，多年稳定的 testid）② 几何对齐（来信靠左/我方靠右）。
    // 这两层是产品语义，不依赖任何会被改版换掉的类名或属性。
    check(`${file} 的方向判据带发送状态图标兜底（msg-clock/check/dblcheck 只在我方）`, source.includes('"msg-dblcheck"') && source.includes('"msg-check"') && source.includes('"msg-clock"'));
    check(`${file} 的方向判据带几何对齐兜底（getBoundingClientRect 比左右空隙）`, source.includes("getBoundingClientRect"));
  }
  check(
    "src/autoreply.js 的 lastInboundRow 认来信前缀（false_）",
    read("src/autoreply.js").includes('startsWith("false_")')
  );
  // 扫描循环不许再直接认类名 —— 那正是 0.6.6 停摆的根因（改版后类名 0 命中）。
  check(
    "content.js 不再直接用 message-in 类名做来信过滤（统一走 isIncomingRow）",
    !contentSource.includes('classList.contains("message-in")) continue')
  );
  // 0.6.8：容器也可能被改版打掉（面板 testid 没了会落到 .copyable-area = 输入框，
  // 行扫描永远 0）—— 两份 messagesContainer 都必须有"气泡反推"层。
  for (const file of ["src/content.js", "src/archive.js"]) {
    const source = read(file);
    check(
      `${file} 的 messagesContainer 带气泡反推层（面板 testid 失配时不再落到输入框）`,
      source.includes('#main [data-testid="msg-container"], #main div.message-in')
    );
  }
  check(
    "content.js 方向认不出必须留痕（gjSkip=direction，诊断单数得出来）",
    contentSource.includes('gjSkip = "direction"')
  );
  {
    const diagBody = extractFunction(contentSource, "diagnoseScan");
    for (const field of ["扩展版本", "容器来源", "行来源", "方向统计", "首行结构"]) {
      check(`诊断单必须带「${field}」字段（一次粘贴定位翻不出来出在哪层）`, diagBody.includes(field));
    }
  check(
    "首行结构必须脱敏（正文一个字不带、号码打码）",
    contentSource.includes("rowSkeleton") && contentSource.includes("#号")
  );
  check(
    "诊断单版本位必须由后台代取（内容脚本没有 getManifest，e2e 实测过）",
    contentSource.includes('type: "getVersion"') && read("src/background.js").includes('"getVersion"')
  );
}
}

/* ---------- 二、manifest 引用与依赖存在 ---------- */

const manifest = JSON.parse(read("manifest.json"));
const refs = new Set();
if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
for (const block of manifest.content_scripts || []) {
  for (const file of [...(block.js || []), ...(block.css || [])]) refs.add(file);
}
for (const key of ["options_page"]) if (manifest[key]) refs.add(manifest[key]);
if (manifest.options_ui?.page) refs.add(manifest.options_ui.page);
if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
for (const file of Object.values(manifest.icons || {})) refs.add(file);
for (const file of Object.values(manifest.action?.default_icon || {})) refs.add(file);

for (const file of refs) {
  check(`清单引用的文件存在：${file}`, fs.existsSync(path.join(root, file)));
}

check("manifest_version 是 3", manifest.manifest_version === 3, String(manifest.manifest_version));

/** 动态 import 的 ESM 模块必须出现在 web_accessible_resources 里，否则 content script 加载不到。 */
const war = (manifest.web_accessible_resources || []).flatMap((block) => block.resources || []);
check(
  "web_accessible_resources 放行了 src/*.js（content script 动态 import 用）",
  war.includes("src/*.js"),
  JSON.stringify(war)
);

/** 所有 ESM 相对导入都要能在磁盘上找到 */
function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

let missingImports = 0;
for (const file of walk("src").filter((f) => f.endsWith(".js"))) {
  const code = read(file);
  for (const match of code.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
    const target = path.resolve(path.dirname(path.join(root, file)), match[1]);
    if (!fs.existsSync(target)) {
      missingImports += 1;
      failures.push(`ESM 相对导入找不到文件：${file} → ${match[1]}`);
    }
  }
}
if (missingImports === 0) passed += 1;

/* ---------- 三、新增设置项确实在默认值里 ---------- */

const defaultSettingsSource = settingsSource.slice(
  settingsSource.indexOf("export const DEFAULT_SETTINGS"),
  settingsSource.indexOf("export function isConfigured")
);
for (const key of ["composeTranslate", "composeAuto", "replyLang", "targetLang"]) {
  check(`DEFAULT_SETTINGS 里有 ${key}`, defaultSettingsSource.includes(`${key}:`));
}

/**
 * CRM 那几个键。
 * 地址嵌在 `crm` 下 —— 取错层级（读成 `settings.crmBaseUrl`）不会报错，只会**静默回落到回环默认值**，
 * 表现成"填了远端地址也连不上"，是这套配置里最难查的一种坏法。
 * 令牌则必须独立成键：设置对象会被设置页整块读写，也会进诊断输出，密钥不该出现在那些地方。
 */
for (const key of ["crmBaseUrl", "pluginBaseUrl"]) {
  check(`DEFAULT_SETTINGS.crm 里有 ${key}`, defaultSettingsSource.includes(`${key}:`));
}
check("CRM 令牌独立成键（不混进设置对象）", /CRM_SESSION_KEY\s*=\s*"gj_[a-z_]+"/u.test(settingsSource));

/** 密码绝不能进存储：设置里出现 password 字段就说明有人把它一起存了。 */
check("设置默认值里没有密码字段", !/password\s*:/iu.test(defaultSettingsSource));

/** 设置页与弹窗的存在性：地址必须在，不然渲染时取到 null，整页 TypeError。 */
check("设置页有 CRM 地址输入框", /id="crmBaseUrl"/u.test(read("src/options.html")));

/* ---------- 四、设计令牌与品牌标识只有一处定义 ---------- */

const themeSource = read("src/gj-theme.css");

/** gj-theme.css 里 `--gj-x: …` 的全部令牌名 */
const definedTokens = new Set([...themeSource.matchAll(/(--gj-[a-z0-9-]+)\s*:/gu)].map((m) => m[1]));

check("gj-theme.css 定义了品牌色令牌 --gj-brand", definedTokens.has("--gj-brand"));
check("gj-theme.css 定义了 GJ 标识组件 .gj-mark", /\.gj-mark\s*\{/u.test(themeSource));

/** 每个 content_scripts 块都要先引令牌再引自己的样式 —— 顺序错了变量还没定义就用上了 */
for (const [index, block] of (manifest.content_scripts || []).entries()) {
  const css = block.css || [];
  check(`content_scripts[${index}].css 第一项是 gj-theme.css`, css[0] === "src/gj-theme.css", JSON.stringify(css));
  check(`content_scripts[${index}].css 里 gj-theme.css 只出现一次`, css.filter((f) => f === "src/gj-theme.css").length === 1, JSON.stringify(css));
}

/** 引用了不存在的令牌 = 该属性会静默失效（比写错色值更难查） */
const TOKEN_CONSUMERS = ["src/content.css", "src/agent.css", "src/popup.html", "src/options.html"];
for (const file of TOKEN_CONSUMERS) {
  const source = read(file);
  const used = new Set([...source.matchAll(/var\((--gj-[a-z0-9-]+)/gu)].map((m) => m[1]));
  const unknown = [...used].filter((name) => !definedTokens.has(name));
  check(`${file} 引用的 --gj-* 令牌都在 gj-theme.css 里有定义`, unknown.length === 0, unknown.join(", "));
}

/**
 * 注入到 WhatsApp 页面里的两份样式不得再出现"第二个品牌色"。
 * 扩展此前一处绿（#1d9e75）、一处靛（#4f46e5），是这次统一要消灭的对象；
 * 品牌色只允许从 --gj-brand 系令牌取（gj-theme.css 自身除外，那里就是它的定义处）。
 */
for (const file of ["src/content.css", "src/agent.css"]) {
  const source = read(file).toLowerCase();
  for (const legacy of ["#1d9e75", "#17845f", "#4f46e5", "#4338ca", "#eef1ff"]) {
    check(`${file} 不再硬编码旧品牌色 ${legacy}`, !source.includes(legacy));
  }
}

/** GJ 标识的标记结构：两处注入脚本各有一份（content script 不是 ESM，无法共享 import） */
const agentSource = read("src/agent.js");
for (const [file, source] of [["content.js", contentSource], ["agent.js", agentSource]]) {
  check(`${file} 里用 .gj-mark 类构建标识`, /"gj-mark"/u.test(source) || /\.className = "gj-mark"/u.test(source));
  check(`${file} 的标识含 G / J 两个字母`, source.includes('"G"') && source.includes('"J"'));
}

/* ---------- 四·二、铁律：任何动作必须有前端响应 ----------
 * 「点分析没任何反馈」是灾难级体验，病根有六类，全部锁死在这里：
 * ① button() 点击无即时确认 / handler 抛异常直接蒸发；② busy 锁静默 return；
 * ③ sendMessage 没超时（后台失联 = busy 永久卡死，之后每次点击都静默无效）；
 * ④ 没有全局兜底网；⑤ 长任务无心跳（用户分不清在跑还是卡死）。 */
{
  const buttonBody = extractFunction(agentSource, "button");
  check(
    "agent.js 的 button() 点击必须先表态再执行（is-busy + 文案挂…）",
    buttonBody.includes("is-busy") && buttonBody.includes('gjBusy')
  );
  check(
    "agent.js 的 button() 必须 catch 处理函数异常并落到界面（noteFailure）",
    buttonBody.includes(".catch(") && buttonBody.includes("noteFailure(")
  );
  const sendBody = extractFunction(agentSource, "sendMessage");
  check(
    "agent.js 的 sendMessage 必须带超时（后台失联不能把 busy 位永久卡死）",
    sendBody.includes("setTimeout") && sendBody.includes("没有响应")
  );
  check(
    "agent.js 必须挂全局 unhandledrejection 兜底网（漏抛的异常也要落界面）",
    agentSource.includes('addEventListener("unhandledrejection"')
  );
  check(
    "agent.js 长任务必须有心跳（startHeartbeat：已等待 N 秒原位刷新）",
    agentSource.includes("startHeartbeat") && agentSource.includes("已等待")
  );
  const analyzeBody = extractFunction(agentSource, "analyzeConversation");
  check(
    "analyzeConversation 的忙碌锁不得静默（要点名骨架屏就是它在跑）",
    analyzeBody.includes("骨架屏") && analyzeBody.includes("renderPanel")
  );
  const composeBody = extractFunction(agentSource, "composeFromCrm");
  check(
    "composeFromCrm 的忙碌锁不得静默",
    composeBody.includes("不用反复点") && composeBody.includes("renderPanel")
  );
  const archiveBody = extractFunction(agentSource, "archiveAndLearn");
  check(
    "archiveAndLearn 的忙碌锁不得静默",
    archiveBody.includes("串行") && archiveBody.includes("renderPanel")
  );
  check(
    "agent.css 必须有 is-busy 按下态样式",
    read("src/agent.css").includes(".gj-agent-btn.is-busy")
  );
}

/* ---------- 五、CRM 通道的接线：一头都不能少 ---------- */

/*
 * 这条链路横跨四个文件（设置页/弹窗 → background → crm.js → 插件的 compose 接口），
 * 而且**每一处漏接都是静默的**：少一个 id 是整页崩、少一个消息分支是"点了没反应"、
 * 少一个导出是那一页加载失败。所以在这里逐个点名，把"漏了一处"变成会红的测试。
 */

const crmSource = read("src/crm.js");
const backgroundSource = read("src/background.js");
const optionsSource = read("src/options.js");
const optionsHtmlSource = read("src/options.html");
const popupSource = read("src/popup.js");
const popupHtmlSource = read("src/popup.html");

/** `el("x")` 引的 id 必须在对应的 HTML 里真的存在 */
const elIds = (source) => new Set([...source.matchAll(/\bel\("([a-zA-Z][\w-]*)"\)/gu)].map((m) => m[1]));
for (const [htmlFile, htmlSource, jsFile, jsSource] of [
  ["options.html", optionsHtmlSource, "options.js", optionsSource],
  ["popup.html", popupHtmlSource, "popup.js", popupSource]
]) {
  const declared = new Set([...htmlSource.matchAll(/id="([a-zA-Z][\w-]*)"/gu)].map((m) => m[1]));
  const missing = [...elIds(jsSource)].filter((id) => !declared.has(id));
  check(`${jsFile} 里 el() 引的 id 都在 ${htmlFile} 里`, missing.length === 0, missing.join(", "));
}

/** crm.js 的具名导出，必须覆盖各处 import 里点到的每个名字 */
const crmExports = new Set(
  [...crmSource.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gu)].map((m) => m[1])
);
for (const file of ["src/background.js", "src/options.js", "src/popup.js"]) {
  for (const match of read(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/crm\.js"/gu)) {
    const names = match[1]
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/u)[0].trim())
      .filter(Boolean);
    const unknown = names.filter((name) => !crmExports.has(name));
    check(`${file} 从 crm.js 引入的名字都真实导出`, unknown.length === 0, unknown.join(", "));
  }
}

/** 页面/弹窗发出去的 CRM 指令，background 必须都有分支 —— 少一个就是「点了没反应」 */
for (const [file, source, types] of [
  ["options.js", optionsSource, ["crmLogin", "crmLogout", "crmStatus"]],
  [
    "agent.js",
    agentSource,
    ["crmStatus", "crmCompose", "crmSuggest", "crmResources", "crmReveal", "crmFeedback", "openOptions"]
  ],
  ["popup.js", popupSource, ["crmStatus"]]
]) {
  for (const type of types) {
    check(`${file} 会发出 ${type}`, source.includes(`"${type}"`));
    check(`background 处理 ${type}`, backgroundSource.includes(`"${type}"`));
  }
}

/**
 * 资源中心的四条通道，background 一个都不能少。
 * 少一个的表现都是"点了没反应"，最难查的一类坏法。
 */
for (const type of ["crmSuggest", "crmResources", "crmReveal", "crmFeedback"]) {
  check(`background 有 ${type} 分支`, backgroundSource.includes(`"${type}"`));
}

check("整列渲染了「推荐回复」区", agentSource.includes("推荐回复"));
check("整列渲染了「相关文档」区", agentSource.includes("相关文档"));
check("整列有「只要回复（不推资料）」入口", agentSource.includes("只要回复（不推资料）"));
check("整列有「只要资料（快）」入口", agentSource.includes("只要资料（快）"));
check("整列有「填进输入框（不发送）」而不是「发送」", agentSource.includes("填进输入框（不发送）"));

/**
 * CRM 那两条路**都只出草稿**：函数体里不该出现任何发送动作。
 * 这是这条链路唯一一条不可挽回的红线 —— 错发的报价/承诺撤不回来。
 *
 * `fillComposer` / `insertText` 也在禁用名单里：把草稿写进输入框的那一步必须由用户点，
 * 自动化那一下离"替你发出去"只差一个回车。
 */
const SEND_ACTIONS = /sendButton|dispatchEvent|\.click\(|fillComposer|insertText/u;

const composeBody = extractFunction(agentSource, "composeFromCrm");
check("agent.js 里有 composeFromCrm", composeBody !== null);
check(
  "composeFromCrm 里没有任何发送动作",
  Boolean(composeBody) && !SEND_ACTIONS.test(composeBody),
  String(composeBody || "").match(SEND_ACTIONS)?.[0] || ""
);

/** 「回复 + 资料一次给全」那条链路（整列的主路径）同样适用。 */
const analyzeBody = extractFunction(agentSource, "analyzeConversation");
check("agent.js 里有 analyzeConversation", analyzeBody !== null);
check(
  "analyzeConversation 里没有任何发送动作",
  Boolean(analyzeBody) && !SEND_ACTIONS.test(analyzeBody),
  String(analyzeBody || "").match(SEND_ACTIONS)?.[0] || ""
);

/**
 * 同理，`crm.js` 里负责"把内容拿回来"的那几个函数也不许夹带发送。
 * 它们跑在 background 里，手上没有页面 DOM，一旦越界只能是通过 storage 或消息绕 —— 更要堵死。
 */
for (const name of ["suggestForConversation", "searchResources", "revealResource", "recordResourceFeedback"]) {
  const body = extractFunction(crmSource, name);
  check(`crm.js 里有 ${name}`, body !== null);
  check(
    `crm.js 的 ${name} 里没有发送动作`,
    Boolean(body) && !SEND_ACTIONS.test(body),
    String(body || "").match(SEND_ACTIONS)?.[0] || ""
  );
}

/* ---------- 六、右侧整列：纯逻辑与 DOM 的接线 ---------- */

/*
 * `resources.js` 是被**动态 import** 进来的，所以"名字写错了"这类错误在静态检查里
 * 根本看不见 —— 运行时才发现 `mods.resources.X is not a function`。逐名比对一次。
 */
const resourcesSource = read("src/resources.js");
const resourcesExports = new Set(
  [...resourcesSource.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gu)].map((m) => m[1])
);
const usedResourceMembers = new Set(
  [...agentSource.matchAll(/mods\.resources\.([A-Za-z_$][\w$]*)/gu)].map((m) => m[1])
);
check("agent.js 确实用了 resources.js 的成员", usedResourceMembers.size >= 10, String(usedResourceMembers.size));
const unknownResourceMembers = [...usedResourceMembers].filter((name) => !resourcesExports.has(name));
check(
  "agent.js 用到的 resources.js 成员都真实导出",
  unknownResourceMembers.length === 0,
  unknownResourceMembers.join(", ")
);

check(
  "web_accessible_resources 放行了 src/resources.js（content script 动态 import 用）",
  war.some((pattern) => pattern === "src/*.js" || pattern === "src/resources.js"),
  JSON.stringify(war)
);

/**
 * 整列必须是**贴边的满高侧栏**，不能退回浮层。
 * 浮层会盖住消息，用户没法边看边回；`top/right/bottom` 三个一起写才是满高，
 * 漏一个就变成"高度由内容决定"的弹窗，看着像但一长就露馅。
 */
const agentCss = read("src/agent.css");
const panelRule = /#gj-agent-panel\s*\{([^}]*)\}/u.exec(agentCss)?.[1] ?? "";
check("agent.css 里能找到 #gj-agent-panel 规则", panelRule.length > 0);
for (const declaration of ["position: fixed", "top: 0", "right: 0", "bottom: 0"]) {
  check(`整列声明了 ${declaration}`, panelRule.includes(declaration));
}
check("整列宽度取自 --gj-col-w 令牌", panelRule.includes("var(--gj-col-w"));
check("gj-theme.css 定义了 --gj-col-w", definedTokens.has("--gj-col-w"));

/** 推窄 WhatsApp 只能用 `#app.style.marginRight` —— 动 body padding 会把底部输入框顶出屏幕。 */
check("给 WhatsApp 留位用 marginRight", agentSource.includes("marginRight"));
check("没有去改 body 的 padding", !/body\.style\.padding/u.test(agentSource));

/** 外链只许留在内存：落到 storage 就等于把"延迟披露"这道闸门拆了。 */
check("取到的外链不写进 storage", !/writeStorage\([^)]*revealed/u.test(agentSource));

/**
 * 打开面板只铺一层**快**资料（`/resources/search`，不调模型），**不**顺手起一轮几十秒的出稿。
 * 展开一列不等于"替我跑个 CLI 任务" —— 那件事只该由"真的换了会话"和用户点击来触发。
 */
const prefillBody = extractFunction(agentSource, "maybePrefillColumn");
check("agent.js 里有 maybePrefillColumn", prefillBody !== null);
check(
  "打开面板做的是快检索而不是出稿",
  Boolean(prefillBody) && prefillBody.includes('"search"') && !prefillBody.includes('"suggest"'),
  String(prefillBody || "").slice(0, 160)
);
check("快检索只用一次（否则每次重绘都会再打一轮请求）", Boolean(prefillBody) && prefillBody.includes("prefilled"));

/**
 * 刷新**不许**动用户的动作记忆。
 *
 * `dismissed` / `revealed` 记的是「这份我标了没帮助」「这份的链接我刚取过」。
 * 自动刷新有可能在用户点下去的那一刻返回，把它清掉就等于把那次点击吞了 ——
 * 用户看到的现象是"点了没反应"，然后就不信这个面板了。
 */
check(
  "analyzeConversation 不覆盖「没帮助」/「取过链接」的记忆",
  Boolean(analyzeBody) && !/column\.(dismissed|revealed)\s*=\s*\{\}/u.test(analyzeBody),
  String(analyzeBody || "").match(/column\.(dismissed|revealed)\s*=\s*\{\}/u)?.[0] || ""
);
check(
  "刷新成功只清自己写的进度提示，不清用户看到的结果文案",
  Boolean(analyzeBody) && analyzeBody.includes("progressNote"),
  ""
);

/**
 * 这条接缝**坏起来是静默的**，所以钉住它。
 *
 * `pluginJson` 把插件的响应体包成 `{ok:true, result:<插件响应体>}`，插件响应体自己
 * 又是 `{ok:true, access}`。agent.js 读 `response.result` 再交给 `revealOutcome`。
 * 谁少包一层，都不会报错 —— 表现是"点了复制链接，提示暂时取不到链接"，
 * 看着像网络抖了一下，其实形状错了。e2e 的假后台也必须照这个形状写。
 */
check("pluginJson 把插件响应包在 result 里", /return\s*\{\s*ok:\s*true,\s*result:\s*payload\s*\}/u.test(crmSource));
check("reveal 的产物形状是 {ok,access}（revealOutcome 就是按它解）", /export function revealOutcome\(body\)/u.test(resourcesSource));

/**
 * 「请手动复制」这类提示必须**真的把东西摆出来**，否则比直接报错更糟：
 * 用户会在面板上一条条找过去，最后以为是自己点错了。
 *
 * 两条这样的路：知识条目没有外链（贴正文）、剪贴板被挡（显示地址）。
 * 它们都收在 `manualBox` 一个出口，且只在用户点过之后才被渲染。
 */
const manualBody = extractFunction(agentSource, "manualBox");
check("agent.js 里有 manualBox", manualBody !== null);
check(
  "manualBox 两条路都真的渲染出内容（正文 / 可全选的地址框）",
  Boolean(manualBody) && manualBody.includes("gj-agent-manual-body") && manualBody.includes("gj-agent-manual-url"),
  String(manualBody || "").slice(0, 160)
);
check(
  "manualBox 只在用户点过（manual 有值）之后才渲染",
  /if \(state\.column\.manual\?\.key === key\) card\.append\(manualBox/u.test(agentSource)
);

/** 换会话要清掉"跟着会话走"的东西，但**不能**清用户的「没帮助」判断。 */
const resetBody = extractFunction(agentSource, "resetConversationScopedState");
check("agent.js 里有 resetConversationScopedState", resetBody !== null);
check(
  "换会话清掉链接 / 手抄内容 / 已复制记忆",
  Boolean(resetBody) &&
    resetBody.includes("revealed = {}") &&
    resetBody.includes("manual = null") &&
    resetBody.includes('copiedKey = ""'),
  String(resetBody || "").slice(0, 160)
);
check("换会话**不**动 dismissed（用户的判断跨会话仍然成立）", Boolean(resetBody) && !resetBody.includes("dismissed"));
check(
  "analyzeConversation 走的是这个 helper，不是自己手写一遍",
  Boolean(analyzeBody) && analyzeBody.includes("resetConversationScopedState"),
  ""
);

/* ---------- 扩展重载后的旧页面：不许静默停摆 ---------- */

/**
 * 用户在扩展管理页点了「重新加载」后，**已经打开的** WhatsApp 页面里那份脚本会变成"孤儿"：
 * `chrome.runtime.id` 没了，之后每次发消息都必然失败，翻译再也不会恢复 —— 除非刷新这一页。
 *
 * 这条链路以前是静默的（只把 `state.stopped` 置上就完事），用户看到的是"翻译突然不工作了"，
 * 而手里没有任何线索可猜。现在必须变成页面上看得见的一句话。
 */
const aliveBody = extractFunction(contentSource, "extensionAlive");
check("content.js 里有 extensionAlive", aliveBody !== null);
check(
  "判据是 chrome.runtime.id（真扩展必有，重载后消失）",
  Boolean(aliveBody) && /chrome\?\.runtime\?\.id/u.test(aliveBody),
  String(aliveBody || "").slice(0, 140)
);

const stopBody = extractFunction(contentSource, "stopForReload");
check("content.js 里有 stopForReload", stopBody !== null);
check(
  "停手时一定把提示摆出来（不能只是默默停下）",
  Boolean(stopBody) && stopBody.includes("showReloadBanner"),
  String(stopBody || "").slice(0, 120)
);

check('提示条的 id 是常量 STALE_ID = "gj-stale-banner"', /const STALE_ID = "gj-stale-banner";/u.test(contentSource));

const bannerBody = extractFunction(contentSource, "showReloadBanner");
check("content.js 里有 showReloadBanner", bannerBody !== null);
check(
  "提示条真的挂到页面上，而且自己带一个刷新按钮",
  Boolean(bannerBody) && bannerBody.includes("document.body.appendChild") && bannerBody.includes("location.reload"),
  String(bannerBody || "").slice(0, 140)
);
check("提示条文案点名 F5（用户得知道按什么）", Boolean(bannerBody) && /F5/u.test(bannerBody));
check(
  "提示条挂上了 .gj-stale 类（只给 id 的话样式表匹配不上，等于没样式）",
  Boolean(bannerBody) && /className = "gj-stale"/u.test(bannerBody),
  String(bannerBody || "").slice(0, 140)
);

const sendBody = extractFunction(contentSource, "send");
check(
  "send 失败时走 stopForReload（不再静默置 stopped）",
  Boolean(sendBody) && sendBody.includes("stopForReload") && !sendBody.includes("state.stopped = true"),
  String(sendBody || "").slice(0, 140)
);

const scanBody = extractFunction(contentSource, "scan");
check(
  "每次扫描开头先确认脚本还活着",
  Boolean(scanBody) && scanBody.includes("extensionAlive()"),
  String(scanBody || "").slice(0, 120)
);
check("自检位带上 needsReload", /needsReload:\s*state\.stopped/u.test(contentSource));

const contentCssSource = read("src/content.css");
check("content.css 里有提示条样式 .gj-stale", /\.gj-stale\s*\{/u.test(contentCssSource));
check(
  "提示条固定在视口内、浮在页面之上",
  /\.gj-stale\s*\{[^}]*position:\s*fixed/u.test(contentCssSource) &&
    /\.gj-stale\s*\{[^}]*z-index:\s*\d+/u.test(contentCssSource)
);
check(
  "提示条颜色走 gj-* 令牌（不硬编码色值）",
  !/\.gj-stale\s*\{[^}]*#[0-9a-fA-F]{3,8}/u.test(contentCssSource)
);

/* ---------- 卡住的行不能就这么算了（pending 必须有超时兜底） ---------- */

check("PENDING_STALE_MS 有定义且是有限时长", /const PENDING_STALE_MS = \d+;/u.test(contentSource), "");
check(
  "标 pending 的同时记下时刻（没有它就无从判断卡了多久）",
  Boolean(scanBody) && /row\.dataset\.gjPendingAt = String\(Date\.now\(\)\)/u.test(scanBody),
  String(scanBody || "").slice(0, 160)
);
check(
  "扫描遇到 pending 先看卡了多久，过期的清掉重来",
  Boolean(scanBody) && scanBody.includes("gjPendingAt") && scanBody.includes("PENDING_STALE_MS") && scanBody.includes("removeNode(row)"),
  String(scanBody || "").slice(0, 220)
);

const translateRowBody = extractFunction(contentSource, "translateRow");
check("content.js 里有 translateRow", translateRowBody !== null);
check(
  "translateRow 收尾一定清掉 gjPendingAt（否则这条永远被判成在途）",
  Boolean(translateRowBody) && translateRowBody.includes("delete row.dataset.gjPendingAt"),
  String(translateRowBody || "").slice(0, 200)
);
check(
  "孤儿脚本期间不留 pending（刷新之后才重得来）",
  Boolean(translateRowBody) && /state\.stopped\)\s*\{[\s\S]*?delete row\.dataset\.gjStatus/u.test(translateRowBody),
  String(translateRowBody || "").slice(0, 220)
);

/* ---------- 超时：来信重试一次，草稿不重试 ---------- */

const retryBody = extractFunction(backgroundSource, "translateWithRetry");
check("background.js 里有 translateWithRetry", retryBody !== null);
check(
  "只对超时重试，且真的重试（恰好两次 translateText）",
  Boolean(retryBody) &&
    retryBody.includes("OVERALL_TIMEOUT_CODE") &&
    (retryBody.match(/translateText\(/gu) || []).length === 2,
  String(retryBody || "").slice(0, 200)
);
const translateBody = extractFunction(backgroundSource, "translate");
check("background.js 里有 translate", translateBody !== null);
check(
  "来信走重试、草稿（quick）不走",
  Boolean(translateBody) && translateBody.includes("translateWithRetry") && translateBody.includes("message?.quick"),
  String(translateBody || "").slice(0, 220)
);
const draftBody = extractFunction(contentSource, "translateDraft");
check(
  "草稿翻译带 quick: true",
  Boolean(draftBody) && /quick: true/u.test(draftBody),
  String(draftBody || "").slice(0, 160)
);

/* ---------- 失败时浮框要能一键重来 ---------- */

const showPanelBody = extractFunction(contentSource, "showPanel");
check("content.js 里有 showPanel", showPanelBody !== null);
check(
  "失败态把「替换到输入框」让给「重试」；发送按钮独立存在且失败态禁用",
  Boolean(showPanelBody)
    && showPanelBody.includes('error ? "retry" : "replace"')
    && showPanelBody.includes('error ? "重试" : "替换到输入框"')
    && /sendBtn\.disabled = !usable \|\| error/u.test(showPanelBody),
  String(showPanelBody || "").slice(0, 240)
);
check(
  "「替换并发送」按钮跟随设置开关（关掉自动发送 = 不显示，默认 = 显示）",
  /sendBtn\.style\.display = state\.settings\?\.autoSendAfterReplace === false \? "none" : ""/u.test(contentSource),
  ""
);
check(
  "失败态「替换到输入框」保持可点（做成灰的等于没给）",
  Boolean(showPanelBody) && showPanelBody.includes("!usable && !error"),
  ""
);
check(
  "ensurePanel 里认得出重试分支",
  contentSource.includes('gjAction === "retry"') && contentSource.includes('translateDraft({ trigger: "manual" })'),
  ""
);

/* ---------- 「没反应」要能被自检一眼说破 ---------- */

check(
  "pageProbe 报 pending / stalled（卡住的指纹）",
  /pending: rows\.filter/u.test(contentSource) && /stalled: rows\.filter/u.test(contentSource),
  ""
);
check(
  "popup 自检直接下结论：该翻却没翻",
  popupSource.includes("该翻却没翻") && popupSource.includes("shouldTranslate"),
  ""
);

/* ---------- 提速：提示词 · 参数 · 快速失败 ---------- */

const providerSource = read("src/provider.js");
/** README 也要一起查：文档里的模型举例曾把用户坑进 404（见下面「不许瞎举例」那条）。 */
const readmeSource = read("README.md");

/**
 * 抠出 `const NAME = [ "…", "…" ].join("\n")` 里的字符串列表。
 * 跨文件比对「同一个提示词」用 —— 直接比字面量，忽略缩进与拼接写法。
 */
function extractStringArray(source, name) {
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*\\.join`, "u");
  const match = pattern.exec(source);
  if (!match) return null;
  const items = [];
  const literal = /"((?:[^"\\]|\\.)*)"/gu;
  let found;
  while ((found = literal.exec(match[1])) !== null) items.push(found[1]);
  return items;
}

const localPrompt = extractStringArray(providerSource, "TRANSLATOR_SYSTEM_PROMPT");

check("扩展侧提示词抠得出来", Array.isArray(localPrompt) && localPrompt.length >= 4, JSON.stringify(localPrompt));
check(
  "提示词禁止「先想想再答」（推理型模型超时的头号原因）",
  providerSource.includes("Do not think step by step") && providerSource.includes("Translate directly"),
  ""
);
check(
  "提示词要求只输出译文（否则模型的前言会原样显示在客户消息下面）",
  providerSource.includes("no preamble") && providerSource.includes("no original text"),
  ""
);
check(
  "提示词要求保住数字与换行（外贸场景错一个字就是事故）",
  providerSource.includes("numbers") && providerSource.includes("line breaks"),
  ""
);

// 跨项目：插件侧那份提示词必须逐字一致，否则 CRM 里的翻译和浏览器里的翻译出两套译风。
// 插件目录在仓库里必然存在，所以读不到就让它红 —— 不要静默跳过。
let pluginPrompt = null;
let pluginReadError = "";
try {
  const pluginSource = fs.readFileSync(
    path.join(root, "..", "whatsapp-plugin", "src/server/services/translation.ts"),
    "utf8"
  );
  pluginPrompt = extractStringArray(pluginSource, "TRANSLATOR_SYSTEM_PROMPT");
} catch (error) {
  pluginReadError = error instanceof Error ? error.message : String(error);
}
check(
  "插件侧提示词与扩展侧逐字一致（同口径，避免两套译风）",
  Array.isArray(pluginPrompt) && JSON.stringify(pluginPrompt) === JSON.stringify(localPrompt),
  pluginReadError ? `读不到插件侧：${pluginReadError}` : `插件=${JSON.stringify(pluginPrompt)}`
);

check(
  "settings 里有首字超时预算且流式默认开，并带一个真正会被读到的迁移版本号",
  /firstTokenMs:\s*\d+/u.test(settingsSource) &&
    /stream:\s*true/u.test(settingsSource) &&
    /SETTINGS_SCHEMA_VERSION\s*=\s*(\d+)/u.test(settingsSource),
  ""
);
check(
  "首字超时阈值必须与「实测线路最慢模型」相称（实测 gpt-5.5 首字 66 秒、gpt-6.1-sol 65.8 秒）",
  (() => {
    const found = settingsSource.match(/firstTokenMs:\s*(\d+)/u);
    return Boolean(found) && Number(found[1]) >= 60000;
  })(),
  String(settingsSource.match(/firstTokenMs:\s*(\d+)/u))
);
check(
  "整体超时也必须够宽（实测同线路 10.6 ~ 67.9 秒，低阈值会把能用的模型判死）",
  (() => {
    const found = settingsSource.match(/timeoutMs:\s*(\d+)/u);
    return Boolean(found) && Number(found[1]) >= 90000;
  })(),
  String(settingsSource.match(/timeoutMs:\s*(\d+)/u))
);
/**
 * ⚠️ 这条是**本轮最贵的教训**的守卫。
 *
 * `mergeSettings` 是 `{...默认值, ...存储值}`，存储值一律赢。所以「只改代码里的默认值、
 * 不加迁移」= 老用户永远升不上来 —— 上一轮就是这么把 `firstTokenMs` 从 8000 放宽到 20000、
 * 自检全绿，而用户浏览器里存的还是 8000，每次翻译都在第 8 秒被判死。
 */
check(
  "改设置默认值必须配套迁移（光改默认值 = 老用户升不上来）",
  (() => {
    const version = Number((settingsSource.match(/SETTINGS_SCHEMA_VERSION\s*=\s*(\d+)/u) || [])[1]);
    if (!(version >= 2)) return false;
    if (!/export function migrateSettings\(/u.test(settingsSource)) return false;
    // 迁移必须真的被 loadSettings 调起来、并且落盘 —— 只定义不调用等于没写
    const load = settingsSource.match(/export async function loadSettings\(\)[\s\S]*?\n\}/u)?.[0] || "";
    return load.includes("migrateSettings(") && load.includes("chrome.storage.local.set");
  })(),
  ""
);
check(
  "迁移必须覆盖「已实测会坏」的模型名（不存在的 404 / 慢到被超时判死）",
  /WOBBLY_MODELS/u.test(settingsSource) &&
    settingsSource.includes('"gpt-4o-mini"') &&
    settingsSource.includes('"gpt-5.5"'),
  ""
);
check(
  "默认模型取实测最快的那一个（gpt-5.5 是这条线上最慢的，不许当默认值）",
  /model:\s*"gpt-5\.6-sol"/u.test(settingsSource) && !/model:\s*"gpt-5\.5"/u.test(settingsSource),
  String(settingsSource.match(/model:\s*"([^"]+)"/u))
);
check(
  "provider 把「首字超时」与「整体超时」分开判（白等 20 秒才是用户真正难受的地方）",
  providerSource.includes("hitFirstToken") && providerSource.includes("hitOverall"),
  ""
);
check(
  "首字超时只在流式下计时（非流式根本看不到「第一个字」什么时候到）",
  providerSource.includes("const firstTimer = useStream"),
  ""
);
check(
  "上游 400 不认可选参数时自动去掉参数重试（用户不必猜哪些参数能传）",
  providerSource.includes("error.status === 400") && providerSource.includes("request(true)"),
  ""
);
check("重试时连 stream 一起去掉", providerSource.includes("stream: useStream"), "");
check(
  "重试判据挂在错误 code 上，不再靠错误文案（文案改一次，includes 那版当场变死代码）",
  backgroundSource.includes("OVERALL_TIMEOUT_CODE") && !backgroundSource.includes('includes("翻译超时")'),
  ""
);
check(
  "超时判据是 provider 导出的常量（文案随便改，逻辑不受影响）",
  providerSource.includes('FIRST_TOKEN_CODE = "first-token-timeout"') &&
    providerSource.includes('OVERALL_TIMEOUT_CODE = "overall-timeout"'),
  ""
);
check(
  "首字超时确实不重试（只重试整体超时：首字超时说明这个模型没响应，重试白等）",
  backgroundSource.includes("error?.code !== OVERALL_TIMEOUT_CODE"),
  ""
);
check(
  "测速报秒数而不是只说「连接正常」（用户靠秒数判断模型行不行）",
  optionsSource.includes("response.totalMs") && optionsSource.includes("describeSpeed"),
  ""
);
check(
  "配置页能选推理强度，且选项闭环（html 有控件、js 有读写）",
  optionsHtmlSource.includes('id="reasoningEffort"') &&
    optionsSource.includes('el("reasoningEffort").value = settings.reasoningEffort') &&
    optionsSource.includes("reasoningEffort: el(\"reasoningEffort\").value"),
  ""
);
check(
  "配置页能对比测速（html 有按钮、js 有实现与绑定）",
  optionsHtmlSource.includes('id="bench"') &&
    optionsSource.includes("async function bench") &&
    optionsSource.includes('el("bench").addEventListener'),
  ""
);

/* ---------- 模型清单：把「手输模型名」这件事从根上消掉 ----------
 *
 * 真实事故：扩展里被填了一个该线路根本没有的模型名（gpt-4o-mini），于是每次请求
 * 秒回 404 model_not_found，而 625 项单测 + 187 项 parity + 122 项 e2e **全绿** ——
 * 用户那边一条译文都出不来，界面上也没有任何线索。
 *
 * 根因有两条，这里各钉一条：
 *   ① 模型名只能手输，用户无从知道这条线路上有什么 → 必须能「拉清单 + 点选」；
 *   ② 文档/界面拿未经核实的模型名举例（我自己就干了）→ 直接禁掉。
 */

check("provider 导出 listModels（设置页靠它把手输变点选）", providerSource.includes("export async function listModels"), "");
check(
  "background 有 listModels 指令分支",
  backgroundSource.includes('type === "listModels"') && backgroundSource.includes("async function handleListModels"),
  ""
);
check("options.html 有「拉取清单」按钮", optionsHtmlSource.includes('id="listModels"'), "");
check("options.html 有清单容器", optionsHtmlSource.includes('id="modelList"'), "");
check(
  "清单渲染成可点标签（含选中态）",
  optionsSource.includes("function renderModelList") && optionsSource.includes("aria-pressed"),
  ""
);
check("清单有样式（没样式会掉成一堆无格式文字，用户不知道能点）", optionsHtmlSource.includes(".model-list"), "");
check(
  "拉清单失败要说明「有些站不开放这个接口」，别让用户以为 Key 坏了",
  optionsSource.includes("不开放"),
  ""
);
// 禁的是「把未经核实的模型名当**推荐举例**」这种句式（"如 gpt-4o-mini 一类"），
// 而不是禁止提及它 —— 在事故说明里当反例写出来是有价值的，别一并禁掉。
const recommendedModelExample = /(?:如|例如|比如|e\.g\.|such as)\s*`?gpt-4o-mini/u;
check(
  "设置页与 README 里不许把未经核实的模型名当作**推荐举例**（gpt-4o-mini 就是这么坑进去的）",
  !recommendedModelExample.test(optionsHtmlSource) && !recommendedModelExample.test(readmeSource),
  ""
);
check(
  "README 必须告诉用户「先拉清单再选」，而不是让他手输",
  readmeSource.includes("拉取") && readmeSource.includes("模型清单"),
  ""
);
check(
  "真实链路自检脚本存在 —— 它是唯一能发现「模型名在这条线路上不存在」的一层",
  fs.existsSync(path.join(root, "tests/live-check.mjs")),
  ""
);
check(
  "真实链路自检用的是**真** provider 与真网络（防止它被改成又一个桩）",
  read("tests/live-check.mjs").includes('from "../src/provider.js"'),
  ""
);

/* ---------- 快速底座：两段式翻译的「第一段」 ----------
 * 这一层解决的是「这条线路根本没有快模型」——实测最快也要 10.3 秒出首字。
 * 它是**唯一**能让用户第一眼就看到译文的东西，所以接线一头都不能少：
 *   ① 模块存在且默认不碰第三方（host permission 走可选，不是 manifest 硬写）；
 *   ② background 真的先问底座、再把 AI 精修结果推回页面；
 *   ③ 初译**不进缓存**（进了会把"机译"永久钉在这句话上）；
 *   ④ 页面认得精修推送，但**绝不代发**。
 */
const fastBaseSource = read("src/fast-base.js");

check(
  "快速底座模块存在且导出关键能力",
  ["fastTranslate", "probeFastBase", "isFastBaseEnabled", "pickFastTranslation", "splitForBase"].every((name) =>
    fastBaseSource.includes(`export ${name.startsWith("isFast") ? "function" : name === "fastTranslate" || name === "probeFastBase" ? "async function" : "function"} ${name}`)
  ),
  ""
);
check(
  "底座默认地址是 MyMemory（实测可达；谷歌 12 秒超时不可用）",
  fastBaseSource.includes("api.mymemory.translated.net"),
  ""
);
check(
  "⚠️ 第三方域名**不许**写进 manifest 的 host_permissions（要用可选权限，在用户打开它的那一刻才申请）",
  !JSON.stringify(manifest.host_permissions || []).includes("mymemory"),
  JSON.stringify(manifest.host_permissions)
);
check(
  "设置页保存底座时申请可选权限（不申请的话请求会被 CORS 拦，且用户毫无线索）",
  optionsSource.includes("ensureHostPermission(fastBaseEndpoint("),
  ""
);
check(
  "background 先问底座、再跑 AI 精修（两段式接线完整）",
  backgroundSource.includes("fastTranslate(settings, input)") &&
    backgroundSource.includes("refineLater(settings,") &&
    backgroundSource.includes("notifyRefined("),
  ""
);
check(
  "精修结果经 tabs.sendMessage 推回页面（不是让页面轮询）",
  backgroundSource.includes('chrome.tabs.sendMessage(tabId, { type: "translateRefined"'),
  ""
);
check(
  "⚠️ 初译**不进缓存**：`putCache` 只能在 AI 之后出现（进了缓存=机译被永久钉住）",
  (() => {
    const body = backgroundSource.match(/async function translate\(message, sender\)[\s\S]*?\n\}/u)?.[0] || "";
    const firstPut = body.indexOf("await putCache(");
    const refineCall = body.indexOf("void refineLater(");
    if (firstPut < 0 || refineCall < 0) return false;
    // putCache 必须出现在 refineLater **之后**：机译那条分支里不许有 putCache
    return firstPut > refineCall;
  })(),
  ""
);
check(
  "底座失败是静默降级（不回报错给用户，但要留下原因供自检）",
  backgroundSource.includes("lastFastBaseError = error instanceof Error"),
  ""
);
check(
  "页面认得精修推送（translateRefined）",
  contentSource.includes('message?.type === "translateRefined"') && contentSource.includes("applyRefined("),
  ""
);
check(
  "机译与 AI 译文在界面上必须可区分（否则用户以为机译就是终稿）",
  contentSource.includes('options.tier === "mt" ? "机译" : "译"') && contentSource.includes("AI 精修中…"),
  ""
);
check(
  "精修替换只能改译文文本，**不许**碰输入框（按回车的人始终是用户）",
  (() => {
    const body = contentSource.match(/function applyRefined\(token, text\)[\s\S]*?\n  \}/u)?.[0] || "";
    if (!body) return false;
    return !body.includes("fillComposer") && !body.includes("execCommand") && !body.includes("dispatchEvent");
  })(),
  ""
);
check(
  "底座认领令牌来自页面生成（靠文本匹配会在「客户连发两条一样的话」时认错行）",
  contentSource.includes("mintRefineToken()") && backgroundSource.includes("message?.refineToken"),
  ""
);
check(
  "⚠️ 两份 e2e 的注入设置里必须**显式关掉**第三方底座：e2e 会加载真 background，" +
    "默认值 mymemory 会让它去打真实第三方服务（测试不该依赖别人的免费额度）",
  read("tests/e2e-extension.mjs").includes('fastBase: "off"') &&
    read("tests/e2e-agent.mjs").includes('fastBase: "off"'),
  ""
);

/* ---------- 改版哨兵：来信翻译停摆必须自己报警，不许静默装死 ---------- */

check(
  "改版哨兵存在：行选择器失配时页面必须亮出横幅（gj-diag-banner）",
  contentSource.includes("DIAG_BANNER_ID") &&
    contentSource.includes("showDiagBanner") &&
    contentSource.includes("stallScans"),
  ""
);
check(
  "哨兵必须自己续扫描拍子（停摆时没有 mutation 就不会再有扫描，不续拍永远数不到阈值）",
  /stallScans \+= 1;[\s\S]{0,400}showDiagBanner\(\);[\s\S]{0,200}scheduleScan\(600\)/u.test(contentSource),
  ""
);
check(
  "跳过要留原因（skip 和「坏了」必须能区分）",
  contentSource.includes("row.dataset.gjSkip =") &&
    contentSource.includes('"empty"') &&
    contentSource.includes('"chinese"') &&
    contentSource.includes('"notTranslatable"'),
  ""
);
check(
  "诊断单是给人看的：中文字段名（看单子的往往是正在着急的老板，不是开 devtools 的工程师）",
  contentSource.includes("来信行数") && contentSource.includes("改版探针_testid气泡"),
  ""
);
check(
  "哨兵横幅只做本地诊断：不许发网络请求、不许发消息（诊断就是诊断）",
  (() => {
    const body = contentSource.match(/function diagnoseScan\(\)[\s\S]*?\n  \}/u)?.[0] || "";
    const banner = contentSource.match(/function showDiagBanner\(\)[\s\S]*?\n  \}/u)?.[0] || "";
    if (!body || !banner) return false;
    return !body.includes("fetch(") && !body.includes("sendMessage") && !banner.includes("sendMessage");
  })(),
  ""
);
check(
  "横幅有样式（DOM 存在 ≠ 看得见 —— 这课交过学费）",
  read("src/content.css").includes("#gj-diag-banner"),
  ""
);

/* ---------- 「写进输入框」：两份副本必须一致，且必须**读回确认** ---------- */

const autoreplySource = read("src/autoreply.js");

/*
 * `composer` / `fillComposer` 在 `content.js`（翻译浮框的「替换到输入框」）和
 * `autoreply.js`（自动回复草稿 / CRM 草稿的「填进输入框」）里各存一份 —— content script
 * 不能用 ESM，只能各写一份。但这是**同一个用户动作**，口径必须一模一样，所以逐字比对。
 */
for (const name of ["composer", "composerWritten", "composerSettle", "fillComposer"]) {
  const inAutoreply = extractFunction(autoreplySource, name);
  const inContent = extractFunction(contentSource, name);
  check(`${name} 在 autoreply.js 里存在`, inAutoreply !== null);
  check(`${name} 在 content.js 里存在`, inContent !== null);
  if (!inAutoreply || !inContent) continue;
  check(
    `${name} 两份副本一致（去注释与空白后逐字相同）`,
    normalize(inAutoreply) === normalize(inContent),
    `autoreply=${normalize(inAutoreply).slice(0, 70)}… / content=${normalize(inContent).slice(0, 70)}…`
  );
}

/**
 * ⚠️ 这一组是**用户报障**的直接守卫，别删。
 *
 * 原话：「点击一键替换，应该把对话框中的内容替换，而不是再确认。」
 * 根因是写入成功与否只看 `document.execCommand` 的返回值 —— 而编辑器（WhatsApp 用的是
 * Lexical）会把这次插入吞掉或按自己的状态回滚，命令**照样返回 true**。于是界面显示
 * 「已替换到输入框」，输入框里一个字都没变。
 *
 * 所以：① 成功与否必须读回输入框判定；② 写入路径上不许有裸 `return true`；
 * ③ 要等编辑器同步；④ 要有「粘贴」这条备用路径；⑤ 全都不成立时返回失败。
 */
const fillBody = extractFunction(autoreplySource, "fillComposer");
check(
  "写入成功与否由**读回输入框**决定（composerWritten），不看 execCommand 的返回值",
  Boolean(fillBody) && fillBody.includes("composerWritten("),
  ""
);
check(
  "写入路径上不许出现裸 `return true`（那就是「信命令返回」的老毛病）",
  Boolean(fillBody) && !normalize(fillBody).includes("return true"),
  ""
);
check(
  "写完要等编辑器同步（await composerSettle()）—— 同步立刻插会撞在它的旧选区上",
  Boolean(fillBody) && fillBody.includes("await composerSettle()"),
  ""
);
check(
  "要有「合成粘贴」这条备用路径（Lexical 认的正是它，不是 insertText）",
  Boolean(fillBody) && fillBody.includes("ClipboardEvent") && fillBody.includes("DataTransfer"),
  ""
);
check(
  "四招都不成立时返回失败，交给界面说实话",
  Boolean(fillBody) && normalize(fillBody).includes('return { ok: false, how: "" }'),
  ""
);

/** 面板侧：点一下必须**当场替换**，不许变成"再让人确认一次"。 */
const replaceHandler = (() => {
  const start = contentSource.indexOf('replace.className = "gj-panel-replace"');
  if (start < 0) return "";
  const end = contentSource.indexOf("\n    const send =", start);
  return end > start ? contentSource.slice(start, end) : "";
})();
check(
  "面板「替换到输入框」走 writeComposer（里面才是读回确认的 await fillComposer）",
  replaceHandler.includes("await writeComposer(text)") && contentSource.includes("await fillComposer(text)"),
  replaceHandler.slice(0, 90)
);
check(
  "写不进去时照实说「没能写进输入框」并引导右上角复制图标，不再谎报已替换",
  replaceHandler.includes("没能写进输入框") && replaceHandler.includes("复制图标"),
  ""
);
check(
  "成功提示**报事实**（「已替换输入框内容」），不是让人再确认一次",
  replaceHandler.includes("已替换输入框内容") && !replaceHandler.includes("确认无误后按回车发送"),
  ""
);
check(
  "写入期间按钮要禁用（免得连点写两遍），替换完成才恢复",
  replaceHandler.includes("replace.disabled = true") && replaceHandler.includes("replace.disabled = false"),
  ""
);

/* ---------- 「替换并发送」：独立按钮、一键到底，但两道闸缺一不发 ----------
 * 用户要求：复制收成右上角图标，底部两个动作按钮——「替换到输入框」+「替换并发送」。
 * 发送是唯一不可撤回的动作，纪律必须钉死在测试里：写入没验证过不发、dom 兜底档不发、
 * 发送后必须读回确认。 */
const sendHandler = (() => {
  const start = contentSource.indexOf('send.className = "gj-panel-send"');
  if (start < 0) return "";
  const end = contentSource.indexOf("\n    const actions =", start);
  return end > start ? contentSource.slice(start, end) : "";
})();
check(
  "「替换并发送」是独立按钮（底部动作位），与「替换到输入框」并列",
  Boolean(sendHandler) && sendHandler.includes("替换并发送"),
  ""
);
check(
  "dom 兜底档**绝不**自动发（编辑器状态没验证过，发了可能是旧内容）",
  sendHandler.includes('filled.how === "dom"') && sendHandler.includes("这一档不自动发送"),
  ""
);
check(
  "发送成功读得到「已替换并发送」，失败照实说「请按回车」（绝不谎报已发送）",
  sendHandler.includes("已替换并发送") && sendHandler.includes("自动发送没成功，请按回车"),
  ""
);
check(
  "复制收成译文右上角的图标（gj-panel-copy 在 bodywrap 里，带 aria-label）",
  contentSource.includes('gj-panel-bodywrap') &&
    /copy\.className = "gj-panel-copy";[\s\S]{0,120}copy\.setAttribute\("aria-label", "复制译文"\)/u.test(contentSource),
  ""
);
const sendComposerBody = extractFunction(contentSource, "sendComposer");
check(
  "content.js 里有 sendComposer，且发送后**读回输入框确认清空**（不是点完就报成功）",
  Boolean(sendComposerBody) && sendComposerBody.includes("waitEmptied") && sendComposerBody.includes("composerText().trim()"),
  ""
);
check(
  "sendComposer 两招：优先点 WhatsApp 自己的发送按钮，Enter 键事件兜底",
  Boolean(sendComposerBody) && sendComposerBody.includes('data-testid="send"') && sendComposerBody.includes('key: "Enter"'),
  ""
);
check(
  "settings.js 出厂默认开「替换后自动发送」（用户要的一键到底）",
  settingsSource.includes("autoSendAfterReplace: true"),
  ""
);

/* ---------- 0.7.1：粘贴/拖拽进输入框也要触发草稿翻译 ----------
 * 真机病灶：Lexical 接管 paste（beforeinput 被拦掉后浏览器不再补发 input，
 * 程序化改 DOM 也不产生 input）→ 用户「复制进去内容」后要再打一个字才翻。
 * mock 的 strictEditor 就是这个行为的复刻（paste preventDefault + 程序化渲染），
 * 所以 e2e 里粘贴段必须走 strictEditor + 合成 paste 事件，不许走直接写 innerText。
 * 0.7.2 追加：删除同样不触发（同一类坑）→ 监听必须含 beforeinput（先于一切接管逻辑）。 */
const composerWatcher = extractFunction(contentSource, "attachComposerWatcher");
check(
  "草稿监听必须含 beforeinput（粘贴/删除/拖拽在 Lexical 接管下都不发 input，beforeinput 是唯一先到的可靠信号）",
  Boolean(composerWatcher) && composerWatcher.includes('addEventListener("beforeinput"'),
  ""
);
check(
  "草稿监听必须含 paste（只听 input 时，粘贴进输入框完全无感）",
  Boolean(composerWatcher) && composerWatcher.includes('addEventListener("paste"'),
  ""
);
check(
  "草稿监听同时含 drop（拖拽进输入框与粘贴同命）",
  Boolean(composerWatcher) && composerWatcher.includes('addEventListener("drop"'),
  ""
);
check(
  "必须有 MutationObserver 兜底盯输入框（真机 beforeinput 都可能到不了监听，DOM 变化是唯一拦不住的信号）",
  Boolean(extractFunction(contentSource, "watchComposerMutations")) &&
    extractFunction(contentSource, "ensureComposeUi")?.includes("watchComposerMutations()"),
  ""
);

/* ---------- 0.7.0：引擎三选一 / 译文贴内容宽度 / 面板配置入口 ---------- */
check(
  "settings.js 出厂引擎是混合（engineMode: hybrid），且 normalize 只认三个值",
  settingsSource.includes('engineMode: "hybrid"') &&
    settingsSource.includes('["hybrid", "mt", "ai"].includes(next.engineMode)'),
  ""
);
const agentPanelSource = read("src/agent.js");
check(
  "background 引擎分流：只机译（mt）不安排精修、只 AI（ai）跳过底座",
  backgroundSource.includes('const mode = ["hybrid", "mt", "ai"].includes(settings.engineMode)') &&
    backgroundSource.includes('aiReady && mode === "hybrid"') &&
    backgroundSource.includes("fastReady && mode !== \"ai\"") &&
    backgroundSource.includes('mode === "mt"'),
  ""
);
check(
  "background 提供 updateSettings 指令（GJ 面板切引擎的通道，写 storage 广播 settingsChanged）",
  backgroundSource.includes('type === "updateSettings"') && backgroundSource.includes("async function updateSettings"),
  ""
);
check(
  "agent.js 面板带翻译引擎三选一 + 打开配置页按钮（配置完不再找不到门）",
  agentPanelSource.includes('type: "updateSettings", patch: { engineMode: picked }') &&
    agentPanelSource.includes('type: "openOptions"') &&
    agentPanelSource.includes("只用机译（最快 · 免费）"),
  ""
);
check(
  "options 页有引擎三选一并读写 engineMode",
  read("src/options.html").includes('id="engineMode"') &&
    read("src/options.js").includes('el("engineMode")'),
  ""
);
check(
  "译文块两层结构：外层独占一行、内层 .gj-translation-card 贴内容宽度（不占一整行）",
  contentSource.includes('gj-translation-card') &&
    /card\.append\(label, body\)/u.test(contentSource) &&
    read("src/content.css").includes(".gj-translation-card") &&
    /width: fit-content/u.test(read("src/content.css")),
  ""
);
check(
  "「已发送」反馈有停留期：草稿看门人不得把 sent 态浮框当「过期译文」抢关",
  contentSource.includes('panel.dataset.gjState === "sent"') &&
    /gjState === "sent"\)\s*return/u.test(contentSource) &&
    /dataset\.gjState === "sent"\)\s*live\.remove\(\)/u.test(contentSource),
  ""
);

/* ---------- 三份 e2e 的 Chrome 启动参数 ----------
 * 本机有一条踩过的坑：给 headless Chrome 指定自定义 `--user-data-dir` 时，
 * http(s) 导航会偶发永久卡住（三份 e2e 的注释里都记着这件事：
 * `Page.frameStartedLoading` 之后请求发不出去、`Page.navigate` 直接超时）。
 * 我复现不出稳定触发（加回去连跑 4 次全绿），所以它不是"已定位的 bug"，
 * 而是三份脚本一致的**防御性戒律** —— 这里把它钉住，免得哪天为了"隔离"又加回去。
 */
const userDataDirArg = /^[ \t]*["'`]--user-data-dir=/mu;
for (const file of ["e2e-agent.mjs", "e2e-extension.mjs", "e2e-options.mjs"]) {
  check(
    `${file} 不给 Chrome 传 --user-data-dir（本机记录过它会偶发卡死 http 导航）`,
    !userDataDirArg.test(read(`tests/${file}`)),
    ""
  );
}
check(
  "e2e-options 卡住时要报出卡在哪一步（原来只报「通过 0 / 1」，等于没有线索）",
  read("tests/e2e-options.mjs").includes("stage = ") && read("tests/e2e-options.mjs").includes("看门狗"),
  ""
);

/* ---------- 输出 ---------- */

console.log(`\n副本一致性自检：通过 ${passed} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
