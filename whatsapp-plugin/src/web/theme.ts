/**
 * 宿主主题同步。
 *
 * 本插件以 iframe 挂在 CRM 的「即刻沟通」里，CRM 支持换肤（15 套预设 + 自定义取色），
 * 而 CSS 自定义属性**不会**穿过 iframe 边界。不同步的话，用户换个主题，外层变了、
 * iframe 里的按钮和气泡还是旧的品牌色，两层同屏出现两种主色 —— 这是这套界面最明显的
 * 视觉割裂来源。
 *
 * 通道有两条，互为兜底：
 *  1. 首次装载：宿主在 iframe 的 URL 上带 `?brand=…&brandStrong=…&brandTint=…&brandRing=…`。
 *  2. 装载后换肤：宿主 `postMessage({ type: "goodjob:theme", tokens })`，插件即时覆盖。
 *
 * 刻意**不**在插件里复制 CRM 的 15 套预设：CRM 还支持自定义取色（把 `--brand` 等
 * 以行内样式挂在 `<html>` 上，见宿主 `applyTheme()`），预设表既复制不过来、也必然过期。
 * 让宿主把自己算好的**最终取值**传过来，插件不需要知道主题叫什么。
 */

export type HostThemeTokens = Partial<{
  brand: string;
  brandStrong: string;
  brandTint: string;
  brandRing: string;
}>;

/** 宿主 → iframe 的主题消息类型。宿主侧同名常量见 frontend/src/prototype-api.ts。 */
export const HOST_THEME_MESSAGE = "goodjob:theme";

/**
 * 宿主令牌名 → 插件令牌名。
 * 插件沿用自己更细的命名（hover / soft），宿主用的是 CRM 的 strong / tint，
 * 语义一一对应，这里做唯一一处映射，避免两边到处写转换。
 */
const TOKEN_MAP: Array<readonly [keyof HostThemeTokens, string]> = [
  ["brand", "--brand"],
  ["brandStrong", "--brand-hover"],
  ["brandTint", "--brand-soft"],
  ["brandRing", "--brand-ring"]
];

/** 只接受颜色字面值，避免把任意字符串写进 CSS 自定义属性。 */
function isSafeColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/u.test(value) || /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/u.test(value);
}

/** 把宿主主题令牌写到 `<html>` 的行内样式上，覆盖 styles.css 里的默认值。 */
export function applyHostTheme(tokens: HostThemeTokens): void {
  const root = document.documentElement;
  for (const [key, cssVariable] of TOKEN_MAP) {
    const value = tokens[key];
    if (typeof value === "string" && isSafeColor(value)) root.style.setProperty(cssVariable, value);
  }
}

/** 从 iframe 的 URL 读取宿主带过来的初始主题。 */
export function readHostThemeFromUrl(search = window.location.search): HostThemeTokens {
  const params = new URLSearchParams(search);
  const tokens: HostThemeTokens = {};
  for (const [key] of TOKEN_MAP) {
    const value = params.get(key);
    if (value) tokens[key] = value;
  }
  return tokens;
}

let listening = false;

/**
 * 装载宿主主题：先吃 URL 上的初始值，再订阅后续换肤消息。
 * 重复调用安全（监听器只挂一次）。
 */
export function installHostTheme(): void {
  applyHostTheme(readHostThemeFromUrl());
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    // 只接受宿主（父窗口）发来的主题。同源检查不够：任何持有本 iframe window 引用的脚本
    // 都能 postMessage，不校验来源就等于把品牌色令牌开放给任意窗口改写。取值虽已被
    // isSafeColor 限制为颜色字面值，但"谁能改"必须收口到宿主。
    if (event.source !== window.parent) return;
    const data = event.data as { type?: string; tokens?: HostThemeTokens } | null;
    if (!data || data.type !== HOST_THEME_MESSAGE || !data.tokens) return;
    applyHostTheme(data.tokens);
  });
}
