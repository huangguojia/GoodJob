/**
 * 网页版 WhatsApp 的注入层。
 *
 * 职责边界（刻意划小）：
 *   ✅ 读页面上的**入站**消息文本 → 交给 background 翻译 → 在气泡下方追加一个只读译文节点
 *   ✅ 读输入框里的**中文草稿** → 自动译成回复语言 → 在右侧浮框里给「复制 / 替换到输入框」
 *   ❌ 绝不替你把消息发出去 —— 替换只是把译文写回输入框，按下回车的人始终是你
 *
 * 消息行的定位分两层：老选择器 `div.message-in / div.message-out`，以及改版兜底
 * `[data-testid="msg-container"]`（方向藏在行元素 `data-id` 首段，`true_`=我方 / `false_`=来信）。
 * 这些是 WhatsApp 自己逻辑依赖的属性，比那些 hash 类名（`_akbu` 之类）稳定得多；
 * 但 0.6.6 哨兵诊断单实锤过：类名也会被整批换掉，所以兜底层必须有。
 */

(() => {
  if (globalThis.__gjTranslatorLoaded) return;
  globalThis.__gjTranslatorLoaded = true;

  const NODE_CLASS = "gj-translation";
  const ROW_FLAG = "gj-has-translation";
  const STATUS_ATTR = "data-gj-status";
  const COMPOSE_BTN_ID = "gj-compose-button";
  const PANEL_ID = "gj-compose-panel";
  const STALE_ID = "gj-stale-banner";
  /** 改版哨兵横幅：聊天开着、面板里明明有气泡，但我们的行选择器一个都没匹配上。 */
  const DIAG_BANNER_ID = "gj-diag-banner";
  const SCAN_DELAY = 350;
  /** 打字停顿多久才发翻译请求。太短会在半句话上反复请求，太长会觉得"没反应"。 */
  const AUTO_DELAY = 900;
  /** 「替换到输入框」之后的抑制窗口，见 settings.js 的 shouldAutoTranslate。 */
  const REPLACE_GUARD_MS = 1600;
  /**
   * 一行被标成 pending 之后，超过这么久还没定终态，就允许重来一遍。
   *
   * 为什么必须有：`translateRow` 等的是 `chrome.runtime.sendMessage` 的回调，而 MV3 的后台
   * service worker 会被回收 —— 回调**可能永远不来**。那一刻这一行就永久停在 pending：
   * 界面上既没有"翻译中…"（节点早被 WhatsApp 重渲染清掉），也没有"翻译失败"，
   * 用户看到的只有一条干干净净、永远不翻的客户消息，连一条线索都没有。
   * 实测就是这样卡了十几个小时（截图里那条 "Hello"）。
   */
  const PENDING_STALE_MS = 45000;
  /**
   * 连续多少次扫描「聊天开着但一行都没匹配到」才报警。1 次会误报（会话加载中的瞬间
   * 本来就没有行），2 次 ≈ 700ms，既躲过加载抖动，又不至于让用户等出疑问。
   */
  const SCAN_STALL_LIMIT = 2;

  const LANGUAGE_LABELS = {
    "zh-CN": "中文",
    en: "英语",
    es: "西班牙语",
    pt: "葡萄牙语",
    fr: "法语",
    de: "德语",
    ru: "俄语",
    ar: "阿拉伯语"
  };

  const state = {
    settings: null,
    stats: { translated: 0, failed: 0 },
    /** 最近一次失败原因。popup 的「翻译自检」直接展示它 —— 没有它，用户只能看到"没反应"。 */
    lastError: "",
    stopped: false
  };

  let scanTimer = null;
  let observer = null;
  let lastContainer = null;
  /** 「聊天开着但一行都没匹配到」的连续计数 —— 改版哨兵的依据，见 scan()。 */
  let stallScans = 0;
  /** 草稿自动翻译的 debounce 计时器 */
  let draftTimer = null;
  /**
   * 请求序号。打字快时会有多个翻译请求在路上，回来顺序不保证 ——
   * 只认最后一次发出的，避免先发的慢响应把后发的覆盖掉。
   */
  let draftSeq = 0;
  /** 最近一次自动翻过的草稿原文（同一份不重复请求） */
  let lastAutoDraft = "";
  let replaceGuardUntil = 0;
  /**
   * 两段式翻译的「认领令牌」。
   *
   * 第一段（机译）先显示出来，第二段（AI 精修）是**后台异步回来**的 —— 回来时必须认清
   * 「这条译文属于哪一格」。靠文本去匹配会在「客户连发两条一模一样的话」时认错行，
   * 所以每条请求发一个一次性令牌，页面按令牌找回对应的节点。
   */
  let refineSeq = 0;
  function mintRefineToken() {
    refineSeq += 1;
    return `r${Date.now().toString(36)}-${refineSeq}`;
  }
  /** 草稿浮框当前挂着哪一次精修（浮框只有一个，所以只要记一份） */
  let draftRefine = null;

  /* ---------- 与 settings.js 同口径的叶子工具（content script 不能用 ESM，故此处保留副本；
                 改动请同步 src/settings.js） ---------- */

  function isChineseText(text) {
    const value = String(text || "");
    // 假名 / 谚文 是日语、韩语的特征 —— 少了这道判断，日语消息会被整条当成中文跳过翻译。
    if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(value)) return false;
    if (!/[\u4e00-\u9fff]/u.test(value)) return false;
    const han = (value.match(/[\u4e00-\u9fff]/gu) || []).length;
    const letters = (value.match(/[A-Za-z\u00c0-\u024f]/gu) || []).length;
    return han >= 2 && han >= letters;
  }

  function isTranslatable(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    if (/^\d+([.,]\d+)?$/u.test(trimmed)) return false;
    if (/^(https?:\/\/|www\.)\S+$/iu.test(trimmed)) return false;
    if (/^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return false;
    return /\p{L}/u.test(trimmed);
  }

  /** 词形匹配：不用 `\b`（它基于 ASCII `\w`，`olá`/`échantillon` 这类重音词旁边永不成立）。 */
  function hasWord(value, alternation) {
    return new RegExp(`(?:^|[^\\p{L}])(?:${alternation})(?![\\p{L}])`, "iu").test(value);
  }

  function detectLanguage(text) {
    const value = String(text || "");
    if (/[\u3040-\u30ff]/u.test(value)) return "ja";
    if (/[\uac00-\ud7af]/u.test(value)) return "ko";
    if (/[\u4e00-\u9fff]/u.test(value)) return "zh-CN";
    if (/[\u0400-\u04ff]/u.test(value)) return "ru";
    if (hasWord(value, "hola|gracias|pedido|precio|muestras|necesitamos|cuál|pueden|podrían")) return "es";
    if (hasWord(value, "olá|obrigado|preço|pedido|amostras|vocês")) return "pt";
    if (hasWord(value, "bonjour|merci|prix|commande|échantillon")) return "fr";
    return "en";
  }

  /* ---------- 草稿方向与自动闸门（与 src/settings.js 同口径，改动请同步） ---------- */

  /** 见 src/settings.js::draftTarget */
  function draftTarget(text, settings) {
    const chinese = isChineseText(text);
    return {
      chinese,
      targetLang: chinese ? settings?.replyLang || "en" : settings?.targetLang || "zh-CN",
      sourceLang: chinese ? "zh-CN" : detectLanguage(text)
    };
  }

  /** 见 src/settings.js::shouldAutoTranslate */
  function shouldAutoTranslate(input = {}) {
    const { text = "", lastText = "", enabled = true, now = Date.now(), guardUntil = 0 } = input;
    const value = String(text || "").trim();
    if (!enabled) return { run: false, reason: "disabled" };
    if (!value) return { run: false, reason: "empty" };
    if (Number(now) < Number(guardUntil)) return { run: false, reason: "guarded" };
    if (!isChineseText(value)) return { run: false, reason: "not-chinese" };
    if (value === lastText) return { run: false, reason: "already" };
    return { run: true, reason: "ok" };
  }

  /* ---------- 与 background 通信 ---------- */

  /**
   * 扩展重新加载 / 更新后，**已经打开的页面**里那份脚本会变成"孤儿"：
   * `chrome.runtime.id` 没了，之后每一次发消息都必然失败。
   *
   * 这是最容易被误判成"扩展坏了"的一种状态：页面看上去一切正常（悬浮球还在、DOM 还在），
   * 但翻译**再也不会恢复** —— 除非用户刷新这一页。以前这里只是静默停手，用户只能自己猜。
   * 现在只要判定进入这个状态，就在页面上直说，并给一个一键刷新。
   */
  function extensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function stopForReload() {
    state.stopped = true;
    showReloadBanner();
  }

  function showReloadBanner() {
    if (!document.body || document.getElementById(STALE_ID)) return;
    const bar = document.createElement("div");
    bar.id = STALE_ID;
    // ⚠️ 样式表是按类名写的，只给 id 的话这条横幅会掉回"文档流里的全宽白条"，
    // 在视口底部之外，看着像什么都没发生 —— 断言里那句 insideViewport 就是抓这个的。
    bar.className = "gj-stale";
    bar.setAttribute("role", "status");

    const dot = document.createElement("span");
    dot.className = "gj-stale-dot";

    const text = document.createElement("span");
    text.className = "gj-stale-text";
    text.textContent = "GoodJob 助手已更新，这一页的翻译已停";

    const hint = document.createElement("span");
    hint.className = "gj-stale-hint";
    hint.textContent = "刷新后自动恢复";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gj-stale-btn";
    button.textContent = "刷新页面（F5）";
    button.addEventListener("click", () => location.reload());

    bar.append(dot, text, hint, button);
    document.body.appendChild(bar);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            const reason = chrome.runtime.lastError.message || "";
            // 有些版本不抛异常、只在这里报"上下文已失效"，两条路都要认。
            if (/context invalidated|Extension context/i.test(reason)) stopForReload();
            resolve({ ok: false, error: reason });
            return;
          }
          resolve(response || { ok: false, error: "后台没有响应" });
        });
      } catch (error) {
        // 扩展被重载后旧的 content script 会走到这里。
        stopForReload();
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /* ---------- DOM 定位 ---------- */

  /** 最近一次 messagesContainer() 是靠哪层兜底拿到的 —— 诊断单要靠它区分"改到哪一层了"。 */
  let containerSource = "还没找过";

  function messagesContainer() {
    const panel = document.querySelector('#main [data-testid="conversation-panel-messages"]');
    if (panel) {
      containerSource = "panel-testid";
      return panel;
    }
    // 改版兜底（0.6.8）：面板 testid 也可能被换掉 —— 那样老逻辑会落到 `.copyable-area`，
    // 而那多半是**输入框**，行扫描永远 0（诊断单显示"容器找到、行总数 0"就是这个形状）。
    // 用气泡自己反推容器：第一个气泡的父层。messageRows 的 closest 允许向上越出这层
    // 找 data-id 行，所以"父层装着气泡"对扫描就够用了。
    const bubble = document.querySelector(
      '#main [data-testid="msg-container"], #main div.message-in, #main div.message-out'
    );
    if (bubble?.parentElement) {
      containerSource = "气泡反推";
      return bubble.parentElement;
    }
    const copyable = document.querySelector("#main .copyable-area");
    if (copyable) {
      containerSource = "copyable-area（疑似输入框，行匹配必败）";
      return copyable;
    }
    containerSource = "#main";
    return document.querySelector("#main");
  }

  /**
   * 消息行定位，两层：
   * ① 老选择器 `div.message-in / div.message-out`（多年稳定，mock 也用它）；
   * ② 改版兜底：新版把行类名整批换掉了，气泡本体是 `[data-testid="msg-container"]`，
   *    方向不在类名上，往上找到带 `data-id` 的行元素再看首段。
   * 哨兵诊断单（0.6.6）实锤的现场：容器在、探针抓到 25 个 msg-container、
   * 老选择器 0 命中 —— 第②层就是为这个准备的。
   */
  function messageRows(container) {
    const legacy = Array.from(container.querySelectorAll("div.message-in, div.message-out"));
    if (legacy.length) return legacy;
    const seen = new Set();
    const rows = [];
    for (const bubble of container.querySelectorAll('[data-testid="msg-container"]')) {
      const row = bubble.closest("[data-id]") || bubble;
      if (seen.has(row)) continue;
      seen.add(row);
      rows.push(row);
    }
    return rows;
  }

  /**
   * 方向兜底第一层：我方出厂消息**必带**发送状态图标（时钟=发送中/单勾=已发/双勾=已读）。
   * 这组 testid 是 WhatsApp 自己的消息状态 UI，多年稳定、只出现在我方消息上 —— 比类名可靠。
   */
  function hasOutgoingStatusMark(row) {
    return Boolean(
      row.querySelector(
        '[data-testid="msg-clock"], [data-testid="msg-check"], [data-testid="msg-dblcheck"]'
      )
    );
  }

  /**
   * 方向兜底第二层（终极）：**几何位置**。来信气泡靠左、我方靠右 —— 这是聊天产品的
   * 语义布局，改版改掉它等于改掉产品本身。行是满宽的 flex 容器（气泡在行内对齐），
   * 拿气泡矩形和行矩形比左右空隙即可；行本身就是气泡时拿父容器作参照。
   */
  function directionByGeometry(row) {
    const rowRect = row.getBoundingClientRect();
    if (!rowRect.width) return "unknown";
    const bubble =
      row.querySelector('[data-testid="msg-container"]') ||
      row.querySelector("span.selectable-text") ||
      row.firstElementChild;
    const bubbleRect = bubble ? bubble.getBoundingClientRect() : rowRect;
    const refRect =
      bubble && bubble !== row ? rowRect : row.parentElement?.getBoundingClientRect() || rowRect;
    if (!refRect.width) return "unknown";
    const span = refRect.width;
    const leftGap = bubbleRect.left - refRect.left;
    const rightGap = refRect.right - bubbleRect.right;
    if (rightGap < span * 0.15 && leftGap > span * 0.35) return "out";
    if (leftGap < span * 0.15 && rightGap > span * 0.35) return "in";
    return "unknown";
  }

  /**
   * 行方向五层判定：类名 → `data-id` 首段（`false_`=来信/`true_`=我方）→
   * 发送状态图标（只在我方）→ 几何对齐 → unknown。
   * ⚠️ `unknown` 必须在扫描里**留痕**（gjSkip="direction"）—— 静默跳过就是下一次
   * "点了没反应/翻了没译文"的复刻，诊断单必须能把这一类数出来。
   */
  function rowDirection(row) {
    if (!row) return "unknown";
    if (row.classList.contains("message-in")) return "in";
    if (row.classList.contains("message-out")) return "out";
    const id = row.getAttribute("data-id") || "";
    if (id.startsWith("false_")) return "in";
    if (id.startsWith("true_")) return "out";
    try {
      if (hasOutgoingStatusMark(row)) return "out";
      return directionByGeometry(row);
    } catch {
      return "unknown"; // getBoundingClientRect 在隐藏节点上可能异常 —— 留给留痕，别炸扫描
    }
  }

  /**
   * 这一行是不是「客户发来的」。两条路都认不出时**当自己的话** ——
   * 宁可不翻，也绝不把我们的回复翻一遍（方向不明的会在诊断单里现形）。
   */
  function isIncomingRow(row) {
    return rowDirection(row) === "in";
  }

  /** 一条消息的纯文本：优先取 WhatsApp 自己标记的可选文本节点，避免把时间戳也吃进来 */
  function extractText(row) {
    const parts = Array.from(row.querySelectorAll("span.selectable-text"))
      .map((node) => (node.innerText || node.textContent || "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join("\n").trim();

    const plain = row.querySelector("[data-pre-plain-text]");
    if (plain) {
      return (plain.innerText || plain.textContent || "").trim();
    }
    // 兜底：整行文本，去掉首尾的时间戳样式片段
    const fallback = (row.innerText || "").trim();
    return fallback.replace(/^\d{1,2}:\d{2}(\s?(AM|PM))?\s*/iu, "").trim();
  }

  function messageKey(row, text) {
    return row.getAttribute("data-id") || row.dataset.id || text.slice(0, 120);
  }

  /* ---------- 译文节点 ---------- */

  function ensureNode(row) {
    let node = row.querySelector(`.${NODE_CLASS}`);
    if (!node) {
      node = document.createElement("div");
      node.className = NODE_CLASS;
      // 目的是让译文换行落在气泡下方，而不是挤在气泡右边
      row.classList.add(ROW_FLAG);
      row.appendChild(node);
    }
    return node;
  }

  function renderPending(row) {
    const node = ensureNode(row);
    node.dataset.gjState = "pending";
    node.textContent = "";
    const card = document.createElement("div");
    card.className = "gj-translation-card";
    const label = document.createElement("span");
    label.className = "gj-translation-label";
    label.textContent = "译";
    const body = document.createElement("span");
    body.className = "gj-translation-body";
    body.textContent = "翻译中…";
    card.append(label, body);
    node.append(card);
  }

  /**
   * 画译文。
   *
   * `options.tier` 区分「谁翻的」：
   *   `"mt"` = 免费底座出的**机译**，标签写「机译」并挂上「AI 精修中…」；
   *   其它   = AI 译文，标签写「译」。
   * 这个区分必须看得见 —— 机译质量确实糙（实测把 `unidades` 译成"单位"），
   * 用户有权知道眼前这句是初稿还是终稿，而不是让两种质量混在一个「译」字后面。
   */
  function renderDone(row, text, options = {}) {
    const node = ensureNode(row);
    node.dataset.gjState = "done";
    node.dataset.gjTier = options.tier === "mt" ? "mt" : "ai";
    node.textContent = "";
    const card = document.createElement("div");
    card.className = "gj-translation-card";
    const label = document.createElement("span");
    label.className = "gj-translation-label";
    label.textContent = options.tier === "mt" ? "机译" : "译";
    const body = document.createElement("span");
    body.className = "gj-translation-body";
    body.textContent = text;
    card.append(label, body);
    node.append(card);

    if (options.refineToken) {
      node.dataset.gjRefine = options.refineToken;
      if (options.refining) {
        const hint = document.createElement("span");
        hint.className = "gj-translation-refining";
        hint.textContent = "AI 精修中…";
        card.appendChild(hint);
      }
    } else {
      delete node.dataset.gjRefine;
    }
    state.stats.translated += 1;
  }

  /**
   * AI 精修回来了：把那一格的机译**原地换成** AI 译文。
   *
   * 找不到那一格（用户已经滚走、或 WhatsApp 把消息重渲染掉了）就静默丢弃 ——
   * 内容已经进了缓存，下次滚回来读到的就直接是 AI 译文，不需要补渲染。
   */
  function applyRefined(token, text) {
    let node = null;
    try {
      node = document.querySelector(`.${NODE_CLASS}[data-gj-refine="${CSS.escape(token)}"]`);
    } catch {
      return false;
    }
    if (!node || !text) return false;
    delete node.dataset.gjRefine;
    node.dataset.gjTier = "ai";
    const label = node.querySelector(".gj-translation-label");
    if (label) label.textContent = "译";
    const body = node.querySelector(".gj-translation-body");
    if (body) body.textContent = text;
    node.querySelector(".gj-translation-refining")?.remove();
    return true;
  }

  function renderFailed(row, message) {
    const node = ensureNode(row);
    node.dataset.gjState = "failed";
    node.textContent = "";
    const card = document.createElement("div");
    card.className = "gj-translation-card";
    const label = document.createElement("span");
    label.className = "gj-translation-label";
    label.textContent = "译";
    const body = document.createElement("span");
    body.className = "gj-translation-body";
    body.textContent = `翻译失败：${message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "gj-translation-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      delete row.dataset.gjStatus;
      const text = extractText(row);
      if (text) void translateRow(row, text, { sourceLang: undefined });
    });
    card.append(label, body, retry);
    node.append(card);
    state.stats.failed += 1;
    state.lastError = message;
  }

  function removeNode(row) {
    row.querySelector(`.${NODE_CLASS}`)?.remove();
    row.classList.remove(ROW_FLAG);
  }

  /* ---------- 主流程 ---------- */

  function scheduleScan(delay = SCAN_DELAY) {
    if (state.stopped) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function scan() {
    if (state.stopped) return;
    // 扩展重载过的旧页面：再扫也是白扫，而且不会自己好 —— 直接把话说清楚。
    if (!extensionAlive()) {
      stopForReload();
      return;
    }
    const enabled = !state.settings || state.settings.enabled;
    const container = messagesContainer();
    if (!container) {
      ensureComposeUi();
      return;
    }
    if (container !== lastContainer) {
      lastContainer = container;
      container.addEventListener("scroll", () => scheduleScan(180), { passive: true });
    }
    ensureComposeUi();

    if (!enabled) {
      for (const row of messageRows(container)) {
        removeNode(row);
        // 同时清掉状态：重新打开时要能整批重算（译文都在缓存里，不会重复花钱）
        delete row.dataset.gjStatus;
      }
      removeDiagBanner();
      stallScans = 0;
      return;
    }

    const rows = messageRows(container);
    // 改版哨兵：聊天开着（footer 在）、消息面板里看得到内容，但我们的行选择器一个都没匹配到。
    // 这正是"来信翻译静默停摆"的形状 —— 用户看到的是干干净净的界面，连一条线索都没有。
    // 这病真实伤过一次：装上以来来信译文 0 条、草稿译文一直正常，最后查出是行选择器没跟上
    // WhatsApp 的 DOM。与其等用户来问"为啥不翻"，不如自己把话说出来。
    const chatOpen = Boolean(document.querySelector("#main footer"));
    if (chatOpen && rows.length === 0) {
      stallScans += 1;
      const panelHasContent = (container.innerText || "").trim().length > 0;
      if (stallScans >= SCAN_STALL_LIMIT && panelHasContent) showDiagBanner();
      // 停摆状态下没有 mutation 就不会再有扫描 —— 哨兵自己续一拍，直到恢复为止。
      scheduleScan(600);
    } else {
      stallScans = 0;
      removeDiagBanner();
    }

    for (const row of rows) {
      const direction = rowDirection(row);
      if (direction === "out") continue; // 只翻客户发来的（方向判据见 rowDirection）
      if (direction === "unknown") {
        // 方向认不出不能静默跳过 —— 必须在诊断单里数得出来，否则改版了没处查。
        row.dataset.gjStatus = "skip";
        row.dataset.gjSkip = "direction";
        continue;
      }
      if (row.querySelector(`.${NODE_CLASS}`)) continue;
      if (row.dataset.gjStatus === "pending") {
        // 在途：正常，别插队。但卡太久的要放行，否则这一条永远不翻、界面还一声不吭。
        // （`since` 取不到 = 老版本留下的 pending，一律当过期处理）
        const since = Number(row.dataset.gjPendingAt || 0);
        if (since && Date.now() - since < PENDING_STALE_MS) continue;
        removeNode(row);
        delete row.dataset.gjStatus;
        delete row.dataset.gjPendingAt;
      }

      const text = extractText(row);
      if (!text || !isTranslatable(text) || isChineseText(text)) {
        row.dataset.gjStatus = "skip";
        // 跳过要留原因：诊断面板要把「跳过(中文) N 条」说清楚，不然 skip 和"坏了"没法区分
        row.dataset.gjSkip = !text ? "empty" : isChineseText(text) ? "chinese" : "notTranslatable";
        continue;
      }
      delete row.dataset.gjSkip;
      row.dataset.gjStatus = "pending";
      row.dataset.gjPendingAt = String(Date.now());
      void translateRow(row, text, {});
    }
  }

  async function translateRow(row, text, options) {
    renderPending(row);
    const targetLang = options.targetLang || state.settings?.targetLang || "zh-CN";
    const sourceLang = options.sourceLang || detectLanguage(text);
    const refineToken = mintRefineToken();
    const result = await send({ type: "translate", text, targetLang, sourceLang, refineToken });
    delete row.dataset.gjPendingAt;
    if (state.stopped) {
      // 孤儿脚本（扩展刚重载过）：这一页本来就不翻了，但**别把行留在 pending 上** ——
      // 刷新之后 scan 重新跑，这一条要能被当成"没处理过"重来，而不是被 pending 判据永久跳过。
      delete row.dataset.gjStatus;
      return;
    }
    if (result.ok && result.text) {
      // ⚠️ `refining` 必须**一路传下来**。曾经只传了 `refineToken`（由 refining 派生），
      // renderDone 里 `options.refining` 就是 undefined → 「AI 精修中…」这个提示
      // **一次都没渲染出来过**，而标签、令牌、精修替换全都是对的 ——
      // 静态自检看不出来，是 e2e 里那条"几何/DOM 复核"把它抓出来的。
      const refining = Boolean(result.refining);
      renderDone(row, result.text, {
        tier: result.tier,
        refining,
        refineToken: refining ? refineToken : ""
      });
      // 落终态：节点在时 scan 靠节点判重；节点被 WhatsApp 重渲染掉后才靠状态决定是否重算
      row.dataset.gjStatus = "done";
      return;
    }
    renderFailed(row, result.error || "未知错误");
    row.dataset.gjStatus = "failed";
  }

  /* ---------- 改版哨兵：自己把"来信翻译为什么不翻"说清楚 ---------- */

  /**
   * 一份给人看的页面体检单。上面的横幅把它复制给开发者，控制台排查也可以直接对照。
   * 字段用中文 —— 看这份单子的人往往是正在着急的老板，不是在开 devtools 的工程师。
   *
   * 0.6.8 起一次粘贴必须能定位「翻不出来」出在哪一层，所以加了：
   * 扩展版本（先排除"没重载"）、容器来源（面板 testid / 气泡反推 / 输入框）、
   * 行来源（老类名 / 气泡）、方向统计（unknown 是改版最阴的形态）、
   * 首行结构（**只有标签和属性骨架，正文与号码脱敏** —— 诊断单会离开用户的机器）。
   */
  function diagnoseScan() {
    const container = messagesContainer();
    const rows = container ? messageRows(container) : [];
    const directions = { 来信: 0, 我方: 0, 方向不明: 0 };
    for (const row of rows) directions[rowDirection(row) === "in" ? "来信" : rowDirection(row) === "out" ? "我方" : "方向不明"] += 1;
    const inRows = rows.filter(isIncomingRow);
    const skipReasons = {};
    for (const row of inRows) {
      if (row.dataset.gjStatus === "skip") {
        const why = row.dataset.gjSkip || "unknown";
        skipReasons[why] = (skipReasons[why] || 0) + 1;
      }
    }
    const legacyRows = document.querySelectorAll("#main div.message-in, #main div.message-out").length;
    const testidRows = document.querySelectorAll('#main [data-testid="msg-container"]').length;
    // 版本三路兜底：后台代取（getManifest 在内容脚本里不可用，e2e 实测过）→ 现场再试 → 明说没拿到。
    let version = state.extVersion || "未知（启动中，稍等两秒再复制一次）";
    try {
      version = chrome.runtime.getManifest().version;
    } catch {
      /* 内容脚本没有 getManifest：用后台代取的那份 */
    }
    return {
      扩展版本: version,
      脚本注入: document.documentElement.dataset.gjTranslator || "无（脚本没进页面）",
      页面脚本已过期: state.stopped,
      消息容器: container ? `找到（${(container.className || container.id || "#main").slice(0, 40)}）` : "找不到",
      容器来源: containerSource,
      行来源: legacyRows ? "message-in/out 类名" : testidRows ? "msg-container 气泡" : "没认出任何行（两层都失配）",
      消息行总数: rows.length,
      方向统计: directions,
      来信行数: inRows.length,
      改版探针_testid气泡: testidRows,
      首行结构: rows.length ? rowSkeleton(rows[0]) : "无行可采样",
      来信状态: {
        已译: inRows.filter((row) => row.dataset.gjStatus === "done").length,
        在途: inRows.filter((row) => row.dataset.gjStatus === "pending").length,
        失败: inRows.filter((row) => row.dataset.gjStatus === "failed").length,
        跳过: skipReasons
      },
      译文节点数: document.querySelectorAll(`.${NODE_CLASS}`).length,
      最近错误: state.lastError || "无"
    };
  }

  /**
   * 首行的**结构骨架**：只留标签名和定位属性（data-id/data-testid/角色），
   * 正文一个字不带；data-id 里的号码段打码。诊断单会离开用户机器，这是隐私底线。
   */
  function rowSkeleton(row) {
    const lines = [];
    const walk = (node, depth) => {
      if (!node || node.nodeType !== 1 || depth > 4 || lines.length > 14) return;
      const attrs = [];
      for (const attr of node.attributes) {
        if (attr.name === "data-id") {
          attrs.push(`data-id=${attr.value.replace(/\d{3,}/gu, (m) => `#号${m.length}位#`)}`);
        } else if (attr.name === "data-testid") {
          attrs.push(`data-testid=${attr.value}`);
        } else if (attr.name === "data-pre-plain-text") {
          attrs.push("data-pre-plain-text=[时间戳]");
        } else if (attr.name === "class") {
          attrs.push(`class=${attr.value.split(/\s+/).slice(0, 3).join(" ")}`);
        }
      }
      lines.push(`${"  ".repeat(depth)}<${node.tagName.toLowerCase()}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(row, 0);
    return lines.join("\n");
  }

  function removeDiagBanner() {
    document.getElementById(DIAG_BANNER_ID)?.remove();
  }

  function showDiagBanner() {
    if (document.getElementById(DIAG_BANNER_ID)) return;
    const banner = document.createElement("div");
    banner.id = DIAG_BANNER_ID;

    const text = document.createElement("span");
    text.className = "gj-diag-text";
    text.textContent = "来信翻译没生效：聊天开着，但一个消息气泡都没匹配上 —— WhatsApp 可能改版了。";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "gj-diag-btn";
    copy.textContent = "复制诊断";
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = JSON.stringify(diagnoseScan(), null, 1);
      const done = (ok) => {
        copy.textContent = ok ? "已复制，发给开发者即可" : "复制失败，请截图这段";
        copy.disabled = ok;
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(payload).then(() => done(true), () => done(copyViaTextarea(payload)));
      } else {
        done(copyViaTextarea(payload));
      }
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "gj-diag-close";
    close.title = "关掉这个提示";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeDiagBanner();
    });

    banner.append(text, copy, close);
    document.body.appendChild(banner);
  }

  /** 剪贴板 API 被拒（非用户手势 / 权限策略）时的兜底：老式 textarea + execCommand。 */
  function copyViaTextarea(payload) {
    const ta = document.createElement("textarea");
    ta.value = payload;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  /* ---------- compose 区：草稿翻译（自动 + 手动） ---------- */

  // 与 autoreply.js 里的那份逐字一致（parity.test.mjs 盯着两个文件，别再各写一份）
  function composer() {
    if (typeof document === "undefined") return null;
    return (
      document.querySelector('#main footer div[contenteditable="true"]') ||
      document.querySelector('#main div[contenteditable="true"][data-lexical-editor="true"]') ||
      document.querySelector('#main div[contenteditable="true"]') ||
      null
    );
  }

  function composerText() {
    const box = composer();
    if (!box) return "";
    // innerText 走布局计算，正常情况更准；textContent 是兜底，免得某个渲染阶段取到空串
    return (box.innerText || box.textContent || "").trim();
  }

  function languageLabel(code) {
    return LANGUAGE_LABELS[code] || code || "";
  }

  function ensureComposeUi() {
    const enabled = state.settings?.composeTranslate !== false && state.settings?.enabled !== false;
    const main = document.querySelector("#main");
    if (!enabled || !main) {
      document.getElementById(COMPOSE_BTN_ID)?.remove();
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (!document.getElementById(COMPOSE_BTN_ID)) {
      const button = document.createElement("button");
      button.id = COMPOSE_BTN_ID;
      button.type = "button";
      button.title = "把输入框里的草稿译成另一种语言（只翻译，不发送）";
      button.textContent = "译";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void translateDraft({ trigger: "manual" });
      });
      document.body.appendChild(button);
    }
    positionComposeUi();
    // 输入框是 WhatsApp 自己会重建的节点（切会话就换一个），每轮扫描对一次引用，
    // 换了就重挂 DOM 变化监听（见 watchComposerMutations 的注释——事件不可靠时的兜底）。
    watchComposerMutations();
  }

  function positionComposeUi() {
    const button = document.getElementById(COMPOSE_BTN_ID);
    if (!button) return;
    const footer = document.querySelector("#main footer");
    const bottom = footer
      ? Math.max(10, window.innerHeight - footer.getBoundingClientRect().top + 10)
      : 90;
    button.style.bottom = `${bottom}px`;
    button.style.right = "20px";
    // 浮框的位置交给 CSS（右侧垂直居中）。跟着 footer 走的话，footer 一长它就被顶到屏幕中间挡住消息。
  }

  /**
   * 打字停顿后自动跑一次。翻不翻由 `shouldAutoTranslate` 判定，这里只负责节流。
   */
  function scheduleDraftTranslate(delay = AUTO_DELAY) {
    if (state.stopped || !state.settings) return;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      void autoTranslateDraft();
    }, delay);
  }

  async function autoTranslateDraft() {
    const text = composerText();
    const gate = shouldAutoTranslate({
      text,
      lastText: lastAutoDraft,
      enabled:
        state.settings?.enabled !== false &&
        state.settings?.composeTranslate !== false &&
        state.settings?.composeAuto !== false,
      guardUntil: replaceGuardUntil
    });
    if (!gate.run) {
      // 输入框空了、或内容已经变成外文 —— 收起浮框，别让它挂着一份过期译文。
      // 例外：刚一键发送完的「已发送」反馈要留到用户看见，收场由点击处理器自己安排。
      if (gate.reason === "empty" || gate.reason === "not-chinese") {
        const panel = document.getElementById(PANEL_ID);
        if (panel && panel.dataset.gjState === "sent") return;
        closePanel();
        lastAutoDraft = "";
      }
      return;
    }
    lastAutoDraft = text;
    await translateDraft({ trigger: "auto" });
  }

  async function translateDraft(options = {}) {
    const trigger = options.trigger || "manual";
    const box = composer();
    if (!box) {
      if (trigger === "manual") showPanel("没有找到输入框", { error: true });
      return;
    }
    const draft = composerText();
    if (!draft) {
      if (trigger === "manual") showPanel("输入框是空的", { error: true });
      else closePanel();
      return;
    }
    const { targetLang, sourceLang } = draftTarget(draft, state.settings);
    const seq = ++draftSeq;
    const refineToken = mintRefineToken();
    draftRefine = { token: refineToken, targetLang };
    showPanel("翻译中…", { pending: true });
    // quick：草稿翻译不重试（用户正盯着浮框等，宁可早点告诉他超时，也别再翻倍地等）
    const result = await send({ type: "translate", text: draft, targetLang, sourceLang, quick: true, refineToken });
    // 期间又发了新请求（用户还在打字）→ 这次的结果已过期，不能覆盖面板
    if (state.stopped || seq !== draftSeq) return;
    if (result.ok && result.text) {
      showPanel(result.text, {
        translated: true,
        targetLang,
        tier: result.tier,
        refining: result.refining
      });
      return;
    }
    state.lastError = result.error || "翻译失败";
    showPanel(result.error || "翻译失败", { error: true });
  }

  /* ---------- 译文浮框（右侧，可复制 / 可替换回输入框） ---------- */

  /**
   * 读回输入框、判断这次写入到底成没成 —— 这是**唯一**可信的成功判据。
   *
   * 为什么不看 `document.execCommand` 的返回值：编辑器可以把这次插入在 `beforeinput`
   * 里取消掉、或者事后按自己的内部状态把 DOM 改回去，而 execCommand 照样返回 true。
   * 于是界面显示「已替换到输入框」、输入框里一个字都没变 —— 用户看到的就是
   * 「我点了替换，它只是确认了一下，输入框里的内容根本没换」。
   *
   * 空白一律折叠再比：编辑器把空格换成 `&nbsp;`、或多包一层 `<p>`，都属正常，不该判失败。
   */
  function composerWritten(box, want) {
    const flatten = (value) => String(value ?? "").replace(/\s+/gu, "");
    return flatten(box.innerText || box.textContent || "") === flatten(want);
  }

  /** 让出一帧 + 一个宏任务：Lexical 靠 `selectionchange` **异步**同步自己的选区。 */
  function composerSettle() {
    const frame =
      typeof requestAnimationFrame === "function"
        ? new Promise((resolve) => requestAnimationFrame(() => resolve()))
        : Promise.resolve();
    return frame.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  /**
   * 把文字真正写进 WhatsApp 输入框（覆盖原有内容）。
   *
   * 为什么必须走编辑命令、不能直接写 `textContent`：WhatsApp 的输入框是 Lexical 富文本
   * 编辑器，只改 DOM 它内部状态还是空的 —— 字看着填进去了，按回车却发不出去。
   *
   * 但"只会 execCommand 这一招"不够：它会被编辑器吞掉而**仍然返回 true**。所以这里排了
   * 四招，**每一招都读回输入框确认**，一招不成立就换下一招；四招都不成立就返回失败，
   * 由调用方照实说"没写进去"，绝不谎报成功。
   *
   * @returns {Promise<{ok: boolean, how: "insertText"|"selectAll"|"paste"|"dom"|""}>}
   */
  async function fillComposer(text) {
    const box = composer();
    const want = String(text ?? "");
    if (!box || !want) return { ok: false, how: "" };
    box.focus();

    const tryOnce = async (run) => {
      try {
        run();
      } catch {
        /* 这一招在这个编辑器上不可用，换下一招 */
      }
      await composerSettle();
      return composerWritten(box, want);
    };

    const selectWholeBox = () => {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    // ① 整段选中 + 原生插入：多数版本这一招就够
    const plainInsert = await tryOnce(() => {
      selectWholeBox();
      document.execCommand("insertText", false, want);
    });
    if (plainInsert) return { ok: true, how: "insertText" };

    // ② 让编辑器自己 selectAll：选区是它自己建的，它更认
    const editorSelectAll = await tryOnce(() => {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, want);
    });
    if (editorSelectAll) return { ok: true, how: "selectAll" };

    // ③ 合成一次粘贴：Lexical 的 paste 处理直接改它自己的状态，绕开 beforeinput 那道坎
    const pasted = await tryOnce(() => {
      document.execCommand("selectAll", false, null);
      const data = new DataTransfer();
      data.setData("text/plain", want);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    if (pasted) return { ok: true, how: "paste" };

    // ④ 兜底：直接写 DOM 再派发 input。编辑器可能不认（那就是"看着有字、发不出去"），
    //    所以把这一档如实标出来，由界面照实提示。
    const domWrite = await tryOnce(() => {
      box.textContent = want;
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want }));
    });
    if (domWrite) return { ok: true, how: "dom" };

    return { ok: false, how: "" };
  }

  /**
   * 把输入框里的草稿发出去。这是「替换并发送」的收尾一步：点按钮的人就是发消息的人，
   * 我们只是替他把回车按了。
   *
   * **只认读回**：发出后输入框必须清空，清不掉就报失败，让人自己按回车 ——
   * 绝不谎报"已发送"（发送是唯一不可撤回的动作，谎报的代价最大）。
   *
   * 两招：① 点 WhatsApp 自己的发送按钮（它认编辑器的真实状态，最可靠）；
   *       ② 派发 Enter 键事件兜底。调用方必须在写入走的是**编辑器命令**路径
   *      （insertText / selectAll / paste）时才允许调 —— dom 兜底档的字未必在
   *      编辑器状态里，点了发送可能把**旧内容**发出去。
   *
   * @returns {Promise<{sent: boolean, how: "button"|"enter"|""}>}
   */
  async function sendComposer() {
    const box = composer();
    if (!box) return { sent: false, how: "" };

    /** 发出去的判据只有一个：输入框被清空了。轮询等编辑器把草稿收走（约 1.6 秒）。 */
    const waitEmptied = async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!composerText().trim()) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    };

    const sendButton = document.querySelector('#main footer [data-testid="send"]')
      || document.querySelector('#main footer span[data-icon="send"]');
    const button = sendButton instanceof HTMLElement ? sendButton.closest("button") || sendButton : null;
    if (button) {
      button.click();
      if (await waitEmptied()) return { sent: true, how: "button" };
    }

    // 兜底：派发 Enter。有的版本发送按钮藏得深，但编辑器自己认 Enter。
    box.focus();
    for (const type of ["keydown", "keyup"]) {
      box.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
    }
    if (await waitEmptied()) return { sent: true, how: "enter" };

    return { sent: false, how: "" };
  }

  /**
   * GJ 标识（几何与配色全部来自 src/gj-theme.css 的 `.gj-mark`）。
   *
   * 与 agent.js 里那份是同一段六行代码 —— 两个 content script 是隔离的、且 content script
   * 不是 ESM 模块没法共享 import，所以只能各放一份；改标识几何请只改 gj-theme.css。
   */
  function gjMark(size) {
    const mark = document.createElement("span");
    mark.className = "gj-mark";
    mark.setAttribute("aria-hidden", "true");
    if (size) mark.style.setProperty("--gj-mark-size", `${size}px`);
    for (const letter of ["G", "J"]) {
      const span = document.createElement("span");
      span.textContent = letter;
      mark.append(span);
    }
    return mark;
  }

  function ensurePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const head = document.createElement("div");
    head.className = "gj-panel-head";
    const title = document.createElement("span");
    title.className = "gj-panel-title";
    title.textContent = "译文";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "gj-panel-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.remove();
      // 记下当前草稿：关掉之后别为同一份草稿又自动弹回来
      lastAutoDraft = composerText();
    });
    head.append(gjMark(22), title, close);

    const body = document.createElement("p");
    body.className = "gj-panel-body";

    // 复制改成**译文内容右方的图标**：底部按钮位让给「替换到输入框 / 替换并发送」两个动作。
    // 位置用 bodywrap 包住 + 绝对定位钉在右上角 —— 译文再长图标也跟着内容区走。
    const bodywrap = document.createElement("div");
    bodywrap.className = "gj-panel-bodywrap";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "gj-panel-copy";
    copy.title = "复制译文";
    copy.setAttribute("aria-label", "复制译文");
    copy.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<rect x="5.5" y="5.5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M10.5 3.5v-0.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v7A1.5 1.5 0 0 0 4 11.5h0.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(body.textContent || "");
        setHint("已复制到剪贴板");
      } catch {
        setHint("复制失败，请手动选中");
      }
    });

    bodywrap.append(body, copy);

    const hint = document.createElement("span");
    hint.className = "gj-panel-hint";
    const setHint = (value) => {
      hint.textContent = value;
      if (!value) return;
      setTimeout(() => {
        if (hint.textContent === value) hint.textContent = "";
      }, 2600);
    };

    /** 两步共用：写输入框 + 读回确认 + 抑制窗口。返回 null 表示没写进去（调用方负责提示）。 */
    const writeComposer = async (text) => {
      const filled = await fillComposer(text);
      if (!filled.ok) return null;
      // 这一步把输入框从中文换成了外文，且是我们自己造成的 —— 抑制自动链路再翻一轮
      replaceGuardUntil = Date.now() + REPLACE_GUARD_MS;
      return filled;
    };

    /** 「替换到输入框」：只写入，发不发由用户按回车（失败态下这个按钮让给「重试」）。 */
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "gj-panel-replace";
    replace.textContent = "替换到输入框";
    replace.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (replace.dataset.gjAction === "retry") {
        void translateDraft({ trigger: "manual" });
        return;
      }
      const text = body.textContent || "";
      if (!text) return;
      // 点一下就地替换：写没写进去由**读回输入框**决定，
      // 不看 execCommand 的返回值（编辑器会吞掉插入却仍然报成功）。
      replace.disabled = true;
      const filled = await writeComposer(text);
      if (!filled) {
        replace.disabled = false;
        // 照实说。以前这里会显示「已替换到输入框」而输入框其实一个字没变。
        setHint("没能写进输入框，请点右上角复制图标手动粘贴");
        return;
      }
      replace.disabled = false;
      lastAutoDraft = composerText() || text;
      panel.dataset.gjState = "replaced";
      title.textContent = "已替换到输入框";
      // 报事实，不是让人再确认一次：写进去的是哪一档要让人看得出来
      setHint(filled.how === "dom" ? "已写入 · 若发不出去请用右上角复制图标" : "已替换输入框内容 · 按回车发送");
    });

    /** 「替换并发送」：一键到底。两道闸缺一不发，纪律见 settings.js 的 autoSendAfterReplace。 */
    const send = document.createElement("button");
    send.type = "button";
    send.className = "gj-panel-send";
    send.textContent = "替换并发送";
    send.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = body.textContent || "";
      if (!text) return;
      send.disabled = true;
      const filled = await writeComposer(text);
      if (!filled) {
        send.disabled = false;
        setHint("没能写进输入框，请点右上角复制图标手动粘贴");
        return;
      }
      // 闸一：dom 兜底档的字未必在编辑器状态里，点了发送可能把**旧内容**发出去 —— 绝不自动发。
      if (filled.how === "dom") {
        send.disabled = false;
        lastAutoDraft = composerText() || text;
        panel.dataset.gjState = "replaced";
        title.textContent = "已替换到输入框";
        setHint("已写入 · 这一档不自动发送，请按回车");
        return;
      }
      const sent = await sendComposer();
      send.disabled = false;
      if (sent.sent) {
        // 发送成功后输入框是空的：记空串，免得自动链路又为这份草稿弹回来
        lastAutoDraft = "";
        panel.dataset.gjState = "sent";
        title.textContent = "已发送";
        setHint("已替换并发送");
        // 「已发送」要让人看见：停一拍再收场（看门人在 sent 态不会抢着关）
        setTimeout(() => {
          const live = document.getElementById(PANEL_ID);
          if (live && live.dataset.gjState === "sent") live.remove();
        }, 1600);
        return;
      }
      // 发送没成（比如这版 WhatsApp 找不到发送按钮）：照实说，回车还在用户手里
      lastAutoDraft = composerText() || text;
      panel.dataset.gjState = "replaced";
      title.textContent = "已替换到输入框";
      setHint("已替换输入框内容 · 自动发送没成功，请按回车");
    });

    const actions = document.createElement("div");
    actions.className = "gj-panel-actions";
    actions.append(replace, send, hint);

    panel.append(head, bodywrap, actions);
    document.body.appendChild(panel);
    return panel;
  }

  function showPanel(text, options = {}) {
    const { error = false, pending = false, translated = false, targetLang = "", tier = "", refining = false } = options;
    const panel = ensurePanel();
    panel.dataset.gjOpen = "1";
    panel.dataset.gjState = error ? "failed" : pending ? "pending" : "done";
    panel.dataset.gjTier = tier === "mt" ? "mt" : "ai";
    panel.querySelector(".gj-panel-body").textContent = text;
    // 标题要把「这份是初稿还是终稿」说清楚：草稿是要发给客户的，
    // 让人误以为机译就是最终稿，代价比多等几秒大得多。
    const language = languageLabel(targetLang);
    panel.querySelector(".gj-panel-title").textContent = pending
      ? "翻译中…"
      : !translated
        ? "译文"
        : tier === "mt"
          ? (refining ? `机译初稿 · ${language} · AI 精修中…` : `机译 · ${language}`)
          : `AI 译文 · ${language}`;
    const hint = panel.querySelector(".gj-panel-hint");
    if (hint) hint.textContent = "";
    // 译中 / 失败时按钮没有意义：禁掉，免得点「替换到输入框」把"翻译中…"写进输入框
    const usable = translated && Boolean(text);
    const copyBtn = panel.querySelector(".gj-panel-copy");
    const replaceBtn = panel.querySelector(".gj-panel-replace");
    const sendBtn = panel.querySelector(".gj-panel-send");
    copyBtn.disabled = !usable;
    // 失败（典型是上游超时）那一刻两个按钮本来都是灰的，用户只能干看着、连重来一次都做不到。
    // 所以错误态下把「替换到输入框」让给「重试」并保持可点；译中态没有可点的东西。
    replaceBtn.disabled = !usable && !error;
    replaceBtn.dataset.gjAction = error ? "retry" : "replace";
    replaceBtn.textContent = error ? "重试" : "替换到输入框";
    // 「替换并发送」只在默认配置下出现（设置里关掉自动发送 = 用户明确不要一键到底）；
    // 失败态没东西可发，禁用。
    sendBtn.style.display = state.settings?.autoSendAfterReplace === false ? "none" : "";
    sendBtn.disabled = !usable || error;
  }

  function closePanel() {
    document.getElementById(PANEL_ID)?.remove();
    // 浮框没了就别再认领精修结果，否则用户已经关掉浮框、几秒后它又被上一次的精修顶出来
    draftRefine = null;
  }

  /* ---------- 页面自检 ---------- */

  /**
   * 把"这一页到底被接管了没有、卡在哪一步"变成可读数字。
   *
   * 为什么必须有：译文节点是**追加在消息气泡下面**的，页面上本来什么都没有的地方没出现东西，
   * 从用户视角就是"啥也没发生" —— 分不清是扩展没装、页面没刷新、消息选择器失效，还是 API Key 没填。
   * `testIdRows` 专门用于判断 WhatsApp 改版（类名换了但 `data-testid` 还在）这一种可能。
   */
  function pageProbe() {
    const container = messagesContainer();
    const rows = container ? messageRows(container) : [];
    return {
      injected: true,
      hasContainer: Boolean(container),
      rows: rows.length,
      inbound: rows.filter(isIncomingRow).length,
      nodes: document.querySelectorAll(`.${NODE_CLASS}`).length,
      skipped: rows.filter((row) => row.dataset.gjStatus === "skip").length,
      failed: rows.filter((row) => row.dataset.gjStatus === "failed").length,
      pending: rows.filter((row) => row.dataset.gjStatus === "pending").length,
      // 卡住的那种："在途"但界面上连"翻译中…"都没有 —— 用户看到的就是"没反应"
      stalled: rows.filter((row) => row.dataset.gjStatus === "pending" && !row.querySelector(`.${NODE_CLASS}`)).length,
      composeButton: Boolean(document.getElementById(COMPOSE_BTN_ID)),
      draftAuto: state.settings ? state.settings.composeAuto !== false : null,
      draftPanel: document.getElementById(PANEL_ID)?.dataset.gjState || "",
      testIdRows: document.querySelectorAll('[data-testid="msg-container"]').length,
      lastError: state.lastError,
      enabled: state.settings ? state.settings.enabled !== false : null,
      configured: state.settings ? Boolean(state.settings.apiKey) : null,
      /** 这一页的脚本已经"过期"（扩展重载过），只能刷新才能恢复。 */
      needsReload: state.stopped,
      /** 改版哨兵：连续扫描都没匹配到消息行时为 true（横幅同时在页面上）。 */
      scanStalled: stallScans >= SCAN_STALL_LIMIT,
      diagBanner: Boolean(document.getElementById(DIAG_BANNER_ID))
    };
  }

  /* ---------- 生命周期 ---------- */

  function attachObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * 输入框是 WhatsApp 自己会重建的节点，所以监听挂在 document 上做**事件委托**，
   * 不能绑在具体的编辑框元素上（切换会话后那个引用就失效了）。
   *
   * `compositionend` 是给中日韩输入法用的：拼音阶段的 `input` 事件拿到的是半成品，
   * 等输入法上屏（compositionend）再起一次计时，才不会把拼音字母当成草稿翻出去。
   */
  function attachComposerWatcher() {
    const handler = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.getAttribute("contenteditable") !== "true") return;
      if (!target.closest("#main")) return;
      scheduleDraftTranslate();
    };
    // ⚠️ beforeinput 必须最先挂：它先于 Lexical 的接管逻辑触发，**粘贴/删除/拖拽/打字**
    // 一网打尽。Lexical 接管这些操作后会拦掉对应的 `input` 事件（beforeinput 被
    // preventDefault 后浏览器不再补发 input，程序化改 DOM 也不产生 input）——所以
    // 0.7.0 只听 input 时「粘贴、删除都要再打一个字才翻」，0.7.1 补的 paste/drop
    // 也只救回粘贴一种。真正可靠的信号是 beforeinput（capture 在 document 上，比
    // Lexical 挂在编辑框上的处理器先跑，拦不拦都拦不到我们）。
    document.addEventListener("beforeinput", handler, true);
    // 打字仍以 input/compositionend 为主（compositionend 是给中日韩输入法的：
    // 拼音上屏才起计时，不把拼音字母当草稿翻出去）。
    document.addEventListener("input", handler, true);
    document.addEventListener("compositionend", handler, true);
    document.addEventListener("paste", handler, true);
    document.addEventListener("drop", handler, true);
  }

  /* ---------- 输入框 DOM 变化兜底（不依赖任何事件） ----------
   * 真机实测：粘贴、删除的 beforeinput/input 都可能到不了我们的监听（Lexical 拦截 +
   * 页面自己的捕获层），打字却正常 —— 逐个事件打补丁追不完。唯一拦不住的是 **DOM 变化
   * 本身**：直接盯输入框子树，内容变了就调度草稿翻译，与事件监听互为冗余。
   * 我们自己写入输入框（「替换到输入框」/发送清空）都在 1600ms 抑制窗口内，窗口里的
   * 变化一律忽略，避免自己写自己触发的死循环；打字路径不受影响（事件照常先到）。 */
  let composerObserver = null;
  let composerObservedEl = null;

  function watchComposerMutations() {
    const box = composer();
    if (!box) {
      composerObserver?.disconnect();
      composerObserver = null;
      composerObservedEl = null;
      return;
    }
    if (composerObservedEl === box) return;
    composerObserver?.disconnect();
    composerObservedEl = box;
    composerObserver = new MutationObserver(() => {
      if (Date.now() < replaceGuardUntil) return;
      scheduleDraftTranslate();
    });
    composerObserver.observe(box, { childList: true, subtree: true, characterData: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "settingsChanged") {
      void refreshSettings();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "translateRefined") {
      // AI 精修回来了（两段式翻译的第二段）。纯推送、不需要应答 ——
      // 认领得到就原地替换，认领不到（滚走了 / 已被重渲染）就当没发生，内容已经在缓存里。
      const token = String(message.token || "");
      const text = String(message.text || "");
      if (token && text) {
        if (!applyRefined(token, text) && draftRefine?.token === token) {
          // 草稿浮框还挂着这一次精修 → 把面板上的机译初稿换成 AI 译文。
          // 注意这里**不碰输入框**：替换输入框永远是用户点了按钮才发生的事。
          showPanel(text, { translated: true, targetLang: draftRefine.targetLang, tier: "ai" });
          draftRefine = null;
        }
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "rescan") {
      void rescan(message?.clearCache);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "stats") {
      sendResponse({ ok: true, ...state.stats, ...pageProbe() });
      return true;
    }
    return false;
  });

  async function refreshSettings() {
    const response = await send({ type: "getSettings" });
    if (response.ok) state.settings = response.settings;
    scheduleScan(60);
  }

  async function rescan(clearCache) {
    if (clearCache) await send({ type: "clearCache" });
    const container = messagesContainer();
    if (container) {
      for (const row of messageRows(container)) {
        removeNode(row);
        delete row.dataset.gjStatus;
      }
    }
    scheduleScan(60);
  }

  window.addEventListener("resize", positionComposeUi);

  void (async () => {
    // 注入标记：自检脚本据此判断 content script 有没有真的跑到页面里
    document.documentElement.dataset.gjTranslator = "on";
    // 诊断单的版本位：后台代取（内容脚本没有 getManifest）。失败不碍事，但要**留下失败原因**
    // —— 静默的空版本位会变成"诊断单自己也在说谎"。
    void send({ type: "getVersion" }).then((response) => {
      if (response?.ok && response.version) {
        state.extVersion = response.version;
        document.documentElement.dataset.gjVersion = response.version;
      } else {
        state.lastError = `getVersion 未取到：${response?.error || "空响应"}`;
      }
    });
    const response = await send({ type: "getSettings" });
    state.settings = response.ok ? response.settings : null;
    if (!response.ok) {
      console.warn("[GoodJob 翻译] 读取设置失败：", response.error);
    }
    attachObserver();
    attachComposerWatcher();
    scheduleScan(300);
  })();
})();
