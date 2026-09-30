const DEFAULT_EXCHANGE_RATE_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,EUR,GBP,JPY";
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface ExchangeRateItem {
  pair: "USD/CNY" | "EUR/USD" | "GBP/USD" | "USD/JPY";
  value: number;
  decimals: number;
}

export interface TodayExchangeRates {
  date: string;
  base: "USD";
  rates: ExchangeRateItem[];
  source: "Frankfurter / ECB reference rates";
  fetchedAt: string;
}

interface FrankfurterPayload {
  base?: unknown;
  date?: unknown;
  rates?: Record<string, unknown>;
}

let cachedRates: TodayExchangeRates | null = null;
let cachedAt = 0;

function configuredUrl() {
  const value = process.env.GOODJOB_EXCHANGE_RATES_URL?.trim();
  return value || DEFAULT_EXCHANGE_RATE_URL;
}

function finiteRate(payload: FrankfurterPayload, currency: string) {
  const value = Number(payload.rates?.[currency]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`汇率数据缺少有效的 ${currency} 报价`);
  }
  return value;
}

function parsePayload(value: unknown): Omit<TodayExchangeRates, "fetchedAt"> {
  const payload = value as FrankfurterPayload;
  if (payload.base !== "USD" || typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(payload.date)) {
    throw new Error("汇率数据格式不正确");
  }
  const eur = finiteRate(payload, "EUR");
  const gbp = finiteRate(payload, "GBP");
  return {
    date: payload.date,
    base: "USD",
    rates: [
      { pair: "USD/CNY", value: finiteRate(payload, "CNY"), decimals: 4 },
      { pair: "EUR/USD", value: 1 / eur, decimals: 4 },
      { pair: "GBP/USD", value: 1 / gbp, decimals: 4 },
      { pair: "USD/JPY", value: finiteRate(payload, "JPY"), decimals: 2 }
    ],
    source: "Frankfurter / ECB reference rates"
  };
}

export async function getTodayExchangeRates(force = false): Promise<TodayExchangeRates> {
  if (!force && cachedRates && Date.now() - cachedAt < CACHE_TTL_MS) return cachedRates;
  const response = await fetch(configuredUrl(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`汇率源返回 HTTP ${response.status}`);
  const parsed = parsePayload(await response.json());
  cachedRates = { ...parsed, fetchedAt: new Date().toISOString() };
  cachedAt = Date.now();
  return cachedRates;
}
