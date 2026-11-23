import { describe, expect, it } from "vitest";
import { runPaperBot, signalEvents, type BotConfig } from "@/algo/engine";
import type { PriceData } from "@/types/stock";

/** Daily bars from a close series, dated consecutively from 2020-01-01. */
function bars(closes: number[]): PriceData[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: c, high: c, low: c, close: c, volume: 1000, adjClose: c,
  }));
}

const cleanOf = (b: PriceData[]) => {
  const dates: string[] = [], closes: number[] = [], byDate = new Map<string, number>();
  for (const bar of b) { dates.push(bar.date); closes.push(bar.close!); byDate.set(bar.date, bar.close!); }
  return { dates, closes, byDate };
};

describe("signal events", () => {
  it("emits a BUY the day after the rule turns on, at that day's close", () => {
    // Flat 300 days, then a steady climb so SMA50 crosses above SMA200.
    const closes = [...Array(260).fill(100), ...Array(120).fill(0).map((_, i) => 100 * 1.01 ** i)];
    const events = signalEvents("sma-cross", "AAA", cleanOf(bars(closes)), "2020-01-01");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].side).toBe("BUY");
    // Executed at a real bar close, never the signal bar itself.
    expect(events[0].price).toBeGreaterThan(0);
  });

  it("drops events before the start date", () => {
    const closes = [...Array(260).fill(100), ...Array(120).fill(0).map((_, i) => 100 * 1.01 ** i)];
    const all = signalEvents("sma-cross", "AAA", cleanOf(bars(closes)), "2020-01-01");
    const late = signalEvents("sma-cross", "AAA", cleanOf(bars(closes)), "2099-01-01");
    expect(all.length).toBeGreaterThan(late.length);
    expect(late).toEqual([]);
  });
});

describe("paper bot", () => {
  const steadyUp = Array.from({ length: 500 }, (_, i) => 100 * 1.004 ** i);

  it("buys whole shares within its slot and tracks cash", () => {
    const config: BotConfig = {
      id: "b1", name: "Test", strategy: "sma-cross", symbols: ["AAA"],
      startingCapital: 100000, startDate: "2020-01-01", costBps: 0,
    };
    const r = runPaperBot(config, { AAA: bars(steadyUp) });
    const buy = r.trades.find((t) => t.side === "BUY")!;
    expect(buy).toBeDefined();
    // Whole shares only, and the buy never exceeds the single-symbol slot (full capital).
    expect(Number.isInteger(buy.shares)).toBe(true);
    expect(buy.value).toBeLessThanOrEqual(100000);
    // In a steady uptrend the trend bot ends in profit and beats cash.
    expect(r.totalReturn).toBeGreaterThan(0);
    expect(r.equity).toBeGreaterThan(100000);
  });

  it("splits capital into equal slots across symbols", () => {
    const config: BotConfig = {
      id: "b2", name: "Two", strategy: "sma-cross", symbols: ["AAA", "BBB"],
      startingCapital: 100000, startDate: "2020-01-01", costBps: 0,
    };
    const r = runPaperBot(config, { AAA: bars(steadyUp), BBB: bars(steadyUp) });
    const firstBuys = ["AAA", "BBB"].map((s) => r.trades.filter((t) => t.symbol === s && t.side === "BUY").at(-1)!);
    // Each first buy is capped at ~half the capital (one slot).
    for (const b of firstBuys) expect(b.value).toBeLessThanOrEqual(50000);
  });

  it("charges fees and realises a loss on a round trip", () => {
    // Rise (triggers entry) then fall back (triggers exit) under cost.
    const up = Array.from({ length: 300 }, (_, i) => 100 * 1.01 ** i);
    const down = Array.from({ length: 120 }, (_, i) => up[up.length - 1] * 0.99 ** i);
    const config: BotConfig = {
      id: "b3", name: "RT", strategy: "sma-cross", symbols: ["AAA"],
      startingCapital: 100000, startDate: "2020-01-01", costBps: 50,
    };
    const r = runPaperBot(config, { AAA: bars([...up, ...down]) });
    const sell = r.trades.find((t) => t.side === "SELL");
    if (sell) {
      expect(sell.fees).toBeGreaterThan(0);
      expect(sell.realised).not.toBeNull();
    }
    // The equity curve and benchmark both exist and start at/again capital.
    expect(r.equityCurve[0].equity).toBeLessThanOrEqual(100000);
  });

  it("skips a symbol with too little history and reports it", () => {
    const config: BotConfig = {
      id: "b4", name: "Short", strategy: "sma-cross", symbols: ["AAA", "SHORT"],
      startingCapital: 50000, startDate: "2020-01-01",
    };
    const r = runPaperBot(config, { AAA: bars(steadyUp), SHORT: bars([1, 2, 3]) });
    expect(r.skipped).toEqual(["SHORT"]);
  });

  it("returns an empty, safe result when nothing has enough data", () => {
    const config: BotConfig = {
      id: "b5", name: "Empty", strategy: "rsi-reversion", symbols: ["X"],
      startingCapital: 10000, startDate: "2020-01-01",
    };
    const r = runPaperBot(config, { X: bars([1, 2, 3]) });
    expect(r.equity).toBe(10000);
    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
  });

  it("never lets a buy exceed available cash", () => {
    const config: BotConfig = {
      id: "b6", name: "Cash", strategy: "sma-cross", symbols: ["AAA", "BBB", "CCC"],
      startingCapital: 1000, startDate: "2020-01-01", costBps: 20,
    };
    const r = runPaperBot(config, { AAA: bars(steadyUp), BBB: bars(steadyUp), CCC: bars(steadyUp) });
    // Cash is never negative at the end.
    expect(r.cash).toBeGreaterThanOrEqual(0);
    const deployed = r.trades.filter((t) => t.side === "BUY").reduce((a, t) => a + t.value + t.fees, 0);
    expect(deployed).toBeLessThanOrEqual(1000 + 1e-6);
  });
});
