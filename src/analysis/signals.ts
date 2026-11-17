/**
 * Technical signal interpretation (Phase 2b) — pure functions over price
 * history and the Phase 2a indicators.
 *
 * 2a answers "what is the RSI?". This module answers "what does that mean?",
 * and the two are kept apart because the second question involves conventions
 * that are worth stating out loud rather than burying in an indicator.
 *
 * ## Conventions
 *
 * - Input bars are **oldest first**, matching `DataProvider.getPriceHistory`.
 * - `strength` is 0-100 and means *magnitude of the read*, not probability. It
 *   is monotone in the underlying deviation and saturates at a documented
 *   full-scale point per indicator, so two signals' strengths are comparable.
 * - An indicator that cannot be computed yields **no signal at all** rather
 *   than a neutral one. A neutral signal asserts "this indicator looked and
 *   saw balance"; silence is the honest output for "this indicator could not
 *   look". Collapsing the two would let a 30-bar history produce a confident
 *   wall of neutrals.
 *
 * ## Directional vs context signals
 *
 * ADX and ATR measure **trend strength** and **volatility**. Neither has a
 * direction: a high ADX says a trend is strong without saying which way, and
 * high volatility is not bullish or bearish. Both are therefore always emitted
 * with `signal: "neutral"`, and their `strength` reports magnitude rather than
 * directional conviction.
 *
 * `CONTEXT_INDICATORS` names them. **Phase 2e must not count these as
 * directional votes** — averaging a direction-less neutral into a bull/bear
 * tally drags every score toward the middle and makes a strongly trending
 * stock look undecided. They belong in the confidence term instead.
 *
 * ## Mean reversion, not momentum
 *
 * RSI and Bollinger Bands are read as **mean-reversion** indicators, the
 * standard convention: an overbought reading is bearish. A momentum reading
 * would invert both. The choice is stated here because it is a choice, and
 * because mixing the two conventions across indicators is a common way to
 * build a scorer that quietly cancels itself out.
 */

import type {
  PriceData,
  SignalDirection,
  TechnicalIndicators,
  TechnicalSignal,
} from "@/types/stock";
import {
  type CleanBar,
  cleanBars,
  computeTechnicalIndicators,
  obvSeries,
} from "@/analysis/technicals";

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every tunable threshold in one place, so the interpretation can be reviewed
 * and adjusted without reading the logic.
 *
 * `*Full` values are the full-scale points where `strength` reaches 100.
 * `*Neutral` values are the dead bands inside which a reading is called
 * neutral rather than directional — without them, a price 0.01% above its
 * moving average would register as a bullish signal.
 */
export const THRESHOLDS = {
  /** Price vs a moving average: dead band, and the deviation scoring 100. */
  priceVsMaNeutral: 0.005, // 0.5%
  priceVsMaFull: 0.1, // 10%
  /** SMA50 vs SMA200 spread. */
  crossNeutral: 0.0025, // 0.25%
  crossFull: 0.05, // 5%
  /** RSI overbought / oversold bounds. */
  rsiOverbought: 70,
  rsiOversold: 30,
  /** MACD histogram as a fraction of price. */
  macdNeutral: 0.001, // 0.1%
  macdFull: 0.02, // 2%
  /** Bollinger %B dead band around the midline, and the band edges. */
  bollingerNeutral: 0.05,
  /** ADX: below `adxNoTrend` there is no trend; `adxFull` scores 100. */
  adxNoTrend: 20,
  adxTrending: 25,
  adxFull: 50,
  /** ATR as a fraction of price; 5% daily range is extreme. */
  atrFull: 0.05,
  /** OBV slope window, and the full-scale slope in average-volume units. */
  obvWindow: 20,
  obvNeutral: 0.05,
  obvFull: 0.75,
} as const;

/**
 * Indicators that report magnitude without direction.
 *
 * See the module header: Phase 2e must exclude these from any directional
 * tally and fold them into confidence instead.
 */
export const CONTEXT_INDICATORS: readonly string[] = [
  "ADX (14)",
  "ATR (14)",
];

/** True when this signal carries no directional information by construction. */
export function isContextSignal(signal: TechnicalSignal): boolean {
  return CONTEXT_INDICATORS.includes(signal.indicator);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Clamp to [0, 100]. */
function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Map a magnitude onto 0-100, reaching 100 at `full`.
 *
 * Linear and saturating rather than, say, logistic: the inputs are already
 * normalised fractions, and a linear ramp keeps `strength` auditable — a
 * reader can recover the underlying deviation from the number.
 */
function scaleStrength(magnitude: number, full: number): number {
  if (full <= 0) return 0;
  return clampStrength((Math.abs(magnitude) / full) * 100);
}

/**
 * Direction of a deviation, with a dead band.
 *
 * `neutral` inside ±`deadBand` — see `THRESHOLDS` for why the dead band is not
 * optional.
 */
function directionOf(deviation: number, deadBand: number): SignalDirection {
  if (deviation > deadBand) return "bullish";
  if (deviation < -deadBand) return "bearish";
  return "neutral";
}

/** Format a fraction as a signed percentage, for descriptions. */
function pct(fraction: number, places = 1): string {
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(places)}%`;
}

function signal(
  indicator: string,
  direction: SignalDirection,
  strength: number,
  description: string,
): TechnicalSignal {
  return {
    indicator,
    signal: direction,
    strength: Math.round(clampStrength(strength)),
    description,
  };
}

/** Least-squares slope of `values` against its index. */
export function linearSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * (values[i] - meanY);
    denominator += dx * dx;
  }

  if (denominator === 0) return null;
  const slope = numerator / denominator;
  return Number.isFinite(slope) ? slope : null;
}

/* ------------------------------------------------------------------ */
/* Individual interpreters                                             */
/* ------------------------------------------------------------------ */

/**
 * Price relative to a moving average.
 *
 * Returns `null` when the average does not exist — a 200-day average on 150
 * bars is not a 200-day average, and inventing a neutral read for it would be
 * worse than saying nothing.
 */
export function priceVsMovingAverage(
  label: string,
  price: number | null,
  movingAverage: number | null,
): TechnicalSignal | null {
  if (price === null || movingAverage === null || movingAverage === 0) {
    return null;
  }

  const deviation = (price - movingAverage) / movingAverage;
  const direction = directionOf(deviation, THRESHOLDS.priceVsMaNeutral);
  const strength = scaleStrength(deviation, THRESHOLDS.priceVsMaFull);

  const relation =
    direction === "neutral"
      ? "is at"
      : direction === "bullish"
        ? "is above"
        : "is below";

  return signal(
    label,
    direction,
    strength,
    `Price ${relation} its ${label} (${pct(deviation)}).`,
  );
}

/**
 * The SMA50 / SMA200 relationship — the golden and death cross.
 *
 * Reported as a *spread*, not as a crossing event: a crossing is a single-bar
 * occurrence that is stale the next day, whereas the spread says how far into
 * the regime the stock currently is, which is what a score wants.
 */
export function movingAverageCross(
  sma50: number | null,
  sma200: number | null,
): TechnicalSignal | null {
  if (sma50 === null || sma200 === null || sma200 === 0) return null;

  const spread = (sma50 - sma200) / sma200;
  const direction = directionOf(spread, THRESHOLDS.crossNeutral);
  const strength = scaleStrength(spread, THRESHOLDS.crossFull);

  const label =
    direction === "bullish"
      ? "golden-cross regime"
      : direction === "bearish"
        ? "death-cross regime"
        : "no clear regime";

  return signal(
    "SMA 50/200 Cross",
    direction,
    strength,
    `SMA50 is ${pct(spread)} vs SMA200 — ${label}.`,
  );
}

/**
 * RSI, read for mean reversion.
 *
 * Above 70 is overbought and therefore **bearish**; below 30 is oversold and
 * therefore bullish. Inside the band the direction is neutral and strength
 * ramps with distance from 50, so the output is monotone in |RSI - 50| across
 * the whole range rather than jumping at the bounds.
 */
export function interpretRsi(value: number | null): TechnicalSignal | null {
  if (value === null) return null;

  const { rsiOverbought, rsiOversold } = THRESHOLDS;

  if (value >= rsiOverbought) {
    // 70 -> 50, 100 -> 100.
    const strength = 50 + (50 * (value - rsiOverbought)) / (100 - rsiOverbought);
    return signal(
      "RSI (14)",
      "bearish",
      strength,
      `RSI ${value.toFixed(1)} is overbought (>= ${rsiOverbought}).`,
    );
  }

  if (value <= rsiOversold) {
    // 30 -> 50, 0 -> 100.
    const strength = 50 + (50 * (rsiOversold - value)) / rsiOversold;
    return signal(
      "RSI (14)",
      "bullish",
      strength,
      `RSI ${value.toFixed(1)} is oversold (<= ${rsiOversold}).`,
    );
  }

  // Inside the band: no directional call, strength from distance to the nearer
  // bound so it meets 50 exactly where the directional branches begin.
  const halfBand = (rsiOverbought - rsiOversold) / 2;
  const strength = (50 * Math.abs(value - 50)) / halfBand;
  return signal(
    "RSI (14)",
    "neutral",
    strength,
    `RSI ${value.toFixed(1)} is in the neutral band (${rsiOversold}-${rsiOverbought}).`,
  );
}

/**
 * MACD, read from the histogram.
 *
 * The histogram (MACD line minus signal line) is used rather than the raw
 * MACD line because the line's sign only says which EMA is higher, while the
 * histogram's sign says whether that gap is *widening* — the actual momentum
 * claim. It is normalised by price so the strength is comparable between a
 * ₹40 stock and a $400 one.
 */
export function interpretMacd(
  histogram: number | null,
  price: number | null,
): TechnicalSignal | null {
  if (histogram === null || price === null || price === 0) return null;

  const normalised = histogram / Math.abs(price);
  const direction = directionOf(normalised, THRESHOLDS.macdNeutral);
  const strength = scaleStrength(normalised, THRESHOLDS.macdFull);

  const label =
    direction === "bullish"
      ? "above"
      : direction === "bearish"
        ? "below"
        : "level with";

  return signal(
    "MACD (12/26/9)",
    direction,
    strength,
    `MACD line is ${label} its signal line; histogram ${pct(normalised, 2)} of price.`,
  );
}

/**
 * Bollinger Bands, read for mean reversion via %B.
 *
 * `%B = (price - lower) / (upper - lower)`: 0 at the lower band, 1 at the
 * upper, 0.5 at the midline. Above the upper band is overextended and read as
 * **bearish**, matching the RSI convention above.
 */
export function interpretBollinger(
  price: number | null,
  bands: { upper: number | null; middle: number | null; lower: number | null },
): TechnicalSignal | null {
  const { upper, lower } = bands;
  if (price === null || upper === null || lower === null) return null;

  const width = upper - lower;
  if (width <= 0) {
    // Zero-width bands mean a flat series — no dispersion to interpret.
    return signal(
      "Bollinger Bands (20, 2)",
      "neutral",
      0,
      "Bands have collapsed to zero width — no dispersion to read.",
    );
  }

  const percentB = (price - lower) / width;
  // Centre on the midline so the sign matches the other indicators.
  const offset = percentB - 0.5;
  // Overextension is bearish, so the direction is inverted.
  const direction = directionOf(-offset, THRESHOLDS.bollingerNeutral);
  // Full scale at the band edge (offset 0.5).
  const strength = scaleStrength(offset, 0.5);

  const position =
    percentB > 1
      ? "above the upper band"
      : percentB < 0
        ? "below the lower band"
        : percentB > 0.5
          ? "in the upper half of the bands"
          : percentB < 0.5
            ? "in the lower half of the bands"
            : "on the midline";

  return signal(
    "Bollinger Bands (20, 2)",
    direction,
    strength,
    `Price is ${position} (%B ${percentB.toFixed(2)}).`,
  );
}

/**
 * ADX — trend strength only.
 *
 * Always `neutral`: ADX is computed from the *absolute* difference of the
 * directional indicators, so it is direction-blind by construction. Reporting
 * it as bullish because the stock happens to be rising would be attributing a
 * claim to the indicator that it does not make. See `CONTEXT_INDICATORS`.
 */
export function interpretAdx(value: number | null): TechnicalSignal | null {
  if (value === null) return null;

  const strength = scaleStrength(value, THRESHOLDS.adxFull);
  const label =
    value < THRESHOLDS.adxNoTrend
      ? "no trend"
      : value < THRESHOLDS.adxTrending
        ? "a weak or emerging trend"
        : "an established trend";

  return signal(
    "ADX (14)",
    "neutral",
    strength,
    `ADX ${value.toFixed(1)} indicates ${label} (direction-blind by construction).`,
  );
}

/**
 * ATR as a fraction of price — volatility context.
 *
 * Always `neutral`, for the same reason as ADX: a wide daily range is neither
 * bullish nor bearish. See `CONTEXT_INDICATORS`.
 */
export function interpretAtr(
  value: number | null,
  price: number | null,
): TechnicalSignal | null {
  if (value === null || price === null || price === 0) return null;

  const fraction = value / Math.abs(price);
  const strength = scaleStrength(fraction, THRESHOLDS.atrFull);

  return signal(
    "ATR (14)",
    "neutral",
    strength,
    `Average true range is ${(fraction * 100).toFixed(2)}% of price.`,
  );
}

/**
 * On-Balance Volume trend.
 *
 * Reads the **slope** of the OBV series over the last `obvWindow` bars, not
 * its level: OBV is a cumulative total with an arbitrary origin, so its level
 * says nothing at all. The slope is normalised by the window's average volume,
 * which makes it a dimensionless "net accumulation per bar as a share of
 * typical volume" and comparable across symbols.
 */
export function interpretObv(bars: CleanBar[]): TechnicalSignal | null {
  const window = THRESHOLDS.obvWindow;
  if (bars.length < window + 1) return null;

  const recent = bars.slice(bars.length - window);
  const series = obvSeries(bars).slice(bars.length - window);

  const slope = linearSlope(series);
  if (slope === null) return null;

  const averageVolume =
    recent.reduce((total, bar) => total + bar.volume, 0) / recent.length;
  if (averageVolume <= 0) return null;

  const normalised = slope / averageVolume;
  const direction = directionOf(normalised, THRESHOLDS.obvNeutral);
  const strength = scaleStrength(normalised, THRESHOLDS.obvFull);

  const label =
    direction === "bullish"
      ? "accumulation"
      : direction === "bearish"
        ? "distribution"
        : "no net accumulation";

  return signal(
    "OBV Trend",
    direction,
    strength,
    `OBV slope over ${window} bars shows ${label} (${normalised.toFixed(2)}x average volume per bar).`,
  );
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Interpret a full indicator set into signals.
 *
 * Pass `indicators` when they have already been computed (the API route has
 * them) to avoid recomputing; otherwise they are derived from `history`.
 *
 * Indicators that could not be computed contribute **no entry**, so the length
 * of the result is itself information: a stock with 40 bars of history yields
 * a handful of signals, not a full set of fabricated neutrals.
 */
export function interpretTechnicals(
  history: PriceData[],
  indicators?: TechnicalIndicators,
): TechnicalSignal[] {
  const bars = cleanBars(history);
  if (bars.length === 0) return [];

  const closes = bars.map((bar) => bar.close);
  const price = closes[closes.length - 1];

  // Recompute only what we were not given.
  const ind: TechnicalIndicators =
    indicators ?? computeTechnicalIndicators(history);

  const signals: (TechnicalSignal | null)[] = [
    movingAverageCross(ind.sma50, ind.sma200),
    priceVsMovingAverage("SMA 50", price, ind.sma50),
    priceVsMovingAverage("SMA 200", price, ind.sma200),
    interpretRsi(ind.rsi14),
    interpretMacd(ind.macd.histogram, price),
    interpretBollinger(price, ind.bollingerBands),
    interpretObv(bars),
    interpretAdx(ind.adx),
    interpretAtr(ind.atr, price),
  ];

  return signals.filter((item): item is TechnicalSignal => item !== null);
}
