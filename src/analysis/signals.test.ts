/**
 * Phase 2b tests — technical signal interpretation.
 *
 * Standard matched from 2a: exact hand-computed strengths first, then the
 * monotonicity and boundary properties that make `strength` comparable across
 * indicators, then the degradation behaviour.
 *
 * The properties matter more here than in 2a. An indicator has one right
 * answer; an interpretation has a *convention*, and the way these go wrong is
 * subtle — a dead band that lets noise through, a strength that is not
 * monotone, a direction inverted on one indicator but not another. Those are
 * tested directly.
 */

import { describe, expect, it } from "vitest";
import type { PriceData, TechnicalIndicators } from "@/types/stock";
import {
  CONTEXT_INDICATORS,
  THRESHOLDS,
  interpretAdx,
  interpretAtr,
  interpretBollinger,
  interpretMacd,
  interpretObv,
  interpretRsi,
  interpretTechnicals,
  isContextSignal,
  linearSlope,
  movingAverageCross,
  priceVsMovingAverage,
} from "@/analysis/signals";
import { computeTechnicalIndicators } from "@/analysis/technicals";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function bar(
  close: number,
  volume = 1_000_000,
  high = close * 1.01,
  low = close * 0.99,
): PriceData {
  return {
    date: "2026-01-01",
    open: close,
    high,
    low,
    close,
    volume,
    adjClose: close,
  };
}

/** `n` bars rising by `step` per bar from `start`. */
function rising(n: number, start = 100, step = 1): PriceData[] {
  return Array.from({ length: n }, (_, i) => bar(start + i * step));
}

/** `n` bars falling by `step` per bar from `start`. */
function falling(n: number, start = 400, step = 1): PriceData[] {
  return Array.from({ length: n }, (_, i) => bar(start - i * step));
}

/** `n` identical bars. */
function flat(n: number, price = 100): PriceData[] {
  return Array.from({ length: n }, () => bar(price));
}

function find(signals: ReturnType<typeof interpretTechnicals>, indicator: string) {
  return signals.find((s) => s.indicator === indicator);
}

/* ------------------------------------------------------------------ */
/* Exact strengths                                                    */
/* ------------------------------------------------------------------ */

describe("exact hand-computed strengths", () => {
  it("scales price-vs-MA deviation linearly to the full-scale point", () => {
    // priceVsMaFull is 10%, so a 5% deviation is exactly half scale.
    const half = priceVsMovingAverage("SMA 50", 105, 100)!;
    expect(half.signal).toBe("bullish");
    expect(half.strength).toBe(50);

    // 10% hits 100 exactly; 20% saturates there.
    expect(priceVsMovingAverage("SMA 50", 110, 100)!.strength).toBe(100);
    expect(priceVsMovingAverage("SMA 50", 120, 100)!.strength).toBe(100);

    // Symmetric below.
    const down = priceVsMovingAverage("SMA 50", 95, 100)!;
    expect(down.signal).toBe("bearish");
    expect(down.strength).toBe(50);
  });

  it("scales the SMA cross spread to its own full-scale point", () => {
    // crossFull is 5%, so a 2.5% spread is half scale.
    const golden = movingAverageCross(102.5, 100)!;
    expect(golden.signal).toBe("bullish");
    expect(golden.strength).toBe(50);
    expect(golden.description).toContain("golden-cross");

    const death = movingAverageCross(97.5, 100)!;
    expect(death.signal).toBe("bearish");
    expect(death.strength).toBe(50);
    expect(death.description).toContain("death-cross");
  });

  it("maps RSI onto strength continuously across the bounds", () => {
    // Band edges are exactly 50, by construction.
    expect(interpretRsi(70)!.strength).toBe(50);
    expect(interpretRsi(30)!.strength).toBe(50);
    // Extremes are 100.
    expect(interpretRsi(100)!.strength).toBe(100);
    expect(interpretRsi(0)!.strength).toBe(100);
    // Midpoint is 0.
    expect(interpretRsi(50)!.strength).toBe(0);
    // Halfway into the neutral band: |60-50| / 20 * 50 = 25.
    expect(interpretRsi(60)!.strength).toBe(25);
    // Halfway into the overbought range: 70 + 15 -> 50 + 25 = 75.
    expect(interpretRsi(85)!.strength).toBe(75);
  });

  it("normalises the MACD histogram by price", () => {
    // macdFull is 2% of price, so 1% is half scale.
    const signal = interpretMacd(1, 100)!;
    expect(signal.signal).toBe("bullish");
    expect(signal.strength).toBe(50);
    // Same fraction at a different price level gives the same strength --
    // the point of normalising.
    expect(interpretMacd(10, 1000)!.strength).toBe(50);
    expect(interpretMacd(-1, 100)!.signal).toBe("bearish");
  });

  it("computes Bollinger %B and scales from the midline", () => {
    // Bands 90/100/110. Price 110 is %B 1.0, offset 0.5 -> full scale.
    const bands = { upper: 110, middle: 100, lower: 90 };
    const atUpper = interpretBollinger(110, bands)!;
    expect(atUpper.signal).toBe("bearish"); // mean reversion
    expect(atUpper.strength).toBe(100);
    expect(atUpper.description).toContain("%B 1.00");

    const atLower = interpretBollinger(90, bands)!;
    expect(atLower.signal).toBe("bullish");
    expect(atLower.strength).toBe(100);

    // Midline: %B 0.5, offset 0 -> neutral, zero strength.
    const mid = interpretBollinger(100, bands)!;
    expect(mid.signal).toBe("neutral");
    expect(mid.strength).toBe(0);

    // Halfway to the upper band: %B 0.75, offset 0.25 -> 50.
    expect(interpretBollinger(105, bands)!.strength).toBe(50);
  });

  it("scales ADX to its full-scale point", () => {
    // adxFull is 50.
    expect(interpretAdx(25)!.strength).toBe(50);
    expect(interpretAdx(50)!.strength).toBe(100);
    expect(interpretAdx(75)!.strength).toBe(100);
    expect(interpretAdx(0)!.strength).toBe(0);
  });

  it("scales ATR as a fraction of price", () => {
    // atrFull is 5% of price, so 2.50 on a 100 price is half scale.
    expect(interpretAtr(2.5, 100)!.strength).toBe(50);
    expect(interpretAtr(5, 100)!.strength).toBe(100);
    expect(interpretAtr(0, 100)!.strength).toBe(0);
  });

  it("computes a least-squares slope exactly", () => {
    expect(linearSlope([0, 1, 2, 3, 4])).toBe(1);
    expect(linearSlope([0, 2, 4, 6])).toBe(2);
    expect(linearSlope([5, 5, 5, 5])).toBe(0);
    expect(linearSlope([4, 3, 2, 1, 0])).toBe(-1);
    // Least-squares through noise. By hand, n=6, meanX=2.5, meanY=3.5:
    //   sum(dx*dy) = 8.75 + 0.75 + 0.75 + 0.75 + 0.75 + 8.75 = 20.5
    //   sum(dx*dx) = 6.25 + 2.25 + 0.25 + 0.25 + 2.25 + 6.25 = 17.5
    //   slope      = 20.5 / 17.5 = 1.1714285714...
    expect(linearSlope([0, 3, 2, 5, 4, 7])).toBeCloseTo(20.5 / 17.5, 12);
    expect(linearSlope([1])).toBeNull();
    expect(linearSlope([])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Dead bands                                                         */
/* ------------------------------------------------------------------ */

describe("dead bands suppress noise", () => {
  it("calls a sub-threshold price deviation neutral", () => {
    // priceVsMaNeutral is 0.5%.
    expect(priceVsMovingAverage("SMA 50", 100.4, 100)!.signal).toBe("neutral");
    expect(priceVsMovingAverage("SMA 50", 99.6, 100)!.signal).toBe("neutral");
    // Just outside becomes directional.
    expect(priceVsMovingAverage("SMA 50", 100.6, 100)!.signal).toBe("bullish");
    expect(priceVsMovingAverage("SMA 50", 99.4, 100)!.signal).toBe("bearish");
  });

  it("calls a sub-threshold SMA spread neutral", () => {
    // crossNeutral is 0.25%.
    expect(movingAverageCross(100.2, 100)!.signal).toBe("neutral");
    expect(movingAverageCross(100.3, 100)!.signal).toBe("bullish");
  });

  it("calls a sub-threshold MACD histogram neutral", () => {
    // macdNeutral is 0.1% of price.
    expect(interpretMacd(0.05, 100)!.signal).toBe("neutral");
    expect(interpretMacd(0.2, 100)!.signal).toBe("bullish");
  });

  it("calls a near-midline Bollinger reading neutral", () => {
    const bands = { upper: 110, middle: 100, lower: 90 };
    // bollingerNeutral is 0.05 of %B offset, i.e. +/- 0.5 price here.
    expect(interpretBollinger(100.4, bands)!.signal).toBe("neutral");
    expect(interpretBollinger(101.5, bands)!.signal).toBe("bearish");
  });

  it("a neutral reading never carries a direction-implying description", () => {
    const neutral = priceVsMovingAverage("SMA 50", 100, 100)!;
    expect(neutral.signal).toBe("neutral");
    expect(neutral.description).not.toMatch(/above|below/);
  });
});

/* ------------------------------------------------------------------ */
/* Monotonicity                                                       */
/* ------------------------------------------------------------------ */

describe("strength is monotone in the underlying deviation", () => {
  it("rises monotonically as price moves away from its MA", () => {
    const strengths = [100, 101, 103, 105, 108, 110, 115].map(
      (price) => priceVsMovingAverage("SMA 50", price, 100)!.strength,
    );
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]).toBeGreaterThanOrEqual(strengths[i - 1]);
    }
    expect(strengths.at(-1)).toBe(100);
  });

  it("rises monotonically in |RSI - 50| across the whole range", () => {
    // The continuity property: no jump at the 30/70 bounds.
    const values = [50, 55, 60, 65, 69, 70, 75, 85, 95, 100];
    const strengths = values.map((v) => interpretRsi(v)!.strength);
    for (let i = 1; i < strengths.length; i++) {
      expect(
        strengths[i],
        `RSI ${values[i]} vs ${values[i - 1]}`,
      ).toBeGreaterThanOrEqual(strengths[i - 1]);
    }
    // Mirrored below 50.
    const mirrored = [50, 45, 40, 35, 31, 30, 25, 15, 5, 0].map(
      (v) => interpretRsi(v)!.strength,
    );
    expect(mirrored).toEqual(strengths);
  });

  it("is symmetric under sign inversion for the directional indicators", () => {
    expect(priceVsMovingAverage("SMA 50", 107, 100)!.strength).toBe(
      priceVsMovingAverage("SMA 50", 93, 100)!.strength,
    );
    expect(movingAverageCross(103, 100)!.strength).toBe(
      movingAverageCross(97, 100)!.strength,
    );
    expect(interpretMacd(1.3, 100)!.strength).toBe(
      interpretMacd(-1.3, 100)!.strength,
    );
    const bands = { upper: 110, middle: 100, lower: 90 };
    expect(interpretBollinger(107, bands)!.strength).toBe(
      interpretBollinger(93, bands)!.strength,
    );
  });

  it("keeps every strength inside [0, 100] and integral", () => {
    const cases = [
      priceVsMovingAverage("SMA 50", 1e9, 1),
      priceVsMovingAverage("SMA 50", 1, 1e9),
      movingAverageCross(1e9, 1),
      interpretRsi(0),
      interpretRsi(100),
      interpretMacd(1e9, 1),
      interpretMacd(-1e9, 1),
      interpretBollinger(1e9, { upper: 110, middle: 100, lower: 90 }),
      interpretBollinger(-1e9, { upper: 110, middle: 100, lower: 90 }),
      interpretAdx(1e6),
      interpretAtr(1e6, 1),
    ];
    for (const result of cases) {
      expect(result).not.toBeNull();
      expect(result!.strength).toBeGreaterThanOrEqual(0);
      expect(result!.strength).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result!.strength)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Mean-reversion convention                                          */
/* ------------------------------------------------------------------ */

describe("the mean-reversion convention is applied consistently", () => {
  it("reads overbought as bearish on both RSI and Bollinger", () => {
    // If one of these ever inverts, the two indicators silently cancel in the
    // composite score. That is the bug this test exists to catch.
    expect(interpretRsi(80)!.signal).toBe("bearish");
    expect(
      interpretBollinger(112, { upper: 110, middle: 100, lower: 90 })!.signal,
    ).toBe("bearish");
  });

  it("reads oversold as bullish on both RSI and Bollinger", () => {
    expect(interpretRsi(20)!.signal).toBe("bullish");
    expect(
      interpretBollinger(88, { upper: 110, middle: 100, lower: 90 })!.signal,
    ).toBe("bullish");
  });

  it("reads trend-following indicators in the trend's direction", () => {
    // The cross and price-vs-MA are trend indicators, not mean-reversion
    // ones, so these are deliberately the opposite polarity.
    expect(movingAverageCross(110, 100)!.signal).toBe("bullish");
    expect(priceVsMovingAverage("SMA 50", 110, 100)!.signal).toBe("bullish");
  });
});

/* ------------------------------------------------------------------ */
/* Context signals                                                    */
/* ------------------------------------------------------------------ */

describe("context signals carry magnitude but never direction", () => {
  it("always reports ADX as neutral, however strong the trend", () => {
    for (const value of [0, 10, 20, 25, 40, 60, 100]) {
      expect(interpretAdx(value)!.signal).toBe("neutral");
    }
  });

  it("always reports ATR as neutral", () => {
    for (const value of [0, 1, 5, 50]) {
      expect(interpretAtr(value, 100)!.signal).toBe("neutral");
    }
  });

  it("says so in the ADX description", () => {
    expect(interpretAdx(40)!.description).toContain("direction-blind");
  });

  it("labels the ADX trend regime by its documented thresholds", () => {
    expect(interpretAdx(15)!.description).toContain("no trend");
    expect(interpretAdx(22)!.description).toContain("weak or emerging");
    expect(interpretAdx(40)!.description).toContain("established");
  });

  it("identifies exactly the two context signals in a full run", () => {
    // Guards 2e: if a third direction-less indicator is added and not listed,
    // it would be counted as a neutral directional vote.
    const signals = interpretTechnicals(rising(260));
    const context = signals.filter(isContextSignal).map((s) => s.indicator);
    expect(context.sort()).toEqual([...CONTEXT_INDICATORS].sort());
    // And every context signal really is neutral.
    for (const signal of signals.filter(isContextSignal)) {
      expect(signal.signal).toBe("neutral");
    }
  });
});

/* ------------------------------------------------------------------ */
/* OBV trend                                                          */
/* ------------------------------------------------------------------ */

describe("OBV reads slope, not level", () => {
  it("reports accumulation on a steady advance", () => {
    const signal = interpretObv(
      // cleanBars -> CleanBar[]; build them directly.
      rising(40).map((b) => ({
        high: b.high!,
        low: b.low!,
        close: b.close!,
        volume: b.volume!,
      })),
    )!;
    expect(signal.signal).toBe("bullish");
    expect(signal.description).toContain("accumulation");
  });

  it("reports distribution on a steady decline", () => {
    const signal = interpretObv(
      falling(40).map((b) => ({
        high: b.high!,
        low: b.low!,
        close: b.close!,
        volume: b.volume!,
      })),
    )!;
    expect(signal.signal).toBe("bearish");
    expect(signal.description).toContain("distribution");
  });

  it("reports no net accumulation on a flat series", () => {
    const signal = interpretObv(
      flat(40).map((b) => ({
        high: b.high!,
        low: b.low!,
        close: b.close!,
        volume: b.volume!,
      })),
    )!;
    expect(signal.signal).toBe("neutral");
  });

  it("is invariant to the absolute volume level", () => {
    // Normalising by average volume is what makes OBV comparable between a
    // mega-cap and a small-cap. A raw slope would not be.
    const makeBars = (volume: number) =>
      rising(40).map((b) => ({
        high: b.high!,
        low: b.low!,
        close: b.close!,
        volume,
      }));
    expect(interpretObv(makeBars(1_000))!.strength).toBe(
      interpretObv(makeBars(500_000_000))!.strength,
    );
  });

  it("returns null without enough bars for the window", () => {
    const bars = rising(THRESHOLDS.obvWindow).map((b) => ({
      high: b.high!,
      low: b.low!,
      close: b.close!,
      volume: b.volume!,
    }));
    expect(interpretObv(bars)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Degradation                                                        */
/* ------------------------------------------------------------------ */

describe("an uncomputable indicator yields no signal", () => {
  it("returns null, not a neutral signal, for a missing input", () => {
    expect(priceVsMovingAverage("SMA 50", null, 100)).toBeNull();
    expect(priceVsMovingAverage("SMA 50", 100, null)).toBeNull();
    expect(priceVsMovingAverage("SMA 50", 100, 0)).toBeNull();
    expect(movingAverageCross(null, 100)).toBeNull();
    expect(movingAverageCross(100, null)).toBeNull();
    expect(movingAverageCross(100, 0)).toBeNull();
    expect(interpretRsi(null)).toBeNull();
    expect(interpretMacd(null, 100)).toBeNull();
    expect(interpretMacd(1, null)).toBeNull();
    expect(interpretMacd(1, 0)).toBeNull();
    expect(interpretBollinger(null, { upper: 1, middle: 1, lower: 1 })).toBeNull();
    expect(interpretBollinger(100, { upper: null, middle: null, lower: null })).toBeNull();
    expect(interpretAdx(null)).toBeNull();
    expect(interpretAtr(null, 100)).toBeNull();
    expect(interpretAtr(1, null)).toBeNull();
  });

  it("handles collapsed Bollinger bands without dividing by zero", () => {
    const signal = interpretBollinger(100, {
      upper: 100,
      middle: 100,
      lower: 100,
    })!;
    expect(signal.signal).toBe("neutral");
    expect(signal.strength).toBe(0);
    expect(signal.description).toContain("zero width");
  });

  it("emits only the computable signals on a short history", () => {
    // 60 bars: SMA50 exists, SMA200 does not, OBV window is satisfied.
    const signals = interpretTechnicals(rising(60));
    const names = signals.map((s) => s.indicator);
    expect(names).toContain("SMA 50");
    expect(names).not.toContain("SMA 200");
    expect(names).not.toContain("SMA 50/200 Cross");
    expect(names).toContain("OBV Trend");
  });

  it("emits almost nothing on a very short history", () => {
    const signals = interpretTechnicals(rising(5));
    // Nothing fabricated: no 50-day average, no RSI, no bands.
    for (const name of [
      "SMA 50",
      "SMA 200",
      "RSI (14)",
      "Bollinger Bands (20, 2)",
      "OBV Trend",
      "ADX (14)",
    ]) {
      expect(signals.map((s) => s.indicator)).not.toContain(name);
    }
  });

  it("returns an empty array for empty or unusable history", () => {
    expect(interpretTechnicals([])).toEqual([]);
    // Every bar missing a required field is dropped by cleanBars.
    const unusable: PriceData[] = [
      { date: "2026-01-01", open: 1, high: null, low: 1, close: 1, volume: 1, adjClose: 1 },
      { date: "2026-01-02", open: 1, high: 1, low: 1, close: null, volume: 1, adjClose: 1 },
    ];
    expect(interpretTechnicals(unusable)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Full runs                                                          */
/* ------------------------------------------------------------------ */

describe("interpretTechnicals over a full history", () => {
  it("emits every signal on a long series and keeps the shape valid", () => {
    const signals = interpretTechnicals(rising(260));
    expect(signals.map((s) => s.indicator)).toEqual([
      "SMA 50/200 Cross",
      "SMA 50",
      "SMA 200",
      "RSI (14)",
      "MACD (12/26/9)",
      "Bollinger Bands (20, 2)",
      "OBV Trend",
      "ADX (14)",
      "ATR (14)",
    ]);

    for (const signal of signals) {
      expect(["bullish", "bearish", "neutral"]).toContain(signal.signal);
      expect(signal.strength).toBeGreaterThanOrEqual(0);
      expect(signal.strength).toBeLessThanOrEqual(100);
      expect(signal.description.length).toBeGreaterThan(0);
      expect(signal.indicator.length).toBeGreaterThan(0);
    }
  });

  it("reads a sustained uptrend as net bullish", () => {
    const signals = interpretTechnicals(rising(260));
    expect(find(signals, "SMA 50/200 Cross")!.signal).toBe("bullish");
    expect(find(signals, "SMA 50")!.signal).toBe("bullish");
    expect(find(signals, "SMA 200")!.signal).toBe("bullish");
    expect(find(signals, "OBV Trend")!.signal).toBe("bullish");
    // A relentless advance is overbought on the mean-reversion indicators --
    // the two conventions genuinely disagree here, by design.
    expect(find(signals, "RSI (14)")!.signal).toBe("bearish");
    // ADX should see a strong trend.
    expect(find(signals, "ADX (14)")!.strength).toBeGreaterThan(50);
  });

  it("reads a sustained downtrend as net bearish", () => {
    const signals = interpretTechnicals(falling(260));
    expect(find(signals, "SMA 50/200 Cross")!.signal).toBe("bearish");
    expect(find(signals, "SMA 50")!.signal).toBe("bearish");
    expect(find(signals, "SMA 200")!.signal).toBe("bearish");
    expect(find(signals, "OBV Trend")!.signal).toBe("bearish");
    expect(find(signals, "RSI (14)")!.signal).toBe("bullish"); // oversold
  });

  it("reads a flat series as neutral everywhere it has an opinion", () => {
    const signals = interpretTechnicals(flat(260));
    for (const signal of signals) {
      expect(signal.signal, signal.indicator).toBe("neutral");
    }
  });

  it("gives the same result whether indicators are passed or recomputed", () => {
    // The route passes its already-computed indicators; the convenience path
    // recomputes. They must not diverge.
    const history = rising(260);
    const indicators: TechnicalIndicators = computeTechnicalIndicators(history);
    expect(interpretTechnicals(history, indicators)).toEqual(
      interpretTechnicals(history),
    );
  });

  it("is unaffected by bars the cleaner drops", () => {
    const history = rising(260);
    const withHoles: PriceData[] = [
      ...history.slice(0, 100),
      { date: "x", open: 1, high: null, low: 1, close: 1, volume: 1, adjClose: 1 },
      ...history.slice(100),
    ];
    expect(interpretTechnicals(withHoles)).toEqual(
      interpretTechnicals(history),
    );
  });
});
