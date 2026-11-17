/**
 * Fixture provider — hard-coded sample data for development and verification.
 *
 * NOT A DATA SOURCE. Every number here is static and will be stale/wrong; it
 * exists so the UI, formatters and API contract can be exercised when a live
 * source is unreachable (see the Yahoo 429 blocker in PROGRESS.md).
 *
 * Opt in explicitly — it is never the default:
 *
 *     QUANTIQ_DATA_PROVIDER=fixture npm run dev
 *
 * The shapes deliberately include awkward real-world cases: `null` metrics, a
 * loss-making period, and an Indian (INR) listing, so the UI's `N/A` handling
 * and currency switching get tested rather than assumed.
 */

import type { DataProvider } from "@/services/provider";
import type {
  FinancialStatement,
  FundamentalMetrics,
  PriceData,
  QuoteData,
  SearchResult,
} from "@/types/stock";

const SEARCH: SearchResult[] = [
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NMS",
    market: "US",
    quoteType: "EQUITY",
  },
  {
    symbol: "RELIANCE.NS",
    name: "Reliance Industries Limited",
    exchange: "NSI",
    market: "IN",
    quoteType: "EQUITY",
  },
];

const QUOTES: Record<string, QuoteData> = {
  AAPL: {
    symbol: "AAPL",
    name: "Apple Inc.",
    price: 241.84,
    change: 2.31,
    changePercent: 0.00965,
    volume: 48_219_400,
    avgVolume: 54_112_000,
    marketCap: 3_585_000_000_000,
    peRatio: 36.72,
    eps: 6.59,
    high52Week: 260.1,
    low52Week: 169.21,
    dividendYield: 0.0042,
    beta: 1.19,
    exchange: "NMS",
    currency: "USD",
  },
  "RELIANCE.NS": {
    symbol: "RELIANCE.NS",
    name: "Reliance Industries Limited",
    price: 1_412.6,
    change: -18.45,
    changePercent: -0.0129,
    volume: 9_845_200,
    avgVolume: 11_230_000,
    marketCap: 19_120_000_000_000,
    peRatio: 24.18,
    eps: 58.42,
    high52Week: 1_608.8,
    low52Week: 1_114.85,
    // Deliberately null: exercises the UI's N/A path.
    dividendYield: null,
    beta: 0.47,
    exchange: "NSI",
    currency: "INR",
  },
};

/** Deterministic pseudo-random walk, so output is stable across reloads. */
function buildHistory(symbol: string, base: number): PriceData[] {
  const bars: PriceData[] = [];
  let seed = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let close = base * 0.82;
  const start = new Date("2026-11-14T00:00:00Z");

  for (let i = 250; i >= 0; i--) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() - i);
    // Skip weekends so the date axis looks like real sessions.
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;

    const drift = (rand() - 0.47) * base * 0.018;
    const open = close;
    close = Math.max(base * 0.4, open + drift);
    const high = Math.max(open, close) * (1 + rand() * 0.008);
    const low = Math.min(open, close) * (1 - rand() * 0.008);

    bars.push({
      date: day.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Math.round(2_000_000 + rand() * 60_000_000),
      adjClose: Number(close.toFixed(2)),
    });
  }
  return bars;
}

function buildFinancials(scale: number): FinancialStatement[] {
  const years = ["2026-09-30", "2025-09-30", "2024-09-30", "2023-09-30"];
  return years.map((date, i) => {
    const revenue = scale * (1 - i * 0.07);
    // 2023 is a loss year, so the coloured negative path gets exercised.
    const netIncome = i === 3 ? -scale * 0.03 : revenue * 0.24;
    return {
      date,
      revenue,
      grossProfit: revenue * 0.46,
      operatingIncome: revenue * 0.31,
      netIncome,
      ebitda: revenue * 0.34,
      totalAssets: revenue * 1.05,
      totalLiabilities: revenue * 0.78,
      totalEquity: revenue * 0.27,
      totalDebt: revenue * 0.29,
      cashAndEquivalents: revenue * 0.09,
      freeCashFlow: i === 3 ? -scale * 0.01 : revenue * 0.26,
      operatingCashFlow: revenue * 0.3,
      capitalExpenditure: -revenue * 0.04,
      // One period intentionally missing a figure entirely.
      ...(i === 2 ? { ebitda: null } : {}),
    };
  });
}

const FUNDAMENTALS: FundamentalMetrics = {
  peRatio: 36.72,
  forwardPE: 31.4,
  pegRatio: 2.18,
  priceToBook: 58.9,
  priceToSales: 9.12,
  evToEbitda: 27.3,
  grossMargin: 0.4621,
  operatingMargin: 0.3184,
  netMargin: 0.2397,
  // Phase 2c now derives these, so the fixture carries real figures and the
  // UI's number-formatting path is exercised rather than only its N/A path.
  roic: 0.4812,
  roe: 1.4523,
  roa: 0.2214,
  fcfYield: 0.0291,
  fcfPerShare: 6.74,
  // A true ratio (1.54x). We compute D/E ourselves now as
  // totalDebt / stockholdersEquity, so there is no percent form any more.
  debtToEquity: 1.5449,
  currentRatio: 0.87,
  quickRatio: 0.74,
  interestCoverage: 28.4,
  // Comfortably in Altman's "safe" zone (> 2.99), so the UI's healthy-band
  // rendering gets exercised. `interestCoverage` deliberately stays a finite
  // number here; the unbounded (debt-free) case is covered by the unit tests,
  // since this flat shape cannot represent it.
  altmanZScore: 7.21,
};

/**
 * Unknown symbols resolve to `null` rather than falling back to a default.
 * A fallback would make every ticker "exist" and hide the route's 404 path,
 * which is one of the things this provider exists to let us test.
 */
/** All-null metrics, the shape a real provider returns for an unknown symbol. */
const EMPTY_FUNDAMENTALS: FundamentalMetrics = Object.fromEntries(
  Object.keys(FUNDAMENTALS).map((k) => [k, null]),
) as unknown as FundamentalMetrics;

function resolve(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  return upper in QUOTES ? upper : null;
}

export const fixtureProvider: DataProvider = {
  id: "fixture",
  label: "Fixture (sample data — not live)",

  async searchTickers(query: string): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return SEARCH.filter(
      (r) =>
        r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    );
  },

  async getQuote(symbol: string): Promise<QuoteData | null> {
    const key = resolve(symbol);
    return key ? QUOTES[key] : null;
  },

  async getPriceHistory(symbol: string): Promise<PriceData[]> {
    const key = resolve(symbol);
    if (!key) return [];
    return buildHistory(key, QUOTES[key].price ?? 100);
  },

  async getFinancials(symbol: string): Promise<FinancialStatement[]> {
    const key = resolve(symbol);
    if (!key) return [];
    return buildFinancials(
      key === "AAPL" ? 391_000_000_000 : 9_740_000_000_000,
    );
  },

  async getFundamentalMetrics(symbol: string): Promise<FundamentalMetrics> {
    return resolve(symbol) ? FUNDAMENTALS : EMPTY_FUNDAMENTALS;
  },
};
