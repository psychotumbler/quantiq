import { describe, expect, it } from "vitest";
import { computeComposite, scale, scoreAnalysts, scoreFundamentals, scoreTechnicals, signalFor } from "@/analysis/composite";
import type { FundamentalMetrics, TechnicalSignal } from "@/types/stock";

const noFundamentals: FundamentalMetrics = {
  peRatio: null, forwardPE: null, pegRatio: null, priceToBook: null, priceToSales: null,
  evToEbitda: null, grossMargin: null, operatingMargin: null, netMargin: null, roic: null,
  roe: null, roa: null, fcfYield: null, fcfPerShare: null, debtToEquity: null,
  currentRatio: null, quickRatio: null, interestCoverage: null, altmanZScore: null,
};

const sig = (indicator: string, signal: TechnicalSignal["signal"], strength: number): TechnicalSignal =>
  ({ indicator, signal, strength, description: "" });

describe("composite scoring", () => {
  it("scales linearly in both directions and clamps", () => {
    expect(scale(0.125, 0, 0.25)).toBe(50);
    expect(scale(25, 40, 10)).toBe(50); // lower is better
    expect(scale(99, 40, 10)).toBe(0);
    expect(scale(-5, 0, 1)).toBe(0);
    expect(scale(null, 0, 1)).toBeNull();
  });

  it("omits a layer with no inputs instead of scoring it neutral", () => {
    expect(scoreFundamentals(noFundamentals)).toBeNull();
    expect(scoreTechnicals([])).toBeNull();
    expect(computeComposite({ fundamentals: noFundamentals, technicalSignals: [], risk: null, analysts: null })).toBeNull();
  });

  it("scores a loss-making P/E at the floor, not as cheap", () => {
    const layer = scoreFundamentals({ ...noFundamentals, peRatio: -12 })!;
    expect(layer.score).toBe(0);
  });

  it("ignores ADX and ATR when tallying technical direction", () => {
    const withContext = scoreTechnicals([sig("RSI (14)", "bullish", 80), sig("ADX (14)", "neutral", 90), sig("ATR (14)", "neutral", 90)])!;
    const without = scoreTechnicals([sig("RSI (14)", "bullish", 80)])!;
    expect(withContext.score).toBe(without.score);
    expect(without.score).toBe(90); // 50 + 80/2
  });

  it("nets opposing technical signals to the midpoint", () => {
    expect(scoreTechnicals([sig("A", "bullish", 60), sig("B", "bearish", 60)])!.score).toBe(50);
  });

  it("weights analyst ratings 100/75/50/25/0", () => {
    const layer = scoreAnalysts({ period: "2026-11-01", strongBuy: 11, buy: 19, hold: 15, sell: 3, strongSell: 1, total: 49 })!;
    expect(layer.score).toBe(Math.round((1100 + 1425 + 750 + 75) / 49));
  });

  it("renormalises weights over the layers present and reports coverage", () => {
    const composite = computeComposite({
      fundamentals: { ...noFundamentals, netMargin: 0.25 }, // 100, weight 30
      technicalSignals: [sig("RSI (14)", "bearish", 100)], // 0, weight 15
      risk: null,
      analysts: null,
    })!;
    expect(composite.totalScore).toBe(Math.round((100 * 30 + 0 * 15) / 45));
    expect(composite.confidence).toBe(45);
    expect(composite.layers.map((l) => l.layer)).toEqual(["Fundamental", "Technical"]);
  });

  it("maps scores to signals at the documented cut-offs", () => {
    expect(signalFor(75)).toBe("Strong Buy");
    expect(signalFor(74)).toBe("Buy");
    expect(signalFor(59)).toBe("Hold");
    expect(signalFor(39)).toBe("Sell");
    expect(signalFor(24)).toBe("Strong Sell");
  });
});
