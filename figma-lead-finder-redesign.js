// GoodJob CRM 自动获客页 Figma MCP use_figma script
// 用法：在已连接 Figma MCP 的 Codex 会话中，将本脚本作为 use_figma 的 code 执行。
// 注意：这是 use_figma 运行时脚本，使用 top-level await 和 return，不调用 figma.closePlugin。

await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Medium" });
await figma.loadFontAsync({ family: "Inter", style: "Bold" });

const ids = [];
const c = {
  ink: { r: 17 / 255, g: 24 / 255, b: 39 / 255 },
  text: { r: 51 / 255, g: 65 / 255, b: 85 / 255 },
  muted: { r: 102 / 255, g: 117 / 255, b: 139 / 255 },
  line: { r: 223 / 255, g: 231 / 255, b: 242 / 255 },
  soft: { r: 248 / 255, g: 251 / 255, b: 1 },
  page: { r: 244 / 255, g: 247 / 255, b: 251 / 255 },
  blue: { r: 49 / 255, g: 87 / 255, b: 213 / 255 },
  teal: { r: 15 / 255, g: 159 / 255, b: 149 / 255 },
  amber: { r: 180 / 255, g: 112 / 255, b: 25 / 255 },
  white: { r: 1, g: 1, b: 1 }
};

function solid(color) {
  return [{ type: "SOLID", color }];
}

function frame(name, width, height, fill = c.white) {
  const node = figma.createFrame();
  node.name = name;
  node.resize(width, height);
  node.fills = solid(fill);
  node.cornerRadius = 8;
  node.clipsContent = false;
  ids.push(node.id);
  return node;
}

function auto(node, mode, gap, pad) {
  node.layoutMode = mode;
  node.itemSpacing = gap;
  node.paddingTop = pad;
  node.paddingRight = pad;
  node.paddingBottom = pad;
  node.paddingLeft = pad;
  node.counterAxisSizingMode = "FIXED";
}

function text(name, value, size, style = "Regular", color = c.ink) {
  const node = figma.createText();
  node.name = name;
  node.fontName = { family: "Inter", style };
  node.fontSize = size;
  node.lineHeight = { unit: "PIXELS", value: Math.round(size * 1.45) };
  node.letterSpacing = { unit: "PERCENT", value: 0 };
  node.characters = value;
  node.fills = solid(color);
  ids.push(node.id);
  return node;
}

function card(parent, name, width, height) {
  const node = frame(name, width, height);
  node.strokes = solid(c.line);
  node.strokeWeight = 1;
  node.effects = [{ type: "DROP_SHADOW", color: { r: 23 / 255, g: 35 / 255, b: 61 / 255, a: .06 }, offset: { x: 0, y: 12 }, radius: 26, spread: 0, visible: true, blendMode: "NORMAL" }];
  auto(node, "VERTICAL", 10, 14);
  parent.appendChild(node);
  return node;
}

function metric(parent, label, value, hint) {
  const node = card(parent, "指标/" + label, 250, 66);
  node.appendChild(text("Label", label, 11, "Medium", c.muted));
  node.appendChild(text("Value", value, 21, "Bold", c.ink));
  node.appendChild(text("Hint", hint, 10, "Regular", c.muted));
  return node;
}

function field(parent, label, value, width = 216) {
  const wrap = frame("字段/" + label, width, 56, c.white);
  wrap.fills = [];
  auto(wrap, "VERTICAL", 4, 0);
  wrap.appendChild(text("Label", label, 11, "Bold", c.muted));
  const input = frame("输入/" + label, width, 32, c.white);
  input.strokes = solid(c.line);
  input.strokeWeight = 1;
  auto(input, "HORIZONTAL", 0, 9);
  input.appendChild(text("Value", value, 11, "Regular", c.text));
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return wrap;
}

function chip(parent, label, sub, checked = true) {
  const node = frame("渠道/" + label, 218, 36, c.white);
  node.strokes = solid(c.line);
  node.strokeWeight = 1;
  auto(node, "HORIZONTAL", 8, 8);
  node.counterAxisAlignItems = "CENTER";
  const mark = frame("Check", 14, 14, checked ? c.teal : c.page);
  mark.cornerRadius = 3;
  mark.strokes = solid(checked ? c.teal : c.line);
  node.appendChild(mark);
  const t = frame("文字", 146, 20, c.white);
  t.fills = [];
  auto(t, "VERTICAL", 0, 0);
  t.appendChild(text("Name", label, 11, "Bold", c.ink));
  t.appendChild(text("Sub", sub, 9, "Regular", c.muted));
  node.appendChild(t);
  parent.appendChild(node);
  return node;
}

function job(parent, title, status, progress, tone) {
  const node = card(parent, "任务/" + title, 556, 154);
  const top = frame("任务头", 528, 36, c.white);
  top.fills = [];
  auto(top, "HORIZONTAL", 10, 0);
  const copy = frame("标题组", 402, 34, c.white);
  copy.fills = [];
  auto(copy, "VERTICAL", 2, 0);
  copy.appendChild(text("Title", title, 14, "Bold", c.ink));
  copy.appendChild(text("Desc", "公开API + 平台入口 + 官网解析 + 交叉验证", 10, "Regular", c.muted));
  top.appendChild(copy);
  const badge = frame("状态/" + status, 74, 24, tone);
  auto(badge, "HORIZONTAL", 0, 8);
  badge.primaryAxisAlignItems = "CENTER";
  badge.counterAxisAlignItems = "CENTER";
  badge.appendChild(text("Badge", status, 10, "Bold", c.white));
  top.appendChild(badge);
  node.appendChild(top);
  const metrics = frame("任务指标", 528, 43, c.white);
  metrics.fills = [];
  auto(metrics, "HORIZONTAL", 6, 0);
  ["线索进度 10/20", "已耗时 2分钟", "启用渠道 7个", "预计进度 " + progress + "%"].forEach((item) => {
    const m = frame("指标/" + item, 124, 42, c.soft);
    m.strokes = solid(c.line);
    m.strokeWeight = 1;
    auto(m, "VERTICAL", 1, 7);
    const parts = item.split(" ");
    m.appendChild(text("MLabel", parts[0], 9, "Regular", c.muted));
    m.appendChild(text("MValue", parts.slice(1).join(" "), 12, "Bold", c.ink));
    metrics.appendChild(m);
  });
  node.appendChild(metrics);
  const bar = frame("进度条", 528, 5, { r: 234 / 255, g: 240 / 255, b: 248 / 255 });
  bar.cornerRadius = 999;
  const fill = frame("进度", Math.round(528 * progress / 100), 5, tone);
  fill.cornerRadius = 999;
  bar.appendChild(fill);
  node.appendChild(bar);
  const steps = frame("阶段", 528, 24, c.white);
  steps.fills = [];
  auto(steps, "HORIZONTAL", 5, 0);
  ["生成搜索语法", "检索公开API", "提取公司资料", "等待同步"].forEach((s, i) => {
    const p = frame("阶段/" + s, 92, 22, { r: 232 / 255, g: 248 / 255, b: 247 / 255 });
    auto(p, "HORIZONTAL", 0, 6);
    p.primaryAxisAlignItems = "CENTER";
    p.counterAxisAlignItems = "CENTER";
    p.appendChild(text("Step", `${i + 1} ${s}`, 9, "Bold", { r: 15 / 255, g: 118 / 255, b: 110 / 255 }));
    steps.appendChild(p);
  });
  node.appendChild(steps);
  return node;
}

const page = figma.createPage();
page.name = "自动获客重设计";
await figma.setCurrentPageAsync(page);

const app = frame("自动获客 / GoodJob CRM", 1440, 1080, c.page);
app.x = 120;
app.y = 80;
auto(app, "VERTICAL", 12, 22);
page.appendChild(app);

const head = frame("页面标题", 1396, 62, c.page);
head.fills = [];
auto(head, "HORIZONTAL", 16, 0);
head.counterAxisAlignItems = "CENTER";
const titleBox = frame("标题组", 1040, 58, c.page);
titleBox.fills = [];
auto(titleBox, "VERTICAL", 2, 0);
titleBox.appendChild(text("Eyebrow", "Auto Prospecting", 11, "Bold", c.teal));
titleBox.appendChild(text("Title", "自动获客", 24, "Bold", c.ink));
titleBox.appendChild(text("Sub", "先定义目标客户画像，再用公开 API、平台入口和官网解析生成可跟进的候选客户。", 12, "Regular", c.muted));
head.appendChild(titleBox);
["AI配置", "导出结果"].forEach((name) => {
  const btn = frame("按钮/" + name, 82, 30, name === "AI配置" ? c.white : c.blue);
  btn.strokes = solid(name === "AI配置" ? c.line : c.blue);
  btn.strokeWeight = 1;
  auto(btn, "HORIZONTAL", 0, 10);
  btn.primaryAxisAlignItems = "CENTER";
  btn.counterAxisAlignItems = "CENTER";
  btn.appendChild(text("Label", name, 11, "Bold", name === "AI配置" ? c.text : c.white));
  head.appendChild(btn);
});
app.appendChild(head);

const metrics = frame("顶部指标", 1396, 76, c.page);
metrics.fills = [];
auto(metrics, "HORIZONTAL", 10, 0);
metric(metrics, "候选结果", "0", "来自公开源与导入链接");
metric(metrics, "待确认", "0", "可转客户/商机");
metric(metrics, "已同步", "0", "进入CRM闭环");
metric(metrics, "解析模式", "规则", "未启用时使用规则解析");
app.appendChild(metrics);

const workbench = frame("任务工作区", 1396, 482, c.page);
workbench.fills = [];
auto(workbench, "HORIZONTAL", 12, 0);
const build = card(workbench, "创建搜客任务", 672, 482);
build.appendChild(text("Panel Title", "创建搜客任务", 16, "Bold", c.ink));
const row1 = frame("模式行", 644, 58, c.white);
row1.fills = [];
auto(row1, "HORIZONTAL", 9, 0);
field(row1, "搜客模式", "公开公司获客", 318);
field(row1, "搜索深度", "标准：产品 + 市场 + 客户类型", 318);
build.appendChild(row1);
field(build, "获客目标", "找德国、英国做压力/流量/液位仪表的分销商、系统集成商或EPC工程商。", 644);
const grid = frame("条件网格", 644, 122, c.white);
grid.fills = [];
auto(grid, "HORIZONTAL", 9, 0);
const colA = frame("条件左", 318, 122, c.white);
colA.fills = [];
auto(colA, "VERTICAL", 8, 0);
field(colA, "产品关键词", "pressure transmitter, flow meter", 318);
field(colA, "行业/应用场景", "water treatment, automation", 318);
const colB = frame("条件右", 318, 122, c.white);
colB.fills = [];
auto(colB, "VERTICAL", 8, 0);
field(colB, "国家/地区", "Germany, UK, Turkey, UAE", 318);
field(colB, "客户类型", "经销商 / Distributor", 318);
grid.appendChild(colA);
grid.appendChild(colB);
build.appendChild(grid);
const sources = frame("获客来源", 644, 128, c.soft);
sources.strokes = solid(c.line);
sources.strokeWeight = 1;
auto(sources, "VERTICAL", 7, 10);
sources.appendChild(text("Source title", "获客来源", 13, "Bold", c.ink));
const chipGrid = frame("渠道网格", 624, 78, c.soft);
chipGrid.fills = [];
auto(chipGrid, "HORIZONTAL", 7, 0);
const chipCol1 = frame("渠道列1", 306, 78, c.soft);
chipCol1.fills = [];
auto(chipCol1, "VERTICAL", 6, 0);
chip(chipCol1, "GLEIF", "公开API");
chip(chipCol1, "Google/Web", "搜索入口");
const chipCol2 = frame("渠道列2", 306, 78, c.soft);
chipCol2.fills = [];
auto(chipCol2, "VERTICAL", 6, 0);
chip(chipCol2, "Wikidata", "公开API");
chip(chipCol2, "Alibaba RFQ", "询盘入口");
chipGrid.appendChild(chipCol1);
chipGrid.appendChild(chipCol2);
sources.appendChild(chipGrid);
build.appendChild(sources);

const queue = card(workbench, "任务队列", 712, 482);
queue.appendChild(text("Panel Title", "任务队列", 16, "Bold", c.ink));
job(queue, "Germany · pressure transmitter · Distributor", "已完成", 100, c.teal);
job(queue, "Turkey · flow meter · System Integrator", "运行中", 58, c.blue);
const query = card(queue, "搜索入口", 684, 90);
query.effects = [];
query.appendChild(text("Query Title", "搜索入口", 13, "Bold", c.ink));
query.appendChild(text("Query", "Google/Web · pressure transmitter distributor Germany company website -job -used", 11, "Regular", c.text));
workbench.appendChild(build);
workbench.appendChild(queue);
app.appendChild(workbench);

const results = frame("结果与动作", 1396, 398, c.page);
results.fills = [];
auto(results, "HORIZONTAL", 12, 0);
const table = card(results, "候选客户结果库", 1054, 398);
table.appendChild(text("Table Title", "候选客户结果库", 16, "Bold", c.ink));
["公司 / 官网", "业务", "国家", "联系人", "说明", "评分", "状态"].forEach((h) => table.appendChild(text("表头/" + h, 11, "Bold", c.muted)));
["Auma Instruments GmbH · auma.com", "压力/流量仪表分销", "Germany", "sales@auma.com", "官网与产品匹配，建议核实采购联系人", "86分", "待确认"].forEach((v) => table.appendChild(text("结果/" + v, 12, "Regular", c.text)));
const side = frame("画像与动作", 330, 398, c.page);
side.fills = [];
auto(side, "VERTICAL", 12, 0);
const profile = card(side, "线索画像", 330, 220);
profile.appendChild(text("Profile Title", "线索画像", 16, "Bold", c.ink));
profile.appendChild(text("Profile", "高匹配，建议优先核实采购/工程联系人。", 12, "Regular", c.text));
profile.appendChild(text("Contact", "联系方式：sales@company.com", 12, "Regular", c.text));
const actions = card(side, "同步动作", 330, 166);
actions.appendChild(text("Action Title", "同步动作", 16, "Bold", c.ink));
["生成待办", "同步商机", "导出Excel", "配置AI"].forEach((name) => actions.appendChild(text("Action/" + name, 12, "Bold", name === "同步商机" ? c.blue : c.text)));
results.appendChild(table);
results.appendChild(side);
app.appendChild(results);

figma.viewport.scrollAndZoomIntoView([app]);
return { success: true, pageId: page.id, createdNodeIds: ids };
