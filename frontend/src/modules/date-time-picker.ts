/**
 * 日期 + 时间选择器（客户「下次跟进」等场景共用）。
 *
 * 为什么不直接用 `<input type="datetime-local">`：
 * 原生控件在各家浏览器里长得完全不一样、点开是两个割裂的系统面板，也没有「今天 / 明天 / 下周一」
 * 这类业务快捷入口。这里自己画一个：月历用克制的品牌色渐变做选中态，底部固定一条时间行
 * （小时 / 分钟两个紧凑下拉 + 「此刻」），既好看也能精确到分钟。
 *
 * 值的统一口径：`YYYY-MM-DD HH:mm`（本地时间，无时区）。写库仍走客户表的自由文本字段，
 * 所以老数据里「明天 10:00」「已逾期」「7 天后复购」这类人话原样保留 —— 展示时能解析成人话就
 * 换成人话（今天 / 明天 / 周X），解析不了就原样显示，绝不丢字。
 */
import { escapeHtml } from "./shared";

const MINUTE_STEP = 5;
const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const QUICK_DAYS = [
  { label: "今天", offset: 0 },
  { label: "明天", offset: 1 },
  { label: "后天", offset: 2 }
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayDiff(target: Date, base: Date) {
  return Math.round((startOfDay(target).getTime() - startOfDay(base).getTime()) / 86_400_000);
}

export function formatReminderValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function withTime(base: Date, hours: number, minutes: number) {
  const copy = new Date(base);
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

/**
 * 把各种历史写法解析成 Date：
 * - `2026-11-25 14:30` / `2026/11/25 14:30` / ISO
 * - `11-25 14:30`（补当前年）
 * - `今天 14:30` / `明天 09:30` / `后天 10:00`
 * - `明天上午 10 点` 这类解析不了的一律返回 null，由调用方原样展示。
 */
export function parseReminderValue(raw: string, now = new Date()): Date | null {
  const text = (raw || "").trim();
  if (!text) return null;

  // 带时区标记的 ISO（Agent 写入的 nextFollowAt 可能是这种）交给 Date 解析，避免把 UTC 当本地时间。
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(text)) {
    const zoned = new Date(text);
    return Number.isNaN(zoned.getTime()) ? null : zoned;
  }

  const full = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/u);
  if (full) {
    const date = new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] || 9),
      Number(full[5] || 0),
      0,
      0
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const shortDate = text.match(/^(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{1,2})/u);
  if (shortDate) {
    const date = new Date(now.getFullYear(), Number(shortDate[1]) - 1, Number(shortDate[2]), Number(shortDate[3]), Number(shortDate[4]), 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const relative = text.match(/^(今天|明天|后天|大后天)\s*(?:上午|下午|晚上|中午)?\s*(\d{1,2})\s*[:：点]\s*(\d{1,2})?/u);
  if (relative) {
    const offset = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[relative[1] as "今天" | "明天" | "后天" | "大后天"];
    const date = startOfDay(now);
    date.setDate(date.getDate() + offset);
    const isAfternoon = /下午|晚上/u.test(text);
    let hours = Number(relative[2]);
    if (isAfternoon && hours < 12) hours += 12;
    date.setHours(hours, Number(relative[3] || 0), 0, 0);
    return date;
  }

  const iso = new Date(text);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/**
 * 列表 / 详情里的展示文案：能解析的换成人话（今天 14:30、明天 09:30、周三 10:00），
 * 解析不了的（已逾期、7 天后复购）原样返回。
 */
export function formatReminderDisplay(raw: string, now = new Date()) {
  const text = (raw || "").trim();
  if (!text) return "";
  const date = parseReminderValue(text, now);
  if (!date) return text;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const diff = dayDiff(date, now);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  if (diff === 2) return `后天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff > 2 && diff < 7) return `周${WEEK_LABELS[(date.getDay() + 6) % 7]} ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 快捷按钮对应的日期：今天 / 明天 / 后天用偏移天数，「下周一」= 本周之后那一个周一。 */
function quickDate(value: string, from = new Date()) {
  const base = startOfDay(from);
  if (value === "next-week") {
    const isoWeekday = base.getDay() === 0 ? 7 : base.getDay();
    base.setDate(base.getDate() + ((8 - isoWeekday) % 7 || 7));
  } else {
    base.setDate(base.getDate() + Number(value || 0));
  }
  return base;
}

export interface DateTimePickerOptions {
  /** 当前值：`YYYY-MM-DD HH:mm` 或历史人话；空串表示未设置 */
  value?: string;
  /** 没有值时默认落在哪一天（默认明天 10:00） */
  fallback?: Date;
  /** 是否显示「清除」（默认 true） */
  allowClear?: boolean;
  onConfirm: (value: string) => void;
  onClear?: () => void;
}

interface PickerState {
  view: Date;
  selected: Date | null;
  hours: number;
  minutes: number;
}

let activePicker: { close: () => void } | null = null;

/** 主动关掉当前打开的选择器（例如弹窗关闭、路由切换时）。 */
export function closeDateTimePicker() {
  activePicker?.close();
  activePicker = null;
}

function defaultFallback() {
  const date = startOfDay(new Date());
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return date;
}

/** 新建客户时的默认提醒：明天 10:00（和 3.5.7 之前后端写死的默认值保持一致）。 */
export function defaultReminderValue() {
  return formatReminderValue(defaultFallback());
}

/**
 * 在 anchor 下方（空间不够就上方）弹出选择器。
 * 返回的函数用于手动关闭；重复调用会自动关掉上一个。
 */
export function openDateTimePicker(anchor: HTMLElement, options: DateTimePickerOptions) {
  closeDateTimePicker();

  const parsed = parseReminderValue(options.value || "");
  const fallback = options.fallback ? new Date(options.fallback) : defaultFallback();
  const initial = parsed || fallback;
  const picker: PickerState = {
    view: new Date(initial.getFullYear(), initial.getMonth(), 1),
    selected: options.value === "" ? null : initial,
    hours: initial.getHours(),
    minutes: initial.getMinutes()
  };

  const popover = document.createElement("div");
  popover.className = "dtp-pop";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "选择下次跟进时间");
  document.body.appendChild(popover);

  const minuteOptions = () => {
    const values = new Set<number>();
    for (let value = 0; value < 60; value += MINUTE_STEP) values.add(value);
    values.add(picker.minutes);
    return [...values].sort((left, right) => left - right);
  };

  const selectedDayKey = () => (picker.selected ? `${picker.selected.getFullYear()}-${picker.selected.getMonth()}-${picker.selected.getDate()}` : "");

  function render() {
    const year = picker.view.getFullYear();
    const month = picker.view.getMonth();
    const today = startOfDay(new Date());
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - firstWeekday);

    const cells = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const otherMonth = date.getMonth() !== month;
      const isToday = date.getTime() === today.getTime();
      const isPast = date.getTime() < today.getTime();
      const isSelected = selectedDayKey() === `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const classes = [
        "dtp-cell",
        otherMonth ? "is-outside" : "",
        isToday ? "is-today" : "",
        isPast && !otherMonth ? "is-past" : "",
        isSelected ? "is-selected" : ""
      ].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-day="${formatReminderValue(date).slice(0, 10)}" ${otherMonth ? 'tabindex="-1"' : ""} aria-pressed="${isSelected}">${date.getDate()}</button>`;
    }).join("");

    const selectedLabel = picker.selected
      ? `${picker.selected.getMonth() + 1}月${picker.selected.getDate()}日 · 周${WEEK_LABELS[(picker.selected.getDay() + 6) % 7]} · ${pad(picker.hours)}:${pad(picker.minutes)}`
      : "未设置（客户会显示「待安排」）";

    // 快捷按钮的高亮：选中的日期正好是「今天 / 明天 / 后天 / 下周一」时就点亮，一眼能看出当前落点。
    const chipHtml = (value: string, label: string) => {
      const active = picker.selected ? formatReminderValue(quickDate(value)).slice(0, 10) === formatReminderValue(picker.selected).slice(0, 10) : false;
      return `<button type="button" class="dtp-chip${active ? " is-active" : ""}" data-quick="${value}" aria-pressed="${active}">${label}</button>`;
    };

    popover.innerHTML = `
      <div class="dtp-head">
        <button type="button" class="dtp-nav" data-nav="-1" aria-label="上个月">${chevron("left")}</button>
        <div class="dtp-title"><b>${year} 年 ${month + 1} 月</b><span class="dtp-sub">${selectedLabel}</span></div>
        <button type="button" class="dtp-nav" data-nav="1" aria-label="下个月">${chevron("right")}</button>
      </div>
      <div class="dtp-quick">
        ${QUICK_DAYS.map((item) => chipHtml(String(item.offset), item.label)).join("")}
        ${chipHtml("next-week", "下周一")}
      </div>
      <div class="dtp-week">${WEEK_LABELS.map((label) => `<span>${label}</span>`).join("")}</div>
      <div class="dtp-grid">${cells}</div>
      <div class="dtp-time">
        <span class="dtp-time-label">时间</span>
        <div class="dtp-select-wrap">
          <select class="dtp-select" data-time="hour" aria-label="小时">
            ${Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${hour === picker.hours ? "selected" : ""}>${pad(hour)}</option>`).join("")}
          </select>
          <i>:</i>
          <select class="dtp-select" data-time="minute" aria-label="分钟">
            ${minuteOptions().map((minute) => `<option value="${minute}" ${minute === picker.minutes ? "selected" : ""}>${pad(minute)}</option>`).join("")}
          </select>
        </div>
        <button type="button" class="dtp-now" data-now>此刻</button>
      </div>
      <div class="dtp-foot">
        ${options.allowClear === false ? "" : `<button type="button" class="dtp-link dtp-clear" data-clear>清除</button>`}
        <span class="dtp-foot-spacer"></span>
        <button type="button" class="btn" data-cancel>取消</button>
        <button type="button" class="btn primary" data-ok>确定</button>
      </div>
    `;
    position();
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth || 320;
    const height = popover.offsetHeight || 396;
    const gap = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8));
    let top = rect.bottom + gap;
    if (top + height > viewportHeight - 8 && rect.top - gap - height > 8) top = rect.top - gap - height;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(8, top))}px`;
    anchor.classList.add("is-open");
  }

  function commit() {
    const target = picker.selected ? withTime(picker.selected, picker.hours, picker.minutes) : withTime(new Date(), picker.hours, picker.minutes);
    options.onConfirm(formatReminderValue(target));
    close();
  }

  function close() {
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", onScroll, true);
    anchor.classList.remove("is-open");
    popover.remove();
    if (activePicker?.close === close) activePicker = null;
  }

  function onOutside(event: MouseEvent) {
    const target = event.target as Node | null;
    if (!target) return;
    if (popover.contains(target) || anchor.contains(target)) return;
    close();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  function onScroll(event: Event) {
    const target = event.target as Node | null;
    if (target && popover.contains(target)) return;
    position();
  }

  popover.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-nav]");
    if (nav) {
      picker.view = new Date(picker.view.getFullYear(), picker.view.getMonth() + Number(nav.dataset.nav || 1), 1);
      render();
      return;
    }
    const quick = target.closest<HTMLElement>("[data-quick]");
    if (quick) {
      const base = quickDate(quick.dataset.quick || "0");
      picker.selected = base;
      picker.view = new Date(base.getFullYear(), base.getMonth(), 1);
      render();
      return;
    }
    const day = target.closest<HTMLElement>("[data-day]");
    if (day?.dataset.day) {
      const [year, month, date] = day.dataset.day.split("-").map(Number);
      picker.selected = new Date(year, month - 1, date);
      picker.view = new Date(year, month - 1, 1);
      render();
      return;
    }
    if (target.closest("[data-now]")) {
      const now = new Date();
      // 向上取整到 5 分钟，避免默认给一个「已经过去 3 分钟」的时间点。
      const total = Math.ceil((now.getHours() * 60 + now.getMinutes()) / MINUTE_STEP) * MINUTE_STEP;
      picker.hours = Math.floor(total / 60) % 24;
      picker.minutes = total % 60;
      picker.selected = startOfDay(now);
      picker.view = new Date(now.getFullYear(), now.getMonth(), 1);
      render();
      return;
    }
    if (target.closest("[data-clear]")) {
      picker.selected = null;
      options.onClear?.();
      close();
      return;
    }
    if (target.closest("[data-cancel]")) {
      close();
      return;
    }
    if (target.closest("[data-ok]")) commit();
  });

  popover.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    if (!(select instanceof HTMLSelectElement) || !select.dataset.time) return;
    if (!picker.selected) picker.selected = startOfDay(new Date());
    if (select.dataset.time === "hour") picker.hours = Number(select.value);
    else picker.minutes = Number(select.value);
    render();
  });

  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", onScroll, true);

  render();
  const firstCell = popover.querySelector<HTMLElement>(".dtp-cell.is-selected");
  firstCell?.focus({ preventScroll: true });

  activePicker = { close };
  return close;
}

function chevron(direction: "left" | "right") {
  const path = direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7";
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

/**
 * 把某个触发器按钮和隐藏输入框绑成一对：点按钮弹日历，确定后写回隐藏输入并刷新按钮文案。
 * 表单里所有「下次跟进 / 下一提醒」都走这里，行为保持一致。
 */
export function bindDateTimeField(trigger: HTMLElement | null, input: HTMLInputElement | null) {
  if (!trigger || !input) return;
  const sync = () => {
    const text = formatReminderDisplay(input.value);
    const label = trigger.querySelector<HTMLElement>(".dtp-trigger-text");
    if (label) label.textContent = text || "未设置";
    trigger.classList.toggle("is-empty", !input.value.trim());
  };
  trigger.addEventListener("click", () => {
    // 再点一次同一个触发器 = 收起（避免"点了没反应"的错觉，也方便误点后随手关掉）。
    if (trigger.classList.contains("is-open")) {
      closeDateTimePicker();
      return;
    }
    openDateTimePicker(trigger, {
      value: input.value,
      onConfirm: (value) => {
        input.value = value;
        sync();
      },
      onClear: () => {
        input.value = "";
        sync();
      }
    });
  });
  sync();
}

/** 表单里那种「长得像输入框、点开是日历」的触发器 + 隐藏输入框。 */
export function dateTimeFieldHtml(id: string, value: string) {
  return `<div class="dtp-field">
    <button type="button" class="dtp-trigger${value.trim() ? "" : " is-empty"}" aria-haspopup="dialog" aria-label="选择日期与时间">
      ${calendarIcon()}
      <span class="dtp-trigger-text">${escapeHtml(formatReminderDisplay(value) || "未设置")}</span>
      ${chevron("right")}
    </button>
    <input type="hidden" id="${escapeHtml(id)}" value="${escapeHtml(value)}">
  </div>`;
}

function calendarIcon() {
  return `<svg class="dtp-trigger-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3.5V7M16 3.5V7M3.5 10.2h17"/></svg>`;
}
