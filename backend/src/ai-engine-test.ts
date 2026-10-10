/**
 * AI 执行引擎（背调 / 开发信来源）回归测试。
 *
 * 覆盖 2026-10-06 需求：「背调」与「开发信」都要能选来源（CRM / AI API / 本机 CLI），
 * 并且 CRM 只做稳定框架——准备事实、冻结提示词、留档结果、做质量自检。
 *
 * 重点防回归：
 *   1. CLI 输出里夹带说明/围栏时，必须仍能抠出 JSON（本机 CLI 实测会加解释性文字）；
 *   2. 引擎补充的来源必须是可点击的 http(s)，且要标记来源，不能和 CRM 证据混为一谈；
 *   3. 引擎输出不规范（缺字段、类型错）时只能丢弃该字段，绝不能让整次背调失败；
 *   4. 超时上限必须与 Runner 任务上限（24 小时）一致，且不允许低于 1 分钟。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ENGINE_CLI_SKILLS,
  applyResearchEnginePatch,
  buildAcquisitionCliPrompt,
  buildEmailCliPrompt,
  buildResearchCliPrompt,
  buildTenderDailyCliPrompt,
  engineSkillDirective,
  extractAcquisitionFindings,
  extractEngineJson,
  normalizeAcquisitionCompanies,
  normalizeEmailPatch,
  normalizeResearchPatch,
  type EngineResearchSkeleton
} from "./ai-engine-prompts.js";
import {
  AI_ENGINE_CLI_TIMEOUT_DEFAULT,
  AI_ENGINE_CLI_TIMEOUT_MAX,
  AI_ENGINE_CLI_TIMEOUT_MIN,
  AI_ENGINE_CLI_EFFORTS,
  AI_ENGINE_CLI_MODELS,
  AI_ENGINE_CLI_MODEL_DEFAULT,
  AI_ENGINE_CLI_MODEL_IDS,
  aiEngineAdapterLabel,
  aiEngineSourceLabel,
  clampAiEngineTimeout,
  defaultTeamAiEngineSettings,
  EMAIL_ENGINE_SOURCES,
  RESEARCH_ENGINE_SOURCES,
  resolveEngineSource,
  sanitizeTeamAiEngineSettings
} from "./ai-engine-settings.js";
import { EngineUnavailableError, applyCliProfileToPrompt, pickEngineRunner } from "./ai-engine-service.js";

const checked: string[] = [];
function check(condition: boolean, message: string) {
  assert.ok(condition, message);
  checked.push(message);
}

function skeleton(): EngineResearchSkeleton {
  return {
    score: 52,
    verdict: "建议核实后推进",
    summary: "CRM 骨架结论",
    scoreReason: "",
    nextAction: "先补齐联系方式",
    crmOnly: true,
    facts: [{ label: "主体", value: "Acme Trading LLC" }],
    opportunities: [],
    talkTracks: [],
    risks: [{ level: "medium", title: "联系方式", detail: "尚无可直接触达的联系方式" }],
    sources: [{ title: "企业官网", url: "https://acme.example", observedAt: "2026-10-01T00:00:00.000Z" }]
  };
}

async function main() {
  // ── 1. 来源设置 ────────────────────────────────────────────
  const defaults = defaultTeamAiEngineSettings("team_1");
  check(defaults.researchSource === "ai" && defaults.emailSource === "ai", "默认来源必须是 ai，保持既有行为不变");
  check(defaults.cliAdapter === "workbuddy", "默认 CLI 适配器必须是 WorkBuddy");
  check(defaults.cliTimeoutSeconds === AI_ENGINE_CLI_TIMEOUT_DEFAULT, "默认超时必须等于常量默认值");

  check(RESEARCH_ENGINE_SOURCES.join(",") === "crm,ai,cli", "背调来源集合必须固定为 crm/ai/cli");
  check(EMAIL_ENGINE_SOURCES.join(",") === "template,ai,cli", "开发信来源集合必须固定为 template/ai/cli");
  check(aiEngineSourceLabel("cli") === "本机 CLI", "来源标签必须可读");
  check(aiEngineAdapterLabel("codex") === "Codex CLI" && aiEngineAdapterLabel("workbuddy") === "WorkBuddy CLI", "适配器标签必须区分 WorkBuddy / Codex");

  const dirty = sanitizeTeamAiEngineSettings("team_1", {
    researchSource: "gpt",
    emailSource: "cli",
    cliAdapter: "gemini",
    cliWorkspace: "   /srv/goodjob/workspace   ",
    cliTimeoutSeconds: 999_999,
    runnerId: " lrr_x ",
    updatedBy: "u_admin"
  }, defaults);
  check(dirty.researchSource === "ai", "非法来源必须回落到默认值，不能写进设置");
  check(dirty.emailSource === "cli", "合法来源必须保留");
  check(dirty.cliAdapter === "workbuddy", "非法适配器必须回落到 WorkBuddy");
  check(dirty.cliWorkspace === "/srv/goodjob/workspace", "工作目录必须 trim");
  check(dirty.cliTimeoutSeconds === AI_ENGINE_CLI_TIMEOUT_MAX, "超时必须被钳到 24 小时上限");
  check(dirty.runnerId === "lrr_x", "Runner 指定必须保留");
  check(clampAiEngineTimeout(0) === AI_ENGINE_CLI_TIMEOUT_MIN, "超时下限必须是 60 秒");
  check(clampAiEngineTimeout(Number.NaN) === AI_ENGINE_CLI_TIMEOUT_DEFAULT, "非法超时必须回落到默认值");

  check(resolveEngineSource(undefined, "cli", RESEARCH_ENGINE_SOURCES) === "cli", "未指定来源时必须用团队默认值");
  check(resolveEngineSource("crm", "cli", RESEARCH_ENGINE_SOURCES) === "crm", "显式来源必须优先于默认值");
  check(resolveEngineSource("bogus", "cli", RESEARCH_ENGINE_SOURCES) === "cli", "非法显式来源必须回落到默认值");

  // ── 1b. CLI 模型 / 思考档位（2026-10-10：用户反馈「走 CLI 后变傻」）──────────
  check(defaults.cliModel === AI_ENGINE_CLI_MODEL_DEFAULT && AI_ENGINE_CLI_MODEL_DEFAULT === "deepseek-v4.1-flash",
    "出厂默认模型必须显式指定为 deepseek-v4.1-flash，不能留空交给 CLI 那档随账号变化的默认");
  check(defaults.cliEffort === "", "思考档位默认仍留空 = 跟随 CLI 默认（用户只指定了模型）");
  check(AI_ENGINE_CLI_MODEL_IDS.has(AI_ENGINE_CLI_MODEL_DEFAULT),
    "出厂默认模型必须落在白名单内，否则会被 sanitize 回落成空串");
  check(AI_ENGINE_CLI_MODEL_IDS.has("fast-model") && AI_ENGINE_CLI_MODEL_IDS.has("deep-model"), "模型白名单必须包含 CLI 的通用别名");
  check(AI_ENGINE_CLI_MODEL_IDS.size === AI_ENGINE_CLI_MODELS.length, "模型清单不能有重复 id");
  check(AI_ENGINE_CLI_EFFORTS.includes("low") && AI_ENGINE_CLI_EFFORTS.includes("max"), "档位白名单必须覆盖 Runner 的 EFFORT_LEVELS");

  const modelOk = sanitizeTeamAiEngineSettings("team_1", { cliModel: " deep-model ", cliEffort: "HIGH" }, defaults);
  check(modelOk.cliModel === "deep-model", "合法模型必须保留并 trim");
  check(modelOk.cliEffort === "high", "档位必须小写归一");
  const modelBad = sanitizeTeamAiEngineSettings("team_1", { cliModel: "gpt-9", cliEffort: "turbo" }, { ...defaults, cliModel: "glm-5.3", cliEffort: "medium" });
  check(modelBad.cliModel === "glm-5.3", "非法模型必须回落到上一次的值，而不是写进一个永远不生效的设置");
  check(modelBad.cliEffort === "medium", "非法档位必须回落到上一次的值");
  const modelCleared = sanitizeTeamAiEngineSettings("team_1", { cliModel: "", cliEffort: "" }, { ...defaults, cliModel: "deep-model", cliEffort: "high" });
  check(modelCleared.cliModel === "" && modelCleared.cliEffort === "", "空串是合法值，表示回到「跟随 CLI 默认」");

  const noPatch = applyCliProfileToPrompt("你是助手", {});
  check(noPatch === "你是助手", "没有模型/档位时不能产生多余标记");
  const patched = applyCliProfileToPrompt("你是助手", { model: "deep-model", effort: "high" });
  check(patched.startsWith('[[gj-cli-options {"model":"deep-model","effort":"high"}]]\n'), "标记必须写在首行且 JSON 合法");
  check(patched.endsWith("你是助手"), "正文必须完整保留在标记之后");
  const merged = applyCliProfileToPrompt(
    '[[gj-cli-options {"effort":"low","maxTurns":6,"disallowedTools":["Glob","Grep"]}]]\n你是录入助手',
    { model: "deep-model", effort: "high" }
  );
  check(merged.includes('"maxTurns":6'), "合并时必须保留 maxTurns 这类硬约束");
  check(merged.includes('"disallowedTools":["Glob","Grep"]'), "合并时必须保留 disallowedTools");
  check(merged.includes('"model":"deep-model"') && merged.includes('"effort":"high"'), "模型与档位必须覆盖旧值");
  check(merged.endsWith("你是录入助手"), "合并后正文不能被吞掉");
  const brokenHeader = applyCliProfileToPrompt("[[gj-cli-options {坏掉的 JSON}]]\n正文", { model: "glm-5.3" });
  check(brokenHeader.startsWith('[[gj-cli-options {"model":"glm-5.3"}]]\n'), "坏标记要能重建成干净的一份");
  check(brokenHeader.endsWith("正文"), "坏标记场景下正文同样不能丢");

  // ── 2. 背调提示词 ──────────────────────────────────────────
  const researchPrompt = buildResearchCliPrompt({
    entityType: "customer",
    company: "Acme Trading LLC",
    country: "United States",
    business: "industrial weighing equipment",
    grade: "A",
    website: "https://acme.example",
    facts: [{ label: "客户分级", value: "A" }],
    contacts: [{ channel: "邮箱", value: "buyer@acme.example" }],
    sources: [{ title: "企业官网", url: "https://acme.example" }],
    context: ["邮件：已发送首封开发信"]
  });
  check(researchPrompt.includes("Acme Trading LLC"), "背调提示词必须带上主体名称");
  check(researchPrompt.includes("industrial weighing equipment"), "背调提示词必须带上业务信息");
  check(researchPrompt.includes('"sources"') && researchPrompt.includes('"findings"'), "背调提示词必须声明 JSON 输出结构");
  check(researchPrompt.includes("Return ONE JSON object"), "背调提示词必须要求只返回一个 JSON");
  check(researchPrompt.includes("untrusted data"), "背调提示词必须声明数据不可信，防提示词注入");
  check(researchPrompt.includes("do not scrape LinkedIn"), "背调提示词必须包含领英禁令");

  const emailPrompt = buildEmailCliPrompt("SUBJECT RULE\nWrite only in English.");
  check(emailPrompt.includes("Write only in English."), "开发信提示词必须完整保留开发信技能的原始约束");
  check(emailPrompt.includes("single-shot"), "开发信提示词必须声明一次性任务，避免 CLI 反问");

  // ── 3. JSON 抽取 ──────────────────────────────────────────
  const plain = extractEngineJson('{"summary":"a","score":80}');
  check(plain?.summary === "a" && plain?.score === 80, "纯 JSON 必须能直接解析");
  const fenced = extractEngineJson("好的，结果如下：\n```json\n{\"summary\":\"b\"}\n```\n以上。");
  check(fenced?.summary === "b", "围栏 JSON 必须能抠出来");
  const chatty = extractEngineJson('I checked the website. Here is the result:\n{"summary":"c","risks":[{"level":"high","title":"x","detail":"y"}]}\nDone.');
  check(chatty?.summary === "c", "带前后说明的 JSON 必须能抠出来");
  const nested = extractEngineJson('分析：{"a":{"b":1},"s":"}"} 完毕');
  check(nested?.s === "}" && (nested?.a as Record<string, unknown> | undefined)?.b === 1, "字符串里含花括号也不能误判闭合");
  check(extractEngineJson("完全不包含 JSON 的一段话") === null, "没有 JSON 时必须返回 null");
  check(extractEngineJson("") === null, "空输出必须返回 null");
  const last = extractEngineJson('{"summary":"first"}\n其实最终结果：\n{"summary":"last"}');
  check(last?.summary === "last", "多个 JSON 时必须取最后一个（CLI 常先打印草稿再打印结论）");

  // ── 4. 补丁规范化 ──────────────────────────────────────────
  const patch = normalizeResearchPatch({
    summary: "  引擎结论  ",
    score: 88.4,
    opportunities: ["确认采购节奏", "", 42],
    risks: [{ level: "urgent", title: "风险", detail: "依据" }, { level: "low", title: "只有标题" }],
    talkTracks: ["Would you like the spec sheet?"],
    findings: [{ label: "员工规模", value: "约 50 人" }, { label: "", value: "无效" }],
    sources: [{ title: "新闻", url: "https://news.example/a" }, { title: "非法", url: "javascript:alert(1)" }],
    nextAction: "发规格书"
  });
  check(patch.summary === "引擎结论", "补丁必须 trim 字符串");
  check(patch.score === 88.4, "补丁必须保留合法分数");
  check(patch.opportunities.length === 1 && patch.opportunities[0] === "确认采购节奏", "补丁必须丢弃非字符串机会项");
  // 2026-10-10 起口径改为「信息尽量全面」：只给标题的风险、只给 value 的调研条目都保留，
  // 不再因为「另一个字段为空」整条丢弃（那正是「CLI 挖到了、界面上却没有」的常见成因）。
  check(patch.risks.length === 2 && patch.risks[0]!.level === "medium" && patch.risks[1]!.title === "只有标题",
    "非法风险等级回落 medium；只有标题的风险也保留");
  check(patch.findings.length === 2 && patch.findings[1]!.label === "无效", "缺 label 的调研条目用 value 兜底保留");
  check(patch.sources.length === 1 && patch.sources[0]!.url === "https://news.example/a", "只有 http(s) 来源才允许保留");

  const empty = normalizeResearchPatch(null);
  check(empty.score === null && empty.summary === "" && empty.risks.length === 0, "空输入必须得到空补丁而不是抛错");

  const emailPatch = normalizeEmailPatch({ subject: " Subject ", body: "Body\n", extra: 1 });
  check(emailPatch.subject === "Subject" && emailPatch.body === "Body", "开发信补丁必须只取 subject/body");

  // ── 5. 骨架回填 ────────────────────────────────────────────
  const base = skeleton();
  const applied = applyResearchEnginePatch(base, {
    summary: "引擎重写的结论",
    score: 91,
    risks: [{ level: "high", title: "付款条件", detail: "有拖欠记录" }],
    findings: [{ label: "员工规模", value: "约 50 人" }],
    sources: [{ title: "行业新闻", url: "https://news.example/a" }]
  });
  check(applied.research.summary === "引擎重写的结论", "引擎结论必须覆盖骨架结论");
  check(applied.research.score === 91, "引擎分数必须回填");
  check(applied.research.risks.length === 1 && applied.research.risks[0]!.level === "high", "引擎风险必须替换骨架风险");
  check(applied.research.facts.some((fact) => fact.group === "引擎补充"), "引擎补充的事实必须单独成组，不能和 CRM 事实混淆");
  check(applied.research.facts.some((fact) => fact.label === "主体" && !fact.group), "CRM 自己的事实必须保留");
  check(applied.research.sources.some((source) => source.authority === "引擎引用"), "引擎引用来源必须标记 authority");
  check(applied.research.sources.some((source) => source.url === "https://acme.example"), "CRM 已有来源必须保留");
  check(applied.research.crmOnly === false, "引擎引用了公开来源时 crmOnly 必须变 false");
  check(applied.applied.includes("summary") && applied.applied.includes("sources"), "必须记录实际回填了哪些字段");

  // 重复来源不得重复登记
  const deduped = applyResearchEnginePatch(base, { sources: [{ title: "企业官网", url: "https://acme.example" }] });
  check(deduped.research.sources.length === base.sources.length, "URL 已存在的来源不得重复登记");
  check(deduped.research.crmOnly === true, "没有新增来源时不得改动 crmOnly");

  // 引擎什么都没返回：骨架必须原样保留（不能把背调搞崩）
  const noop = applyResearchEnginePatch(base, { nonsense: true });
  check(noop.applied.length === 0, "无效输出不得改动任何字段");
  check(noop.research.summary === base.summary && noop.research.score === base.score, "无效输出必须原样保留 CRM 骨架");
  check(noop.research === base || noop.research.facts.length === base.facts.length, "无效输出不得增删事实");

  // 分数越界必须收敛
  const clamped = applyResearchEnginePatch(base, { score: 1000 });
  check(clamped.research.score === 97, "引擎分数上限必须收敛到 97");

  // ── 4. CLI 不可用必须是「可恢复冲突」而不是 500 ─────────────
  // 实测：Runner 离线时前端只看到「服务器处理请求失败」，用户不知道该起 Runner 还是换来源。
  const offline = new EngineUnavailableError("AI_ENGINE_RUNNER_OFFLINE", "Runner 离线");
  check(offline.status === 409, "Runner 离线属于可恢复冲突，必须回 409 而不是 500");
  check(offline.code === "AI_ENGINE_RUNNER_OFFLINE", "必须带上机器可读 code 供前端提示");
  check(offline instanceof Error, "必须仍是 Error，交给统一错误处理");
  check(new EngineUnavailableError("AI_ENGINE_REPOSITORY_UNAVAILABLE", "无档位", 503).status === 503, "档位缺能力才是 503");

  // 没有本地 Runner 服务（未走 MySQL 档位）时挑机器必须抛 503，而不是静默返回某个 Runner
  const noService = await pickEngineRunner(
    { id: "u_1", teamId: "team_1", role: "admin" } as never,
    defaultTeamAiEngineSettings("team_1")
  ).then(() => null, (error: unknown) => error as EngineUnavailableError);
  check(noService instanceof EngineUnavailableError, "没有 Runner 服务时必须抛出可识别的错误");
  check(noService?.status === 503 && noService?.code === "AI_ENGINE_RUNNER_UNAVAILABLE",
    "缺少 Runner 持久化能力必须回 503 + AI_ENGINE_RUNNER_UNAVAILABLE");

  // ---- CLI 获客（kind=search）：提示词口径 + 结果规范化 ----
  const acquisitionPrompt = buildAcquisitionCliPrompt({
    goal: "寻找德国水处理分销商",
    productKeywords: "water treatment",
    countries: "Germany",
    industry: "",
    customerType: "distributor",
    excludeKeywords: "retail",
    limit: 8
  });
  check(acquisitionPrompt.includes("public sources only"), "获客提示词必须内嵌获客技能的「只用公开来源」硬约束");
  check(acquisitionPrompt.includes("never invent company names"), "获客提示词必须明确禁止编造公司");
  check(acquisitionPrompt.includes("scrape LinkedIn") === false || acquisitionPrompt.includes("do not scrape LinkedIn"),
    "获客提示词必须明确禁止爬领英");
  check(acquisitionPrompt.includes("water treatment") && acquisitionPrompt.includes("Germany"),
    "搜索条件必须进提示词");
  check(acquisitionPrompt.includes('"requestedCount"'), "目标数量必须进提示词");

  const dirtyAcquisition = extractEngineJson('前缀说明\n```json\n{"companies":[{"company":" Acme GmbH ","website":"https://acme.example","country":"Germany","business":"water systems","description":"匹配","sourceUrl":"https://search.example/acme","confidence":88},{"company":"","website":"https://junk.example"},{"website":"https://noname.example"},{"company":"Bad Site","website":"ftp://nope.example"},{"company":"No Site"}]}\n```');
  const companies = normalizeAcquisitionCompanies(dirtyAcquisition);
  check(companies.length === 3, `脏输出规范化后应只剩 3 条有公司名的条目（实际 ${companies.length}）`);
  check(companies[0]?.company === "Acme GmbH", "公司名应去首尾空白");
  check(companies[0]?.website === "https://acme.example" && companies[0]?.sourceUrl === "https://search.example/acme",
    "合法官网与来源 URL 应保留");
  check(companies[0]?.confidence === 88, "置信度应保留");
  check(companies[1]?.company === "Bad Site" && companies[1]?.website === "",
    "非法协议（ftp）的网址应清空、公司名保留");
  check(companies[2]?.company === "No Site" && companies[2]?.website === "", "没有官网的条目应保留公司、网址为空");
  check(normalizeAcquisitionCompanies(null).length === 0 && normalizeAcquisitionCompanies({}).length === 0,
    "空输入/缺 companies 时应返回空数组而不是抛错");
  check(normalizeAcquisitionCompanies({ companies: "oops" } as never).length === 0,
    "companies 不是数组时应返回空数组而不是抛错");

  // ── 增量获客：@@FOUND@@ 标记行提取（CLI 边搜边回协议）───────────────────────
  check(acquisitionPrompt.includes("@@FOUND@@") && acquisitionPrompt.includes("IMMEDIATELY print a single line"),
    "获客提示词必须包含 @@FOUND@@ 增量标记协议（边搜边回，不等任务结束）");
  check(acquisitionPrompt.includes("STILL return the final JSON object"),
    "增量协议必须同时保留最终 JSON 汇总要求（最终记录以汇总为准）");

  // ── 2c. CLI 技能点名加载（2026-10-10：放对位置 ≠ CLI 会用它）──────────────
  // 四个领域技能包改名后，提示词必须点名新名字；名字还必须与磁盘上的目录名 + frontmatter
  // 逐字一致——Runner 只是把目录注入 CLI 的扫描路径，名字对不上就等于没加载，
  // 而且**不会有任何报错**，只表现为输出质量静默降档。这条断言就是防这种「静默失效」。
  //
  // ⚠️ 技能包自 r42 起**不进版本库**（改为独立成品包分发），所以磁盘核对是**条件断言**：
  // 本机装了技能就逐字核对，没装（比如刚 checkout 的干净环境）就跳过——否则别人跑
  // `npm test` 会因为「没有技能目录」而红，那是环境缺失，不是代码错了。
  const tenderPrompt = buildTenderDailyCliPrompt({
    reportDate: "2026-10-10",
    companyName: "New Land",
    productSummary: "industrial weighing scales",
    regions: "Vietnam",
    focusNote: ""
  });
  const skillPrompts: Record<keyof typeof ENGINE_CLI_SKILLS, string> = {
    research: researchPrompt,
    acquisition: acquisitionPrompt,
    tender: tenderPrompt,
    email: emailPrompt
  };
  let skillDiskChecked = 0;
  let skillDiskSkipped = 0;
  for (const kind of Object.keys(ENGINE_CLI_SKILLS) as Array<keyof typeof ENGINE_CLI_SKILLS>) {
    const skillName = ENGINE_CLI_SKILLS[kind];
    check(skillPrompts[kind].includes(engineSkillDirective(skillName)),
      `「${kind}」提示词必须点名加载技能 ${skillName}`);
    check(skillPrompts[kind].includes(`\`${skillName}\``),
      `「${kind}」提示词必须以反引号形式引用技能名 ${skillName}`);
    const skillPath = fileURLToPath(new URL(`../../.workbuddy/skills/${skillName}/SKILL.md`, import.meta.url));
    if (existsSync(skillPath)) {
      skillDiskChecked += 1;
      const frontmatter = readFileSync(skillPath, "utf8").split("\n").slice(0, 6).join("\n");
      check(frontmatter.includes(`name: ${skillName}`),
        `技能 frontmatter 名必须与提示词一致（${skillName}）`);
    } else {
      skillDiskSkipped += 1;
    }
  }
  if (skillDiskSkipped > 0) {
    console.log(`  · 技能包未安装（${skillDiskSkipped}/${skillDiskChecked + skillDiskSkipped} 个目录不存在），跳过磁盘核对；`
      + "提示词点名断言仍已全部执行。装技能包后本项会自动开启。");
  }
  check(new Set(Object.values(ENGINE_CLI_SKILLS)).size === 4, "四个技能名不得重复");
  check(Object.values(ENGINE_CLI_SKILLS).every((name) => /^goodjob-[a-z-]+$/.test(name)),
    "技能名必须是小写连字符的 goodjob-* 形式");
  check(tenderPrompt.includes('"previouslyReported"'), "日报提示词必须带上跨期去重字段");

  const streamText = [
    "我先核实了这两家：",
    '@@FOUND@@ {"company": "Alpha Coatings", "website": "https://alpha.example", "country": "Malaysia", "business": "coatings", "description": "匹配", "sourceUrl": "https://alpha.example/about", "confidence": 80}',
    "继续找……",
    '@@FOUND@@ {"company": "beta paints", "website": "https://beta.example", "country": "Malaysia"}',
    '@@FOUND@@ {"company": "Alpha Coatings", "website": "https://alpha.example"}',
    "@@FOUND@@ {broken json",
    "最终汇总略。"
  ].join("\n");
  const findings = extractAcquisitionFindings(streamText);
  check(findings.length === 2, `@@FOUND@@ 提取应去重并丢弃脏行（期望 2 条，实际 ${findings.length}）`);
  check(findings[0]?.company === "Alpha Coatings" && findings[0]?.confidence === 80,
    "首条发现应完整规范化（公司名 + 置信度）");
  check(findings[1]?.company === "beta paints" && findings[1]?.website === "https://beta.example",
    "第二家应保留（大小写/去重按 公司名|网址 签名）");
  check(extractAcquisitionFindings("").length === 0 && extractAcquisitionFindings("没有任何标记").length === 0,
    "无标记文本应返回空数组而不是抛错");

  console.log(JSON.stringify({
    ok: true,
    checked: checked.length,
    assertions: checked.length
  }, null, 2));
}

await main();
