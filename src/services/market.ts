/**
 * Cross-asset market data for the ticker ribbon, dashboard and portfolio.
 *
 * One source: Yahoo's `v8/finance/chart`, the only free endpoint found that
 * covers Indian and US indices, commodity futures, FX and crypto with one
 * shape and no key. It is unofficial: it needs no crumb and worked on every
 * local test, but it is undocumented and may be refused from a datacenter IP.
 * Results are cached in-process and a failed refresh keeps serving the last
 * good value (marked stale) rather than blanking the UI.
 *
 * Day change is computed from the last two daily closes, NOT from
 * `meta.chartPreviousClose` — on a multi-day range that field is the close
 * before the first bar of the window, which would report a month's move as
 * today's.
 */

import axios from "axios";
import type { PriceData } from "@/types/stock";

const QUERY1 = "https://query1.finance.yahoo.com";

/**
 * Measured on 2026-11-17 via /api/health: Yahoo answers a bare
 * `Mozilla/5.0` with 200 and a full Chrome desktop User-Agent with 429,
 * from axios, fetch and curl alike. Send the bare form and nothing else.
 */
const HEADERS = { "User-Agent": "Mozilla/5.0" } as const;

export type MarketGroup =
  | "India"
  | "US"
  | "Global"
  | "Commodities"
  | "Currencies"
  | "Crypto"
  | "Rates";

export interface MarketInstrument {
  symbol: string;
  label: string;
  group: MarketGroup;
  /** Shown in the ticker ribbon as well as on the dashboard. */
  ribbon: boolean;
  /** `%` for yields and volatility indices, otherwise a price. */
  unit?: "%" | "pts";
}

export const INSTRUMENTS: readonly MarketInstrument[] = [
  { symbol: "^NSEI", label: "NIFTY 50", group: "India", ribbon: true },
  { symbol: "^CNX100", label: "NIFTY 100", group: "India", ribbon: true },
  { symbol: "^NSEBANK", label: "BANK NIFTY", group: "India", ribbon: true },
  { symbol: "^BSESN", label: "SENSEX", group: "India", ribbon: true },
  { symbol: "^INDIAVIX", label: "INDIA VIX", group: "India", ribbon: false, unit: "pts" },
  { symbol: "^GSPC", label: "S&P 500", group: "US", ribbon: true },
  { symbol: "^IXIC", label: "NASDAQ", group: "US", ribbon: true },
  { symbol: "^DJI", label: "DOW JONES", group: "US", ribbon: true },
  { symbol: "^RUT", label: "RUSSELL 2000", group: "US", ribbon: false },
  { symbol: "^VIX", label: "VIX", group: "US", ribbon: true, unit: "pts" },
  { symbol: "^FTSE", label: "FTSE 100", group: "Global", ribbon: false },
  { symbol: "^N225", label: "NIKKEI 225", group: "Global", ribbon: false },
  { symbol: "^HSI", label: "HANG SENG", group: "Global", ribbon: false },
  { symbol: "GC=F", label: "GOLD", group: "Commodities", ribbon: true },
  { symbol: "SI=F", label: "SILVER", group: "Commodities", ribbon: true },
  { symbol: "CL=F", label: "CRUDE WTI", group: "Commodities", ribbon: true },
  { symbol: "BZ=F", label: "BRENT", group: "Commodities", ribbon: true },
  { symbol: "NG=F", label: "NATURAL GAS", group: "Commodities", ribbon: false },
  { symbol: "HG=F", label: "COPPER", group: "Commodities", ribbon: false },
  { symbol: "USDINR=X", label: "USD/INR", group: "Currencies", ribbon: true },
  { symbol: "EURUSD=X", label: "EUR/USD", group: "Currencies", ribbon: false },
  { symbol: "DX-Y.NYB", label: "DOLLAR INDEX", group: "Currencies", ribbon: false },
  { symbol: "BTC-USD", label: "BITCOIN", group: "Crypto", ribbon: true },
  { symbol: "ETH-USD", label: "ETHEREUM", group: "Crypto", ribbon: false },
  { symbol: "^TNX", label: "US 10Y YIELD", group: "Rates", ribbon: true, unit: "%" },
];

export interface MarketQuote extends MarketInstrument {
  price: number | null;
  change: number | null;
  /** Decimal fraction: 0.012 is +1.2%. */
  changePercent: number | null;
  currency: string;
  /** Recent daily closes, oldest first, for a sparkline. */
  spark: number[];
  /** True when a refresh failed and this is the last good value. */
  stale: boolean;
}

export interface ChartBundle {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  bars: PriceData[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure parser for a `v8/finance/chart` body. Exported for tests. */
export function parseChart(symbol: string, body: unknown): ChartBundle | null {
  const result: Json = (body as Json)?.chart?.result?.[0];
  const meta: Json = result?.meta;
  if (!meta) return null;

  const timestamps: number[] = result.timestamp ?? [];
  const quote: Json = result.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  const bars: PriceData[] = timestamps
    .map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open: num(quote.open?.[i]),
      high: num(quote.high?.[i]),
      low: num(quote.low?.[i]),
      close: num(quote.close?.[i]),
      volume: num(quote.volume?.[i]),
      adjClose: num(adj[i]) ?? num(quote.close?.[i]),
    }))
    .filter((bar) => bar.close !== null);

  const closes = bars.map((bar) => bar.close as number);
  const last = closes[closes.length - 1] ?? null;
  const price = num(meta.regularMarketPrice) ?? last;
  // The final bar is the current (or most recent) session, so the session
  // before it is the reference close.
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] : null;
  const change =
    price === null || previousClose === null ? null : price - previousClose;

  return {
    symbol: String(meta.symbol ?? symbol).toUpperCase(),
    name: String(meta.longName ?? meta.shortName ?? symbol),
    currency: String(meta.currency ?? "USD").toUpperCase(),
    exchange: String(meta.fullExchangeName ?? meta.exchangeName ?? ""),
    price,
    previousClose,
    change,
    changePercent:
      change === null || !previousClose ? null : change / previousClose,
    bars,
  };
}

/* ------------------------------------------------------------------ */
/* Cached fetch                                                        */
/* ------------------------------------------------------------------ */

const TTL_MS: Record<string, number> = {
  "1mo": 3 * 60 * 1000,
  "1y": 30 * 60 * 1000,
  "5y": 6 * 60 * 60 * 1000,
};

const bundleCache = new Map<string, { at: number; value: ChartBundle }>();

export interface ChartResult {
  bundle: ChartBundle | null;
  stale: boolean;
}

/** One symbol's chart, cached. A failed refresh returns the last good value. */
export async function getChart(
  symbol: string,
  range: "1mo" | "1y" | "5y" = "1mo",
): Promise<ChartResult> {
  const key = `${symbol}|${range}`;
  const hit = bundleCache.get(key);
  if (hit && Date.now() - hit.at < (TTL_MS[range] ?? 180_000)) {
    return { bundle: hit.value, stale: false };
  }

  try {
    const { data } = await axios.get(
      `${QUERY1}/v8/finance/chart/${encodeURIComponent(symbol)}`,
      {
        timeout: 12_000,
        headers: HEADERS,
        params: { range, interval: "1d", includeAdjustedClose: true },
      },
    );
    const bundle = parseChart(symbol, data);
    if (bundle) {
      bundleCache.set(key, { at: Date.now(), value: bundle });
      return { bundle, stale: false };
    }
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[market] ${symbol} failed${status ? ` (HTTP ${status})` : ""}`);
  }
  return { bundle: hit?.value ?? null, stale: hit !== undefined };
}

/** Run `task` over `items` with at most `limit` in flight. */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function toQuote(
  instrument: MarketInstrument,
  result: ChartResult,
): MarketQuote {
  const b = result.bundle;
  return {
    ...instrument,
    price: b?.price ?? null,
    change: b?.change ?? null,
    changePercent: b?.changePercent ?? null,
    currency: b?.currency ?? "",
    spark: b ? b.bars.map((bar) => bar.close as number) : [],
    stale: result.stale,
  };
}

/** Every tracked instrument. ~25 upstream calls at most once per 3 minutes. */
export async function getMarketSnapshot(): Promise<MarketQuote[]> {
  return pooled(INSTRUMENTS, 6, async (instrument) =>
    toQuote(instrument, await getChart(instrument.symbol, "1mo")),
  );
}

/* ------------------------------------------------------------------ */
/* US sectors (SPDR sector ETFs) and market regime                     */
/* ------------------------------------------------------------------ */

export interface SectorQuote {
  name: string;
  /** Decimal fractions. */
  change: number | null;
  change30d: number | null;
  change1y: number | null;
  pe: number | null;
}

/** The eleven GICS sectors, each tracked by its SPDR ETF. */
export const US_SECTOR_ETFS: readonly [string, string][] = [
  ["XLK", "Technology"], ["XLF", "Financials"], ["XLV", "Health Care"],
  ["XLY", "Consumer Discretionary"], ["XLP", "Consumer Staples"], ["XLE", "Energy"],
  ["XLI", "Industrials"], ["XLU", "Utilities"], ["XLB", "Materials"],
  ["XLRE", "Real Estate"], ["XLC", "Communication"],
];

export async function getUsSectors(): Promise<SectorQuote[]> {
  const rows = await pooled(US_SECTOR_ETFS, 6, async ([symbol, name]) => {
    const { bundle } = await getChart(symbol, "1mo");
    const closes = bundle ? bundle.bars.map((bar) => bar.close as number) : [];
    return {
      name,
      change: bundle?.changePercent ?? null,
      change30d:
        closes.length >= 2 && bundle?.price ? bundle.price / closes[0] - 1 : null,
      change1y: null,
      pe: null,
    };
  });
  return rows.filter((row) => row.change !== null);
}

export interface MarketRegime {
  market: "IN" | "US";
  /** Volatility index level: India VIX or CBOE VIX. */
  vix: number | null;
  /** Benchmark index change over about one month, decimal. */
  indexTrend: number | null;
  indexName: string;
}

/** Volatility and one-month trend for a stock's home market. */
export async function getMarketRegime(market: "IN" | "US"): Promise<MarketRegime> {
  const [vixSymbol, indexSymbol, indexName] =
    market === "IN" ? ["^INDIAVIX", "^NSEI", "Nifty 50"] : ["^VIX", "^GSPC", "S&P 500"];
  const [vix, index] = await Promise.all([
    getChart(vixSymbol, "1mo"),
    getChart(indexSymbol, "1mo"),
  ]);
  const first = index.bundle?.bars[0]?.close ?? null;
  const last = index.bundle?.price ?? null;
  return {
    market,
    vix: vix.bundle?.price ?? null,
    indexTrend: first && last ? last / first - 1 : null,
    indexName,
  };
}

/* ------------------------------------------------------------------ */
/* Sample data                                                         */
/* ------------------------------------------------------------------ */

const SAMPLE_LEVELS: Record<string, number> = {
  "^NSEI": 24850, "^CNX100": 25480, "^NSEBANK": 53200, "^BSESN": 81400,
  "^INDIAVIX": 13.4, "^GSPC": 6120, "^IXIC": 20150, "^DJI": 44300,
  "^RUT": 2290, "^VIX": 15.8, "^FTSE": 8650, "^N225": 39800, "^HSI": 21400,
  "GC=F": 2950, "SI=F": 33.1, "CL=F": 71.2, "BZ=F": 75.0, "NG=F": 3.4,
  "HG=F": 4.6, "USDINR=X": 86.4, "EURUSD=X": 1.06, "DX-Y.NYB": 106.2,
  "BTC-USD": 97000, "ETH-USD": 3300, "^TNX": 4.4,
};

/**
 * Fabricated snapshot for the fixture provider — deterministic, obviously
 * round, and only ever served alongside `sampleData: true`.
 */
export function sampleMarketSnapshot(): MarketQuote[] {
  return INSTRUMENTS.map((instrument, i) => {
    const level = SAMPLE_LEVELS[instrument.symbol] ?? 100;
    const spark: number[] = [];
    let seed = (i + 1) * 9301;
    let value = level * 0.97;
    for (let d = 0; d < 22; d += 1) {
      seed = (seed * 49297 + 233280) % 233281;
      value *= 1 + (seed / 233281 - 0.47) * 0.016;
      spark.push(value);
    }
    const price = spark[spark.length - 1];
    const previous = spark[spark.length - 2];
    return {
      ...instrument,
      price,
      change: price - previous,
      changePercent: price / previous - 1,
      currency: instrument.group === "India" ? "INR" : "USD",
      spark,
      stale: false,
    };
  });
}
