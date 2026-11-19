/**
 * ECORE 风格折线图生成（纯函数，零依赖，可在 node/tsx 下直接自测）。
 *
 * 视觉规范取自 ECORE CRM 的主题令牌：
 *   #111 面 / #242424 细网格线 / 水青 #7dd3fc · 绿 #4ade80 · 琥珀 #f5b544 · 玫红 #f26d6d
 *   2px round cap 折线、首序列 10% 面积填充、数据点带 <title> 悬停提示。
 */
export const ecPct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function ecNiceMax(value: number): number {
  if (value <= 4) return 4;
  const base = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= value) return m * base;
  }
  return 10 * base;
}

export function ecLineChart(opts: {
  points: Array<{ label: string; values: number[]; tips: string[] }>;
  series: Array<{ color: string; area?: boolean }>;
  height?: number;
  /** 量程上限；不传按数据自动取整刻度 */
  yMaxOverride?: number;
  /** 网格线颜色；不传用暗面默认 #242424 */
  gridColor?: string;
  /** 轴标签颜色；不传用暗面默认 #8a8a90 */
  labelColor?: string;
}): string {
  const { points, series, height = 240, yMaxOverride, gridColor = "#242424", labelColor = "#8a8a90" } = opts;
  const W = 720;
  const L = 46;
  const R = 14;
  const T = 18;
  const B = 30;
  const plotW = W - L - R;
  const plotH = height - T - B;
  const n = points.length;
  if (!n) return "";
  const dataMax = Math.max(1, ...points.flatMap((p) => p.values));
  const yMax = yMaxOverride && yMaxOverride >= dataMax ? yMaxOverride : ecNiceMax(dataMax);
  const x = (i: number) => L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => T + plotH - (v / yMax) * plotH;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = T + plotH - f * plotH;
    return `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="${gridColor}" stroke-width="1"/><text x="${L - 7}" y="${gy + 3}" font-size="10" fill="${labelColor}" text-anchor="end">${Math.round(yMax * f)}</text>`;
  }).join("");
  const labelIdx = [...new Set(Array.from({ length: 6 }, (_, k) => Math.round((k * (n - 1)) / 5)))];
  const xLabels = labelIdx.map((i) => `<text x="${x(i)}" y="${height - 8}" font-size="11" fill="${labelColor}" text-anchor="middle">${points[i].label}</text>`).join("");
  const paths = series.map((s, si) => {
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.values[si]).toFixed(1)}`).join(" ");
    const area = s.area ? `<path d="${d} L${x(n - 1).toFixed(1)},${(T + plotH).toFixed(1)} L${x(0).toFixed(1)},${(T + plotH).toFixed(1)} Z" fill="${s.color}" fill-opacity=".1" stroke="none"/>` : "";
    const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.values[si]).toFixed(1)}" r="2.2" fill="${s.color}"><title>${p.tips[si]}</title></circle>`).join("");
    return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${height}" role="img">${gridLines}${paths}${xLabels}</svg>`;
}

/** 时间轴短标签：日桶 2026-11-10 → 11-10；月桶 2026-11 → 26-11 */
export function ecShortLabel(key: string, mode: "day" | "month") {
  return mode === "day" ? key.slice(5) : key.slice(2);
}
