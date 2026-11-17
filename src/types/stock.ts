/**
 * QuantIQ — core domain types.
 *
 * Convention: any field that the upstream provider may omit is typed
 * `number | null`. Nothing in this file is optional-by-`?` for numerics, so
 * missing data is an explicit `null` the UI must handle, never `undefined`
 * silently becoming `NaN` in a calculation or a template.
 */

/** Markets the platform covers. */
export type Market = "US" | "IN" | "CN" | "EU";

/** Direction of a technical or fundamental read. */
export type SignalDirection = "bullish" | "bearish" | "neutral";

/** Final recommendation buckets for the composite score. */
export type CompositeSignal =
  | "Strong Buy"
  | "Buy"
  | "Hold"
  | "Sell"
  | "Strong Sell";

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

/** One OHLCV bar. `date` is an ISO-8601 date string (YYYY-MM-DD). */
export interface PriceData {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
}

/** Point-in-time snapshot shown in the quote header and stat grid. */
export interface QuoteData {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  high52Week: number | null;
  low52Week: number | null;
  dividendYield: number | null;
  beta: number | null;
  exchange: string;
  currency: string;
}

/* ------------------------------------------------------------------ */
/* Financial statements                                                */
/* ------------------------------------------------------------------ */

/**
 * One fiscal period, flattened across the income statement, balance sheet
 * and cash-flow statement. `date` is the fiscal period end date (ISO-8601).
 */
export interface FinancialStatement {
  date: string;
  // Income statement
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null;
  // Balance sheet
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  // Cash flow
  freeCashFlow: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
}

/* ------------------------------------------------------------------ */
/* Fundamentals                                                        */
/* ------------------------------------------------------------------ */

/**
 * Derived fundamental ratios.
 *
 * Margins, yields and `roe`/`roa`/`roic` are expressed as decimal fractions
 * (0.42 means 42%), matching what the provider returns. Format at the edge,
 * never in the data layer.
 */
export interface FundamentalMetrics {
  // Valuation
  peRatio: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  evToEbitda: number | null;
  // Profitability
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roic: number | null;
  roe: number | null;
  roa: number | null;
  // Cash flow
  fcfYield: number | null;
  fcfPerShare: number | null;
  // Financial health
  debtToEquity: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  interestCoverage: number | null;
  altmanZScore: number | null;
}

/** Output of a discounted-cash-flow valuation. */
export interface DCFResult {
  intrinsicValue: number | null;
  currentPrice: number | null;
  /** Decimal fraction: 0.25 means 25% upside to intrinsic value. */
  upside: number | null;
  wacc: number | null;
  terminalGrowthRate: number | null;
  /** Forward-projected free cash flows, earliest year first. */
  projectedFCF: number[];
}

/* ------------------------------------------------------------------ */
/* Technicals                                                          */
/* ------------------------------------------------------------------ */

export interface MACD {
  macdLine: number | null;
  signalLine: number | null;
  histogram: number | null;
}

export interface BollingerBands {
  upper: number | null;
  middle: number | null;
  lower: number | null;
}

export interface TechnicalIndicators {
  sma50: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macd: MACD;
  bollingerBands: BollingerBands;
  adx: number | null;
  obv: number | null;
  atr: number | null;
}

/** A single indicator's interpreted read. `strength` is 0-100. */
export interface TechnicalSignal {
  indicator: string;
  signal: SignalDirection;
  strength: number;
  description: string;
}

/* ------------------------------------------------------------------ */
/* Ownership & sentiment                                               */
/* ------------------------------------------------------------------ */

export interface InstitutionalHolder {
  holder: string;
  shares: number | null;
  value: number | null;
  /** Decimal fraction of shares outstanding. */
  percentHeld: number | null;
  changeShares: number | null;
  changePercent: number | null;
  dateReported: string;
}

export interface InsiderTransaction {
  name: string;
  title: string;
  transactionType: string;
  shares: number | null;
  value: number | null;
  date: string;
}

export interface SentimentData {
  /** Aggregate sentiment in the range -1 (max bearish) to 1 (max bullish). */
  overall: number;
  positive: number;
  negative: number;
  neutral: number;
  source: string;
  headlines: SentimentHeadline[];
}

export interface SentimentHeadline {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  /** -1 to 1 for this individual headline. */
  sentiment: number | null;
}

/* ------------------------------------------------------------------ */
/* Risk                                                                */
/* ------------------------------------------------------------------ */

export interface RiskMetrics {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  /** Decimal fraction, negative: -0.34 means a 34% peak-to-trough drawdown. */
  maxDrawdown: number | null;
  /** Annualised standard deviation of returns, as a decimal fraction. */
  volatility: number | null;
  var95: number | null;
  cvar95: number | null;
  beta: number | null;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** One analysis layer's contribution to the composite score. */
export interface LayerScore {
  layer: string;
  /** 0-100. */
  score: number;
  /** Decimal fraction of the composite; the layer weights sum to 1. */
  weight: number;
  signals: TechnicalSignal[];
  sentiment: SignalDirection;
}

export interface CompositeScore {
  /** 0-100. */
  totalScore: number;
  signal: CompositeSignal;
  /** 0-100 — how much agreement there was between layers. */
  confidence: number;
  layers: LayerScore[];
  /** ISO-8601 timestamp. */
  lastUpdated: string;
}

/* ------------------------------------------------------------------ */
/* Full report                                                         */
/* ------------------------------------------------------------------ */

/** The complete multi-layer analysis for one security. */
export interface StockAnalysis {
  symbol: string;
  name: string;
  market: Market;
  currency: string;
  quote: QuoteData | null;
  priceHistory: PriceData[];
  financials: FinancialStatement[];
  fundamentals: FundamentalMetrics | null;
  dcf: DCFResult | null;
  technicals: TechnicalIndicators | null;
  technicalSignals: TechnicalSignal[];
  institutionalHolders: InstitutionalHolder[];
  insiderTransactions: InsiderTransaction[];
  sentiment: SentimentData | null;
  risk: RiskMetrics | null;
  composite: CompositeScore | null;
  /** ISO-8601 timestamp of when this report was assembled. */
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Portfolio                                                           */
/* ------------------------------------------------------------------ */

export interface PortfolioHolding {
  symbol: string;
  name: string;
  market: Market;
  currency: string;
  quantity: number;
  averageCost: number;
  currentPrice: number | null;
  /** quantity * averageCost */
  investedValue: number;
  /** quantity * currentPrice */
  currentValue: number | null;
  unrealizedPnL: number | null;
  /** Decimal fraction. */
  unrealizedPnLPercent: number | null;
  /** Decimal fraction of total portfolio value. */
  weight: number | null;
  /** ISO-8601 date the position was opened. */
  purchaseDate: string;
}

/** Projection for a systematic investment plan. */
export interface SIPProjection {
  monthlyInvestment: number;
  /** Decimal fraction, annualised. */
  expectedAnnualReturn: number;
  years: number;
  totalInvested: number;
  projectedValue: number;
  totalGains: number;
  /** Year-by-year breakdown, earliest first. */
  yearlyBreakdown: SIPYearlyPoint[];
}

export interface SIPYearlyPoint {
  year: number;
  invested: number;
  value: number;
  gains: number;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/** Uniform envelope for every QuantIQ API route. */
export type APIResponse<T> =
  | { success: true; data: T; timestamp: string }
  | { success: false; error: string; timestamp: string };

/** One row of the ticker-search autocomplete. */
export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  /** Provider's instrument type, e.g. "EQUITY" or "ETF". */
  quoteType: string;
}

/* ------------------------------------------------------------------ */
/* Metric availability                                                 */
/* ------------------------------------------------------------------ */

/**
 * Why a metric could not be computed.
 *
 * The point of this union is that `null` is ambiguous: it cannot distinguish
 * "the provider reported 0" from "the provider reported nothing" from "this
 * input does not exist for this market". A metric that silently returns `null`
 * reads, in a UI, exactly like a computed zero. These reasons make the
 * difference explicit and renderable.
 */
export type MetricUnavailableReason =
  /** One or more required inputs came back `null` from the provider. */
  | "missing-inputs"
  /**
   * The input is structurally not reported for this listing's market, so no
   * amount of retrying will produce it. See `MARKET_INPUT_GAPS`.
   */
  | "unavailable-for-market"
  /**
   * No data provider is configured that covers this listing's market at all,
   * so the question of individual inputs does not arise yet. Distinct from
   * `unavailable-for-market`, which means a provider covers the market but
   * does not report that particular line. See `MARKETS_WITHOUT_PROVIDER`.
   */
  | "no-provider-for-market"
  /**
   * Inputs were present but the metric is mathematically undefined for this
   * company — a zero denominator, or an unbounded ratio. This is a real
   * finding about the company, not a data gap.
   */
  | "not-meaningful"
  /**
   * Needs a live price or market capitalisation, which the pure computation
   * was not given. Supply a quote to resolve it.
   */
  | "requires-quote";

/** A metric that could not be computed, and precisely why. */
export interface MetricUnavailable {
  status: "unavailable";
  reason: MetricUnavailableReason;
  /** Named inputs that were absent, for display and for debugging. */
  missing: string[];
  /** One-line explanation, safe to show in a tooltip. */
  detail: string;
}

/** A metric that was computed. */
export interface MetricOk<T> {
  status: "ok";
  value: T;
}

/**
 * The result of computing one metric.
 *
 * Discriminate on `status` — there is no `null` case by construction, so a
 * caller cannot accidentally treat an unavailable metric as a number.
 */
export type MetricResult<T = number> = MetricOk<T> | MetricUnavailable;

/**
 * Phase 2c derived fundamentals.
 *
 * Deliberately **not** `number | null`: these are the five metrics whose
 * inputs are most likely to be missing on non-US listings, so each carries its
 * own availability. `collapseDerived()` flattens them into the
 * `FundamentalMetrics` wire shape when a plain number is all the consumer can
 * take.
 */
export interface DerivedFundamentals {
  /** Return on invested capital: NOPAT / (total debt + total equity). */
  roic: MetricResult;
  /** Free cash flow / market capitalisation. */
  fcfYield: MetricResult;
  /** Free cash flow / weighted average shares. */
  fcfPerShare: MetricResult;
  /** EBIT / |interest expense|. */
  interestCoverage: MetricResult;
  /** Altman Z-Score (classic five-factor form). */
  altmanZScore: MetricResult;
}

/* ------------------------------------------------------------------ */
/* Analyst consensus                                                   */
/* ------------------------------------------------------------------ */

/** Sell-side recommendation counts for one month. */
export interface AnalystConsensus {
  /** Month the counts refer to, `YYYY-MM-DD`. */
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  total: number;
}
