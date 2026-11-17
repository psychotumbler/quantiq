import { describe, expect, it } from "vitest";
import { computeRiskMetrics, dailyReturns, historicalVar, maxDrawdown } from "@/analysis/risk";
import type { PriceData } from "@/types/stock";

const bars = (prices: number[]): PriceData[] =>
  prices.map((p, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: p, high: p, low: p, close: p, volume: 1, adjClose: p,
  }));

describe("risk metrics", () => {
  it("computes simple daily returns", () => {
    const r = dailyReturns(bars([100, 110, 99]));
    expect(r[0]).toBeCloseTo(0.1);
    expect(r[1]).toBeCloseTo(-0.1);
  });

  it("finds the worst peak-to-trough decline", () => {
    // Peak 120, trough 90 → 25%; the later recovery does not reduce it.
    expect(maxDrawdown(bars([100, 120, 90, 130, 125]))).toBeCloseTo(0.25);
    expect(maxDrawdown(bars([100, 101, 102]))).toBe(0);
  });

  it("reports VaR and CVaR as positive losses from the 5% tail", () => {
    // 100 returns: −0.10, −0.09, −0.08, −0.07, −0.06, then 95 × +0.01.
    const returns = [-0.1, -0.09, -0.08, -0.07, -0.06, ...Array(95).fill(0.01)];
    const tail = historicalVar(returns)!;
    expect(tail.var).toBeCloseTo(0.06); // 5th-worst observation
    expect(tail.cvar).toBeCloseTo(0.08); // mean of the worst five
  });

  it("matches a hand-computed Sharpe and volatility", () => {
    // Alternating +2% / −1% for 60 returns. mean = 0.005;
    // sample std = 0.015 × sqrt(60/59).
    const prices = [100];
    for (let i = 0; i < 60; i += 1) prices.push(prices[i] * (i % 2 === 0 ? 1.02 : 0.99));
    const risk = computeRiskMetrics(bars(prices), { riskFreeRate: 0 });
    const std = 0.015 * Math.sqrt(60 / 59);
    expect(risk.volatility).toBeCloseTo(std * Math.sqrt(252), 10);
    expect(risk.sharpeRatio).toBeCloseTo((0.005 / std) * Math.sqrt(252), 10);
    // Downside deviation over all 60: sqrt(30 × 0.01² / 60).
    const downside = Math.sqrt((30 * 0.0001) / 60);
    expect(risk.sortinoRatio).toBeCloseTo((0.005 / downside) * Math.sqrt(252), 10);
    expect(risk.maxDrawdown).toBeCloseTo(0.01, 10);
  });

  it("returns nulls rather than noise on a short series", () => {
    const risk = computeRiskMetrics(bars([100, 101, 102]), { beta: 1.1 });
    expect(risk.sharpeRatio).toBeNull();
    expect(risk.volatility).toBeNull();
    expect(risk.beta).toBe(1.1);
  });
});
