/**
 * Yahoo Finance data service.
 *
 * ## ⚠ DEMOTED — local development only, not the default provider
 *
 * Yahoo has had **no official API since 2017**. Every endpoint below is
 * undocumented internal plumbing for finance.yahoo.com, and it is retained for
 * two reasons only: as a second opinion when cross-checking another provider's
 * figures, and as evidence that the `DataProvider` abstraction actually
 * permits swapping sources. **Do not make it the default again.**
 *
 * Specifically:
 *
 * - `query1` returns **HTTP 429 without a valid browser session crumb**. This
 *   was previously recorded as IP rate limiting; it is not — it is the
 *   unauthenticated-request response, on top of a roughly 2,000/hour IP cap.
 * - Implementing the cookie + crumb handshake would still fail from a
 *   datacenter IP, so it cannot work on a Vercel deploy regardless of effort.
 * - 23 of the 28 `TS` type names remain unverified, and the probe to settle
 *   them has never completed from any machine with sandbox access.
 *
 * ### Not all of it is equally dead
 *
 * The demotion is about the *authenticated* surface. `v8/finance/chart` is the
 * exception: it never required a crumb and returned 200 on every test from a
 * residential connection. It is therefore **retained deliberately as a
 * local-dev OHLCV source**, for offline comparison against whichever provider
 * supplies price history in production — useful precisely because it is an
 * independent implementation of the same series.
 *
 * | Endpoint | State |
 * |---|---|
 * | `v8/finance/chart` | works unauthenticated — **kept for local dev** |
 * | `v1/finance/search` | works unauthenticated |
 * | `ws/fundamentals-timeseries` | 429 without a crumb; 23 type names unverified |
 * | `v10/finance/quoteSummary` | dead — requires a crumb, always `Invalid Crumb` |
 *
 * Even `v8/finance/chart` 429s from a datacenter IP, so it cannot serve
 * production on Vercel. Local dev and comparison only.
 *
 * `finnhub` replaces it as the primary source for fundamentals, quotes and
 * metrics. Opt into this one explicitly with
 * `QUANTIQ_DATA_PROVIDER=yahoo npm run dev`.
 *
 * ## Endpoint situation (verified from the user's own machine, Nov 2026)
 *
 * `v10/finance/quoteSummary` is **dead for unauthenticated use** — it requires
 * a crumb + cookie session and otherwise returns
 * `{"finance":{"result":null,"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}`.
 * The first version of this file was built on it, so `getQuote`,
 * `getFinancials` and `getFundamentalMetrics` were all non-functional. They
 * are now rebuilt on the two endpoints confirmed to work without auth:
 *
 * - `v8/finance/chart/{symbol}` — prices, and a `meta` block used for quotes.
 * - `ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}` — statements.
 *
 * ## Timeseries quirks
 *
 * - Yahoo **silently drops** type names it doesn't recognise rather than
 *   erroring, so a typo yields `null` metrics, not a failure. Names are
 *   therefore probed (`scripts/probe-yahoo-types.mjs`), not guessed.
 * - Casing is inconsistent: `annualEBITDA`, not `annualEbitda`.
 * - Each requested type is its own entry in `timeseries.result`, keyed by its
 *   own name, with periods **oldest first** and values at
 *   `reportedValue.raw`.
 *
 * Every exported function is total: it catches its own errors, logs them, and
 * returns `[]` / `null` rather than throwing.
 */

import axios, { type AxiosInstance } from "axios";
import type { DataProvider } from "@/services/provider";
import type {
  DerivedFundamentals,
  FinancialStatement,
  FundamentalMetrics,
  Market,
  PriceData,
  QuoteData,
  SearchResult,
} from "@/types/stock";
import {
  collapseDerived,
  computeDerivedFundamentals,
  type FundamentalInputs,
} from "@/analysis/fundamentals";

const QUERY1 = "https://query1.finance.yahoo.com";

/**
 * Measured on 2026-11-17 via /api/health: Yahoo answers a bare
 * `Mozilla/5.0` with 200 and a full Chrome desktop User-Agent with 429,
 * from axios, fetch and curl alike. Send the bare form and nothing else.
 */
const BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0" } as const;

const client: AxiosInstance = axios.create({
  timeout: 20_000,
  headers: BROWSER_HEADERS,
});

/* ------------------------------------------------------------------ */
/* Timeseries type names                                               */
/* ------------------------------------------------------------------ */

/**
 * Yahoo timeseries type names, in one place so a probe correction is a
 * one-line change.
 *
 * `CONFIRMED` were verified against a real captured payload, committed as
 * `__fixtures__/aapl-timeseries.json`. A test asserts the CONFIRMED list
 * matches that payload exactly, so no name can be promoted without evidence.
 *
 * `UNCONFIRMED` are best guesses. Because Yahoo drops unknown names silently,
 * a wrong guess shows up as a `null` metric rather than an error, so these
 * must be probed before being trusted. Probe with
 * `node scripts/probe-yahoo-types.mjs`.
 *
 * **Do not promote a name from a probe run whose output has
 * `inconclusive: true`.** The run of 2026-11-14 reported all 51 names as
 * dropped for both AAPL and RELIANCE.NS because every request returned HTTP
 * 429 — acting on it would have deleted the five confirmed names below. See
 * PROGRESS.md.
 */
export const TS = {
  // --- CONFIRMED against __fixtures__/aapl-timeseries.json ---
  revenue: "annualTotalRevenue",
  netIncome: "annualNetIncome",
  ebitda: "annualEBITDA",
  totalDebt: "annualTotalDebt",
  totalEquity: "annualStockholdersEquity",

  // --- Confirmed LIVE on 2026-11-17 for AAPL and RELIANCE.NS through
  // /api/health?raw=1 (every name below returned four annual periods).
  // Not fixture-backed, so the fixture test above still lists only five. ---
  grossProfit: "annualGrossProfit",
  operatingIncome: "annualOperatingIncome",
  ebit: "annualEBIT",
  pretaxIncome: "annualPretaxIncome",
  taxProvision: "annualTaxProvision",
  interestExpense: "annualInterestExpense",
  totalAssets: "annualTotalAssets",
  totalLiabilities: "annualTotalLiabilitiesNetMinorityInterest",
  cash: "annualCashAndCashEquivalents",
  currentAssets: "annualCurrentAssets",
  currentLiabilities: "annualCurrentLiabilities",
  inventory: "annualInventory",
  retainedEarnings: "annualRetainedEarnings",
  workingCapital: "annualWorkingCapital",
  operatingCashFlow: "annualOperatingCashFlow",
  freeCashFlow: "annualFreeCashFlow",
  capex: "annualCapitalExpenditure",
  shares: "annualBasicAverageShares",
} as const;

/** Types needed to build `FinancialStatement[]`. */
const STATEMENT_TYPES: string[] = [
  TS.revenue,
  TS.grossProfit,
  TS.operatingIncome,
  TS.netIncome,
  TS.ebitda,
  TS.totalAssets,
  TS.totalLiabilities,
  TS.totalEquity,
  TS.totalDebt,
  TS.cash,
  TS.freeCashFlow,
  TS.operatingCashFlow,
  TS.capex,
];

/**
 * Additional types needed for the fundamental ratios, including the Phase 2c
 * derived metrics (ROIC needs the tax lines; the Altman Z-Score needs retained
 * earnings, working capital and total liabilities).
 */
const RATIO_TYPES: string[] = [
  TS.revenue,
  TS.grossProfit,
  TS.operatingIncome,
  TS.netIncome,
  TS.ebit,
  TS.pretaxIncome,
  TS.taxProvision,
  TS.interestExpense,
  TS.totalAssets,
  TS.totalLiabilities,
  TS.totalEquity,
  TS.totalDebt,
  TS.currentAssets,
  TS.currentLiabilities,
  TS.inventory,
  TS.retainedEarnings,
  TS.workingCapital,
  TS.freeCashFlow,
  TS.operatingCashFlow,
  TS.capex,
  TS.shares,
];

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** A Yahoo numeric: bare, or wrapped as `{ raw, fmt }`. */
type YahooNumber = number | { raw?: number; fmt?: string } | null | undefined;

/** Unwrap to a finite `number | null`, rejecting `NaN`/`Infinity`. */
function raw(value: YahooNumber): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : value.raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Safe division: `null` unless both sides are usable and the divisor is non-zero. */
function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** Add two possibly-null numbers; `null` only when both are missing. */
function add(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Map a Yahoo exchange code to a market. Yahoo is inconsistent (`NSI` and
 * `NSE` both appear for India), so the lists are generous and anything
 * unrecognised falls back to US.
 */
export function marketFromExchange(exchange: string): Market {
  const code = (exchange || "").toUpperCase();
  if (["NSI", "BSE", "NSE", "BOM"].includes(code)) return "IN";
  if (["SHH", "SHZ", "HKG"].includes(code)) return "CN";
  if (["LSE", "PAR", "FRA", "AMS", "MIL"].includes(code)) return "EU";
  return "US";
}

/**
 * Market implied by a ticker's suffix.
 *
 * Yahoo encodes the listing venue in the symbol (`RELIANCE.NS`, `0700.HK`),
 * which is the only market signal available before a quote comes back. Used to
 * attribute a missing statement line to the market rather than to a transient
 * provider gap. A bare symbol is US, matching Yahoo's own convention.
 */
export function marketFromSymbol(symbol: string): Market {
  const suffix = (symbol.split(".")[1] ?? "").toUpperCase();
  if (!suffix) return "US";
  if (["NS", "BO", "NSE", "BSE"].includes(suffix)) return "IN";
  if (["SS", "SZ", "HK"].includes(suffix)) return "CN";
  if (["L", "PA", "DE", "F", "AS", "MI", "MC", "BR", "LS", "VI", "SW"].includes(suffix)) {
    return "EU";
  }
  return "US";
}

function logFailure(fn: string, symbol: string, error: unknown): void {
  const detail = axios.isAxiosError(error)
    ? `HTTP ${error.response?.status ?? "?"} ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  console.error(`[yahooFinance.${fn}] ${symbol}: ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Timeseries access                                                   */
/* ------------------------------------------------------------------ */

/** One type's values, keyed by fiscal period end date (`asOfDate`). */
type TypeSeries = Map<string, number>;

interface TimeseriesResult {
  /** Yahoo type name -> (asOfDate -> value). */
  series: Map<string, TypeSeries>;
  /** Reporting currency, from the first row that carries one. */
  currency: string | null;
  /** Requested names that came back with no data — i.e. unknown to Yahoo. */
  missing: string[];
}

/**
 * Parse a raw fundamentals-timeseries response into `type -> (date -> value)`.
 *
 * Exported and pure so it can be tested against real saved payloads rather
 * than trusted. Merges into `into` when given, so batched requests accumulate.
 */
export function parseTimeseriesPayload(
  data: Json,
  into?: Map<string, TypeSeries>,
): { series: Map<string, TypeSeries>; currency: string | null } {
  const series = into ?? new Map<string, TypeSeries>();
  let currency: string | null = null;

  for (const entry of (data?.timeseries?.result ?? []) as Json[]) {
    const name: string | undefined = entry?.meta?.type?.[0];
    if (!name) continue;

    const rows: Json[] = Array.isArray(entry[name])
      ? entry[name].filter(Boolean)
      : [];
    if (rows.length === 0) continue;

    const byDate: TypeSeries = series.get(name) ?? new Map();
    for (const row of rows) {
      const date = String(row?.asOfDate ?? "");
      const value = raw(row?.reportedValue);
      if (date && value !== null) byDate.set(date, value);
      if (!currency && row?.currencyCode) currency = String(row.currencyCode);
    }
    if (byDate.size > 0) series.set(name, byDate);
  }

  return { series, currency };
}

/** Yahoo rejects very long query strings, so types go in batches. */
const BATCH_SIZE = 20;

/**
 * Fetch the given timeseries types.
 *
 * A dropped type is recorded in `missing` rather than treated as an error:
 * that is how Yahoo reports an unknown name, and a single bad name must not
 * cost us the other twelve.
 */
async function fetchTimeseries(
  symbol: string,
  types: string[],
  yearsBack = 8,
): Promise<TimeseriesResult> {
  const series = new Map<string, TypeSeries>();
  let currency: string | null = null;

  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - yearsBack * 365 * 24 * 60 * 60;

  const unique = Array.from(new Set(types));

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const url = `${QUERY1}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`;

    const { data } = await client.get(url, {
      params: {
        symbol,
        type: batch.join(","),
        period1,
        period2,
        merge: false,
      },
    });

    const parsed = parseTimeseriesPayload(data, series);
    if (!currency) currency = parsed.currency;
  }

  const missing = unique.filter((t) => !series.has(t));
  if (missing.length > 0) {
    // Loud, because this is the silent-failure mode: unknown names become
    // null metrics with no HTTP error anywhere.
    console.warn(
      `[yahooFinance] ${symbol}: ${missing.length} timeseries type(s) returned no data (unknown name or unavailable for this listing): ${missing.join(", ")}`,
    );
  }

  return { series, currency, missing };
}

/** Every fiscal period present across all types, most recent first. */
function periodsDescending(series: Map<string, TypeSeries>): string[] {
  const dates = new Set<string>();
  for (const byDate of series.values()) {
    for (const date of byDate.keys()) dates.add(date);
  }
  return Array.from(dates).sort((a, b) => b.localeCompare(a));
}

/** Value of `type` at `date`, or `null`. */
function at(
  series: Map<string, TypeSeries>,
  type: string,
  date: string,
): number | null {
  const value = series.get(type)?.get(date);
  return value === undefined ? null : value;
}

/** Value of `type` in the most recent period that has one. */
function latest(
  series: Map<string, TypeSeries>,
  type: string,
  periods: string[],
): number | null {
  for (const date of periods) {
    const value = at(series, type, date);
    if (value !== null) return value;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ticker autocomplete. Unchanged — `v1/finance/search` works unauthenticated.
 */
export async function searchTickers(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const { data } = await client.get(`${QUERY1}/v1/finance/search`, {
      params: {
        q: trimmed,
        quotesCount: 10,
        newsCount: 0,
        listsCount: 0,
        enableFuzzyQuery: false,
      },
    });

    const quotes: Json[] = data?.quotes ?? [];

    return quotes
      .filter((q) => {
        const type = String(q?.quoteType ?? "").toUpperCase();
        return (type === "EQUITY" || type === "ETF") && Boolean(q?.symbol);
      })
      .map((q) => {
        const exchange = String(q.exchange ?? "");
        return {
          symbol: String(q.symbol),
          name: String(q.longname ?? q.shortname ?? q.symbol),
          exchange,
          market: marketFromExchange(exchange),
          quoteType: String(q.quoteType ?? "").toUpperCase(),
        };
      });
  } catch (error) {
    logFailure("searchTickers", trimmed, error);
    return [];
  }
}

/**
 * Quote, built from the v8 chart `meta` block.
 *
 * ### Fields the chart meta genuinely cannot provide
 *
 * These are returned as `null`, not guessed:
 *
 * - `marketCap` — not in meta. Derivable as `price × shares outstanding`, but
 *   the only available share count is the *annual average* from the
 *   timeseries, which is both stale and the wrong measure, so it is not used
 *   here. The analysis layer computes it where a share count is in hand.
 * - `peRatio`, `eps` — not in meta. These need a trailing EPS, which lives in
 *   the timeseries, so they are derived in the analysis layer instead.
 * - `dividendYield` — not in meta at all.
 * - `beta` — not in meta; it is a computed statistic, and the risk layer
 *   (Phase 2e) derives it from price history against an index.
 *
 * `avgVolume` IS derived here: the chart response already carries the volume
 * series, so a 3-month average costs nothing extra and is a real figure rather
 * than a `null`.
 */
export async function getQuote(symbol: string): Promise<QuoteData | null> {
  try {
    const url = `${QUERY1}/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const { data } = await client.get(url, {
      params: { range: "3mo", interval: "1d" },
    });

    const result: Json = data?.chart?.result?.[0];
    const meta: Json = result?.meta;
    if (!meta) return null;

    const price = raw(meta.regularMarketPrice);
    // A symbol that resolves but carries no price is not a usable quote.
    if (price === null) return null;

    const previousClose =
      raw(meta.chartPreviousClose) ?? raw(meta.previousClose);
    const change = previousClose === null ? null : price - previousClose;
    const changePercent =
      change === null ? null : ratio(change, previousClose);

    // 3-month average volume from the series the chart already returned.
    const volumes: number[] = (result?.indicators?.quote?.[0]?.volume ?? [])
      .map((v: YahooNumber) => raw(v))
      .filter((v: number | null): v is number => v !== null && v > 0);
    const avgVolume =
      volumes.length > 0
        ? volumes.reduce((a, b) => a + b, 0) / volumes.length
        : null;

    const exchange = String(meta.exchangeName ?? meta.fullExchangeName ?? "");

    return {
      symbol: String(meta.symbol ?? symbol).toUpperCase(),
      name: String(meta.longName ?? meta.shortName ?? meta.symbol ?? symbol),
      price,
      change,
      // Fraction, matching the rest of the codebase; the UI multiplies by 100.
      changePercent,
      volume: raw(meta.regularMarketVolume),
      avgVolume,
      marketCap: null, // see doc comment
      peRatio: null, // see doc comment
      eps: null, // see doc comment
      high52Week: raw(meta.fiftyTwoWeekHigh),
      low52Week: raw(meta.fiftyTwoWeekLow),
      dividendYield: null, // see doc comment
      beta: null, // see doc comment
      exchange,
      currency: String(meta.currency ?? "USD").toUpperCase(),
    };
  } catch (error) {
    logFailure("getQuote", symbol, error);
    return null;
  }
}

/**
 * OHLCV history, oldest bar first.
 *
 * Unchanged: `v8/finance/chart` was the one function that always worked.
 */
export async function getPriceHistory(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<PriceData[]> {
  try {
    const url = `${QUERY1}/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const { data } = await client.get(url, {
      params: { range, interval, includeAdjustedClose: true },
    });

    const result: Json = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const quote: Json = result.indicators?.quote?.[0] ?? {};
    const adjClose: (number | null)[] =
      result.indicators?.adjclose?.[0]?.adjclose ?? [];

    const bars: PriceData[] = timestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open: raw(quote.open?.[i]),
      high: raw(quote.high?.[i]),
      low: raw(quote.low?.[i]),
      close: raw(quote.close?.[i]),
      volume: raw(quote.volume?.[i]),
      adjClose: raw(adjClose[i]) ?? raw(quote.close?.[i]),
    }));

    return bars.filter((bar) => bar.close !== null);
  } catch (error) {
    logFailure("getPriceHistory", symbol, error);
    return [];
  }
}

/**
 * Annual financial statements, most recent period first.
 *
 * Rebuilt on fundamentals-timeseries. Periods are keyed by Yahoo's own
 * `asOfDate`, so the three statements align by construction — the index-merge
 * hazard of the old quoteSummary implementation is gone entirely.
 *
 * EBITDA is read directly from `annualEBITDA` (confirmed to exist); the old
 * `operatingIncome + depreciation` reconstruction has been removed.
 */
export async function getFinancials(
  symbol: string,
): Promise<FinancialStatement[]> {
  try {
    const { series } = await fetchTimeseries(symbol, STATEMENT_TYPES);
    return buildStatements(series);
  } catch (error) {
    logFailure("getFinancials", symbol, error);
    return [];
  }
}

/**
 * Build `FinancialStatement[]` from a parsed series map. Pure and exported for
 * testing against real payloads.
 */
export function buildStatements(
  series: Map<string, TypeSeries>,
): FinancialStatement[] {
  const periods = periodsDescending(series);
  if (periods.length === 0) return [];

  return periods.map((date) => {
      const operatingCashFlow = at(series, TS.operatingCashFlow, date);
      const capitalExpenditure = at(series, TS.capex, date);

      // Prefer Yahoo's own FCF; fall back to OCF + capex (capex is negative).
      const reportedFcf = at(series, TS.freeCashFlow, date);
      const freeCashFlow =
        reportedFcf !== null
          ? reportedFcf
          : operatingCashFlow === null && capitalExpenditure === null
            ? null
            : add(operatingCashFlow, capitalExpenditure);

      return {
        date,
        revenue: at(series, TS.revenue, date),
        grossProfit: at(series, TS.grossProfit, date),
        operatingIncome: at(series, TS.operatingIncome, date),
        netIncome: at(series, TS.netIncome, date),
        ebitda: at(series, TS.ebitda, date),
        totalAssets: at(series, TS.totalAssets, date),
        totalLiabilities: at(series, TS.totalLiabilities, date),
        totalEquity: at(series, TS.totalEquity, date),
        totalDebt: at(series, TS.totalDebt, date),
        cashAndEquivalents: at(series, TS.cash, date),
      freeCashFlow,
      operatingCashFlow,
      capitalExpenditure,
    };
  });
}

/** All-null metrics — the honest answer when nothing could be fetched. */
function emptyFundamentals(): FundamentalMetrics {
  return {
    peRatio: null,
    forwardPE: null,
    pegRatio: null,
    priceToBook: null,
    priceToSales: null,
    evToEbitda: null,
    grossMargin: null,
    operatingMargin: null,
    netMargin: null,
    roic: null,
    roe: null,
    roa: null,
    fcfYield: null,
    fcfPerShare: null,
    debtToEquity: null,
    currentRatio: null,
    quickRatio: null,
    interestCoverage: null,
    altmanZScore: null,
  };
}

/**
 * Fundamental ratios computed from the latest reported annual period.
 *
 * Because the ratios are now **our own arithmetic** rather than Yahoo's
 * pre-computed figures, their units are unambiguous:
 *
 * - Margins, `roe`, `roa` are decimal fractions (0.42 = 42%).
 * - `debtToEquity` is a true ratio (1.54 = 1.54x), computed as
 *   `annualTotalDebt / annualStockholdersEquity`. The old percent-vs-ratio
 *   ambiguity from `financialData.debtToEquity` is gone.
 *
 * `roic`, `fcfPerShare` and `interestCoverage` are now populated here, from
 * the Phase 2c module in `@/analysis/fundamentals`.
 *
 * Still `null` here, deliberately:
 *
 * - `peRatio`, `forwardPE`, `pegRatio`, `priceToBook`, `priceToSales`,
 *   `evToEbitda` — all need a live price or market cap, which this function
 *   does not fetch. (`forwardPE` and `pegRatio` additionally need analyst
 *   estimates, which no unauthenticated Yahoo endpoint provides — see
 *   PROGRESS.md.)
 * - `fcfYield`, `altmanZScore` — these need a market capitalisation, which no
 *   endpoint currently supplies (see `getQuote`). `getDerivedFundamentals`
 *   returns them as `requires-quote` with that reason attached, rather than as
 *   a bare `null` here.
 */
export async function getFundamentalMetrics(
  symbol: string,
): Promise<FundamentalMetrics> {
  try {
    const { series } = await fetchTimeseries(symbol, RATIO_TYPES);
    return buildFundamentals(series, marketFromSymbol(symbol));
  } catch (error) {
    logFailure("getFundamentalMetrics", symbol, error);
    return emptyFundamentals();
  }
}

/**
 * The Phase 2c derived metrics with their availability reasons intact.
 *
 * `getFundamentalMetrics` flattens these into nullable numbers for the wire
 * shape, which loses the distinction between "not reported", "not reported for
 * this market" and "mathematically unbounded". Callers that can render an
 * explanation should prefer this.
 *
 * `marketCap` is threaded through because `fcfYield` and `altmanZScore`
 * genuinely require it; pass `null` and they come back as `requires-quote`
 * rather than silently missing.
 */
export async function getDerivedFundamentals(
  symbol: string,
  marketCap: number | null = null,
): Promise<DerivedFundamentals | null> {
  try {
    const { series } = await fetchTimeseries(symbol, RATIO_TYPES);
    const periods = periodsDescending(series);
    if (periods.length === 0) return null;
    return computeDerivedFundamentals(
      fundamentalInputs(series, periods),
      { market: marketFromSymbol(symbol), marketCap },
    );
  } catch (error) {
    logFailure("getDerivedFundamentals", symbol, error);
    return null;
  }
}

/**
 * Collect the Phase 2c inputs from a parsed series map, taking each line from
 * the most recent period that reports it.
 *
 * Exported for testing. Note the free-cash-flow fallback: Yahoo's own
 * `annualFreeCashFlow` is preferred, but operating cash flow plus capex
 * (reported negative) is the same figure and is used when it is absent.
 */
export function fundamentalInputs(
  series: Map<string, TypeSeries>,
  periods: string[] = periodsDescending(series),
): FundamentalInputs {
  const pick = (type: string) => latest(series, type, periods);

  const operatingCashFlow = pick(TS.operatingCashFlow);
  const capex = pick(TS.capex);
  const reportedFcf = pick(TS.freeCashFlow);
  const freeCashFlow =
    reportedFcf !== null
      ? reportedFcf
      : operatingCashFlow === null && capex === null
        ? null
        : add(operatingCashFlow, capex);

  return {
    ebit: pick(TS.ebit),
    pretaxIncome: pick(TS.pretaxIncome),
    taxProvision: pick(TS.taxProvision),
    interestExpense: pick(TS.interestExpense),
    revenue: pick(TS.revenue),
    totalAssets: pick(TS.totalAssets),
    totalLiabilities: pick(TS.totalLiabilities),
    totalEquity: pick(TS.totalEquity),
    totalDebt: pick(TS.totalDebt),
    retainedEarnings: pick(TS.retainedEarnings),
    workingCapital: pick(TS.workingCapital),
    currentAssets: pick(TS.currentAssets),
    currentLiabilities: pick(TS.currentLiabilities),
    freeCashFlow,
    shares: pick(TS.shares),
  };
}

/**
 * Build `FundamentalMetrics` from a parsed series map. Pure and exported for
 * testing against real payloads.
 */
export function buildFundamentals(
  series: Map<string, TypeSeries>,
  market: Market = "US",
): FundamentalMetrics {
  const periods = periodsDescending(series);
  if (periods.length === 0) return emptyFundamentals();

  const revenue = latest(series, TS.revenue, periods);
  const netIncome = latest(series, TS.netIncome, periods);
  const equity = latest(series, TS.totalEquity, periods);
  const currentAssets = latest(series, TS.currentAssets, periods);
  const currentLiabilities = latest(series, TS.currentLiabilities, periods);
  const inventory = latest(series, TS.inventory, periods);

  // Phase 2c. No market cap is available here, so `fcfYield` and
  // `altmanZScore` come back as `requires-quote` and collapse to `null`.
  const derived = collapseDerived(
    computeDerivedFundamentals(fundamentalInputs(series, periods), {
      market,
      marketCap: null,
    }),
  );

  const quickAssets =
    currentAssets === null
      ? null
      : inventory === null
        ? currentAssets
        : currentAssets - inventory;

  return {
    ...emptyFundamentals(),
    // Profitability
    grossMargin: ratio(latest(series, TS.grossProfit, periods), revenue),
    operatingMargin: ratio(
      latest(series, TS.operatingIncome, periods),
      revenue,
    ),
    netMargin: ratio(netIncome, revenue),
    roe: ratio(netIncome, equity),
    roa: ratio(netIncome, latest(series, TS.totalAssets, periods)),
    // Leverage and liquidity
    debtToEquity: ratio(latest(series, TS.totalDebt, periods), equity),
    currentRatio: ratio(currentAssets, currentLiabilities),
    quickRatio: ratio(quickAssets, currentLiabilities),
    // Phase 2c: roic, fcfYield, fcfPerShare, interestCoverage, altmanZScore.
    // Spread last so these win over the all-null defaults.
    ...derived,
  };
}

/* ------------------------------------------------------------------ */
/* Company bundle: statements + ratios + valuation in one pass         */
/* ------------------------------------------------------------------ */

/**
 * Valuation series. Confirmed live on 2026-11-17 for AAPL and RELIANCE.NS.
 * These are dated daily/quarterly rather than by fiscal period, and can go
 * stale for thinly covered listings (RELIANCE.NS's forward P/E was last
 * updated in 2021), so each is only used when recent — see `fresh`.
 */
export const VALUATION_TS = {
  marketCap: "trailingMarketCap",
  pe: "trailingPeRatio",
  pb: "trailingPbRatio",
  ps: "trailingPsRatio",
  evEbitda: "trailingEnterprisesValueEBITDARatio",
  forwardPe: "trailingForwardPeRatio",
  peg: "trailingPegRatio",
} as const;

const EPS_TYPE = "annualDilutedEPS";

/** A valuation reading older than this is treated as missing. */
const VALUATION_MAX_AGE_DAYS = 120;

export interface YahooCompany {
  financials: FinancialStatement[];
  fundamentals: FundamentalMetrics;
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  /** Currency the statements are reported in. */
  currency: string | null;
}

/** Most recent value of a dated series, if it is recent enough. Exported for tests. */
export function fresh(
  byDate: Map<string, number> | undefined,
  now: Date,
  maxAgeDays = VALUATION_MAX_AGE_DAYS,
): number | null {
  if (!byDate || byDate.size === 0) return null;
  const date = Array.from(byDate.keys()).sort().pop() as string;
  const ageDays = (now.getTime() - Date.parse(date)) / 86_400_000;
  return ageDays <= maxAgeDays ? (byDate.get(date) as number) : null;
}

/** Currency code per series type, read from a raw timeseries body. */
function currenciesByType(data: Json, into: Map<string, string>): void {
  for (const entry of (data?.timeseries?.result ?? []) as Json[]) {
    const name: string | undefined = entry?.meta?.type?.[0];
    const rows: Json[] = name && Array.isArray(entry[name]) ? entry[name] : [];
    const code = rows.find((row) => row?.currencyCode)?.currencyCode;
    if (name && code) into.set(name, String(code));
  }
}

/** Build the bundle from parsed series. Pure; exported for tests. */
export function buildCompany(
  series: Map<string, TypeSeries>,
  currencies: Map<string, string>,
  market: Market,
  now: Date,
): YahooCompany {
  const statementCurrency = currencies.get(TS.revenue) ?? null;
  const capCurrency = currencies.get(VALUATION_TS.marketCap) ?? null;

  // Only the fiscal-period series define statement periods; the valuation
  // series are dated daily and would otherwise appear as bogus "periods".
  const annual = new Map<string, TypeSeries>();
  for (const [name, values] of series) {
    if (name.startsWith("annual")) annual.set(name, values);
  }
  const periods = periodsDescending(annual);
  const base = buildFundamentals(annual, market);

  const marketCap = fresh(series.get(VALUATION_TS.marketCap), now);
  // An ADR can report in one currency and trade in another (TSM: TWD
  // statements, USD price). Mixing them would scale fcfYield and Altman's X4
  // by the exchange rate, so the price-dependent metrics are dropped instead.
  const comparable =
    statementCurrency !== null && capCurrency !== null && statementCurrency === capCurrency;

  const inputs = fundamentalInputs(annual, periods);
  // Interest expense is often missing for the newest years (AAPL: last
  // reported 2023). Pairing a stale figure with current EBIT would invent a
  // coverage ratio, so it is only used when it belongs to the latest period.
  const latestPeriod = periods[0];
  inputs.interestExpense = latestPeriod
    ? at(annual, TS.interestExpense, latestPeriod)
    : null;

  const derived = collapseDerived(
    computeDerivedFundamentals(inputs, {
      market,
      marketCap: comparable ? marketCap : null,
      marketsWithoutProvider: [],
    }),
  );

  return {
    financials: periods.length === 0 ? [] : buildStatements(annual).slice(0, 5),
    fundamentals: {
      ...base,
      ...derived,
      peRatio: fresh(series.get(VALUATION_TS.pe), now),
      forwardPE: fresh(series.get(VALUATION_TS.forwardPe), now),
      pegRatio: fresh(series.get(VALUATION_TS.peg), now),
      priceToBook: fresh(series.get(VALUATION_TS.pb), now),
      priceToSales: fresh(series.get(VALUATION_TS.ps), now),
      evToEbitda: fresh(series.get(VALUATION_TS.evEbitda), now),
    },
    marketCap,
    peRatio: fresh(series.get(VALUATION_TS.pe), now),
    eps: latestPeriod ? at(annual, EPS_TYPE, latestPeriod) : null,
    currency: statementCurrency,
  };
}

const COMPANY_TTL_MS = 30 * 60 * 1000;
const companyCache = new Map<string, { at: number; value: Promise<YahooCompany | null> }>();

/**
 * Statements, ratios and valuation for any listing Yahoo covers — US, NSE
 * and BSE were all confirmed. Two upstream calls, cached for 30 minutes.
 * Returns `null` when Yahoo has no fundamentals (indices, futures, crypto).
 */
export function getYahooCompany(symbol: string): Promise<YahooCompany | null> {
  const hit = companyCache.get(symbol);
  if (hit && Date.now() - hit.at < COMPANY_TTL_MS) return hit.value;

  const value = (async (): Promise<YahooCompany | null> => {
    try {
      const types = Array.from(
        new Set([...STATEMENT_TYPES, ...RATIO_TYPES, ...Object.values(VALUATION_TS), EPS_TYPE]),
      );
      const series = new Map<string, TypeSeries>();
      const currencies = new Map<string, string>();
      const period2 = Math.floor(Date.now() / 1000);
      const period1 = period2 - 8 * 365 * 24 * 60 * 60;

      for (let i = 0; i < types.length; i += BATCH_SIZE) {
        const { data } = await client.get(
          `${QUERY1}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`,
          { params: { symbol, type: types.slice(i, i + BATCH_SIZE).join(","), period1, period2, merge: false } },
        );
        parseTimeseriesPayload(data, series);
        currenciesByType(data, currencies);
      }

      if (!series.has(TS.revenue) && !series.has(TS.netIncome)) return null;
      return buildCompany(series, currencies, marketFromSymbol(symbol), new Date());
    } catch (error) {
      logFailure("getYahooCompany", symbol, error);
      companyCache.delete(symbol);
      return null;
    }
  })();

  companyCache.set(symbol, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* Provider binding                                                    */
/* ------------------------------------------------------------------ */

/**
 * Yahoo as a `DataProvider`.
 *
 * The named functions remain exported for direct use and testing; this object
 * is what the rest of the app consumes, via `getProvider()`.
 */
export const yahooProvider: DataProvider = {
  id: "yahoo",
  label: "Yahoo Finance",
  searchTickers,
  getQuote,
  getPriceHistory,
  getFinancials,
  getFundamentalMetrics,
};
