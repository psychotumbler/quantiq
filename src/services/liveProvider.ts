/**
 * The composite live provider.
 *
 * No single free source covers what the platform needs, so this stitches
 * together the ones that were probed and confirmed:
 *
 * | Need | US listings | Non-US listings |
 * |---|---|---|
 * | search | Finnhub + Yahoo index | Yahoo index |
 * | quote | Finnhub | Yahoo chart meta |
 * | statements, ratios | Finnhub (SEC as-reported) | none — returned empty |
 * | analyst, insiders | Finnhub | none |
 * | daily OHLCV | Twelve Data if keyed, else Yahoo chart | Yahoo chart |
 *
 * Yahoo's `v8/finance/chart` is the one unofficial endpoint here. It needs no
 * crumb and worked on every local test, but it is undocumented and will
 * likely be refused from a datacenter IP — set `TWELVEDATA_API_KEY` before
 * deploying. Bars are cached in-process so a symbol costs one upstream call
 * per six hours rather than one per page view.
 */

import type { DataProvider } from "@/services/provider";
import type { PriceData, QuoteData, SearchResult } from "@/types/stock";
import { emptyFundamentals, finnhubProvider } from "@/services/finnhub";
import { getChart } from "@/services/market";
import {
  getPriceHistory as yahooHistory,
  getYahooCompany,
  marketFromSymbol,
  searchTickers as yahooSearch,
} from "@/services/yahooFinance";
import { getTwelveDataHistory, twelveDataConfigured } from "@/services/twelveData";
import { getUniverse, searchUniverse } from "@/services/universe";

const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const historyCache = new Map<string, { at: number; bars: PriceData[] }>();

/**
 * True for a US-listed equity or ETF — the only thing Finnhub's free plan
 * serves. Indices (`^NSEI`), futures (`GC=F`), FX (`USDINR=X`) and crypto
 * (`BTC-USD`) have no dotted suffix either, so they are excluded by shape.
 */
export function isUS(symbol: string): boolean {
  return (
    marketFromSymbol(symbol) === "US" &&
    !/[\^=]/.test(symbol) &&
    !/-USD$/i.test(symbol)
  );
}

async function getPriceHistory(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<PriceData[]> {
  const key = `${symbol}|${range}|${interval}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.bars;

  let bars: PriceData[] = [];
  if (interval === "1d" && isUS(symbol) && twelveDataConfigured()) {
    bars = await getTwelveDataHistory(symbol, range);
  }
  if (bars.length === 0) bars = await yahooHistory(symbol, range, interval);
  // Last resort for US symbols when Yahoo refuses and Twelve Data was skipped.
  if (bars.length === 0 && interval === "1d" && twelveDataConfigured()) {
    bars = await getTwelveDataHistory(symbol, range);
  }

  // Never cache a failure: an empty result should be retried next request.
  if (bars.length > 0) historyCache.set(key, { at: Date.now(), bars });
  return bars;
}

/**
 * A quote built from a year of daily bars.
 *
 * Used for listings Finnhub's free plan does not serve. Day change comes from
 * the last two closes and the 52-week range from the bars themselves, so no
 * field depends on Yahoo's window-relative `chartPreviousClose`.
 */
async function quoteFromChart(symbol: string): Promise<QuoteData | null> {
  const { bundle } = await getChart(symbol, "1y");
  if (!bundle || bundle.price === null) return null;

  const highs = bundle.bars.map((b) => b.high).filter((v): v is number => v !== null);
  const lows = bundle.bars.map((b) => b.low).filter((v): v is number => v !== null);
  const volumes = bundle.bars
    .map((b) => b.volume)
    .filter((v): v is number => v !== null && v > 0);
  const recent = volumes.slice(-63);

  return {
    symbol: bundle.symbol,
    name: bundle.name,
    price: bundle.price,
    change: bundle.change,
    changePercent: bundle.changePercent,
    volume: volumes[volumes.length - 1] ?? null,
    avgVolume:
      recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
    marketCap: null,
    peRatio: null,
    eps: null,
    high52Week: highs.length > 0 ? Math.max(...highs) : null,
    low52Week: lows.length > 0 ? Math.min(...lows) : null,
    dividendYield: null,
    beta: null,
    exchange: bundle.exchange,
    currency: bundle.currency,
  };
}

/**
 * Search across three indexes: NSE's own constituent list (best for Indian
 * names), Finnhub (US listings) and Yahoo (everything else, including BSE
 * tickers, indices and ETFs). Results are de-duplicated by symbol.
 */
async function searchTickers(query: string): Promise<SearchResult[]> {
  const [universe, us, global] = await Promise.all([
    getUniverse(),
    finnhubProvider.searchTickers(query),
    yahooSearch(query),
  ]);

  const india: SearchResult[] = searchUniverse(
    universe.filter((company) => company.market === "IN"),
    query,
    6,
  ).map((company) => ({
    symbol: company.symbol,
    name: company.name,
    exchange: "NSE",
    market: "IN",
    quoteType: "EQUITY",
  }));

  // An exact US ticker match leads; otherwise Indian names, then the rest.
  const q = query.trim().toUpperCase();
  const exactUs = us.filter((row) => row.symbol === q);
  const ordered = [...exactUs, ...india, ...us, ...global];

  const seen = new Set<string>();
  return ordered
    .filter((row) => (seen.has(row.symbol) ? false : (seen.add(row.symbol), true)))
    .slice(0, 12);
}

/** Prefer `primary`; fill any `null` from `fallback`. */
function fillNulls<T extends object>(primary: T, fallback: T): T {
  const out = { ...primary } as Record<string, unknown>;
  for (const [key, value] of Object.entries(fallback)) {
    if (out[key] === null || out[key] === undefined) out[key] = value;
  }
  return out as T;
}

export const liveProvider: DataProvider = {
  id: "live",
  label: twelveDataConfigured()
    ? "Finnhub + Yahoo + Twelve Data"
    : "Finnhub + Yahoo Finance",
  searchTickers,

  async getQuote(symbol) {
    if (isUS(symbol)) {
      const quote = await finnhubProvider.getQuote(symbol);
      if (quote) return quote;
    }
    // Everything else: price from the chart, valuation from the fundamentals feed.
    const [quote, company] = await Promise.all([
      quoteFromChart(symbol),
      getYahooCompany(symbol),
    ]);
    if (!quote) return null;
    return {
      ...quote,
      marketCap: company?.marketCap ?? null,
      peRatio: company?.peRatio ?? null,
      eps: company?.eps ?? null,
    };
  },

  getPriceHistory,

  /**
   * Yahoo's standardised statements first: one consistent shape for US and
   * Indian filers, banks included. Finnhub's SEC as-reported filings are the
   * fallback for US names, since their XBRL tags vary by filer.
   */
  async getFinancials(symbol) {
    const company = await getYahooCompany(symbol);
    if (company && company.financials.length > 0) return company.financials;
    return isUS(symbol) ? finnhubProvider.getFinancials(symbol) : [];
  },

  async getFundamentalMetrics(symbol) {
    const us = isUS(symbol);
    const [company, finnhub] = await Promise.all([
      getYahooCompany(symbol),
      us
        ? finnhubProvider.getFundamentalMetrics(symbol)
        : Promise.resolve(emptyFundamentals()),
    ]);
    return company ? fillNulls(company.fundamentals, finnhub) : finnhub;
  },

  async getStatementCurrency(symbol) {
    return (await getYahooCompany(symbol))?.currency ?? null;
  },

  async getAnalystConsensus(symbol) {
    return isUS(symbol) ? finnhubProvider.getAnalystConsensus!(symbol) : null;
  },
  async getInsiderTransactions(symbol) {
    return isUS(symbol) ? finnhubProvider.getInsiderTransactions!(symbol) : [];
  },
};
