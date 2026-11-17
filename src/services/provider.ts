/**
 * The contract every market-data source must satisfy.
 *
 * Phases 2+ (analysis, scoring, portfolio) depend on this interface and never
 * on a concrete vendor, so a source can be swapped — or a failing one fenced
 * off — without touching analysis code.
 *
 * Implementations are **total**: they absorb their own transport errors, log
 * them, and return `[]` / `null`. Nothing here throws, so callers (API routes,
 * analysis layer) never need a try/catch and a single dead endpoint degrades
 * one section of a report instead of failing the whole request.
 */

import type {
  AnalystConsensus,
  FinancialStatement,
  FundamentalMetrics,
  InsiderTransaction,
  PriceData,
  QuoteData,
  SearchResult,
} from "@/types/stock";

/**
 * Registered data sources.
 *
 * `live` is the composite used in practice: Finnhub for US fundamentals and
 * quotes, a separate OHLCV source for bars (Finnhub's candles are premium).
 * See `src/services/liveProvider.ts`.
 */
export type ProviderId = "live" | "finnhub" | "yahoo" | "fixture";

export interface DataProvider {
  /** Stable id, used for logging and provider selection. */
  readonly id: ProviderId;
  /** Human-readable name for attribution in the UI. */
  readonly label: string;

  /** Ticker autocomplete, restricted to tradeable instruments. */
  searchTickers(query: string): Promise<SearchResult[]>;

  /** Latest quote, or `null` if the symbol has no usable price. */
  getQuote(symbol: string): Promise<QuoteData | null>;

  /** OHLCV bars, **oldest first**. */
  getPriceHistory(
    symbol: string,
    range?: string,
    interval?: string,
  ): Promise<PriceData[]>;

  /** Annual statements, **most recent period first**. */
  getFinancials(symbol: string): Promise<FinancialStatement[]>;

  /**
   * Fundamental ratios. Returns a fully-populated object with `null` for any
   * metric the source does not report, never a partial object.
   */
  getFundamentalMetrics(symbol: string): Promise<FundamentalMetrics>;

  /** Latest sell-side recommendation counts. Optional: not every source has them. */
  getAnalystConsensus?(symbol: string): Promise<AnalystConsensus | null>;

  /** Recent open-market insider buys and sells, newest first. Optional. */
  getInsiderTransactions?(symbol: string): Promise<InsiderTransaction[]>;

  /**
   * Currency the financial statements are reported in, when it is known.
   * Differs from the trading currency for some listings (Infosys reports in
   * USD and trades in INR), which makes price-vs-statement maths invalid.
   */
  getStatementCurrency?(symbol: string): Promise<string | null>;
}
