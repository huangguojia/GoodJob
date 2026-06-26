// GoodJob CRM Figma MCP use_figma script
// 用法：在已连接 Figma MCP 的 Codex 会话中，将本脚本作为 use_figma 的 code 执行。
// 注意：这是 use_figma 运行时脚本，按技能要求使用 top-level await 和 return，不调用 figma.closePlugin。

await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Medium" });
await figma.loadFontAsync({ family: "Inter", style: "Bold" });

const page = figma.createPage();
page.name = "GoodJob CRM 原型";
await figma.setCurrentPageAsync(page);

const ids = [];
const colors = {
  ink: { r: 23 / 255, g: 32 / 255, b: 51 / 255 },
  muted: { r: 101 / 255, g: 112 / 255, b: 135 / 255 },
  line: { r: 221 / 255, g: 227 / 255, b: 238 / 255 },
  soft: { r: 244 / 255, g: 247 / 255, b: 251 / 255 },
  nav: { r: 15 / 255, g: 39 / 255, b: 66 / 255 },
  blue: { r: 43 / 255, g: 110 / 255, b: 234 / 255 },
  green: { r: 35 / 255, g: 163 / 255, b: 106 / 255 },
  amber: { r: 217 / 255, g: 145 / 255, b: 19 / 255 },
  red: { r: 216 / 255, g: 76 / 255, b: 76 / 255 },
  white: { r: 1, g: 1, b: 1 }
};

function solid(color) {
  return [{ type: "SOLID", color }];
}

function makeFrame(name, width, height, fill) {
  const frame = figma.createFrame();
  frame.name = name;
  frame.resize(width, height);
  frame.fills = solid(fill || colors.white);
  frame.cornerRadius = 8;
  frame.clipsContent = false;
  ids.push(frame.id);
  return frame;
}

function makeText(name, text, size, weight, color) {
  const node = figma.createText();
  node.name = name;
  node.fontName = { family: "Inter", style: weight || "Regular" };
  node.fontSize = size;
  node.lineHeight = { unit: "PIXELS", value: Math.round(size * 1.45) };
  node.letterSpacing = { unit: "PERCENT", value: 0 };
  node.characters = text;
  node.fills = solid(color || colors.ink);
  ids.push(node.id);
  return node;
}

function setupAuto(frame, mode, gap, padding) {
  frame.layoutMode = mode;
  frame.itemSpacing = gap;
  frame.paddingTop = padding;
  frame.paddingRight = padding;
  frame.paddingBottom = padding;
  frame.paddingLeft = padding;
}

function card(parent, name, w, h) {
  const frame = makeFrame(name, w, h, colors.white);
  frame.strokes = solid(colors.line);
  frame.strokeWeight = 1;
  setupAuto(frame, "VERTICAL", 10, 16);
  parent.appendChild(frame);
  return frame;
}

function metric(parent, label, value, hint, accent) {
  const c = card(parent, "指标卡/" + label, 246, 108);
  c.appendChild(makeText("Label", label, 12, "Regular", colors.muted));
  c.appendChild(makeText("Value", value, 28, "Bold", colors.ink));
  c.appendChild(makeText("Hint", hint, 12, "Medium", accent || colors.green));
  return c;
}

function pill(text, fill, color) {
  const p = makeFrame("状态/" + text, 70, 24, fill);
  setupAuto(p, "HORIZONTAL", 0, 8);
  p.counterAxisAlignItems = "CENTER";
  p.primaryAxisAlignItems = "CENTER";
  p.appendChild(makeText("Pill Text", text, 11, "Medium", color));
  return p;
}

function task(parent, title, desc, tag, tagFill, tagColor, accent) {
  const row = makeFrame("跟进任务/" + title, 654, 68, { r: 251 / 255, g: 253 / 255, b: 1 });
  setupAuto(row, "HORIZONTAL", 12, 12);
  row.counterAxisAlignItems = "CENTER";
  row.strokes = solid(colors.line);
  row.strokeWeight = 1;
  const bar = makeFrame("优先级条", 4, 44, accent || colors.blue);
  bar.cornerRadius = 999;
  row.appendChild(bar);
  const textBox = makeFrame("文本", 450, 44, { r: 251 / 255, g: 253 / 255, b: 1 });
  textBox.fills = [];
  setupAuto(textBox, "VERTICAL", 2, 0);
  textBox.appendChild(makeText("Title", title, 13, "Bold", colors.ink));
  textBox.appendChild(makeText("Desc", desc, 11, "Regular", colors.muted));
  row.appendChild(textBox);
  row.appendChild(pill(tag, tagFill, tagColor));
  parent.appendChild(row);
  return row;
}

function stage(parent, title, items) {
  const s = makeFrame("管道/" + title, 130, 168, { r: 248 / 255, g: 250 / 255, b: 252 / 255 });
  setupAuto(s, "VERTICAL", 8, 10);
  s.strokes = solid(colors.line);
  s.strokeWeight = 1;
  s.appendChild(makeText("Stage Title", title, 12, "Bold", colors.muted));
  items.forEach((item) => {
    const sc = makeFrame("商机卡/" + item[0], 108, 48, colors.white);
    setupAuto(sc, "VERTICAL", 2, 8);
    sc.strokes = solid(colors.line);
    sc.strokeWeight = 1;
    sc.appendChild(makeText("Name", item[0], 11, "Bold", colors.ink));
    sc.appendChild(makeText("Meta", item[1], 10, "Regular", colors.muted));
    s.appendChild(sc);
  });
  parent.appendChild(s);
  return s;
}

const app = makeFrame("GoodJob CRM Web Prototype", 1440, 1320, { r: 237 / 255, g: 242 / 255, b: 247 / 255 });
app.x = 120;
app.y = 80;
setupAuto(app, "HORIZONTAL", 0, 0);
page.appendChild(app);

const sidebar = makeFrame("Sidebar", 236, 1320, colors.nav);
sidebar.cornerRadius = 0;
setupAuto(sidebar, "VERTICAL", 18, 22);
app.appendChild(sidebar);

const brand = makeText("Brand", "GoodJob CRM\n外贸客户增长中台", 16, "Bold", colors.white);
sidebar.appendChild(brand);
["工作台", "客户", "商机", "跟进提醒", "导入导出", "报表", "企业微信", "系统设置"].forEach((label, i) => {
  const item = makeFrame("导航/" + label, 190, 40, i === 0 ? { r: 36 / 255, g: 73 / 255, b: 112 / 255 } : colors.nav);
  setupAuto(item, "HORIZONTAL", 10, 10);
  item.counterAxisAlignItems = "CENTER";
  item.appendChild(makeText("Nav Text", label, 13, "Medium", colors.white));
  sidebar.appendChild(item);
});

const main = makeFrame("Main", 1204, 1320, { r: 237 / 255, g: 242 / 255, b: 247 / 255 });
main.cornerRadius = 0;
setupAuto(main, "VERTICAL", 0, 0);
app.appendChild(main);

const topbar = makeFrame("Topbar", 1204, 68, colors.white);
topbar.cornerRadius = 0;
topbar.strokes = solid(colors.line);
topbar.strokeWeight = 1;
setupAuto(topbar, "HORIZONTAL", 14, 18);
topbar.counterAxisAlignItems = "CENTER";
main.appendChild(topbar);

const search = makeFrame("全局搜索", 520, 38, colors.soft);
setupAuto(search, "HORIZONTAL", 8, 11);
search.counterAxisAlignItems = "CENTER";
search.strokes = solid(colors.line);
search.strokeWeight = 1;
search.appendChild(makeText("Search Text", "搜索客户、联系人、国家、产品或商机", 13, "Regular", colors.muted));
topbar.appendChild(search);

["导入", "导出", "新增客户"].forEach((label, i) => {
  const b = makeFrame("按钮/" + label, i === 2 ? 92 : 62, 36, i === 2 ? colors.blue : colors.white);
  setupAuto(b, "HORIZONTAL", 0, 12);
  b.counterAxisAlignItems = "CENTER";
  b.primaryAxisAlignItems = "CENTER";
  b.strokes = solid(i === 2 ? colors.blue : colors.line);
  b.strokeWeight = 1;
  b.appendChild(makeText("Button Text", label, 12, "Medium", i === 2 ? colors.white : colors.ink));
  topbar.appendChild(b);
});

const content = makeFrame("工作台内容", 1204, 1252, { r: 237 / 255, g: 242 / 255, b: 247 / 255 });
content.cornerRadius = 0;
setupAuto(content, "VERTICAL", 16, 28);
main.appendChild(content);

content.appendChild(makeText("Page Title", "工作台", 24, "Bold", colors.ink));
content.appendChild(makeText("Subtitle", "今天优先处理逾期提醒、报价未回复和高意向客户。", 13, "Regular", colors.muted));

const metrics = makeFrame("核心指标", 1148, 116, { r: 237 / 255, g: 242 / 255, b: 247 / 255 });
metrics.fills = [];
setupAuto(metrics, "HORIZONTAL", 16, 0);
content.appendChild(metrics);
metric(metrics, "今日待跟进", "28", "7 个已逾期", colors.red);
metric(metrics, "本月新增客户", "186", "较上月 +18%", colors.green);
metric(metrics, "预测成交额", "$428k", "样品阶段贡献 31%", colors.green);
metric(metrics, "企微已绑定", "64%", "32 个客户待绑定", colors.amber);

const row = makeFrame("主要区域", 1148, 360, { r: 237 / 255, g: 242 / 255, b: 247 / 255 });
row.fills = [];
setupAuto(row, "HORIZONTAL", 16, 0);
content.appendChild(row);

const follow = card(row, "跟进优先级", 700, 342);
follow.appendChild(makeText("Section Title", "跟进优先级", 16, "Bold", colors.ink));
task(follow, "Nordic Tools AB 报价后 5 天未回复", "瑞典 · 采购电动工具 · 预计 $36,000", "逾期", { r: 253 / 255, g: 236 / 255, b: 236 / 255 }, colors.red, colors.red);
task(follow, "Atlas Home Inc 样品签收后待确认", "美国 · 家居用品 · 下一步：确认测试反馈", "今日", { r: 1, g: 244 / 255, b: 221 / 255 }, colors.amber, colors.amber);
task(follow, "Al Noor Trading 需发送更新报价", "阿联酋 · LED 灯具 · 汇率变动提醒", "10:30", { r: 233 / 255, g: 241 / 255, b: 1 }, colors.blue, colors.blue);

const pipe = card(row, "销售管道", 430, 342);
pipe.appendChild(makeText("Section Title", "销售管道", 16, "Bold", colors.ink));
const pgrid = makeFrame("管道网格", 398, 188, colors.white);
pgrid.fills = [];
setupAuto(pgrid, "HORIZONTAL", 8, 0);
pipe.appendChild(pgrid);
stage(pgrid, "询盘 42", [["Marco", "意大利 · $8k"]]);
stage(pgrid, "已联系 31", [["Blue", "智利 · $14k"]]);
stage(pgrid, "已报价 26", [["Nordic", "瑞典 · $36k"]]);

const customerSection = card(content, "客户管理列表", 1148, 360);
customerSection.appendChild(makeText("Section Title", "客户管理", 16, "Bold", colors.ink));
const headers = ["客户", "国家", "阶段", "金额", "最近跟进", "下一提醒", "企微"];
const rows = [
  ["Nordic Tools AB", "瑞典", "已报价", "$36,000", "5 天前", "已逾期", "已绑定"],
  ["Atlas Home Inc", "美国", "样品", "$22,000", "昨天", "今天 16:00", "已绑定"],
  ["Kanto Retail", "日本", "谈判", "$48,000", "今天", "明天 09:30", "未绑定"]
];
const table = makeFrame("客户表格", 1112, 240, colors.white);
setupAuto(table, "VERTICAL", 0, 0);
customerSection.appendChild(table);
[headers, ...rows].forEach((r, index) => {
  const tr = makeFrame(index === 0 ? "表头" : "客户行", 1112, 48, index === 0 ? { r: 248 / 255, g: 250 / 255, b: 252 / 255 } : colors.white);
  setupAuto(tr, "HORIZONTAL", 0, 0);
  tr.strokes = solid(colors.line);
  tr.strokeWeight = 1;
  r.forEach((cell) => {
    const td = makeFrame("单元格", 158, 48, tr.fills[0].color);
    td.fills = [];
    setupAuto(td, "HORIZONTAL", 0, 10);
    td.counterAxisAlignItems = "CENTER";
    td.appendChild(makeText("Cell Text", cell, 12, index === 0 ? "Bold" : "Regular", index === 0 ? colors.muted : colors.ink));
    tr.appendChild(td);
  });
  table.appendChild(tr);
});

const reportSection = card(content, "经营报表", 1148, 300);
reportSection.appendChild(makeText("Section Title", "经营报表", 16, "Bold", colors.ink));
const chart = makeFrame("漏斗图", 760, 190, colors.white);
chart.fills = [];
setupAuto(chart, "VERTICAL", 12, 0);
reportSection.appendChild(chart);
[
  ["询盘", "42", 620, colors.blue],
  ["已联系", "31", 520, { r: 32 / 255, g: 166 / 255, b: 184 / 255 }],
  ["已报价", "26", 430, colors.amber],
  ["样品", "14", 300, colors.green],
  ["成交", "6", 160, colors.green]
].forEach(([label, count, width, color]) => {
  const line = makeFrame("报表/" + label, 760, 24, colors.white);
  line.fills = [];
  setupAuto(line, "HORIZONTAL", 10, 0);
  line.counterAxisAlignItems = "CENTER";
  line.appendChild(makeText("Label", label, 12, "Medium", colors.muted));
  const bar = makeFrame("Bar", width, 10, color);
  bar.cornerRadius = 999;
  line.appendChild(bar);
  line.appendChild(makeText("Count", count, 12, "Bold", colors.ink));
  chart.appendChild(line);
});

figma.viewport.scrollAndZoomIntoView([app]);

return {
  success: true,
  message: "GoodJob CRM 原型画布已创建",
  createdNodeIds: ids,
  rootNodeId: app.id,
  pageId: page.id
};
