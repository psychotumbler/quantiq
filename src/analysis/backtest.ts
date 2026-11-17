/**
 * Strategy backtests over daily bars — long-only, fully in or fully out.
 *
 * Rules that keep the result honest:
 *
 * - **No look-ahead.** The position for day `t+1` is decided from data up to
 *   and including the close of day `t`. A signal can never trade on the bar
 *   that produced it.
 * - **Costs.** Each entry or exit pays `costBps` of the position.
 * - **Benchmark.** Every strategy is shown against buy-and-hold of the same
 *   security over the same dates, starting once the slowest indicator has
 *   warmed up, so the comparison is like for like.
 *
 * What this does NOT do: dividends (unless the source's close is adjusted),
 * slippage, taxes, position sizing, or any out-of-sample validation. A rule
 * that beat buy-and-hold on one stock's history has not been shown to work.
 * Only technical rules are tested — the composite score cannot be backtested
 * because point-in-time fundamentals are not available from any free source.
 */

import type { PriceData } from "@/types/stock";

export type StrategyId = "sma-cross" | "rsi-reversion" | "macd-cross";

export const STRATEGIES: Record<StrategyId, { label: string; rule: string }> = {
  "sma-cross": {
    label: "SMA 50/200 trend",
    rule: "Hold while the 50-day average is above the 200-day average.",
  },
  "rsi-reversion": {
    label: "RSI mean reversion",
    rule: "Buy when RSI(14) closes below 30; sell when it closes above 60.",
  },
  "macd-cross": {
    label: "MACD crossover",
    rule: "Hold while the MACD line (12, 26) is above its 9-day signal line.",
  },
};

export interface BacktestStats {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number | null;
}

export interface BacktestResult {
  strategy: StrategyId;
  label: string;
  rule: string;
  from: string;
  to: string;
  /** Completed round trips. */
  trades: number;
  /** Share of completed trades that made money after costs. */
  winRate: number | null;
  /** Share of days spent invested. */
  exposure: number;
  strategyStats: BacktestStats;
  benchmarkStats: BacktestStats;
  /** Both curves start at 100. */
  curve: { date: string; strategy: number; benchmark: number }[];
}

/* ------------------------------------------------------------------ */
/* Indicator series                                                    */
/* ------------------------------------------------------------------ */

export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const window: number[] = [];
  let ema: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null) continue;
    if (ema === null) {
      // Seed with the SMA of the first `period` usable values.
      window.push(value);
      if (window.length === period) {
        ema = window.reduce((a, b) => a + b, 0) / period;
        out[i] = ema;
      }
    } else {
      ema = value * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

/** Wilder's RSI, index-aligned with `closes`. */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Position rules: desired position at the CLOSE of each day           */
/* ------------------------------------------------------------------ */

/** `null` until the rule's indicators have warmed up. */
export function positions(strategy: StrategyId, closes: number[]): (0 | 1 | null)[] {
  if (strategy === "sma-cross") {
    const fast = smaSeries(closes, 50);
    const slow = smaSeries(closes, 200);
    return closes.map((_, i) =>
      fast[i] === null || slow[i] === null ? null : fast[i]! > slow[i]! ? 1 : 0,
    );
  }

  if (strategy === "macd-cross") {
    const fast = emaSeries(closes, 12);
    const slow = emaSeries(closes, 26);
    const line = closes.map((_, i) =>
      fast[i] === null || slow[i] === null ? null : fast[i]! - slow[i]!,
    );
    const signal = emaSeries(line, 9);
    return closes.map((_, i) =>
      line[i] === null || signal[i] === null ? null : line[i]! > signal[i]! ? 1 : 0,
    );
  }

  // RSI reversion carries state: stay in after an entry until the exit fires.
  const rsi = rsiSeries(closes, 14);
  let holding: 0 | 1 = 0;
  return rsi.map((value) => {
    if (value === null) return null;
    if (holding === 0 && value < 30) holding = 1;
    else if (holding === 1 && value > 60) holding = 0;
    return holding;
  });
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

function stats(curve: number[], dailyReturns: number[]): BacktestStats {
  const totalReturn = curve[curve.length - 1] / curve[0] - 1;
  const years = dailyReturns.length / 252;

  let peak = curve[0];
  let maxDrawdown = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0) /
    Math.max(1, dailyReturns.length - 1);
  const std = Math.sqrt(variance);

  return {
    totalReturn,
    cagr: years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : 0,
    maxDrawdown,
    // Excess over zero: a like-for-like comparison, not an absolute Sharpe.
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : null,
  };
}

export function runBacktest(
  strategy: StrategyId,
  history: PriceData[],
  costBps = 10,
): BacktestResult | null {
  const bars = history
    .map((bar) => ({ date: bar.date, close: bar.adjClose ?? bar.close }))
    .filter(
      (bar): bar is { date: string; close: number } =>
        typeof bar.close === "number" && bar.close > 0,
    );
  const closes = bars.map((bar) => bar.close);
  const desired = positions(strategy, closes);

  const start = desired.findIndex((p) => p !== null);
  // Need a warmed-up indicator and at least ~3 months of trading after it.
  if (start === -1 || bars.length - start < 60) return null;

  const cost = costBps / 10_000;
  const curve = [{ date: bars[start].date, strategy: 100, benchmark: 100 }];
  const strategyReturns: number[] = [];
  const benchmarkReturns: number[] = [];

  let held: 0 | 1 = 0;
  let invested = 0;
  let trades = 0;
  let wins = 0;
  let entryValue = 0;
  let equity = 100;
  let benchmark = 100;

  for (let t = start; t < bars.length - 1; t += 1) {
    // Decided at the close of day t, in force over day t+1.
    const target = desired[t] as 0 | 1;
    let dayReturn = 0;

    if (target !== held) {
      equity *= 1 - cost;
      dayReturn -= cost;
      if (target === 1) {
        entryValue = equity;
      } else {
        trades += 1;
        if (equity > entryValue) wins += 1;
      }
      held = target;
    }

    const move = closes[t + 1] / closes[t] - 1;
    if (held === 1) {
      equity *= 1 + move;
      dayReturn += move;
      invested += 1;
    }
    benchmark *= 1 + move;

    strategyReturns.push(dayReturn);
    benchmarkReturns.push(move);
    curve.push({ date: bars[t + 1].date, strategy: equity, benchmark });
  }

  return {
    strategy,
    label: STRATEGIES[strategy].label,
    rule: STRATEGIES[strategy].rule,
    from: curve[0].date,
    to: curve[curve.length - 1].date,
    trades,
    winRate: trades > 0 ? wins / trades : null,
    exposure: invested / strategyReturns.length,
    strategyStats: stats(curve.map((p) => p.strategy), strategyReturns),
    benchmarkStats: stats(curve.map((p) => p.benchmark), benchmarkReturns),
    curve,
  };
}

/** Thin a curve for charting without dropping its endpoints. */
export function downsample<T>(points: T[], max = 400): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}
