/**
 * Finnhub data source — US fundamentals, quotes and filings on the free plan.
 *
 * Built only from endpoints `scripts/probe-finnhub.mjs` confirmed usable with
 * a free key (2026-11-15): `/search`, `/quote`, `/stock/profile2`,
 * `/stock/metric`, `/stock/financials-reported`, `/stock/recommendation`,
 * `/stock/insider-transactions`.
 *
 * NOT available on the free plan, and therefore not attempted here:
 *   - `/stock/candle` (403) — no OHLCV. `getPriceHistory` returns `[]`; the
 *     `live` composite provider sources bars elsewhere.
 *   - Non-US listings (403 / empty-200).
 *
 * The key is read from `process.env.FINNHUB_API_KEY`, sent as a header (never
 * a query parameter, so it cannot leak through a logged URL) and never logged.
 *
 * Every unit conversion goes through `finnhubUnits.ts`.
 */

import axios, { type AxiosInstance } from "axios";
import type { DataProvider } from "@/services/provider";
import type {
  AnalystConsensus,
  FinancialStatement,
  FundamentalMetrics,
  InsiderTransaction,
  PriceData,
  QuoteData,
  SearchResult,
} from "@/types/stock";
import {
  marketCapFromProfile,
  readMetric,
  sharesFromProfile,
} from "@/services/finnhubUnits";
import {
  collapseDerived,
  computeDerivedFundamentals,
  emptyInputs,
  type FundamentalInputs,
} from "@/analysis/fundamentals";

const BASE = "https://finnhub.io/api/v1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let cachedClient: AxiosInstance | null = null;

/** True when a key is configured. The registry uses this to pick a default. */
export function finnhubConfigured(): boolean {
  return Boolean(process.env.FINNHUB_API_KEY?.trim());
}

function client(): AxiosInstance | null {
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  if (!cachedClient) {
    cachedClient = axios.create({
      baseURL: BASE,
      timeout: 15_000,
      headers: { "X-Finnhub-Token": key },
    });
  }
  return cachedClient;
}

/* ------------------------------------------------------------------ */
/* Tiny per-process cache                                              */
/* ------------------------------------------------------------------ */

/**
 * `getQuote` and `getFundamentalMetrics` both need profile + metric, and the
 * route calls them concurrently. Caching the in-flight promise makes that one
 * upstream call each instead of two, which matters on a 60/min plan.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Json> }>();

async function get(path: string, params: Record<string, string>): Promise<Json> {
  const http = client();
  if (!http) return null;

  const key = `${path}?${new URLSearchParams(params).toString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = http
    .get(path, { params })
    .then((response) => {
      // Finnhub sometimes answers a gated endpoint with 200 + an HTML page.
      if (typeof response.data === "string") return null;
      return response.data as Json;
    })
    .catch((error: unknown) => {
      const status = axios.isAxiosError(error) ? error.response?.status : null;
      console.error(
        `[finnhub] ${path} failed${status ? ` (HTTP ${status})` : ""}`,
      );
      cache.delete(key);
      return null;
    });

  cache.set(key, { at: Date.now(), value });
  return value;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const SEARCHABLE_TYPES = ["Common Stock", "ETP", "ADR", "REIT"];

export async function searchTickers(query: string): Promise<SearchResult[]> {
  const data = await get("/search", { q: query });
  const rows: Json[] = Array.isArray(data?.result) ? data.result : [];

  return rows
    .filter(
      (row) =>
        typeof row?.symbol === "string" &&
        // The index is global but the free plan only serves US data; a dotted
        // symbol (RELIANCE.NS, SAP.DE) would 403 on every data endpoint.
        !row.symbol.includes(".") &&
        SEARCHABLE_TYPES.includes(String(row.type ?? "")),
    )
    .slice(0, 10)
    .map((row) => ({
      symbol: String(row.symbol).toUpperCase(),
      name: String(row.description ?? row.symbol),
      exchange: "US",
      market: "US" as const,
      quoteType: String(row.type ?? "EQUITY"),
    }));
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export async function getQuote(symbol: string): Promise<QuoteData | null> {
  const [quote, profile, metricBody] = await Promise.all([
    get("/quote", { symbol }),
    get("/stock/profile2", { symbol }),
    get("/stock/metric", { symbol, metric: "all" }),
  ]);

  const price = num(quote?.c);
  // An unsupported symbol returns 200 with every field 0 and t=0.
  if (price === null || price === 0 || !num(quote?.t)) return null;

  const metric: Record<string, unknown> | null = metricBody?.metric ?? null;
  const pe = readMetric(metric, "peBasicExclExtraTTM");
  const changePct = num(quote?.dp);

  return {
    symbol: symbol.toUpperCase(),
    name: String(profile?.name ?? symbol),
    price,
    change: num(quote?.d),
    // `dp` is a percent (0.3917 = 0.39%); QuoteData carries a fraction.
    changePercent: changePct === null ? null : changePct / 100,
    // Not on /quote. The route fills both from the bar history.
    volume: null,
    avgVolume: null,
    marketCap: marketCapFromProfile(profile?.marketCapitalization),
    peRatio: pe,
    // Implied by price and trailing P/E rather than read from an
    // unconfirmed metric key.
    eps: pe !== null && pe !== 0 ? price / pe : null,
    high52Week: readMetric(metric, "52WeekHigh"),
    low52Week: readMetric(metric, "52WeekLow"),
    dividendYield: readMetric(metric, "dividendYieldIndicatedAnnual"),
    beta: readMetric(metric, "beta"),
    exchange: String(profile?.exchange ?? "US"),
    currency: String(profile?.currency ?? "USD").toUpperCase(),
  };
}

/* ------------------------------------------------------------------ */
/* Statements (SEC financials-as-reported, XBRL concepts)              */
/* ------------------------------------------------------------------ */

/**
 * XBRL concept fallbacks, most specific first.
 *
 * Filers do not share one tag per line item — revenue alone has four common
 * spellings — so each line tries a list and takes the first that is present.
 * Only AAPL's tags were observed in the probe; the rest are the standard
 * us-gaap alternatives and are UNCONFIRMED against other filers. A line that
 * no alternative matches stays `null` rather than being guessed.
 */
export const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  costOfRevenue: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  taxProvision: ["IncomeTaxExpenseBenefit"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  interestExpense: [
    "InterestExpense",
    "InterestExpenseNonoperating",
    "InterestExpenseDebt",
  ],
  depreciation: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
  ],
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities"],
  liabilitiesAndEquity: ["LiabilitiesAndStockholdersEquity"],
  totalEquity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  retainedEarnings: ["RetainedEarningsAccumulatedDeficit"],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  currentDebt: ["LongTermDebtCurrent", "DebtCurrent"],
  commercialPaper: ["CommercialPaper", "ShortTermBorrowings"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ],
} as const;

type Line = keyof typeof CONCEPTS;

/** `us-gaap_GrossProfit` / `us-gaap:GrossProfit` / `GrossProfit` → `GrossProfit`. */
export function bareConcept(concept: unknown): string {
  const parts = String(concept ?? "").split(/[_:]/);
  return parts[parts.length - 1] ?? "";
}

/** Index one filing's three statements by bare concept name. */
export function indexReport(report: Json): Map<string, number> {
  const index = new Map<string, number>();
  for (const section of ["bs", "ic", "cf"]) {
    const rows: Json[] = Array.isArray(report?.[section]) ? report[section] : [];
    for (const row of rows) {
      const name = bareConcept(row?.concept);
      const value = num(row?.value);
      // First occurrence wins: the face-statement total precedes any
      // dimensional breakdown that reuses the tag.
      if (name && value !== null && !index.has(name)) index.set(name, value);
    }
  }
  return index;
}

function pick(index: Map<string, number>, line: Line): number | null {
  for (const concept of CONCEPTS[line]) {
    const value = index.get(concept);
    if (value !== undefined) return value;
  }
  return null;
}

function sum(...values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function minus(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

interface ParsedPeriod {
  statement: FinancialStatement;
  inputs: FundamentalInputs;
  hasBalanceSheet: boolean;
}

/** Turn one as-reported filing into our statement shape. Exported for tests. */
export function parsePeriod(filing: Json): ParsedPeriod | null {
  const index = indexReport(filing?.report);
  if (index.size === 0) return null;

  const revenue = pick(index, "revenue");
  const operatingIncome = pick(index, "operatingIncome");
  const depreciation = pick(index, "depreciation");
  const totalAssets = pick(index, "totalAssets");
  const totalEquity = pick(index, "totalEquity");
  const operatingCashFlow = pick(index, "operatingCashFlow");
  // Reported as a positive outflow.
  const capex = pick(index, "capex");

  const totalLiabilities =
    pick(index, "totalLiabilities") ??
    // Some filers report only the combined total.
    minus(pick(index, "liabilitiesAndEquity"), totalEquity);

  const totalDebt = sum(
    pick(index, "longTermDebt"),
    pick(index, "currentDebt"),
    pick(index, "commercialPaper"),
  );

  const currentAssets = pick(index, "currentAssets");
  const currentLiabilities = pick(index, "currentLiabilities");
  const freeCashFlow =
    operatingCashFlow === null ? null : operatingCashFlow - Math.abs(capex ?? 0);

  const date = String(filing?.endDate ?? "").slice(0, 10) || `${filing?.year ?? ""}-12-31`;

  return {
    hasBalanceSheet: totalAssets !== null,
    statement: {
      date,
      revenue,
      grossProfit:
        pick(index, "grossProfit") ?? minus(revenue, pick(index, "costOfRevenue")),
      operatingIncome,
      netIncome: pick(index, "netIncome"),
      // RECONSTRUCTED: operating income + D&A. As-reported filings carry no
      // EBITDA line, so this is the standard approximation, not a filed figure.
      ebitda:
        operatingIncome === null || depreciation === null
          ? null
          : operatingIncome + depreciation,
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalDebt,
      cashAndEquivalents: pick(index, "cash"),
      freeCashFlow,
      operatingCashFlow,
      capitalExpenditure: capex === null ? null : Math.abs(capex),
    },
    inputs: {
      ...emptyInputs(),
      ebit: operatingIncome,
      pretaxIncome: pick(index, "pretaxIncome"),
      taxProvision: pick(index, "taxProvision"),
      interestExpense: pick(index, "interestExpense"),
      revenue,
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalDebt,
      retainedEarnings: pick(index, "retainedEarnings"),
      workingCapital: minus(currentAssets, currentLiabilities),
      currentAssets,
      currentLiabilities,
      freeCashFlow,
    },
  };
}

async function parsedPeriods(symbol: string): Promise<ParsedPeriod[]> {
  const data = await get("/stock/financials-reported", { symbol, freq: "annual" });
  const filings: Json[] = Array.isArray(data?.data) ? data.data : [];
  return filings
    .map(parsePeriod)
    .filter((period): period is ParsedPeriod => period !== null)
    .sort((a, b) => b.statement.date.localeCompare(a.statement.date));
}

/** Annual statements, most recent first, capped at five periods. */
export async function getFinancials(symbol: string): Promise<FinancialStatement[]> {
  const periods = await parsedPeriods(symbol);
  // The newest filing can arrive with an empty balance sheet (observed for
  // AAPL: bs 0 rows, ic 24, cf 26). Keep it for income/cash-flow rows — its
  // balance-sheet fields are simply null.
  return periods.slice(0, 5).map((period) => period.statement);
}

/* ------------------------------------------------------------------ */
/* Fundamentals                                                        */
/* ------------------------------------------------------------------ */

export function emptyFundamentals(): FundamentalMetrics {
  return {
    peRatio: null, forwardPE: null, pegRatio: null, priceToBook: null,
    priceToSales: null, evToEbitda: null, grossMargin: null,
    operatingMargin: null, netMargin: null, roic: null, roe: null, roa: null,
    fcfYield: null, fcfPerShare: null, debtToEquity: null, currentRatio: null,
    quickRatio: null, interestCoverage: null, altmanZScore: null,
  };
}

export async function getFundamentalMetrics(
  symbol: string,
): Promise<FundamentalMetrics> {
  const [metricBody, profile, periods] = await Promise.all([
    get("/stock/metric", { symbol, metric: "all" }),
    get("/stock/profile2", { symbol }),
    parsedPeriods(symbol),
  ]);

  const metric: Record<string, unknown> | null = metricBody?.metric ?? null;
  if (!metric && periods.length === 0) return emptyFundamentals();

  const marketCap = marketCapFromProfile(profile?.marketCapitalization);
  const shares = sharesFromProfile(profile?.shareOutstanding);

  // Derived metrics mix income, cash-flow and balance-sheet lines, so they use
  // the most recent period that has all three rather than `periods[0]`.
  const basis = periods.find((period) => period.hasBalanceSheet) ?? null;

  const derived = basis
    ? collapseDerived(
        computeDerivedFundamentals(
          { ...basis.inputs, shares },
          { market: "US", marketCap, marketsWithoutProvider: [] },
        ),
      )
    : null;

  // EV/EBITDA from our own lines: (market cap + debt − cash) / EBITDA.
  const s = basis?.statement ?? null;
  const ev =
    marketCap === null || !s
      ? null
      : marketCap + (s.totalDebt ?? 0) - (s.cashAndEquivalents ?? 0);
  const ebitda = periods[0]?.statement.ebitda ?? s?.ebitda ?? null;

  return {
    ...emptyFundamentals(),
    peRatio: readMetric(metric, "peBasicExclExtraTTM"),
    priceToBook: readMetric(metric, "pbAnnual"),
    priceToSales: readMetric(metric, "psTTM"),
    evToEbitda: ev !== null && ebitda !== null && ebitda > 0 ? ev / ebitda : null,
    grossMargin: readMetric(metric, "grossMarginTTM"),
    operatingMargin: readMetric(metric, "operatingMarginTTM"),
    netMargin: readMetric(metric, "netProfitMarginTTM"),
    roe: readMetric(metric, "roeTTM"),
    roa: readMetric(metric, "roaTTM"),
    debtToEquity: readMetric(metric, "totalDebt/totalEquityAnnual"),
    currentRatio: readMetric(metric, "currentRatioAnnual"),
    quickRatio: readMetric(metric, "quickRatioAnnual"),
    roic: derived?.roic ?? null,
    fcfYield: derived?.fcfYield ?? null,
    fcfPerShare: derived?.fcfPerShare ?? null,
    // Prefer our own EBIT / interest; fall back to Finnhub's multiple.
    interestCoverage:
      derived?.interestCoverage ?? readMetric(metric, "netInterestCoverageTTM"),
    altmanZScore: derived?.altmanZScore ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Extras: analyst consensus and insider transactions                  */
/* ------------------------------------------------------------------ */

export async function getAnalystConsensus(
  symbol: string,
): Promise<AnalystConsensus | null> {
  const data = await get("/stock/recommendation", { symbol });
  const rows: Json[] = Array.isArray(data) ? data : [];
  if (rows.length === 0) return null;

  const latest = [...rows].sort((a, b) =>
    String(b?.period ?? "").localeCompare(String(a?.period ?? "")),
  )[0];

  const consensus = {
    period: String(latest?.period ?? ""),
    strongBuy: num(latest?.strongBuy) ?? 0,
    buy: num(latest?.buy) ?? 0,
    hold: num(latest?.hold) ?? 0,
    sell: num(latest?.sell) ?? 0,
    strongSell: num(latest?.strongSell) ?? 0,
  };
  const total =
    consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell;
  return total === 0 ? null : { ...consensus, total };
}

/** SEC Form 4 codes worth showing: open-market purchases and sales. */
const INSIDER_CODES: Record<string, string> = { P: "Buy", S: "Sell" };

export async function getInsiderTransactions(
  symbol: string,
): Promise<InsiderTransaction[]> {
  const data = await get("/stock/insider-transactions", { symbol });
  const rows: Json[] = Array.isArray(data?.data) ? data.data : [];

  return rows
    .filter(
      (row) => INSIDER_CODES[String(row?.transactionCode ?? "")] && !row?.isDerivative,
    )
    .sort((a, b) =>
      String(b?.transactionDate ?? "").localeCompare(String(a?.transactionDate ?? "")),
    )
    .slice(0, 15)
    .map((row) => {
      const shares = num(row?.change);
      const price = num(row?.transactionPrice);
      return {
        name: String(row?.name ?? ""),
        title: "",
        transactionType: INSIDER_CODES[String(row.transactionCode)],
        shares: shares === null ? null : Math.abs(shares),
        value:
          shares === null || price === null ? null : Math.abs(shares) * price,
        date: String(row?.transactionDate ?? ""),
      };
    });
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/** `/stock/candle` is premium (HTTP 403 on the free plan). */
async function getPriceHistory(): Promise<PriceData[]> {
  return [];
}

export const finnhubProvider: DataProvider = {
  id: "finnhub",
  label: "Finnhub",
  searchTickers,
  getQuote,
  getPriceHistory,
  getFinancials,
  getFundamentalMetrics,
  getAnalystConsensus,
  getInsiderTransactions,
};
