/**
 * Layer 6 — risk metrics from a daily price series.
 *
 * Pure functions over `PriceData[]` (oldest first). Conventions, stated once:
 *
 * - Returns are simple daily returns on `adjClose`, falling back to `close`.
 *   On sources without a dividend-adjusted close the two are equal, so
 *   return-based figures slightly understate total return for dividend payers.
 * - Annualisation uses 252 trading days.
 * - Sharpe and Sortino are measured against `riskFreeRate` (annual, decimal).
 *   The default is a placeholder assumption, not a live Treasury yield.
 * - VaR and CVaR are **historical**, one-day, 95%, reported as positive loss
 *   fractions: `var95 = 0.021` means "on the worst 5% of days the loss was at
 *   least 2.1%".
 * - `maxDrawdown` is a positive fraction of the prior peak.
 */

import type { PriceData, RiskMetrics } from "@/types/stock";

export const TRADING_DAYS = 252;
export const DEFAULT_RISK_FREE_RATE = 0.04;
/** Fewer observations than this and every figure is `null` rather than noise. */
export const MIN_RETURNS = 30;

/** Simple daily returns from the series, skipping unusable bars. */
export function dailyReturns(history: PriceData[]): number[] {
  const prices = history
    .map((bar) => bar.adjClose ?? bar.close)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    returns.push(prices[i] / prices[i - 1] - 1);
  }
  return returns;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n − 1). */
function sampleStd(values: number[]): number {
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Largest peak-to-trough decline, as a positive fraction. */
export function maxDrawdown(history: PriceData[]): number | null {
  let peak = -Infinity;
  let worst = 0;
  let seen = 0;
  for (const bar of history) {
    const price = bar.adjClose ?? bar.close;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    seen += 1;
    if (price > peak) peak = price;
    const drawdown = 1 - price / peak;
    if (drawdown > worst) worst = drawdown;
  }
  return seen < 2 ? null : worst;
}

/** Historical VaR and CVaR at `confidence`, as positive loss fractions. */
export function historicalVar(
  returns: number[],
  confidence = 0.95,
): { var: number; cvar: number } | null {
  if (returns.length < MIN_RETURNS) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  // Number of observations in the tail, at least one.
  const tailCount = Math.max(1, Math.floor(sorted.length * (1 - confidence)));
  const tail = sorted.slice(0, tailCount);
  return {
    var: Math.max(0, -sorted[tailCount - 1]),
    cvar: Math.max(0, -mean(tail)),
  };
}

export function computeRiskMetrics(
  history: PriceData[],
  options: { riskFreeRate?: number; beta?: number | null } = {},
): RiskMetrics {
  const riskFreeRate = options.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const beta = options.beta ?? null;
  const returns = dailyReturns(history);

  if (returns.length < MIN_RETURNS) {
    return {
      sharpeRatio: null, sortinoRatio: null, calmarRatio: null,
      maxDrawdown: null, volatility: null, var95: null, cvar95: null, beta,
    };
  }

  const dailyRf = riskFreeRate / TRADING_DAYS;
  const excess = returns.map((r) => r - dailyRf);
  const std = sampleStd(returns);
  const volatility = std * Math.sqrt(TRADING_DAYS);
  const annualReturn = mean(returns) * TRADING_DAYS;

  const sharpeRatio =
    std > 0 ? (mean(excess) / std) * Math.sqrt(TRADING_DAYS) : null;

  // Downside deviation: root mean square of below-target excess returns,
  // taken over ALL observations (the standard Sortino denominator).
  const downsideSq = excess.map((r) => (r < 0 ? r * r : 0));
  const downside = Math.sqrt(mean(downsideSq));
  const sortinoRatio =
    downside > 0 ? (mean(excess) / downside) * Math.sqrt(TRADING_DAYS) : null;

  const drawdown = maxDrawdown(history);
  const calmarRatio =
    drawdown !== null && drawdown > 0 ? annualReturn / drawdown : null;

  const tail = historicalVar(returns);

  return {
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    maxDrawdown: drawdown,
    volatility,
    var95: tail?.var ?? null,
    cvar95: tail?.cvar ?? null,
    beta,
  };
}
