/**
 * Paper-trading engine — runs a strategy over real prices with simulated money.
 *
 * A "bot" is nothing more than a config (strategy + symbols + starting capital
 * + start date). Its entire history — every trade, the equity curve, the open
 * positions — is DERIVED by replaying the strategy over the symbols' price
 * history. There is no stored running state to drift out of sync: re-run it and
 * you get the same past plus any new day. That is deliberate, and it means the
 * paper bot and the backtest share one signal engine (`positions`), so the
 * signals are identical. They differ only in execution timing: the backtest
 * trades close-to-close (decision and fill on the same close), while the paper
 * bot fills the NEXT session — a signal at tonight's close, bought at tomorrow's
 * — which is how an after-hours retail workflow actually trades.
 *
 * Design, stated once:
 * - **No look-ahead.** A signal at the close of day t is acted on at the close
 *   of day t+1 — the same rule the backtest uses. A bot can never trade on the
 *   bar that produced its signal.
 * - **Fixed slots.** Capital is split equally across the symbols; each symbol's
 *   slot is `startingCapital / N`. On entry the bot buys whole shares up to its
 *   slot; on exit it sells the lot. Slots do not grow, so leftover cash simply
 *   accumulates — simple and churn-free, not optimal sizing.
 * - **Costs.** Each fill pays `costBps` of its value (brokerage + an allowance
 *   for slippage and taxes).
 * - **Benchmark.** Equal-weight buy-and-hold of the same symbols over the same
 *   dates, so the comparison is like-for-like.
 *
 * This simulates fills at the daily close. It models neither intraday slippage
 * nor partial fills nor dividends (unless the source close is adjusted), and a
 * paper record is not a promise of live results.
 */

import type { PriceData } from "@/types/stock";
import { positions, type StrategyId } from "@/analysis/backtest";

export interface BotConfig {
  id: string;
  name: string;
  strategy: StrategyId;
  symbols: string[];
  startingCapital: number;
  /** ISO date the bot began paper trading. Signals before it are ignored. */
  startDate: string;
  /** Round-trip cost in basis points. Default 20 (0.20%). */
  costBps?: number;
  /** Display currency the user chose (e.g. "INR", "USD"). Display only; the
   *  engine computes in each symbol's native prices. Defaults to the first
   *  priced symbol's currency when unset. */
  currency?: string;
}

export type TradeSide = "BUY" | "SELL";

export interface PaperTrade {
  date: string;
  symbol: string;
  side: TradeSide;
  shares: number;
  price: number;
  /** Gross value, shares × price. */
  value: number;
  fees: number;
  /** Realised profit on a SELL, in money. `null` for a BUY. */
  realised: number | null;
}

export interface OpenPosition {
  symbol: string;
  shares: number;
  avgEntry: number;
  lastClose: number;
  value: number;
  unrealisedPnl: number;
  unrealisedPct: number;
  /** When the current lot was opened. */
  since: string;
}

export interface EquityPoint {
  date: string;
  /** Total value: cash + marked-to-market holdings. */
  equity: number;
  /** Equal-weight buy-and-hold of the same symbols, same start. */
  benchmark: number;
  /** Fraction of equity currently deployed in positions. */
  invested: number;
}

export interface BotStats {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number | null;
  /** Share of days with any position open. */
  exposure: number;
  tradeCount: number;
  /** Fraction of closed round-trips that made money. */
  winRate: number | null;
}

export interface BotResult {
  config: BotConfig;
  from: string;
  to: string;
  cash: number;
  equity: number;
  /** Equity change since inception, decimal. */
  totalReturn: number;
  /** Change over the last session, decimal. */
  dayChange: number;
  positions: OpenPosition[];
  trades: PaperTrade[];
  equityCurve: EquityPoint[];
  stats: BotStats;
  benchmarkReturn: number;
  /** Symbols dropped for too little usable history. */
  skipped: string[];
  /** Currency of the first priced symbol, for display. */
  currency: string;
  /** Non-fatal caveat for the UI (e.g. symbols span more than one currency). */
  warning?: string;
}

interface CleanBars {
  dates: string[];
  closes: number[];
  /** date → close. */
  byDate: Map<string, number>;
}

function clean(bars: PriceData[]): CleanBars {
  const dates: string[] = [];
  const closes: number[] = [];
  const byDate = new Map<string, number>();
  for (const bar of bars) {
    const close = bar.adjClose ?? bar.close;
    if (typeof close === "number" && close > 0 && bar.date) {
      dates.push(bar.date);
      closes.push(close);
      byDate.set(bar.date, close);
    }
  }
  return { dates, closes, byDate };
}

interface SignalEvent {
  date: string;
  symbol: string;
  side: TradeSide;
  price: number;
}

/**
 * Transition events for one symbol: a BUY when the strategy turns on, a SELL
 * when it turns off, each executed at the NEXT day's close. Events before
 * `startDate` are dropped. Reuses `positions`, so the signals are identical to
 * the backtest's.
 */
export function signalEvents(
  strategy: StrategyId,
  symbol: string,
  bars: CleanBars,
  startDate: string,
): SignalEvent[] {
  const desired = positions(strategy, bars.closes);
  const events: SignalEvent[] = [];
  let held: 0 | 1 = 0;
  for (let t = 0; t < bars.dates.length - 1; t += 1) {
    // A null (not-yet-warmed-up) signal means stay flat.
    const target: 0 | 1 = desired[t] === 1 ? 1 : 0;
    if (target !== held) {
      const date = bars.dates[t + 1];
      // The signal fired at close t; it is acted on at close t+1 (no look-ahead).
      if (date >= startDate) {
        events.push({ date, symbol, side: target === 1 ? "BUY" : "SELL", price: bars.closes[t + 1] });
      }
      held = target;
    }
  }
  return events;
}

/** Last close on or before `date`, or `null` if the symbol had no bar yet. */
function closeAsOf(bars: CleanBars, date: string): number | null {
  const exact = bars.byDate.get(date);
  if (exact !== undefined) return exact;
  // Walk back through the sorted dates.
  let lo = 0;
  let hi = bars.dates.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars.dates[mid] <= date) {
      best = bars.closes[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeStats(curve: EquityPoint[], investedDays: number, trades: PaperTrade[]): BotStats {
  const equity = curve.map((p) => p.equity);
  const first = equity[0];
  const last = equity[equity.length - 1];
  const totalReturn = first > 0 ? last / first - 1 : 0;

  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    if (equity[i - 1] > 0) returns.push(equity[i] / equity[i - 1] - 1);
  }
  const years = returns.length / 252;
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? 1 - v / peak : 0);
  }
  const s = std(returns);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

  const sells = trades.filter((t) => t.side === "SELL" && t.realised !== null);
  const wins = sells.filter((t) => (t.realised as number) > 0).length;

  return {
    totalReturn,
    cagr: years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : 0,
    maxDrawdown,
    sharpe: s > 0 ? (mean / s) * Math.sqrt(252) : null,
    exposure: curve.length > 0 ? investedDays / curve.length : 0,
    tradeCount: sells.length,
    winRate: sells.length > 0 ? wins / sells.length : null,
  };
}

/** Run one bot over the given price history. Pure and deterministic. */
export function runPaperBot(
  config: BotConfig,
  barsBySymbol: Record<string, PriceData[]>,
): BotResult {
  const costRate = (config.costBps ?? 20) / 10_000;
  const skipped: string[] = [];

  // Prepare each symbol: clean bars + its signal events.
  const prepared = new Map<string, CleanBars>();
  const events: SignalEvent[] = [];
  for (const symbol of config.symbols) {
    const bars = clean(barsBySymbol[symbol] ?? []);
    // Need enough history for the slowest indicator (SMA200) plus some runway.
    if (bars.dates.length < 60) {
      skipped.push(symbol);
      continue;
    }
    prepared.set(symbol, bars);
    for (const e of signalEvents(config.strategy, symbol, bars, config.startDate)) events.push(e);
  }

  const active = [...prepared.keys()];
  const emptyResult = (): BotResult => ({
    config, from: config.startDate, to: config.startDate, cash: config.startingCapital,
    equity: config.startingCapital, totalReturn: 0, dayChange: 0, positions: [], trades: [],
    equityCurve: [], stats: { totalReturn: 0, cagr: 0, maxDrawdown: 0, sharpe: null, exposure: 0, tradeCount: 0, winRate: null },
    benchmarkReturn: 0, skipped, currency: "",
  });
  if (active.length === 0) return emptyResult();

  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  // Union date axis from the start date onward.
  const dateSet = new Set<string>();
  for (const bars of prepared.values()) {
    for (const d of bars.dates) if (d >= config.startDate) dateSet.add(d);
  }
  const dates = [...dateSet].sort();
  if (dates.length === 0) return emptyResult();

  const slot = config.startingCapital / active.length;
  let cash = config.startingCapital;
  const holdings = new Map<string, { shares: number; avgEntry: number; since: string }>();
  const trades: PaperTrade[] = [];
  const curve: EquityPoint[] = [];
  let investedDays = 0;

  // Equal-weight benchmark: buy each symbol at its first close on/after start.
  const benchShares = new Map<string, number>();
  for (const symbol of active) {
    const bars = prepared.get(symbol)!;
    const idx = bars.dates.findIndex((d) => d >= config.startDate);
    const firstClose = idx === -1 ? null : bars.closes[idx];
    if (firstClose && firstClose > 0) benchShares.set(symbol, slot / firstClose);
  }

  let eventIdx = 0;
  for (const date of dates) {
    // Execute every signal dated today, in symbol order.
    while (eventIdx < events.length && events[eventIdx].date === date) {
      const e = events[eventIdx];
      eventIdx += 1;
      const pos = holdings.get(e.symbol);
      if (e.side === "BUY" && !pos) {
        const budget = Math.min(slot, cash);
        const shares = Math.floor(budget / e.price);
        if (shares > 0) {
          const value = shares * e.price;
          const fees = value * costRate;
          if (cash >= value + fees) {
            cash -= value + fees;
            holdings.set(e.symbol, { shares, avgEntry: e.price, since: date });
            trades.push({ date, symbol: e.symbol, side: "BUY", shares, price: e.price, value, fees, realised: null });
          }
        }
      } else if (e.side === "SELL" && pos) {
        const value = pos.shares * e.price;
        const fees = value * costRate;
        cash += value - fees;
        trades.push({
          date, symbol: e.symbol, side: "SELL", shares: pos.shares, price: e.price, value, fees,
          realised: value - fees - pos.shares * pos.avgEntry,
        });
        holdings.delete(e.symbol);
      }
    }

    // Mark to market.
    let held = 0;
    for (const [symbol, pos] of holdings) {
      const px = closeAsOf(prepared.get(symbol)!, date);
      if (px !== null) held += pos.shares * px;
    }
    const equity = cash + held;
    if (held > 0) investedDays += 1;

    let benchmark = 0;
    for (const [symbol, sh] of benchShares) {
      const px = closeAsOf(prepared.get(symbol)!, date);
      if (px !== null) benchmark += sh * px;
    }

    curve.push({ date, equity, benchmark, invested: equity > 0 ? held / equity : 0 });
  }

  // Final open positions, marked at the last close.
  const lastDate = dates[dates.length - 1];
  const openPositions: OpenPosition[] = [...holdings.entries()].map(([symbol, pos]) => {
    const lastClose = closeAsOf(prepared.get(symbol)!, lastDate) ?? pos.avgEntry;
    const value = pos.shares * lastClose;
    const cost = pos.shares * pos.avgEntry;
    return {
      symbol, shares: pos.shares, avgEntry: pos.avgEntry, lastClose, value,
      unrealisedPnl: value - cost, unrealisedPct: cost > 0 ? value / cost - 1 : 0, since: pos.since,
    };
  });

  const equityNow = curve[curve.length - 1].equity;
  const equityPrev = curve.length > 1 ? curve[curve.length - 2].equity : config.startingCapital;
  const benchFirst = curve[0].benchmark;
  const benchLast = curve[curve.length - 1].benchmark;

  return {
    config,
    from: dates[0],
    to: lastDate,
    cash,
    equity: equityNow,
    totalReturn: config.startingCapital > 0 ? equityNow / config.startingCapital - 1 : 0,
    dayChange: equityPrev > 0 ? equityNow / equityPrev - 1 : 0,
    positions: openPositions.sort((a, b) => b.value - a.value),
    trades: trades.sort((a, b) => b.date.localeCompare(a.date)),
    equityCurve: curve,
    stats: computeStats(curve, investedDays, trades),
    benchmarkReturn: benchFirst > 0 ? benchLast / benchFirst - 1 : 0,
    skipped,
    currency: "",
  };
}
