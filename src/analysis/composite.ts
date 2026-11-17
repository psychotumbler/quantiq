/**
 * Composite scoring — combines whichever analysis layers have data.
 *
 * The methodology weights six layers 30/15/20/15/10/10. Only layers with a
 * real data source are scored; the rest are omitted and the remaining weights
 * are renormalised, so a missing layer is never silently counted as neutral.
 * `confidence` reports how much of the full model actually contributed.
 *
 * | Layer | Methodology weight | Scored from |
 * |---|---|---|
 * | Fundamental | 30 | ratios + derived metrics |
 * | Technical | 15 | directional technical signals |
 * | Institutional | 20 | change in promoter stake (NSE-listed only), when it moved |
 * | Macro | 15 | market regime: volatility index, benchmark trend, US yield curve |
 * | Sentiment | 10 | analyst consensus + word-list headline tone (not NLP) |
 * | Risk | 10 | Sharpe, drawdown, volatility |
 *
 * Every threshold below is a stated modelling assumption, not a calibrated or
 * backtested parameter. The output is a model score, not investment advice.
 */

import type {
  AnalystConsensus,
  CompositeScore,
  CompositeSignal,
  FundamentalMetrics,
  LayerScore,
  RiskMetrics,
  SentimentData,
  SignalDirection,
  TechnicalSignal,
} from "@/types/stock";
import { isContextSignal } from "@/analysis/signals";

export const LAYER_WEIGHTS = {
  Fundamental: 30,
  Technical: 15,
  Institutional: 20,
  Macro: 15,
  Sentiment: 10,
  Risk: 10,
} as const;

/** Weight of the full six-layer model, including layers not yet built. */
export const FULL_MODEL_WEIGHT = 100;

/**
 * Map `value` linearly onto 0–100 between `worst` and `best`, clamped.
 * Works in either direction (`best` may be below `worst`).
 */
export function scale(value: number | null, worst: number, best: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const t = (value - worst) / (best - worst);
  return Math.round(Math.min(1, Math.max(0, t)) * 100);
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0
    ? null
    : present.reduce((a, b) => a + b, 0) / present.length;
}

function directionOf(score: number): SignalDirection {
  if (score >= 60) return "bullish";
  if (score <= 40) return "bearish";
  return "neutral";
}

function detail(indicator: string, score: number | null, description: string): TechnicalSignal | null {
  if (score === null) return null;
  return { indicator, signal: directionOf(score), strength: score, description };
}

function layer(
  name: keyof typeof LAYER_WEIGHTS,
  parts: (TechnicalSignal | null)[],
  override?: number,
): LayerScore | null {
  const signals = parts.filter((p): p is TechnicalSignal => p !== null);
  if (signals.length === 0) return null;
  const score = Math.round(
    override ?? (average(signals.map((s) => s.strength)) as number),
  );
  return {
    layer: name,
    score,
    weight: LAYER_WEIGHTS[name],
    signals,
    sentiment: directionOf(score),
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

export function scoreFundamentals(f: FundamentalMetrics | null): LayerScore | null {
  if (!f) return null;
  return layer("Fundamental", [
    // A negative P/E means losses, which is not "cheap": score it at the floor.
    detail(
      "P/E",
      f.peRatio === null ? null : f.peRatio <= 0 ? 0 : scale(f.peRatio, 40, 10),
      f.peRatio === null ? "" : `Trailing P/E ${f.peRatio.toFixed(1)} (10 or below scores full, 40 or above scores zero)`,
    ),
    detail("FCF yield", scale(f.fcfYield, 0, 0.08),
      f.fcfYield === null ? "" : `Free cash flow yield ${pct(f.fcfYield)}`),
    detail("Net margin", scale(f.netMargin, 0, 0.25),
      f.netMargin === null ? "" : `Net margin ${pct(f.netMargin)}`),
    detail("ROIC", scale(f.roic, 0, 0.25),
      f.roic === null ? "" : `Return on invested capital ${pct(f.roic)}`),
    detail("ROE", scale(f.roe, 0, 0.3),
      f.roe === null ? "" : `Return on equity ${pct(f.roe)}`),
    detail("Debt / equity", scale(f.debtToEquity, 2.5, 0.3),
      f.debtToEquity === null ? "" : `Debt to equity ${f.debtToEquity.toFixed(2)}`),
    detail("Current ratio", scale(f.currentRatio, 0.7, 2),
      f.currentRatio === null ? "" : `Current ratio ${f.currentRatio.toFixed(2)}`),
    detail("Interest coverage", scale(f.interestCoverage, 1, 10),
      f.interestCoverage === null ? "" : `EBIT covers interest ${f.interestCoverage.toFixed(1)}x`),
    // Altman's own cut-offs: below 1.8 distress, above 3.0 safe.
    detail("Altman Z", scale(f.altmanZScore, 1.8, 3),
      f.altmanZScore === null ? "" : `Altman Z-Score ${f.altmanZScore.toFixed(2)} (below 1.8 distress, above 3.0 safe)`),
  ]);
}

export function scoreTechnicals(signals: TechnicalSignal[]): LayerScore | null {
  // ADX and ATR carry no direction; counting them would drag every score to 50.
  const directional = signals.filter((s) => !isContextSignal(s));
  if (directional.length === 0) return null;

  const signed = directional.map((s) =>
    s.signal === "bullish" ? s.strength : s.signal === "bearish" ? -s.strength : 0,
  );
  const net = signed.reduce((a, b) => a + b, 0) / directional.length; // −100..100
  return layer("Technical", directional, 50 + net / 2);
}

export function scoreRisk(risk: RiskMetrics | null): LayerScore | null {
  if (!risk) return null;
  return layer("Risk", [
    detail("Sharpe", scale(risk.sharpeRatio, 0, 1.5),
      risk.sharpeRatio === null ? "" : `Sharpe ratio ${risk.sharpeRatio.toFixed(2)} over the window`),
    detail("Max drawdown", scale(risk.maxDrawdown, 0.5, 0.1),
      risk.maxDrawdown === null ? "" : `Worst peak-to-trough fall ${pct(risk.maxDrawdown)}`),
    detail("Volatility", scale(risk.volatility, 0.6, 0.15),
      risk.volatility === null ? "" : `Annualised volatility ${pct(risk.volatility)}`),
  ]);
}

/** Fewer scored headlines than this and news tone is left out as noise. */
export const MIN_SCORED_HEADLINES = 5;

function analystSignal(consensus: AnalystConsensus | null): TechnicalSignal | null {
  if (!consensus || consensus.total === 0) return null;
  const { strongBuy, buy, hold, sell, strongSell, total } = consensus;
  const score = (strongBuy * 100 + buy * 75 + hold * 50 + sell * 25) / total;
  return {
    indicator: "Analyst consensus",
    signal: directionOf(score),
    strength: Math.round(score),
    description: `${strongBuy + buy} buy, ${hold} hold, ${sell + strongSell} sell across ${total} analysts`,
  };
}

function newsSignal(news: SentimentData | null): TechnicalSignal | null {
  if (!news) return null;
  const scored = news.positive + news.negative;
  if (scored < MIN_SCORED_HEADLINES) return null;
  // `overall` is in [−1, 1]; map it onto 0–100.
  const score = Math.round(50 + news.overall * 50);
  return {
    indicator: "Headline tone",
    signal: directionOf(score),
    strength: score,
    description: `${news.positive} positive and ${news.negative} negative of ${news.headlines.length} recent headlines (word-list scoring)`,
  };
}

export function scoreSentiment(
  consensus: AnalystConsensus | null,
  news: SentimentData | null = null,
): LayerScore | null {
  return layer("Sentiment", [analystSignal(consensus), newsSignal(news)]);
}

/** Analyst-only sentiment. Kept for callers without headlines. */
export function scoreAnalysts(consensus: AnalystConsensus | null): LayerScore | null {
  return scoreSentiment(consensus, null);
}

/** Inputs for the macro layer. All optional: missing ones are skipped. */
export interface MacroInputs {
  /** India VIX or CBOE VIX level. */
  vix: number | null;
  /** Benchmark index change over about one month, decimal. */
  indexTrend: number | null;
  indexName: string;
  /** US 10-year minus 2-year Treasury yield, percentage points. US only. */
  curveSpread: number | null;
}

/**
 * Market regime. The same for every stock in a market on a given day: it
 * says whether conditions are supportive, not anything about the company.
 */
export function scoreMacro(macro: MacroInputs | null): LayerScore | null {
  if (!macro) return null;
  return layer("Macro", [
    // A volatility index near 12 is calm; 35 is a stressed market.
    detail("Volatility index", scale(macro.vix, 35, 12),
      macro.vix === null ? "" : `Volatility index at ${macro.vix.toFixed(1)} (12 calm, 35 stressed)`),
    detail(`${macro.indexName} trend`, scale(macro.indexTrend, -0.08, 0.08),
      macro.indexTrend === null ? "" : `${macro.indexName} ${pct(macro.indexTrend)} over the past month`),
    detail("Yield curve", scale(macro.curveSpread, -0.5, 1),
      macro.curveSpread === null ? "" : `US 10Y minus 2Y at ${macro.curveSpread.toFixed(2)} points (negative is inverted)`),
  ]);
}

/** A promoter-stake move smaller than this (percentage points) is not scored. */
export const MIN_PROMOTER_MOVE = 0.25;

/**
 * Ownership: the change in promoter holding over the last four quarters.
 * Scored only when the stake actually moved — an unchanged stake says
 * nothing, and scoring it neutral would just pull every total toward 50.
 * `quarters` is newest first, in percent.
 */
export function scoreOwnership(
  quarters: { date: string; promoter: number }[],
): LayerScore | null {
  if (quarters.length < 5) return null;
  const change = quarters[0].promoter - quarters[4].promoter;
  if (Math.abs(change) < MIN_PROMOTER_MOVE) return null;
  return layer("Institutional", [
    detail(
      "Promoter stake",
      scale(change, -3, 3),
      `Promoters hold ${quarters[0].promoter.toFixed(2)}%, ${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)} points in a year`,
    ),
  ]);
}

/* ------------------------------------------------------------------ */
/* Composite                                                           */
/* ------------------------------------------------------------------ */

export function signalFor(score: number): CompositeSignal {
  if (score >= 75) return "Strong Buy";
  if (score >= 60) return "Buy";
  if (score >= 40) return "Hold";
  if (score >= 25) return "Sell";
  return "Strong Sell";
}

export function computeComposite(input: {
  fundamentals: FundamentalMetrics | null;
  technicalSignals: TechnicalSignal[];
  risk: RiskMetrics | null;
  analysts: AnalystConsensus | null;
  news?: SentimentData | null;
  macro?: MacroInputs | null;
  /** Promoter holding by quarter, newest first. */
  ownership?: { date: string; promoter: number }[];
  now?: string;
}): CompositeScore | null {
  const layers = [
    scoreFundamentals(input.fundamentals),
    scoreTechnicals(input.technicalSignals),
    scoreOwnership(input.ownership ?? []),
    scoreMacro(input.macro ?? null),
    scoreSentiment(input.analysts, input.news ?? null),
    scoreRisk(input.risk),
  ].filter((l): l is LayerScore => l !== null);

  if (layers.length === 0) return null;

  const weight = layers.reduce((acc, l) => acc + l.weight, 0);
  const totalScore = Math.round(
    layers.reduce((acc, l) => acc + l.score * l.weight, 0) / weight,
  );

  return {
    totalScore,
    signal: signalFor(totalScore),
    // Share of the full six-layer model that had data behind it.
    confidence: Math.round((weight / FULL_MODEL_WEIGHT) * 100),
    layers,
    lastUpdated: input.now ?? new Date().toISOString(),
  };
}
