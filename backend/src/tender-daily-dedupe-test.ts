import {
  buildTenderDailyCliPrompt,
  collectReportedTenderLines,
  dedupeTenderItems,
  normalizeTenderReport,
  tenderReferenceKey,
  tenderSourceTier,
  tenderTitleKey,
  tenderUrlKey,
  type TenderDailyItem
} from "./ai-engine-prompts.js";

let passed = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

function item(overrides: Partial<TenderDailyItem> = {}): TenderDailyItem {
  return {
    title: "Supply of industrial coating equipment for port authority",
    country: "印度尼西亚",
    buyer: "PT Pelabuhan Indonesia",
    products: "涂装设备",
    deadline: "",
    budget: "",
    status: "open",
    sourceUrl: "https://procurement.example.go.id/notice/1001",
    relevance: 80,
    action: "48 小时内联系招标代理",
    ...overrides
  };
}

// ── tenderUrlKey：归一化 ──
check(tenderUrlKey("https://WWW.Example.com/Tender/123/") === tenderUrlKey("http://example.com/Tender/123"),
  "协议 / www / 大小写 host / 尾斜杠归一一致");
check(tenderUrlKey("https://example.com/t?id=1&utm_source=news") === tenderUrlKey("https://example.com/t?id=1"),
  "utm_* 跟踪参数剥离");
check(tenderUrlKey("https://example.com/t?id=1&b=2") === tenderUrlKey("https://example.com/t?b=2&id=1"),
  "query 顺序无关");
check(tenderUrlKey("https://example.com/t?id=1") !== tenderUrlKey("https://example.com/t?id=2"),
  "真业务参数（公告 id）必须保留，不得误折叠");
check(tenderUrlKey("https://example.com/a#section") === tenderUrlKey("https://example.com/a"),
  "hash 剥离");
check(tenderUrlKey("") === "", "空链接 → 空键");

// ── tenderTitleKey：标题指纹 ──
check(tenderTitleKey("Supply of  Industrial Coating Equipment!") === tenderTitleKey("supply of industrial coating equipment"),
  "标题指纹：大小写 / 标点 / 多余空白归一");
check(tenderTitleKey("A/B") !== tenderTitleKey("AB"), "标题指纹不吞掉词内字符");

// ── tenderReferenceKey：公告编号指纹 ──
check(tenderReferenceKey("SPD3/2026/051 - FRAMEWORK CONTRACT FOR PAINTING MATERIALS") === "spd32026051",
  "编号指纹：字母段/年份/序号");
check(tenderReferenceKey("Framework contract for painting materials (ref SPD3/2026/051)") === "spd32026051",
  "编号在标题任意位置都能提取（括注形式）");
check(tenderReferenceKey("GEM/2026/B/8109997 (9976880) - SUPPLY OF 100 TON WEIGHBRIDGE") === "gem2026b8109997",
  "多段编号整体提取");
check(tenderReferenceKey("No reference number in this title") === "", "无编号 → 空键");
check(tenderReferenceKey("AB/2026/1") === "", "过短编号（<8 字符）不作键，避免跨机构误撞");

const refDedupe = dedupeTenderItems([
  item({ title: "SPD3/2026/051 - Framework contract for painting materials", sourceUrl: "https://www.tendersontime.com/x" }),
  item({ title: "Supply and delivery of paints and varnishes (ref SPD3/2026/051)", sourceUrl: "https://www.etenders.gov.mt/epps/cft/prepareViewCfTWS.do?resourceId=14142315" })
]);
check(refDedupe.length === 1 && refDedupe[0].sourceUrl.includes("etenders.gov.mt"),
  "编号相同但标题被聚合站改写 → 仍折叠，且保留官方门户");

const refDistinct = dedupeTenderItems([
  item({ title: "Supply of coating equipment ref AA/2026/100 for port A", sourceUrl: "https://a.gov.id/1" }),
  item({ title: "Supply of coating equipment ref AA/2026/101 for port B", sourceUrl: "https://b.gov.id/2" })
]);
check(refDistinct.length === 2, "编号不同 → 不同项目，不误折叠");

// ── dedupeTenderItems：轮内折叠 ──
const sameUrl = dedupeTenderItems([
  item({ title: "Tender A for coating equipment" }),
  item({ title: "完全不同的标题但同一公告页", sourceUrl: "https://procurement.example.go.id/notice/1001/" })
]);
check(sameUrl.length === 1, "归一化链接相同 → 折叠为一条");

const sameTitle = dedupeTenderItems([
  item({ sourceUrl: "https://agg-one.com/x" }),
  item({ sourceUrl: "https://agg-two.com/y" })
]);
check(sameTitle.length === 1, "标题指纹相同（≥8 字符）→ 折叠为一条");

const officialWins = dedupeTenderItems([
  item({ sourceUrl: "https://www.globaltenders.com/notice/1001" }),
  item({ sourceUrl: "https://procurement.example.go.id/notice/1001" })
]);
check(officialWins.length === 1 && officialWins[0].sourceUrl.includes("example.go.id"),
  "聚合站先出现、官方门户后出现 → 保留官方门户（而不是先到先得）");

const officialFirst = dedupeTenderItems([
  item({ sourceUrl: "https://procurement.example.go.id/notice/1001" }),
  item({ sourceUrl: "https://www.globaltenders.com/notice/1001" })
]);
check(officialFirst.length === 1 && officialFirst[0].sourceUrl.includes("example.go.id"),
  "官方门户先出现 → 保留官方门户，不被聚合站替换");

const tierOrder = dedupeTenderItems([
  item({ sourceUrl: "https://some-utility.example.com/notice/1001" }),
  item({ sourceUrl: "https://www.tendersinfo.com/notice/1001" })
]);
check(tierOrder.length === 1 && tierOrder[0].sourceUrl.includes("some-utility.example.com"),
  "普通站先出现、聚合站后出现 → 保留普通站（更弱的不覆盖更强的）");

const tierPromote = dedupeTenderItems([
  item({ sourceUrl: "https://www.tendersinfo.com/notice/1001" }),
  item({ sourceUrl: "https://some-utility.example.com/notice/1001" })
]);
check(tierPromote.length === 1 && tierPromote[0].sourceUrl.includes("some-utility.example.com"),
  "聚合站先出现、普通站后出现 → 普通站替换聚合站");

check(tenderSourceTier("https://procurement.example.go.id/x") === 0
  && tenderSourceTier("https://www.globaltenders.com/x") === 2
  && tenderSourceTier("https://some-utility.example.com/x") === 1
  && tenderSourceTier("https://www.worldbank.org/x") === 0,
  "来源分级：政府门户/国际组织 = 0、普通站 = 1、聚合站 = 2");

const shortTitle = dedupeTenderItems([
  item({ title: "Paint", sourceUrl: "https://a.com/1" }),
  item({ title: "PAINT", sourceUrl: "https://b.com/2" })
]);
check(shortTitle.length === 2, "短标题（<8 字符）不参与标题折叠 → 保守保留两条");

const distinct = dedupeTenderItems([
  item({ title: "Supply of coating equipment for port A", sourceUrl: "https://a.go.id/1" }),
  item({ title: "Supply of coating equipment for port B", sourceUrl: "https://b.go.id/2" })
]);
check(distinct.length === 2, "不同项目不误折叠");
check(dedupeTenderItems([]).length === 0, "空输入不炸");

// ── normalizeTenderReport：整链兜底 ──
const normalized = normalizeTenderReport({
  tenders: [
    { title: "Supply of industrial coating equipment", sourceUrl: "https://agg-a.com/1", status: "open" },
    { title: "Supply of Industrial Coating Equipment!", sourceUrl: "https://www.globaltenders.com/1", status: "open" },
    { title: "Supply of industrial coating equipment", sourceUrl: "https://procurement.gov.id/1", status: "open" },
    { title: "脏数据（无链接）", sourceUrl: "" },
    { title: "", sourceUrl: "https://procurement.gov.id/2" }
  ]
}, { engine: "cli", completedAt: "2026-10-10T00:00:00Z", reportDate: "2026-10-10" });
check(normalized.tenders.length === 1, "三条转载 + 两条脏数据 → 只剩一条");
check(normalized.tenders[0].sourceUrl.includes("procurement.gov.id"),
  "折叠后保留的是官方门户链接");

// 去重必须发生在截断之前：17 条里前 6 条是重复，若先截断则有效条目不足
const many = Array.from({ length: 17 }, (_, index) => index < 6
  ? { title: "Supply of industrial coating equipment lot A", sourceUrl: "https://dupe.example.com/x", status: "open" }
  : { title: `Distinct tender number ${index} for coating equipment`, sourceUrl: `https://portal.gov.id/${index}`, status: "open" });
const truncate = normalizeTenderReport({ tenders: many }, { engine: "cli", completedAt: "x", reportDate: "2026-10-10" });
check(truncate.tenders.length === 12, "先去重再截断：17 条含 6 条同一链接 → 12 条唯一，不因重复条目挤掉名额");
check(new Set(truncate.tenders.map((row) => row.sourceUrl)).size === truncate.tenders.length,
  "输出条目链接唯一");

// ── collectReportedTenderLines：跨期清单 ──
const history = [
  { reportDate: "2026-10-09", tenders: [item({ title: "Yesterday tender about coating lines" })] },
  { reportDate: "2026-10-08", tenders: [item({ title: "Another tender about coating lines" }), item({ title: "Same as yesterday tender about coating lines" })] },
  { reportDate: "2026-10-10", tenders: [item({ title: "Today tender should be excluded entirely" })] },
  { reportDate: "2026-09-20", tenders: [item({ title: "Too old tender beyond the window" })] },
  null,
  { reportDate: "bad-date", tenders: [item()] }
];
const lines = collectReportedTenderLines(history, { excludeDate: "2026-10-10", days: 7 });
check(lines.length === 3, "近 7 天清单只收 3 条（排除当天 / 超窗 / 非法日期）");
check(!lines.some((line) => line.includes("Today tender")), "当天那份被排除（force 重查不会自我屏蔽）");
check(!lines.some((line) => line.includes("Too old")), "超出去重窗口的旧报告不计入");
check(lines.every((line) => line.includes("｜")), "清单行带分隔符，含标题/采购方/国家/链接");
check(collectReportedTenderLines(history, { excludeDate: "2026-10-10", days: 7, limit: 2 }).length === 2,
  "limit 生效");
check(collectReportedTenderLines([], { excludeDate: "2026-10-10" }).length === 0, "无历史 → 空清单");

// ── buildTenderDailyCliPrompt：跨期规则注入 ──
const base = { reportDate: "2026-10-10", companyName: "示例公司", productSummary: "涂装设备", regions: "", focusNote: "" };
const withHistory = buildTenderDailyCliPrompt({ ...base, previouslyReported: lines });
check(withHistory.includes('"previouslyReported":[{"') === false && withHistory.includes('"previouslyReported":["'),
  "提示词 DATA 块带 previouslyReported 清单（数组元素为字符串行）");
check(withHistory.includes("Already-reported filter"), "提示词带跨期去重规则段");
check(withHistory.includes("MATERIAL new development") && withHistory.includes("新进展："),
  "规则要求仅实质进展才可重报，并写明新进展");
check(withHistory.includes("Duplicate collapsing"), "提示词带轮内转载折叠规则");
const withoutHistory = buildTenderDailyCliPrompt(base);
check(withoutHistory.includes('"previouslyReported":[]'), "无历史时清单为空数组，规则段仍在（不改变既有行为）");

console.log(`tender-daily-dedupe-test: ${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
