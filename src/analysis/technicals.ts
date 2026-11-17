/**
 * Technical indicators — pure functions over price history.
 *
 * No I/O and no provider coupling: everything here takes `PriceData[]` and
 * returns numbers, so it is deterministic and unit-testable.
 *
 * Conventions:
 * - Input bars are **oldest first**, matching `DataProvider.getPriceHistory`.
 * - Every indicator returns `null` rather than a wrong number when there are
 *   too few bars to compute it honestly. A 50-day SMA on 30 bars is not a
 *   50-day SMA.
 * - RSI, ATR and ADX use **Wilder smoothing** (the original definitions), not
 *   a simple moving average. Using an SMA here is a common bug and produces
 *   visibly different values from any charting platform.
 */

import type { PriceData, TechnicalIndicators } from "@/types/stock";

/** A bar with every field present — the result of cleaning `PriceData`. */
export interface CleanBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Simple moving average of the most recent `period` values.
 * `null` when there aren't enough values.
 */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  return mean(values.slice(values.length - period));
}

/**
 * Exponential moving average series, index-aligned with `values`.
 * Entries before the seed are `null`.
 *
 * Seeded with the SMA of the first `period` values, which is the standard
 * convention and makes the result independent of how much history precedes it.
 */
export function emaSeries(
  values: number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let ema = mean(values.slice(0, period));
  out[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Latest EMA value, or `null`. */
export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series[series.length - 1] ?? null;
}

/**
 * Wilder's smoothing series for a sequence of per-period raw values.
 *
 * Seeded with the *sum* of the first `period` values (Wilder's original form),
 * then `next = prev - prev / period + current`. Returned values are sums, not
 * averages — callers either take ratios of them (ADX) or divide (ATR, RSI).
 */
function wilderSumSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let acc = values.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = acc;

  for (let i = period; i < values.length; i++) {
    acc = acc - acc / period + values[i];
    out[i] = acc;
  }
  return out;
}

/** Population standard deviation of the most recent `period` values. */
function stdDev(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(values.length - period);
  const m = mean(window);
  const variance = mean(window.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

/**
 * Relative Strength Index, Wilder-smoothed.
 *
 * Needs `period + 1` closes (one extra to produce the first change).
 * Returns 100 when there is no downward movement in the window — the
 * mathematically correct limit, not a divide-by-zero.
 */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  let avgGain = mean(gains.slice(0, period));
  let avgLoss = mean(losses.slice(0, period));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD: the 12/26 EMA spread, its 9-period signal EMA, and the histogram.
 *
 * The signal line is an EMA of the MACD line itself, so it needs
 * `26 + 9 - 1` bars before it exists. Each field degrades to `null`
 * independently.
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macdLine: number | null; signalLine: number | null; histogram: number | null } {
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);

  // MACD line only exists where both EMAs do.
  const macdValues: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (f !== null && s !== null) macdValues.push(f - s);
  }

  if (macdValues.length === 0) {
    return { macdLine: null, signalLine: null, histogram: null };
  }

  const macdLine = macdValues[macdValues.length - 1];
  const signalLine = ema(macdValues, signal);
  const histogram = signalLine === null ? null : macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

/** Bollinger Bands: SMA(period) ± multiplier × standard deviation. */
export function bollingerBands(
  closes: number[],
  period = 20,
  multiplier = 2,
): { upper: number | null; middle: number | null; lower: number | null } {
  const middle = sma(closes, period);
  const sd = stdDev(closes, period);

  if (middle === null || sd === null) {
    return { upper: null, middle, lower: null };
  }
  return {
    upper: middle + multiplier * sd,
    middle,
    lower: middle - multiplier * sd,
  };
}

/** True range for bar `i`, which needs the previous close. */
function trueRange(bars: CleanBar[], i: number): number {
  const prevClose = bars[i - 1].close;
  return Math.max(
    bars[i].high - bars[i].low,
    Math.abs(bars[i].high - prevClose),
    Math.abs(bars[i].low - prevClose),
  );
}

/** Average True Range, Wilder-smoothed. */
export function atr(bars: CleanBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;

  const ranges: number[] = [];
  for (let i = 1; i < bars.length; i++) ranges.push(trueRange(bars, i));

  const series = wilderSumSeries(ranges, period);
  const last = series[series.length - 1];
  return last === null ? null : last / period;
}

/**
 * Average Directional Index, Wilder-smoothed.
 *
 * ADX is a smoothed average of DX, so it needs roughly `2 × period` bars of
 * directional movement before a value exists: one `period` to smooth the
 * directional indicators, another to average DX.
 */
export function adx(bars: CleanBar[], period = 14): number | null {
  if (bars.length < 2 * period + 1) return null;

  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;

    // Only the larger move counts, and only when positive.
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(trueRange(bars, i));
  }

  const trSeries = wilderSumSeries(trs, period);
  const plusSeries = wilderSumSeries(plusDM, period);
  const minusSeries = wilderSumSeries(minusDM, period);

  const dxValues: number[] = [];
  for (let i = 0; i < trSeries.length; i++) {
    const tr = trSeries[i];
    const p = plusSeries[i];
    const m = minusSeries[i];
    if (tr === null || p === null || m === null || tr === 0) continue;

    const plusDI = 100 * (p / tr);
    const minusDI = 100 * (m / tr);
    const sum = plusDI + minusDI;
    if (sum === 0) continue;

    dxValues.push(100 * (Math.abs(plusDI - minusDI) / sum));
  }

  if (dxValues.length < period) return null;

  // ADX is the Wilder average of DX.
  let adxValue = mean(dxValues.slice(0, period));
  for (let i = period; i < dxValues.length; i++) {
    adxValue = (adxValue * (period - 1) + dxValues[i]) / period;
  }
  return adxValue;
}

/**
 * On-Balance Volume as a running series, index-aligned with `bars`.
 *
 * The first entry is always 0 — OBV is a cumulative total with an arbitrary
 * origin, so only its *changes* carry information. That is why the signal
 * layer reads its slope rather than its level: a single OBV number cannot be
 * interpreted on its own.
 */
export function obvSeries(bars: CleanBar[]): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  if (bars.length === 0) return out;

  let total = 0;
  for (let i = 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) total += bars[i].volume;
    else if (diff < 0) total -= bars[i].volume;
    out[i] = total;
  }
  return out;
}

/**
 * On-Balance Volume: a running total of volume signed by the close-to-close
 * direction. An unchanged close contributes nothing.
 */
export function obv(bars: CleanBar[]): number | null {
  if (bars.length < 2) return null;
  const series = obvSeries(bars);
  return series[series.length - 1];
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Drop bars missing any field the indicators need.
 *
 * Providers pad series with nulls for halted sessions; carrying those into a
 * standard deviation or a true range would produce silent garbage.
 */
export function cleanBars(history: PriceData[]): CleanBar[] {
  const out: CleanBar[] = [];
  for (const bar of history) {
    if (
      bar.high === null ||
      bar.low === null ||
      bar.close === null ||
      bar.volume === null ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close) ||
      !Number.isFinite(bar.volume)
    ) {
      continue;
    }
    out.push({
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    });
  }
  return out;
}

/**
 * Compute the full indicator set from price history.
 *
 * Partial results are expected and fine: a stock with 60 bars gets an SMA-50
 * but a `null` SMA-200, which the UI renders as N/A.
 */
export function computeTechnicalIndicators(
  history: PriceData[],
): TechnicalIndicators {
  const bars = cleanBars(history);
  const closes = bars.map((b) => b.close);

  return {
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    bollingerBands: bollingerBands(closes),
    adx: adx(bars),
    obv: obv(bars),
    atr: atr(bars),
  };
}
