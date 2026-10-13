/**
 * 归档 · 学习 · 自动回复（页面侧执行者）。
 *
 * 为什么单独开一个 content script 而不并进 `content.js`：
 * 翻译是已经跑通的功能，不该为了一组新能力给它加"动态 import 扩展内模块"这种新依赖 ——
 * 那是会把翻译一起拖下水的耦合。两个脚本各自独立加载，任何一个坏掉另一个照常工作。
 *
 * 全部计算都在本机浏览器里完成：
 *   - 抓取：只读 DOM（`div.message-in/out`、`data-pre-plain-text`、`data-id`）
 *   - 训练：纯函数，不联网，不需要 CRM 登录态
 *   - 回复：规则通道直接用历史原话，零成本；草稿默认由人确认后发出
 *
 * 另有一条**需要 CRM 的**通道（0.3.0 起）：把页面上这段现场对话交给插件，
 * 由插件以登录用户的权限去读 CRM 客户往来历史与知识检索命中，再交给本机 CLI 出稿。
 * 它与上面那条**互不替代**：CRM 不在、插件没开、CLI 没登录时，本地那条照常工作。
 *
 * 0.4.0 起，CRM 那条通道的产物搬到了**右侧一整列**（不再是浮层）：
 * 「推荐回复（正文 + 为什么这么回 + 来源徽章）」与「相关文档（为什么推荐 + 相关度 + 取链接）」。
 * 这一列是**把 WhatsApp 推窄**而不是盖在上面 —— 用户要的是能长时间开着干活。
 * 列里绝不出现"发送"动作：只有一个「填进输入框」，按回车的人始终是用户。
 */

(() => {
  if (globalThis.__gjAgentLoaded) return;
  globalThis.__gjAgentLoaded = true;

  const BTN_ID = "gj-agent-button";
  const PANEL_ID = "gj-agent-panel";
  const NOTE_CLASS = "gj-reply-note";
  const SCAN_DELAY = 420;
  /** 「归档全部会话」要逐个打开会话，太多会把标签页点爆，设个上限。 */
  const MAX_ARCHIVE_CONVERSATIONS = 50;
  const OPEN_CONVERSATION_TIMEOUT = 6000;
  /** 「已复制」这个反馈留多久。太短用户看不到，太长会以为按钮坏了。 */
  const COPIED_FEEDBACK_MS = 3000;

  let mods = null;
  const state = {
    settings: null,
    profile: null,
    ledger: null,
    busy: false,
    stopped: false,
    note: "",
    lastDownload: null,
    handled: new Set(),
    openRow: null,
    scanTimer: null,
    observer: null,
    lastContainer: null,
    /** CRM 那条通道的状态。刻意与本地档案分开记：它们是两条互不替代的路。 */
    crm: { session: null, engine: null, result: null, error: "", busy: false, fetched: false, fetching: false },
    /**
     * 右侧整列。`revealed` / `copiedKey` 刻意**只存内存**：
     * 真实外链取到就交给页面，不落 storage（这是硬纪律，不是随手的选择）。
     */
    column: {
      prefs: { width: 380, collapsed: false },
      result: null,
      busy: false,
      error: "",
      conversationKey: "",
      lastAnalysisAt: 0,
      revealed: {},
      copiedKey: "",
      dismissed: {},
      /**
       * 「要用户自己动手」的那一份（知识条目正文 / 剪贴板被挡时的地址）。
       * 只在用户点过之后才有值；平时是 null，页面上也就没有那些字符串。
       */
      manual: null,
      /** 「打开面板先铺一层快资料」只做一次，打开时置位、关闭时清掉。 */
      prefilled: false,
      /** 自己写下的那句进度提示。刷新成功时只清掉它，不动用户看到的结果文案。 */
      progressNote: ""
    }
  };

  /** 自检脚本用它读"最后一次下载到底写了什么"，真机上没有任何副作用。 */
  globalThis.__gjAgentTest = {
    get lastDownload() {
      return state.lastDownload;
    },
    get handled() {
      return [...state.handled];
    },
    get column() {
      return {
        prefs: { ...state.column.prefs },
        conversationKey: state.column.conversationKey,
        busy: state.column.busy,
        error: state.column.error,
        /** 只报"取过哪几份的链接"，**不报链接本身** —— 自检日志里不该出现真实地址。 */
        revealed: Object.keys(state.column.revealed),
        dismissed: Object.keys(state.column.dismissed),
        /** 同理：只报"哪一份被摆出来了"，不报摆出来的地址或正文。 */
        manualKey: state.column.manual?.key || "",
        result: state.column.result
      };
    }
  };

  /* -------------------------------------------------------- 基础工具 */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(probe, { timeout = 3000, interval = 120 } = {}) {
    const start = Date.now();
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  async function readStorage(key) {
    const raw = await chrome.storage.local.get(key);
    return raw?.[key];
  }

  async function writeStorage(patch) {
    await chrome.storage.local.set(patch);
  }

  function loadModules() {
    const url = (name) => chrome.runtime.getURL(`src/${name}`);
    return Promise.all([
      import(url("archive.js")),
      import(url("trainer.js")),
      import(url("autoreply.js")),
      // crm.js 里真正联网的那几个函数只有 background 会调；内容脚本只用它的
      // `describeEvidence()`（把依据写成一句人话）。共用一份是为了不让"依据怎么描述"
      // 出现两个版本 —— 那句话是用户唯一能验证"是不是编的"的地方。
      import(url("crm.js")),
      // 右侧整列的纯逻辑（宽度夹取、状态机、徽章、payload 组装）。与 DOM 分离，
      // 这样这几件事能在 Node 回测里被摁住，而不是只能靠人眼看截图。
      import(url("resources.js"))
    ]).then(([archive, trainer, autoreply, crm, resources]) => ({ archive, trainer, autoreply, crm, resources }));
  }

  /**
   * 触发下载。同时把内容留一份在内存里 —— 自检脚本据此断言"导出的到底是什么"，
   * 否则只能靠人眼去看下载目录，等于没测。
   */
  function download(fileName, content, mime = "text/plain;charset=utf-8") {
    state.lastDownload = { fileName, content, at: new Date().toISOString() };
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        anchor.remove();
      }, 1500);
    } catch (error) {
      state.note = `下载失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 真实鼠标序列：React 的根级事件委托认的是 bubbling 的事件，不只是 `element.click()`。 */
  function realClick(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + Math.min(rect.width / 2, 60));
    const clientY = Math.round(rect.top + Math.max(2, rect.height / 2));
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, view: window }));
    }
  }

  function messagesContainer() {
    return mods?.archive.messagesContainer() ?? null;
  }

  /* -------------------------------------------------------- 归档 */

  /** 归档一批：抓取 → 下载文件 → 抽语料 → 合并 → 训练 → 存档案。这就是"一键"。 */
  async function archiveAndLearn({ scope = "current", format = "jsonl", learn = true } = {}) {
    if (state.busy) {
      // 同 analyzeConversation：忙碌锁不静默。
      state.note = "正在处理上一个任务（归档/学习是串行的）—— 等这里的提示变化再点。";
      renderPanel();
      return { ok: false, error: "正在处理上一个任务" };
    }
    state.busy = true;
    const archiveHeartbeat = startHeartbeat("正在归档并学习…", { touchNote: false });
    try {
      const collected = scope === "all" ? await archiveAllConversations() : [mods.archive.readCurrentConversation()];
      const usable = collected.filter((archive) => archive.conversation.messageCount > 0);
      if (!usable.length) {
        state.note = "没有抓到任何消息 —— 确认会话已打开、消息已加载";
        return { ok: false, error: state.note };
      }

      const bundle = usable.length === 1 ? usable[0] : mods.archive.mergeArchives(usable);
      const label = usable.length === 1 ? usable[0].conversation.contactName : `全部会话${usable.length}个`;
      const rendered = mods.archive.renderArchive(bundle, format, label);
      download(rendered.fileName, rendered.content);

      let profile = null;
      if (learn) {
        const stored = (await readStorage("gj_reply_corpus")) ?? mods.trainer.emptyCorpus();
        const merged = mods.trainer.mergeCorpus(stored, mods.trainer.extractCorpus(bundle));
        await writeStorage({ gj_reply_corpus: merged });
        profile = mods.trainer.buildProfileFromCorpus(merged, { name: "Web 会话档案" });
        await writeStorage({ gj_reply_profile: profile });
        state.profile = profile;
      }

      state.note =
        `已归档 ${usable.length} 个会话 / ${usable.reduce((total, item) => total + item.conversation.messageCount, 0)} 条消息` +
        `，导出 ${rendered.fileName}` +
        (profile ? `；学习完成（${profile.examples.length} 组问答）` : "");
      return { ok: true, bundle, profile, file: rendered.fileName, note: state.note };
    } catch (error) {
      state.note = `归档失败：${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, error: state.note };
    } finally {
      archiveHeartbeat.stop();
      state.busy = false;
      renderPanel();
    }
  }

  /**
   * 逐个打开左侧会话并归档。
   *
   * 这段是整份代码里最依赖 WhatsApp 页面结构的地方，所以有两条纪律：
   * 1. 每打开一个都**按会话 id 等待**它真的换成那个会话（而不是死等固定毫秒）；
   * 2. 结束后**恢复原来打开的会话**，不让用户的界面停在别处。
   */
  async function archiveAllConversations() {
    const rows = mods.archive.chatListRows();
    if (!rows.length) return [mods.archive.readCurrentConversation()];

    const currentId = mods.archive.conversationIdOf();
    state.openRow = rows.find((row) => mods.archive.chatRowId(row) === currentId) ?? null;

    const archives = [];
    let lastId = currentId;
    for (const row of rows.slice(0, MAX_ARCHIVE_CONVERSATIONS)) {
      const rowId = mods.archive.chatRowId(row);
      const title = mods.archive.chatRowTitle(row);
      try {
        if (rowId && rowId === lastId) {
          archives.push(mods.archive.readCurrentConversation());
          continue;
        }
        realClick(row);
        const switched = await waitFor(() => {
          const nowId = mods.archive.conversationIdOf();
          if (rowId) return nowId === rowId ? nowId : null;
          return mods.archive.readContact().contactName === title ? title : null;
        }, { timeout: OPEN_CONVERSATION_TIMEOUT });
        if (!switched) continue;
        lastId = rowId || lastId;
        // 消息面板是虚拟列表，切换后要给它一点时间把首屏消息渲染出来。
        await sleep(280);
        archives.push(mods.archive.readCurrentConversation());
      } catch {
        /* 单个会话失败不该中断整批 */
      }
    }

    if (state.openRow) {
      realClick(state.openRow);
      await sleep(220);
    }
    return archives;
  }

  /** 只用本地已有语料重训（不重新抓取）。 */
  async function learnFromCorpus() {
    const stored = (await readStorage("gj_reply_corpus")) ?? mods.trainer.emptyCorpus();
    if (!stored.exchanges.length) {
      state.note = "本地还没有语料 —— 先点「归档并学习」";
      return { ok: false, error: state.note };
    }
    const profile = mods.trainer.buildProfileFromCorpus(stored, { name: "Web 会话档案" });
    await writeStorage({ gj_reply_profile: profile });
    state.profile = profile;
    state.note = `学习完成：${profile.examples.length} 组问答，语气「${profile.tone}」`;
    renderPanel();
    return { ok: true, profile, note: state.note };
  }

  async function exportTrainingKit() {
    if (!state.profile) return { ok: false, error: "还没有训练档案" };
    const name = mods.trainer.profileFileName(state.profile);
    download(name, mods.trainer.exportTrainingKit(state.profile), "text/markdown;charset=utf-8");
    state.note = `训练包已导出：${name}`;
    renderPanel();
    return { ok: true, file: name };
  }

  async function resetCorpus() {
    await writeStorage({ gj_reply_corpus: mods.trainer.emptyCorpus(), gj_reply_profile: null });
    state.profile = null;
    state.handled.clear();
    document.querySelectorAll(`.${NOTE_CLASS}`).forEach((node) => node.remove());
    state.note = "已清空本地语料与训练档案";
    renderPanel();
    return { ok: true, note: state.note };
  }

  /* -------------------------------------------------------- CRM 通道 */

  /** 所有 `chrome.runtime.sendMessage` 都走它：回调式的 `lastError` 只在这里处理一次。
   * ⚠️ 必须带超时：后台那条链（插件 → 本机 CLI）任何一环挂住而没回 sendResponse，
   * 这个 promise 就永远不落 —— busy 位卡死，之后**每一次点击都静默无效**，
   * 用户看到的就是"点了没任何反应"。宁可提前报"后台失联"，也不能让 UI 无限等。 */
  function sendMessage(message, timeoutMs = 150000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `后台 ${Math.round(timeoutMs / 1000)} 秒没有响应 —— 扩展服务可能停了，到 chrome://extensions 重载一下再试`
        });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) finish({ ok: false, error: error.message });
          else finish(response ?? { ok: false, error: "扩展后台没有响应" });
        });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /**
   * 技能扫描结果必须**按名字点名**，缺哪个说哪个。
   *
   * 技能没扫到不会报错：插件会静默降档（回复退成话术库、资料退成纯词法排序），表面上照样能用。
   * 只报「装了 N 个技能」用户不知道少的是哪一个，也就无从补救 —— 所以这里比的是"该有的两个"。
   */
  function skillSummary(engine) {
    const installed = Array.isArray(engine?.skills) ? engine.skills : [];
    const expected = [engine?.autoReplySkill, engine?.resourceScoutSkill].filter(Boolean);
    if (!expected.length) return installed.length ? `技能 ${installed.join("、")}` : "技能未扫描到";
    const missing = expected.filter((name) => !installed.includes(name));
    return missing.length ? `缺技能 ${missing.join("、")}（会静默降档）` : `技能 ${expected.join("、")} 已装`;
  }

  function crmStatusLine() {
    const crm = state.crm;
    if (crm.fetching && !crm.fetched) return "正在读取 CRM 连接状态…";
    if (!crm.fetched) return "CRM 状态待刷新";
    if (!crm.session?.loggedIn) {
      if (crm.session?.expired) return "CRM 登录已过期 —— 去扩展设置页重新登录一次";
      return "还没登录 CRM —— 扩展设置页 →「CRM 连接」填一次账号密码";
    }
    const engine = crm.engine;
    const engineText = engine?.ok
      ? engine.engine?.available
        ? `本机 CLI 可用（${engine.engine.version || "版本未知"}）· ${skillSummary(engine.engine)}`
        : `本机 CLI 不可用：${engine.engine?.reason || "探测未通过"}`
      : engine?.error
        ? `插件探测失败：${engine.error}`
        : "插件状态未知";
    return `已登录 ${crm.session.email}（约剩 ${crm.session.expiresInMinutes} 分钟）· ${engineText}`;
  }

  /** 只在首次展开面板、或用户点「刷新」时真去查一次，避免每次重绘都打一轮请求。 */
  function ensureCrmStatus({ force = false } = {}) {
    const crm = state.crm;
    if (crm.fetching) {
      // 用户点「刷新连接状态」时正在刷新：不能悄悄吞掉这次点击。
      if (force) {
        state.note = "连接状态正在刷新 —— 状态行更新后这里会换成结果。";
        renderPanel(true);
      }
      return;
    }
    if (!force && crm.fetched) return;
    crm.fetching = true;
    void sendMessage({ type: "crmStatus" }).then((response) => {
      crm.fetching = false;
      crm.fetched = true;
      crm.session = response?.session ?? null;
      crm.engine = response?.ok ? response.engine : { ok: false, error: response?.error || "读取失败" };
      renderPanel(true);
    });
  }

  /**
   * 把当前会话交给 CRM 侧的引擎。
   *
   * 与「立即回复最后一条」的区别值得说清楚：那条只用浏览器里那份词法档案 —— 不联网、不推理，
   * 捞到的是一句历史原话；这条是真的把对话送上去，由插件读 CRM 客户往来历史与知识检索命中，
   * 再让本机 CLI 加载 `goodjob-auto-reply` 技能出稿。代价是要等：一次生成几十秒是常态。
   */
  async function composeFromCrm() {
    const crm = state.crm;
    if (crm.busy) {
      // 同 analyzeConversation：忙碌锁不静默。告诉用户上一条在哪、什么时候好。
      state.note = "上一条回复还在生成中 —— 生成完会自动就绪，不用反复点。";
      renderPanel(true);
      return { ok: false, error: "上一条还在生成中" };
    }
    const archive = mods.archive.readCurrentConversation();
    const messages = (archive.messages ?? []).map((message) => ({
      direction: message.direction,
      body: message.body,
      occurredAt: message.occurredAt ?? ""
    }));
    if (!messages.length) {
      state.note = "当前会话里没有读到消息 —— 确认会话已打开";
      renderPanel(true);
      return { ok: false, error: state.note };
    }
    crm.busy = true;
    crm.result = null;
    crm.error = "";
    state.note = "正在让 CRM 侧的引擎生成…（本机 CLI 一次通常要几十秒，别关这个页面）";
    renderPanel(true);
    const composeHeartbeat = startHeartbeat("正在让 CRM 侧的引擎生成…");

    const response = await sendMessage({
      type: "crmCompose",
      payload: {
        messages,
        contact: { phone: archive.conversation.contactPhone, name: archive.conversation.contactName }
      }
    });
    crm.busy = false;
    composeHeartbeat.stop();
    if (!response?.ok) {
      crm.error = response?.error || "生成失败";
      state.note = crm.error;
      // 令牌过期时把状态标记成"待刷新"，下次重绘会重新问一次后台。
      if (response?.needsLogin) crm.fetched = false;
      renderPanel(true);
      return { ok: false, error: crm.error };
    }
    crm.result = response.result;
    /**
     * 同时写进整列的回复块 —— **回复只有一处渲染**。
     * 两条通道（`crmCompose` 只出回复 / `crmSuggest` 回复 + 资料）产物形状一样，
     * 各画一张卡片的话，用户会看到上下两条"推荐回复"，然后不知道该信哪条。
     */
    state.column.result = {
      ...(state.column.result ?? { resources: [], curatorNote: "", warnings: [], curated: false }),
      reply: response.result,
      conversationKey: state.column.conversationKey
    };
    state.column.lastAnalysisAt = Date.now();
    state.note =
      response.result?.action === "reply"
        ? "已生成草稿（没有替你发出去）"
        : `未生成：${response.result?.reason || "引擎没有给出回复"}`;
    renderPanel(true);
    return { ok: true, result: response.result };
  }

  /**
   * 把本地训练档案推送到插件（「归档并学习」之后的可选第二步）。
   *
   * 推送的是**提炼后的档案**（风格 + 问答样本 + 护栏），不是会话原文；服务端按内容指纹
   * 幂等，反复点也只落一份。失败只写 note，绝不影响本地学习结果。
   */
  async function pushProfileToCrm() {
    const profile = state.profile;
    if (!profile) {
      state.note = "还没有训练档案 —— 先归档并学习一次";
      renderPanel(true);
      return { ok: false, error: state.note };
    }
    const response = await sendMessage({
      type: "crmTrainingImport",
      payload: {
        name: profile.name,
        tone: profile.tone,
        summary: profile.summary,
        guidelines: profile.guidelines,
        signaturePhrases: profile.signaturePhrases,
        guardrails: profile.guardrails,
        languages: profile.languages,
        examples: profile.examples,
        stats: profile.stats,
        source: profile.source
      }
    });
    if (!response?.ok) {
      state.note = response?.error || "推送失败";
      renderPanel(true);
      return { ok: false, error: state.note };
    }
    const library = response.result?.library;
    state.note = library
      ? `已推送到 CRM：档案「${profile.name}」，训练库新增 ${library.created} 条 / 跳过 ${library.skipped} 条`
      : `CRM 里已是最新（「${profile.name}」内容没变，未重复入库）`;
    renderPanel(true);
    return { ok: true, result: response.result, note: state.note };
  }

  /* -------------------------------------------------------- 自动回复 */

  function annotate(row, decision) {
    if (row.querySelector(`.${NOTE_CLASS}`)) return;
    const node = document.createElement("div");
    node.className = NOTE_CLASS;
    node.dataset.gjState = decision.action === "reply" ? decision.mode : "skip";
    const badge = document.createElement("span");
    badge.className = "gj-reply-note-badge";
    badge.textContent = decision.action === "reply" ? (decision.mode === "auto" ? "已自动回复" : "建议回复") : "未回复";
    const body = document.createElement("span");
    body.className = "gj-reply-note-body";
    body.textContent = decision.action === "reply" ? decision.body : decision.reason;
    node.append(badge, body);
    if (decision.action === "reply") {
      const hint = document.createElement("span");
      hint.className = "gj-reply-note-hint";
      hint.textContent = decision.mode === "auto" ? "已发出" : "已填入输入框，确认后发送";
      node.append(hint);
    }
    row.appendChild(node);
    row.classList.add("gj-has-reply-note");
  }

  async function processInboundRow(row, { force = false } = {}) {
    const text = mods.archive.extractMessageText(row);
    const key = row.getAttribute("data-id") || `t:${text.slice(0, 80)}`;
    if (!force && state.handled.has(key)) return null;
    state.handled.add(key);

    const decision = mods.autoreply.decideReply({
      inboundBody: text,
      profile: state.profile,
      settings: state.settings?.autoReply,
      ledger: state.ledger
    });
    state.note = decision.action === "reply" ? `生成回复：${decision.reason}` : `未回复：${decision.reason}`;

    if (decision.action === "reply") {
      const box = mods.autoreply.composer();
      const empty = !(box?.innerText || "").trim();
      // 草稿模式绝不覆盖你正在打的内容 —— 那比不填更烦人。
      if (decision.mode === "auto" || empty) {
        // fillComposer 会读回输入框确认真的写进去了 —— 编辑器吞掉插入时它是 ok:false，
        // 所以自动模式绝不能凭"调用过了"就当发出去。
        const filled = await mods.autoreply.fillComposer(decision.body);
        if (filled.ok && decision.mode === "auto") {
          mods.autoreply.clickSend();
          state.ledger = mods.autoreply.recordSend(state.ledger ?? mods.autoreply.createLedger());
          await writeStorage({ gj_auto_reply_ledger: state.ledger });
        } else if (!filled.ok) {
          state.note += "（没能写进输入框，请点「复制这段」手动粘贴）";
        }
      } else {
        state.note += "（输入框里已有内容，没有覆盖）";
      }
    }
    annotate(row, decision);
    renderPanel();
    return decision;
  }

  /** 扫页面：找出"最后一条入站且还没处理过"的消息。 */
  function scanInbound() {
    if (state.stopped) return;
    const autoReply = state.settings?.autoReply;
    if (!autoReply?.enabled || autoReply.mode === "off") return;
    if (state.busy) return;
    const container = messagesContainer();
    if (!container) return;
    const row = mods.autoreply.lastInboundRow(container);
    if (!row) return;
    const key = row.getAttribute("data-id") || "";
    if (key && state.handled.has(key)) return;
    void processInboundRow(row);
  }

  function scheduleScan(delay = SCAN_DELAY) {
    if (state.stopped || state.busy) return;
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanInbound();
      ensureUi();
      // 会话切换后的自动刷新挂在这里：它已经在被 MutationObserver 驱动、自带 420ms 节流，
      // 再加一层 1.5 秒的会话防抖就够稳了，不必再单独挂一个 observer 去盯标题节点。
      maybeAnalyzeOnConversationChange();
    }, delay);
  }

  function attachObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => scheduleScan());
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  /* -------------------------------------------------------- 右侧整列 */

  /**
   * 当前会话的稳定身份 + 转写。
   *
   * `key` 用号码优先（和 CRM 认客户同一口径）：只用名字时，"客户改了备注名"会被当成换会话
   * 而白跑一次几十秒的模型；用号码则改名不动。
   */
  function currentConversation() {
    const contact = mods.archive.readContact();
    const container = messagesContainer();
    const messages = container
      ? (mods.archive.readCurrentConversation().messages ?? []).map((message) => ({
          direction: message.direction,
          body: message.body,
          occurredAt: message.occurredAt ?? ""
        }))
      : [];
    return {
      key: mods.resources.conversationKeyOf(contact, mods.archive.conversationIdOf() || ""),
      contact,
      messages,
      count: container ? mods.archive.messageRows(container).length : 0
    };
  }

  async function loadColumnPrefs() {
    state.column.prefs = mods.resources.readColumnPrefs(await readStorage(mods.resources.COLUMN_KEY));
  }

  function saveColumnPrefs() {
    void writeStorage(mods.resources.columnPrefsPatch(state.column.prefs));
  }

  /**
   * 把布局真的落到页面上。
   *
   * 推窄的实现是给 `#app` 加 `margin-right`，**不是**给 body 加 padding：
   * WhatsApp 的整页滚动容器是 `#app` 里的那一层，动 body 会出现"底部输入框跑到屏幕外"。
   */
  function applyColumnLayout() {
    const panel = document.getElementById(PANEL_ID);
    const layout = mods.resources.resolveLayout({
      width: state.column.prefs.width,
      collapsed: state.column.prefs.collapsed,
      viewportWidth: window.innerWidth
    });
    document.documentElement.style.setProperty("--gj-col-w", `${layout.columnWidth}px`);
    document.documentElement.dataset.gjCol = layout.mode;
    if (panel) panel.style.width = `${layout.columnWidth}px`;
    const app = document.querySelector("#app");
    if (app) app.style.marginRight = layout.push ? `${layout.push}px` : "";
  }

  /** 关闭时把推出来的空间还回去 —— 不还的话页面会一直窄着，用户会以为 WhatsApp 坏了。 */
  function releaseColumnLayout() {
    const app = document.querySelector("#app");
    if (app) app.style.marginRight = "";
    delete document.documentElement.dataset.gjCol;
    document.documentElement.style.removeProperty("--gj-col-w");
    // 顺便把"这次打开已经铺过快资料"的标记清掉：下次展开重新铺一遍当前会话。
    state.column.prefilled = false;
  }

  /**
   * 换会话时，把**跟着会话走**的东西清掉。
   *
   * 取过的链接、要用户手抄的正文、已复制的记忆 —— 都属于"上一个客户"，跟着换过来就是张冠李戴。
   * ⚠️ **`dismissed` 不清**：「这份没帮助」是用户对资料的判断，换个会话也仍然成立；
   * 而自动刷新有可能在用户点下去的那一刻返回，刷新时清它等于把那次点击吞了。
   */
  function resetConversationScopedState(nextKey) {
    state.column.revealed = {};
    state.column.manual = null;
    state.column.copiedKey = "";
    state.column.conversationKey = nextKey;
  }

  /**
   * 让 CRM 分析当前会话。
   *
   * ⚠️ 这里**只发消息、只收结果**：既不自动填输入框，也不发送。
   * 拿到什么就渲染什么，用不用是用户的事。
   *
   * 两条通道走同一个函数，是为了让结果形状、渲染路径、错误处理只有一套：
   * - `channel: "suggest"`（默认）：回复 + 资料一次给全，可能走 CLI，几十秒是常态；
   * - `channel: "search"`：只取资料，不调模型，秒回。面板打开时先铺这一层，
   *   用户不至于对着空面板干等出稿。
   *
   * ⚠️ **不碰 `revealed` / `dismissed`**。它们记的是用户的动作：刚点过「复制链接」、
   * 刚标过「没帮助」。刷新一次就当没发生过，用户会以为按钮坏了 —— 而且自动刷新
   * 是有可能在用户点下去的那一刻返回的，清掉就等于把那次点击吞了。
   */
  async function analyzeConversation({ quiet = false, channel = "suggest" } = {}) {
    const column = state.column;
    if (column.busy) {
      // 铁律：点了必须有响应。上一次分析还在跑时再点，不悄悄吞掉 ——
      // 告诉用户骨架屏就是它在跑、跑完自动铺结果。
      if (!quiet) {
        state.note = "上一次分析还没回来 —— 面板里的骨架屏就是它，跑完会自动铺结果，不用反复点。";
        renderPanel(true);
      }
      return { ok: false, error: "上一次分析还没回来" };
    }
    const conversation = currentConversation();
    if (!conversation.messages.length) {
      column.error = "当前会话里没读到消息 —— 确认会话已打开、消息已加载";
      if (!quiet) renderPanel(true);
      return { ok: false, error: column.error };
    }

    column.busy = true;
    column.error = "";
    column.result = null;
    if (column.conversationKey !== conversation.key) resetConversationScopedState(conversation.key);
    const progressNote =
      channel === "search"
        ? "正在按对话找资料…"
        : "正在分析这段对话…（本机模型出稿通常要几十秒，别关这个页面）";
    column.progressNote = progressNote;
    if (!quiet) state.note = progressNote;
    renderPanel(true);
    // 心跳：出稿几十秒是常态，界面必须一直"活着"（已等待 N 秒），不能让用户猜是卡了还是在跑。
    const heartbeat = startHeartbeat(progressNote, { touchNote: !quiet });

    const isSearch = channel === "search";
    const response = await sendMessage({
      type: isSearch ? "crmResources" : "crmSuggest",
      payload: isSearch
        ? {
            messages: conversation.messages,
            contact: conversation.contact,
            conversationKey: conversation.key,
            limit: mods.resources.RESOURCE_LIMIT
          }
        : mods.resources.buildSuggestPayload({
            messages: conversation.messages,
            contact: conversation.contact,
            engine: state.settings?.crm?.engine,
            limit: mods.resources.RESOURCE_LIMIT
          }),
      conversationKey: conversation.key
    });

    column.busy = false;
    heartbeat.stop();
    column.lastAnalysisAt = Date.now();
    if (!response?.ok) {
      column.error = response?.error || "分析失败";
      state.note = column.error;
      // 令牌过期时把状态标记成"待刷新"，下次重绘会重新问一次后台。
      if (response?.needsLogin) state.crm.fetched = false;
      renderPanel(true);
      return { ok: false, error: column.error };
    }

    column.result = mods.resources.normalizeSuggestion({ ...response.result, conversationKey: conversation.key });
    if (isSearch) {
      // 回复块不能留白说"模型认为依据不足"—— 这一轮**根本没让它出稿**，得说清是用户的选择。
      column.result.reply = { action: "skip", reason: "这次只取了资料（没让模型出稿）" };
    }
    // 只清掉自己写的那句进度提示。用户刚点「复制链接」拿到的"链接已复制（提取码 …）"
    // 可能就在这一瞬间写进去的，一并清掉等于告诉他点了没反应。
    if (state.note === column.progressNote || /^正在分析这段对话…（已等待/.test(state.note)) state.note = "";
    heartbeat.stop();
    renderPanel(true);
    return { ok: true, result: column.result };
  }

  /** 会话切换后的自动刷新：只有**真的换会话了**、且过了防抖窗口才打请求。 */
  function maybeAnalyzeOnConversationChange() {
    const column = state.column;
    if (column.busy || state.busy) return;
    if (document.getElementById(PANEL_ID)?.dataset.gjOpen !== "1") return;
    const conversation = currentConversation();
    const decision = mods.resources.refreshDecision({
      previousKey: column.conversationKey,
      nextKey: conversation.key,
      lastAt: column.lastAnalysisAt
    });
    if (decision.refresh && decision.reason === "conversation-changed") {
      void analyzeConversation({ quiet: true });
    }
  }

  /**
   * 面板一打开就先铺一层**快**的资料（不调模型、秒回）。
   *
   * 三个刻意的选择：
   * 1. 每次"打开"只做一次（`prefilled`，关闭时清掉）。面板每次重绘都触发一次检索
   *    会把插件打成一串无用请求。
   * 2. **不顺手跑那轮几十秒的出稿**。展开面板不该等于"替我起一个 CLI 任务"，
   *    那件事留给"真的换了会话"和用户自己点。
   * 3. **打开这一刻把基准挪到当前会话**。不挪的话，面板关着的期间切过的会话
   *    会被当成"用户刚换了会话"，于是展开一列就自动起一轮出稿 —— 正是第 2 条要避免的。
   *    代价是"关闭期间的切换"不被刷新，但那本来也不该刷：没人看着的时候刷给谁看。
   */
  function maybePrefillColumn() {
    const column = state.column;
    if (column.prefilled || column.busy) return;
    if (document.getElementById(PANEL_ID)?.dataset.gjCollapsed === "1") return;
    if (!state.crm.session?.loggedIn) return;
    const conversation = currentConversation();
    if (!conversation.messages.length) return;

    if (column.conversationKey !== conversation.key) {
      // 上一个会话的结果留着就是张冠李戴，先丢掉；跟着会话走的链接/手抄内容也一起清。
      column.result = null;
      column.error = "";
      resetConversationScopedState(conversation.key);
    }
    if (column.result) return; // 同一个会话、已经有结果：不重复打请求
    column.prefilled = true;
    void analyzeConversation({ channel: "search", quiet: true });
  }

  /** 把一句话塞进剪贴板。`navigator.clipboard` 在 http 页面上不可用，所以要留退路。 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const scratch = el("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "true");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand("copy");
        scratch.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  /**
   * 取真实外链并复制。**这是整条链路上唯一一次把外链拿到页面上**，且只由用户点击触发。
   * 取到的地址只在内存里留一份（为了「已复制」按钮能再点一次），**不写 storage**。
   *
   * 两条"要用户自己动手"的路都必须**真的把东西摆出来**：
   * - 知识条目没有外链 → 把正文显示在卡片里；
   * - 浏览器不让写剪贴板 → 把地址显示成一个可全选的只读框。
   * 只提示"请手动复制"而页面上其实什么都没有，比直接报错更糟 —— 用户会一条条找过去，
   * 最后以为是自己点错了。
   */
  async function revealAndCopy(resource) {
    const column = state.column;
    const key = resource.key || `${resource.sourceType}:${resource.id}`;
    let access = column.revealed[key];
    if (!access) {
      const response = await sendMessage({
        type: "crmReveal",
        payload: { sourceType: resource.sourceType, id: resource.id, reason: "manual", conversationKey: column.conversationKey }
      });
      const outcome = mods.resources.revealOutcome(response?.ok ? response.result : { ok: false, reason: response?.error });
      if (!outcome.ok) {
        state.note = `取链接失败：${outcome.reason}`;
        renderPanel(true);
        return { ok: false, error: outcome.reason };
      }
      access = outcome;
      column.revealed[key] = access;
    }
    if (access.kind === "inline") {
      column.manual = { key, kind: "inline", content: access.content };
      state.note = "这份资料没有外链，正文已经贴在这张卡里，选中即可复制";
      renderPanel(true);
      return { ok: true, kind: "inline", content: access.content };
    }
    const copied = await copyText(access.url);
    column.copiedKey = copied ? key : "";
    column.manual = copied ? null : { key, kind: "external", url: access.url, shareCode: access.shareCode || "" };
    state.note = copied
      ? `链接已复制${access.shareCode ? `（提取码 ${access.shareCode}）` : ""} —— 自己粘到会话里发出去`
      : `浏览器不让自动复制${access.shareCode ? `（提取码 ${access.shareCode}）` : ""} —— 地址已显示在卡片里，全选复制即可`;
    renderPanel(true);
    setTimeout(() => {
      if (state.column.copiedKey === key) {
        state.column.copiedKey = "";
        if (document.getElementById(PANEL_ID)) renderPanel(true);
      }
    }, COPIED_FEEDBACK_MS);
    return { ok: true, kind: "external", url: access.url };
  }

  /** 埋点：纯旁路，失败就算了。 */
  function sendFeedback(resource, action) {
    void sendMessage({
      type: "crmFeedback",
      payload: {
        items: [{ resourceId: resource.id, sourceType: resource.sourceType, action }],
        conversationKey: state.column.conversationKey
      }
    });
  }

  function dismissResource(resource) {
    const key = resource.key || `${resource.sourceType}:${resource.id}`;
    state.column.dismissed[key] = "dismissed";
    sendFeedback(resource, "dismissed");
    state.note = `已记下「${resource.title}」没帮助，下次会排后面`;
    renderPanel(true);
  }

  function markResourceSent(resource) {
    const key = resource.key || `${resource.sourceType}:${resource.id}`;
    sendFeedback(resource, "sent");
    state.note = `已记下「${resource.title}」发给了客户`;
    renderPanel(true);
  }

  function sendState(payload) {
    const stateName = mods.resources.columnState(payload).state;
    document.documentElement.dataset.gjColState = stateName;
    return stateName;
  }

  /* -------------------------------------------------------- 面板 UI */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * GJ 标识（几何与配色全部来自 src/gj-theme.css 的 `.gj-mark`）。
   *
   * 悬浮入口、面板页头都用它 —— 标识只此一处实现，别在别处再写一套「G/J 两个字母」。
   */
  function gjMark(size) {
    const mark = el("span", "gj-mark");
    mark.setAttribute("aria-hidden", "true");
    if (size) mark.style.setProperty("--gj-mark-size", `${size}px`);
    mark.append(el("span", null, "G"), el("span", null, "J"));
    return mark;
  }

  /**
   * 操作失败必须落在界面上 —— 这是 button() 的 catch 和全局兜底网共用的出口。
   */
  function noteFailure(what, error) {
    const message = error instanceof Error ? error.message : String(error ?? "未知错误");
    state.note = `${what}失败：${message}`;
    try {
      renderPanel(true);
    } catch {
      /* 面板都画不出来时只能留给控制台，不能再往上抛 */
    }
  }

  /**
   * 长任务心跳：每 5 秒把「已等待 N 秒」**原位**写进面板提示行。
   * 刻意不整面板重绘 —— 重绘会重建按钮节点，可能把用户正要点的那一下吞掉；
   * 这里只改已有节点的文本。任务收尾必须调 stop()，否则提示会一直跳秒。
   */
  function startHeartbeat(baseText, { touchNote = true } = {}) {
    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (touchNote) {
        state.note = `${baseText}（已等待 ${seconds} 秒）`;
        const note = document.querySelector(`#${PANEL_ID} .gj-agent-note`);
        if (note) note.textContent = state.note;
      }
      const hint = document.querySelector(`#${PANEL_ID} .gj-agent-col-status-hint`);
      if (hint) {
        if (!hint.dataset.gjBase) hint.dataset.gjBase = hint.textContent || "";
        hint.textContent = `${hint.dataset.gjBase} · 已等待 ${seconds} 秒`;
      }
    };
    const timer = setInterval(tick, 5000);
    return { stop: () => clearInterval(timer) };
  }

  function button(label, onClick, variant) {
    const node = el("button", variant ? `gj-agent-btn is-${variant}` : "gj-agent-btn", label);
    node.type = "button";
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 铁律：任何动作必须有前端响应。点击瞬间先让按钮自己表态（变灰 + 文案挂上省略号），
      // 后续进度交给各自的状态渲染；处理函数抛异常也必须落在界面上，绝不静默。
      if (node.dataset.gjBusy === "1") return; // 已经在跑：按钮此刻的样子就是"按下去了"
      node.dataset.gjBusy = "1";
      const original = node.textContent;
      node.classList.add("is-busy");
      if (original && !/[…]$/.test(original)) node.textContent = `${original}…`;
      Promise.resolve()
        .then(onClick)
        .catch((error) => noteFailure(original || "操作", error))
        .finally(() => {
          node.dataset.gjBusy = "";
          node.classList.remove("is-busy");
          if (node.isConnected) node.textContent = original;
        });
    });
    return node;
  }

  function row(label, control) {
    const wrap = el("div", "gj-agent-row");
    wrap.append(el("span", "gj-agent-label", label), control);
    return wrap;
  }

  function ensureUi() {
    const main = document.querySelector("#main");
    if (!main) {
      document.getElementById(BTN_ID)?.remove();
      document.getElementById(PANEL_ID)?.remove();
      releaseColumnLayout();
      return;
    }
    if (!document.getElementById(BTN_ID)) {
      const node = el("button", "gj-mark");
      node.id = BTN_ID;
      node.type = "button";
      node.title = "GoodJob · 推荐回复 / 资料 / 归档";
      node.setAttribute("aria-label", node.title);
      node.append(el("span", null, "G"), el("span", null, "J"));
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      });
      document.body.appendChild(node);
    }
    positionUi();
    applyColumnLayout();
  }

  function positionUi() {
    const node = document.getElementById(BTN_ID);
    if (!node) return;
    const footer = document.querySelector("#main footer");
    const bottom = footer ? Math.max(10, window.innerHeight - footer.getBoundingClientRect().top + 10) : 90;
    node.style.bottom = `${bottom + 46}px`;
    node.style.right = "20px";
  }

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing?.dataset.gjOpen === "1") {
      existing.remove();
      releaseColumnLayout();
      return;
    }
    state.column.prefs.collapsed = false;
    saveColumnPrefs();
    renderPanel(true);
  }

  /** 折叠成一条竖条。折叠状态持久化 —— 下次打开还是折叠的。 */
  function toggleCollapse() {
    state.column.prefs.collapsed = !state.column.prefs.collapsed;
    saveColumnPrefs();
    renderPanel(true);
  }

  /**
   * 拖左边缘调宽度。
   *
   * 用 pointer 事件而不是 mouse：`setPointerCapture` 让鼠标移出窗口后仍然跟着走，
   * 不然用户拖快一点就"脱手"，得重新按住。
   */
  function attachResize(panel, handle) {
    panel.classList.add("gj-agent-resizable");
    handle.id = "gj-agent-resize";
    handle.title = "拖动调宽度，双击回到默认";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "调整面板宽度");

    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      const width = window.innerWidth - event.clientX;
      state.column.prefs.width = mods.resources.clampColumnWidth(width);
      applyColumnLayout();
      event.preventDefault();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("is-dragging");
      try {
        handle.releasePointerCapture?.(handle.__gjPointerId);
      } catch {
        /* 捕获早就没了也无所谓 */
      }
      saveColumnPrefs();
    };
    handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      handle.__gjPointerId = event.pointerId;
      panel.classList.add("is-dragging");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 不支持就退回纯 mousemove */
      }
      event.preventDefault();
    });
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("dblclick", () => {
      state.column.prefs.width = mods.resources.COLUMN_DEFAULTS.width;
      saveColumnPrefs();
      applyColumnLayout();
    });
  }

  function sourceBadgeRow(evidence) {
    const badges = mods.resources.sourceBadges(evidence);
    const box = el("div", "gj-agent-badges");
    if (!badges.length) {
      box.append(el("span", "gj-agent-badge is-muted", "无额外依据"));
      return box;
    }
    for (const badge of badges) {
      const node = el("span", "gj-agent-badge", badge.label);
      node.dataset.gjBadge = badge.key;
      box.append(node);
    }
    return box;
  }

  /**
   * 「要你自己动手」的那块内容。
   *
   * 只在用户**点过**之后才出现：知识条目的正文、或者剪贴板被挡时那份地址。
   * 平时页面上不存在这些字符串 —— 这是"外链不落地"那条纪律与自己动手之间的边界。
   */
  function manualBox(manual) {
    const box = el("div", "gj-agent-manual");
    if (manual.kind === "inline") {
      box.append(el("p", "gj-agent-manual-hint", "这份资料没有外链，正文在这里，选中复制："));
      box.append(el("pre", "gj-agent-manual-body", manual.content || "（正文是空的）"));
      return box;
    }
    box.append(
      el("p", "gj-agent-manual-hint", manual.shareCode ? `浏览器不让自动复制，全选这个地址；提取码 ${manual.shareCode}` : "浏览器不让自动复制，全选这个地址")
    );
    const field = el("input", "gj-agent-manual-url");
    field.type = "text";
    field.readOnly = true;
    field.value = manual.url || "";
    // 聚焦即全选 —— 提示里说了"全选"，就别让用户自己拖。
    field.addEventListener("focus", () => field.select());
    box.append(field);
    return box;
  }

  /** 一张资料卡。信息层级：类型/标题 → 摘要 → 为什么推荐 → 相关度 → 动作。 */
  function resourceCard(resource, { dismissed }) {
    const info = mods.resources.describeResource(resource);
    const key = resource.key || `${resource.sourceType}:${resource.id}`;
    const card = el("div", "gj-agent-res");
    card.dataset.gjRes = resource.sourceType;
    card.dataset.gjResId = resource.id;
    if (dismissed) card.dataset.gjDismissed = "1";

    const head = el("div", "gj-agent-res-head");
    head.append(el("span", "gj-agent-res-type", info.fileLabel), el("span", "gj-agent-res-title", info.title || "（未命名资料）"));
    card.append(head);
    if (info.summary) card.append(el("p", "gj-agent-res-summary", info.summary));

    const why = el("p", "gj-agent-res-why");
    why.dataset.gjWhyKind = info.whyIsAi ? "ai" : "rank";
    why.append(el("span", "gj-agent-res-why-tag", info.whyIsAi ? "为什么推荐" : "为什么排前面"), document.createTextNode(info.why || "（没有更多说明）"));
    card.append(why);

    if (info.suggestedLine) {
      card.append(el("p", "gj-agent-res-line", `可以直接发：${info.suggestedLine}`));
    }

    const actions = el("div", "gj-agent-actions");
    if (info.canReveal) {
      const copied = state.column.copiedKey === key;
      actions.append(
        button(copied ? "已复制" : "复制链接", () => revealAndCopy(resource), "primary")
      );
    } else {
      actions.append(button("看正文", () => revealAndCopy(resource)));
    }
    actions.append(button("已发给客户", () => markResourceSent(resource)));
    actions.append(button("没帮助", () => dismissResource(resource)));
    if (info.scoreText) {
      card.append(el("p", "gj-agent-res-score", `相关度 ${info.scoreText}`));
    }
    card.append(actions);
    if (state.column.manual?.key === key) card.append(manualBox(state.column.manual));
    return card;
  }

  function renderReplyBlock(column) {
    const box = el("section", "gj-agent-block");
    box.append(el("h3", "gj-agent-block-title", "推荐回复"));
    const reply = column.result?.reply;
    if (!reply || reply.action !== "reply" || !String(reply.reply ?? "").trim()) {
      const hint = el("p", "gj-agent-empty");
      hint.textContent = reply?.reason ? `这轮没出稿：${reply.reason}` : "这轮没有生成回复（可能不需要回，或模型认为依据不足）";
      box.append(hint);
      return box;
    }
    const card = el("div", "gj-agent-reply");
    card.dataset.gjState = reply.blocked ? "blocked" : "ok";
    card.append(el("p", "gj-agent-reply-head", reply.blocked ? "草稿（有拦住的地方，先别发）" : "草稿（未发送）"));
    card.append(el("p", "gj-agent-reply-body", reply.reply));
    card.append(el("p", "gj-agent-evidence", mods.crm.describeEvidence(reply.evidence)));
    card.append(sourceBadgeRow(reply.evidence));
    card.append(
      el(
        "p",
        "gj-agent-evidence",
        `引擎 ${reply.engine}${reply.model ? ` · 模型 ${reply.model}` : ""}` +
          `${reply.confidence ? ` · 置信度 ${Number(reply.confidence).toFixed(2)}` : ""}` +
          `${reply.reason ? ` · ${reply.reason}` : ""}`
      )
    );
    const actions = el("div", "gj-agent-actions");
    actions.append(
      button("填进输入框（不发送）", async () => {
        // 读回输入框才算数：编辑器吞掉插入时这里会是 ok:false，得让人去用「复制这段」。
        const filled = await mods.autoreply.fillComposer(reply.reply);
        state.note = filled.ok
          ? filled.how === "dom"
            ? "已写入输入框，但编辑器可能不认 —— 发不出去请改用「复制这段」"
            : "已填进输入框，按回车发送"
          : "没能写进输入框，请点「复制这段」手动粘贴";
        renderPanel(true);
      }, "primary")
    );
    actions.append(
      button("复制这段", async () => {
        const copied = await copyText(reply.reply);
        state.note = copied ? "回复已复制" : "复制失败，请手动选中";
        renderPanel(true);
      })
    );
    card.append(actions);
    box.append(card);
    return box;
  }

  function renderResourceBlock(column) {
    const box = el("section", "gj-agent-block");
    const title = el("h3", "gj-agent-block-title", "相关文档");
    const resources = column.result?.resources ?? [];
    if (column.result?.curated) {
      title.append(el("span", "gj-agent-block-tag", "AI 挑过"));
    }
    box.append(title);

    const visible = resources.filter((resource) => {
      const key = resource.key || `${resource.sourceType}:${resource.id}`;
      return !column.dismissed[key];
    });
    if (!visible.length) {
      box.append(el("p", "gj-agent-empty", resources.length ? "都被你标成「没帮助」了" : "这段对话里没找到对得上的资料"));
      return box;
    }
    if (column.result?.curatorNote) {
      box.append(el("p", "gj-agent-curator", column.result.curatorNote));
    }
    for (const resource of visible) box.append(resourceCard(resource, { dismissed: false }));
    return box;
  }

  function renderColumnBody(column) {
    const conversation = currentConversation();
    const context = {
      key: conversation.key,
      loggedIn: Boolean(state.crm.session?.loggedIn),
      busy: column.busy,
      result: column.result,
      error: column.error,
      cliAvailable: state.crm.engine?.ok ? Boolean(state.crm.engine.engine?.available) : undefined,
      hasConversation: conversation.messages.length > 0
    };
    const status = mods.resources.columnState(context);
    sendState(context);

    const box = el("div", "gj-agent-col-body");
    const head = el("div", "gj-agent-col-status");
    head.append(el("p", "gj-agent-col-status-title", status.title));
    if (status.hint) head.append(el("p", "gj-agent-col-status-hint", status.hint));
    box.append(head);

    if (status.state === "blocked") {
      box.append(button("去设置页登录", () => sendMessage({ type: "openOptions" })));
      return box;
    }
    if (status.state === "idle" && !column.result) {
      box.append(button(column.busy ? "分析中…" : "分析这个会话", () => analyzeConversation(), "primary"));
      return box;
    }
    if (status.state === "scanning") {
      // 骨架屏而不是转圈：转圈会让人以为卡住了，骨架屏说明"内容马上来"。
      const skeleton = el("div", "gj-agent-skeleton");
      for (let index = 0; index < 3; index += 1) skeleton.append(el("div", "gj-agent-skeleton-row"));
      box.append(skeleton);
      return box;
    }
    if (status.state === "error") {
      box.append(el("p", "gj-agent-error", status.hint));
      box.append(button("重试", () => analyzeConversation(), "primary"));
      return box;
    }

    box.append(renderReplyBlock(column));
    box.append(renderResourceBlock(column));

    const summary = mods.resources.warningsSummary(column.result);
    if (summary) box.append(el("p", "gj-agent-warnline", `折损：${summary}`));

    const actions = el("div", "gj-agent-actions");
    actions.append(button(column.busy ? "分析中…" : "重新分析", () => analyzeConversation(), "primary"));
    actions.append(button("只要资料（快）", () => analyzeConversation({ channel: "search" })));
    actions.append(button("只要回复（不推资料）", () => composeFromCrm()));
    actions.append(button("刷新连接状态", () => ensureCrmStatus({ force: true })));
    box.append(actions);
    return box;
  }

  function renderPanel(open = false) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel && !open) return;
    if (!panel) {
      panel = el("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
    panel.dataset.gjOpen = "1";
    panel.textContent = "";

    const collapsed = Boolean(state.column.prefs.collapsed);
    panel.dataset.gjCollapsed = collapsed ? "1" : "0";

    const head = el("div", "gj-agent-head");
    head.append(
      gjMark(22),
      el("span", "gj-agent-title", "即刻沟通"),
      el("span", "gj-agent-sub", "GoodJob")
    );
    const collapse = button(collapsed ? "‹" : "›", () => toggleCollapse());
    collapse.classList.add("gj-agent-collapse");
    collapse.title = collapsed ? "展开" : "折叠成一竖条";
    const close = button("×", () => {
      panel.remove();
      releaseColumnLayout();
    });
    close.classList.add("gj-agent-close");
    close.title = "关闭这一列";
    head.append(collapse, close);
    panel.append(head);

    if (collapsed) {
      // 折叠时只留一条竖条：一个标识 + 竖排文案。不给任何可点区域，
      // 免得用户在关闭状态下误触发出一次几十秒的生成。
      const rail = el("div", "gj-agent-rail");
      rail.append(el("span", "gj-agent-rail-text", "即刻沟通"));
      panel.append(rail);
      ensureCrmStatus();
      applyColumnLayout();
      return;
    }

    const resize = el("div", "gj-agent-resize");
    panel.append(resize);
    attachResize(panel, resize);

    const scroll = el("div", "gj-agent-scroll");
    scroll.append(renderColumnBody(state.column));
    const contact = mods.archive.readContact();
    const meta = el("p", "gj-agent-meta");
    meta.append(
      el("strong", null, contact.contactName || "未识别会话"),
      document.createTextNode(` · 当前会话 ${currentConversation().count} 条消息`)
    );
    scroll.append(meta);
    scroll.append(el("p", "gj-agent-meta", crmStatusLine()));

    /* ---- 配置入口 + 翻译引擎：进面板就能看到（0.7.0） ----
     * 用户原话：「配置完后就不知道怎么进入配置了」。设置页的入口必须常驻面板，
     * 且引擎三选一（混合 / 只机译 / 只AI）就地能切，不用跳去设置页。 */
    const engineRow = el("div", "gj-agent-actions");
    const engineSelect = el("select", "gj-agent-select");
    for (const [value, label] of [
      ["hybrid", "混合（机译打底 + AI 精修）"],
      ["mt", "只用机译（最快 · 免费）"],
      ["ai", "只用 AI（最准 · 慢）"]
    ]) {
      const option = el("option", null, label);
      option.value = value;
      engineSelect.append(option);
    }
    const currentMode = ["hybrid", "mt", "ai"].includes(state.settings?.engineMode)
      ? state.settings.engineMode
      : "hybrid";
    engineSelect.value = currentMode;
    engineSelect.dataset.gjRole = "engineMode";
    engineSelect.addEventListener("change", async () => {
      const picked = engineSelect.value;
      const label = { hybrid: "混合（机译打底 + AI 精修）", mt: "只用机译", ai: "只用 AI" }[picked] || picked;
      const response = await sendMessage({ type: "updateSettings", patch: { engineMode: picked } });
      // 反馈铁律：切完必须当场有说法（成功改下拉框上下文，失败把原因落到 note）。
      state.note = response?.ok
        ? `翻译引擎已切换为「${label}」，下一条消息生效`
        : `引擎切换失败：${response?.error || "后台没有响应"}`;
      if (response?.ok) state.settings = { ...state.settings, engineMode: picked };
      renderPanel(true);
    });
    engineRow.append(row("翻译引擎", engineSelect));
    scroll.append(engineRow);
    const configRow = el("div", "gj-agent-actions");
    configRow.append(button("⚙ 打开配置页", () => sendMessage({ type: "openOptions" })));
    scroll.append(configRow);

    /* ---- 归档 / 训练 / 本地自动回复：收进折叠区，不再和新内容抢注意力 ---- */
    const details = el("details", "gj-agent-more");
    details.append(el("summary", null, "归档 · 训练 · 本地自动回复"));
    const inner = el("div", "gj-agent-more-body");

    const format = el("select", "gj-agent-select");
    for (const [value, label] of [["jsonl", "JSONL（插件同口径）"], ["txt", "WhatsApp TXT（可导入 CRM）"], ["md", "Markdown（人读）"]]) {
      const option = el("option", null, label);
      option.value = value;
      format.append(option);
    }
    format.dataset.gjRole = "format";
    inner.append(row("导出格式", format));

    const archiveActions = el("div", "gj-agent-actions");
    archiveActions.append(
      button(
        "归档并学习（当前会话）",
        async () => {
          const picked = panel.querySelector('[data-gj-role="format"]')?.value || "jsonl";
          await archiveAndLearn({ scope: "current", format: picked, learn: true });
        },
        "primary"
      )
    );
    archiveActions.append(
      button("归档并学习（全部会话）", async () => {
        const picked = panel.querySelector('[data-gj-role="format"]')?.value || "jsonl";
        await archiveAndLearn({ scope: "all", format: picked, learn: true });
      })
    );
    inner.append(archiveActions);

    const profile = state.profile;
    inner.append(
      el(
        "p",
        "gj-agent-meta",
        profile
          ? `训练档案：${profile.status === "ready" ? "就绪" : "样本不足"} · ${profile.examples.length} 组问答 · 语气「${profile.tone}」`
          : "训练档案：还没有，先归档并学习一次"
      )
    );
    if (profile) {
      inner.append(el("p", "gj-agent-meta", `覆盖 ${profile.stats.conversations} 个会话 / ${profile.stats.messages} 条消息 · 语言 ${profile.languages.join(" / ") || "未判定"}`));
      const crmActions = el("div", "gj-agent-actions");
      crmActions.append(
        button("推送到 CRM", async () => {
          await pushProfileToCrm();
        })
      );
      inner.append(crmActions);
      inner.append(el("p", "gj-agent-meta", "推送只送提炼后的问答样本与护栏（服务端幂等，重复点不会重复入库）；需要先在设置页登录 CRM。"));
    }

    const auto = state.settings?.autoReply ?? {};
    const mode = el("select", "gj-agent-select");
    for (const [value, label] of [["off", "关闭"], ["draft", "草稿（推荐）"], ["auto", "全自动发送"]]) {
      const option = el("option", null, label);
      option.value = value;
      mode.append(option);
    }
    mode.value = auto.enabled ? auto.mode : "off";
    mode.addEventListener("change", async () => {
      const picked = mode.value;
      await sendMessage({ type: "setAutoReply", patch: { enabled: picked !== "off", mode: picked === "off" ? "draft" : picked } });
      state.note = picked === "off" ? "自动回复已关闭" : `自动回复已切换为「${picked === "auto" ? "全自动发送" : "草稿"}」`;
      renderPanel(true);
    });
    inner.append(row("自动回复", mode));

    const extra = el("div", "gj-agent-actions");
    extra.append(button("立即回复最后一条", () => replyLatest(), "primary"));
    extra.append(button("重学一次", () => learnFromCorpus()));
    extra.append(button("导出训练包", () => exportTrainingKit()));
    extra.append(button("清空语料", () => resetCorpus()));
    inner.append(extra);
    details.append(inner);
    scroll.append(details);

    if (state.note) scroll.append(el("p", "gj-agent-note", state.note));
    panel.append(scroll);
    ensureCrmStatus();
    applyColumnLayout();
    maybePrefillColumn();
  }

  async function replyLatest() {
    const container = messagesContainer();
    const row = mods.autoreply.lastInboundRow(container);
    if (!row) {
      state.note = "当前会话里没有客户消息";
      renderPanel(true);
      return { ok: false, error: state.note };
    }
    const decision = await processInboundRow(row, { force: true });
    renderPanel(true);
    return { ok: true, decision };
  }

  /* -------------------------------------------------------- 对外接口 */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;
    if (type === "settingsChanged") {
      void reloadSettings();
      sendResponse({ ok: true });
      return true;
    }
    if (type === "agent:status") {
      sendResponse(statusPayload());
      return true;
    }
    if (type === "agent:archive") {
      void archiveAndLearn(message).then(sendResponse);
      return true;
    }
    if (type === "agent:learn") {
      void learnFromCorpus().then(sendResponse);
      return true;
    }
    if (type === "agent:replyNow") {
      void replyLatest().then(sendResponse);
      return true;
    }
    if (type === "agent:exportProfile") {
      void exportTrainingKit().then(sendResponse);
      return true;
    }
    if (type === "agent:reset") {
      void resetCorpus().then(sendResponse);
      return true;
    }
    if (type === "agent:crmStatus") {
      void sendMessage({ type: "crmStatus", force: true }).then((response) => {
        state.crm.session = response?.session ?? null;
        state.crm.engine = response?.ok ? response.engine : { ok: false, error: response?.error || "读取失败" };
        state.crm.fetched = true;
        if (document.getElementById(PANEL_ID)) renderPanel(true);
        sendResponse(response);
      });
      return true;
    }
    if (type === "agent:crmCompose") {
      void composeFromCrm().then(sendResponse);
      return true;
    }
    return false;
  });

  function statusPayload() {
    const contact = mods?.archive.readContact() ?? { contactName: "", contactPhone: "" };
    const container = messagesContainer();
    return {
      ok: true,
      contact,
      messageCount: container ? mods.archive.messageRows(container).length : 0,
      profile: state.profile
        ? {
            status: state.profile.status,
            tone: state.profile.tone,
            samples: state.profile.examples.length,
            languages: state.profile.languages,
            stats: state.profile.stats,
            trainedAt: state.profile.trainedAt
          }
        : null,
      autoReply: state.settings?.autoReply ?? null,
      crm: {
        session: state.crm.session,
        engine: state.crm.engine,
        result: state.crm.result,
        error: state.crm.error,
        busy: state.crm.busy
      },
      ledger: state.ledger,
      busy: state.busy,
      note: state.note
    };
  }

  async function reloadSettings() {
    const response = await sendMessage({ type: "getSettings" });
    if (response?.settings) state.settings = response.settings;
    // 设置页里刚改过 CRM 地址/登录过，这里要重新问一次状态，否则面板上还是旧的。
    state.crm.fetched = false;
    scheduleScan(80);
  }

  window.addEventListener("resize", () => {
    positionUi();
    // 视口跨过 1100px 那条线时要从「推窄」切到「覆盖」，所以 resize 必须重算布局。
    applyColumnLayout();
  });

  // 兜底网（铁律）：任何一处异步代码漏抛的异常都必须落在界面上 ——
  // 「点了没任何反应」里最恶毒的一种就是 handler 抛了异常而 UI 一声不吭。
  // button() 自带 catch 是第一道网，这里兜住所有绕过它的（直接 void 调用、其他监听器等）。
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "未知错误");
    state.note = `操作出错：${message}`;
    try {
      renderPanel(true);
    } catch {
      /* 面板画不出来时只能留给控制台，不能再往上抛 */
    }
  });

  void (async () => {
    try {
      mods = await loadModules();
    } catch (error) {
      // 模块加载失败只影响本脚本，翻译照常工作。
      console.warn("[GoodJob 归档] 模块加载失败：", error);
      return;
    }
    document.documentElement.dataset.gjAgent = "on";
    state.settings = (await readStorage("gj_translator_settings")) ?? null;
    state.ledger = (await readStorage("gj_auto_reply_ledger")) ?? null;
    state.profile = (await readStorage("gj_reply_profile")) ?? null;
    await loadColumnPrefs();
    await reloadSettings();
    attachObserver();
    scheduleScan(400);
  })();
})();
