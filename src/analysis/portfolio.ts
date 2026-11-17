/**
 * Portfolio analytics: valuation, allocation, risk and correlation.
 *
 * Conventions:
 * - Values are converted to one base currency at today's USD/INR rate.
 * - Risk and correlation use each holding's **local-currency** daily returns
 *   over the dates all holdings share, weighted by today's allocation. So
 *   they ignore currency moves and assume the current weights were held
 *   throughout — a snapshot of the portfolio's risk now, not its history.
 */

import type { PriceData, RiskMetrics } from "@/types/stock";
import { computeRiskMetrics } from "@/analysis/risk";

export type BaseCurrency = "INR" | "USD";

export interface HoldingInput {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export interface PricedHolding extends HoldingInput {
  name: string;
  currency: string;
  price: number | null;
  previousClose: number | null;
  bars: PriceData[];
}

export interface PositionRow {
  symbol: string;
  name: string;
  currency: string;
  quantity: number;
  averageCost: number;
  price: number | null;
  /** All monetary fields below are in the base currency. */
  invested: number;
  value: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  weight: number | null;
}

export interface PortfolioAnalysis {
  base: BaseCurrency;
  usdInr: number | null;
  positions: PositionRow[];
  totals: {
    invested: number;
    value: number;
    pnl: number;
    pnlPercent: number | null;
    dayChange: number;
    dayChangePercent: number | null;
  };
  risk: RiskMetrics | null;
  /** Sessions shared by every priced holding. */
  overlapDays: number;
  correlation: { symbols: string[]; matrix: (number | null)[][] } | null;
  /** Symbols that could not be priced and are excluded from totals. */
  unpriced: string[];
}

/** Multiplier from `currency` into `base`, or `null` if it cannot be done. */
export function fxRate(
  currency: string,
  base: BaseCurrency,
  usdInr: number | null,
): number | null {
  if (currency === base) return 1;
  if (!usdInr) return null;
  if (currency === "USD" && base === "INR") return usdInr;
  if (currency === "INR" && base === "USD") return 1 / usdInr;
  return null;
}

export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const meanA = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const meanB = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  return varA === 0 || varB === 0 ? null : cov / Math.sqrt(varA * varB);
}

/** Daily returns for each holding on the dates every holding traded. */
export function alignedReturns(
  holdings: { symbol: string; bars: PriceData[] }[],
): { dates: string[]; returns: Record<string, number[]> } {
  const maps = holdings.map((h) => {
    const map = new Map<string, number>();
    for (const bar of h.bars) {
      const price = bar.adjClose ?? bar.close;
      if (typeof price === "number" && price > 0) map.set(bar.date, price);
    }
    return map;
  });
  if (maps.length === 0) return { dates: [], returns: {} };

  const dates = [...maps[0].keys()]
    .filter((date) => maps.every((map) => map.has(date)))
    .sort();

  const returns: Record<string, number[]> = {};
  holdings.forEach((h, i) => {
    returns[h.symbol] = dates
      .slice(1)
      .map((date, d) => maps[i].get(date)! / maps[i].get(dates[d])! - 1);
  });
  return { dates: dates.slice(1), returns };
}

export function analyzePortfolio(
  holdings: PricedHolding[],
  base: BaseCurrency,
  usdInr: number | null,
): PortfolioAnalysis {
  const unpriced: string[] = [];

  const rows: PositionRow[] = holdings.map((h) => {
    const fx = fxRate(h.currency, base, usdInr);
    const costFx = fx ?? 1;
    const invested = h.quantity * h.averageCost * costFx;
    if (h.price === null || fx === null) {
      unpriced.push(h.symbol);
      return {
        symbol: h.symbol, name: h.name, currency: h.currency,
        quantity: h.quantity, averageCost: h.averageCost, price: h.price,
        invested, value: null, pnl: null, pnlPercent: null,
        dayChange: null, dayChangePercent: null, weight: null,
      };
    }
    const value = h.quantity * h.price * fx;
    const dayChange =
      h.previousClose === null
        ? null
        : h.quantity * (h.price - h.previousClose) * fx;
    return {
      symbol: h.symbol, name: h.name, currency: h.currency,
      quantity: h.quantity, averageCost: h.averageCost, price: h.price,
      invested, value,
      pnl: value - invested,
      pnlPercent: invested > 0 ? value / invested - 1 : null,
      dayChange,
      dayChangePercent:
        h.previousClose ? h.price / h.previousClose - 1 : null,
      weight: null,
    };
  });

  const priced = rows.filter((row) => row.value !== null);
  const value = priced.reduce((acc, row) => acc + (row.value as number), 0);
  const invested = priced.reduce((acc, row) => acc + row.invested, 0);
  const dayChange = priced.reduce((acc, row) => acc + (row.dayChange ?? 0), 0);
  for (const row of priced) row.weight = value > 0 ? (row.value as number) / value : null;

  // Risk on the weighted return series of the priced holdings.
  const pricedHoldings = holdings.filter((h) => !unpriced.includes(h.symbol) && h.bars.length > 0);
  const { dates, returns } = alignedReturns(pricedHoldings);
  let risk: RiskMetrics | null = null;
  let correlation: PortfolioAnalysis["correlation"] = null;

  if (pricedHoldings.length > 0 && dates.length > 0) {
    const weightOf = new Map(priced.map((row) => [row.symbol, row.weight ?? 0]));
    const included = pricedHoldings.reduce((acc, h) => acc + (weightOf.get(h.symbol) ?? 0), 0);
    let level = 100;
    const synthetic: PriceData[] = [
      { date: "start", open: null, high: null, low: null, close: level, volume: null, adjClose: level },
    ];
    dates.forEach((date, d) => {
      const r = pricedHoldings.reduce(
        (acc, h) =>
          acc + ((weightOf.get(h.symbol) ?? 0) / (included || 1)) * returns[h.symbol][d],
        0,
      );
      level *= 1 + r;
      synthetic.push({ date, open: null, high: null, low: null, close: level, volume: null, adjClose: level });
    });
    risk = computeRiskMetrics(synthetic);

    if (pricedHoldings.length >= 2) {
      const symbols = pricedHoldings.map((h) => h.symbol);
      correlation = {
        symbols,
        matrix: symbols.map((a) =>
          symbols.map((b) => (a === b ? 1 : pearson(returns[a], returns[b]))),
        ),
      };
    }
  }

  return {
    base,
    usdInr,
    positions: rows,
    totals: {
      invested,
      value,
      pnl: value - invested,
      pnlPercent: invested > 0 ? value / invested - 1 : null,
      dayChange,
      dayChangePercent: value - dayChange > 0 ? dayChange / (value - dayChange) : null,
    },
    risk,
    overlapDays: dates.length,
    correlation,
    unpriced,
  };
}
