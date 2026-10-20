/**
 * 时区相关的两个纯函数。
 *
 * 为什么单独一个文件：定时节奏（`automation-rhythm`）与跟进同步（`followup-sync`）都要
 * 「按业务员所在时区算今天是几号」和「算出下一次几点」。各存一份的实现迟早会漂——
 * 一个用 `en-CA`、一个用 `en-US`（后者给出 `10/14/2026`，切片就全错），
 * 而症状是「同步记到了昨天」，极难查。
 */

/** 本地时区下的 `YYYY-MM-DD`。 */
export function localDate(timezone: string, value: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

/**
 * 下一个「本地时区的 hour:minute」对应的 UTC 时刻。
 * 从现在往后最多找 48 小时；找不到（时区数据异常）就退到 24 小时后，绝不返回一个过去的时刻
 * —— 返回过去时刻会让定时任务每 60 秒触发一次。
 */
export function nextDaily(hour: number, minute: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const start = Date.now() + 60_000;
  for (let offset = 0; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(start + offset * 60_000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    if (Number(parts.hour) === hour && Number(parts.minute) === minute) return candidate.toISOString();
  }
  return new Date(start + 24 * 3_600_000).toISOString();
}
