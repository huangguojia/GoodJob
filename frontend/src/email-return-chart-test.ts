// ECORE 折线生成回归：单点、90 天多点、量程覆盖、空输入
import assert from "node:assert/strict";
import { ecLineChart, ecNiceMax } from "./modules/ec-charts";

assert.equal(ecLineChart({ points: [], series: [] }), "", "空输入必须返回空串");
const one = ecLineChart({
  points: [{ label: "11-10", values: [3, 1], tips: ["a", "b"] }],
  series: [{ color: "#7dd3fc", area: true }, { color: "#4ade80" }]
});
assert.ok(one.startsWith("<svg"), "单点也要出图");
assert.ok(one.includes('viewBox="0 0 720 240"'));
assert.equal((one.match(/<circle/g) || []).length, 2, "单点两条线各一个数据点");

const many = ecLineChart({
  points: Array.from({ length: 90 }, (_, i) => ({
    label: `11-${String((i % 30) + 1).padStart(2, "0")}`,
    values: [i % 7, i % 3],
    tips: [`t${i}`, `r${i}`]
  })),
  series: [{ color: "#7dd3fc", area: true }, { color: "#4ade80" }]
});
assert.equal((many.match(/<circle/g) || []).length, 180, "90 天两条线 = 180 个数据点");
assert.equal((many.match(/<path /g) || []).length, 3, "两条线 1 个面积填充");

const rate = ecLineChart({
  points: Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1}月`, values: [i * 0.4], tips: [`p${i}`] })),
  series: [{ color: "#f5b544", area: true }],
  yMaxOverride: 6
});
assert.ok(rate.includes('stroke="#f5b544"'));
assert.equal(ecNiceMax(4), 4);

// 晨白主题：网格/轴标颜色必须可注入，否则白底上会是暗面灰线
const light = ecLineChart({
  points: [{ label: "11-10", values: [2, 1, 0], tips: ["s", "o", "r"] }],
  series: [{ color: "#6366f1", area: true }, { color: "#f59e0b" }, { color: "#10b981" }],
  gridColor: "#e4eaf3",
  labelColor: "#94a3b8"
});
assert.ok(light.includes('stroke="#e4eaf3"'), "浅网格线要生效");
assert.ok(light.includes('fill="#94a3b8"'), "浅轴标要生效");
assert.equal((light.match(/<circle/g) || []).length, 3, "发送/打开/回复三条线各一个点");
assert.equal((light.match(/<path /g) || []).length, 4, "三条线 + 1 个面积填充");
assert.equal(ecNiceMax(7), 10);
assert.equal(ecNiceMax(37), 50);
assert.equal(ecNiceMax(120), 200);

console.log("ECORE 折线生成回归：全部通过");
