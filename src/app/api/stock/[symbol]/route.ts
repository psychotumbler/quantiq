/**
 * GET /api/stock/:symbol
 *
 * Assembles the full data bundle for one security. The four upstream calls are
 * independent, so they run concurrently; each service function already absorbs
 * its own failures, which means a partial bundle (e.g. financials unavailable
 * for an ETF) still returns 200 with empty sections rather than failing the
 * whole request.
 */

import type {
  AnalystConsensus,
  APIResponse,
  CompositeScore,
  DCFResult,
  InsiderTransaction,
  SentimentData,
  RiskMetrics,
  FinancialStatement,
  FundamentalMetrics,
  PriceData,
  QuoteData,
  TechnicalIndicators,
  TechnicalSignal,
} from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import type { ProviderId } from "@/services";
import { computeTechnicalIndicators } from "@/analysis/technicals";
import { interpretTechnicals } from "@/analysis/signals";
import { computeRiskMetrics, DEFAULT_RISK_FREE_RATE } from "@/analysis/risk";
import {
  computeDcf,
  defaultDcfAssumptions,
  type DcfAssumptions,
} from "@/analysis/dcf";
import { getRiskFreeRate } from "@/services/fred";

/**
 * Assumed risk-free rate for INR-denominated analysis. A stated assumption:
 * India's 10-year government bond has yielded roughly 6.5–7.5% in recent
 * years, and no free source for the live figure was found.
 */
const INDIA_RISK_FREE_RATE = 0.068;
import { getNews, sampleNews } from "@/services/news";
import { getMarketRegime } from "@/services/market";
import { getMacro } from "@/services/fred";
import {
  getCompanyFilings,
  getShareholding,
  type Filing,
  type HoldingQuarter,
} from "@/services/nse";
import { computeComposite } from "@/analysis/composite";

export interface StockRouteData {
  symbol: string;
  quote: QuoteData | null;
  priceHistory: PriceData[];
  financials: FinancialStatement[];
  fundamentals: FundamentalMetrics | null;
  /** Derived locally from `priceHistory`, not fetched. */
  technicals: TechnicalIndicators | null;
  /**
   * Phase 2b interpretation of `technicals`. Only indicators that could
   * actually be computed appear, so a short history yields a short list rather
   * than a full set of fabricated neutrals.
   */
  technicalSignals: TechnicalSignal[];
  /** Layer 6, derived locally from `priceHistory`. `null` without bars. */
  risk: RiskMetrics | null;
  /** Sell-side recommendation counts, when the provider has them. */
  analysts: AnalystConsensus | null;
  /** Recent open-market insider trades, when the provider has them. */
  insiderTransactions: InsiderTransaction[];
  /** Weighted score across the layers that had data. Not investment advice. */
  composite: CompositeScore | null;
  /** Recent headlines with word-list tone scores. */
  news: SentimentData | null;
  /** Starting DCF assumptions and the value they imply; `null` without positive FCF. */
  dcf: { assumptions: DcfAssumptions; result: DCFResult } | null;
  /** Annual risk-free rate used for Sharpe/Sortino and the DCF. */
  riskFreeRate: { value: number; source: string };
  /** Promoter and public holding by quarter, newest first. NSE listings only. */
  shareholding: HoldingQuarter[];
  /** The company's latest exchange filings. NSE listings only. */
  filings: Filing[];
  /** Currency the statements are reported in, when known. */
  statementCurrency: string | null;
  /** Plain-language caveats about what could not be computed, and why. */
  notes: string[];
  /**
   * Which source produced this payload.
   *
   * Present so sample data can never be mistaken for live market data in a
   * screenshot or a bug report — `sampleData` is true when the figures are
   * fabricated. The default provider currently *is* sample data (see
   * `DEFAULT_PROVIDER`), which is why this is on the response rather than
   * left to the client to guess.
   */
  provider: {
    id: ProviderId;
    label: string;
    sampleData: boolean;
  };
}

/**
 * No `export const dynamic` here: this project runs with
 * `cacheComponents: true`, which rejects that route segment config. It isn't
 * needed anyway — under Cache Components a GET handler that performs network
 * requests (as this one does) is treated as runtime-rendered automatically,
 * so quotes are never served stale.
 */

function json<T>(body: APIResponse<T>, status: number): Response {
  return Response.json(body, { status });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> },
): Promise<Response> {
  const timestamp = new Date().toISOString();

  try {
    // In Next.js 16 route params are async and must be awaited.
    const { symbol: rawSymbol } = await params;
    const symbol = decodeURIComponent(rawSymbol ?? "").trim().toUpperCase();

    if (!symbol) {
      return json(
        { success: false, error: "A ticker symbol is required.", timestamp },
        400,
      );
    }

    const provider = getProvider();
    const sample = isSampleData(provider.id);

    const [
      rawQuote,
      priceHistory,
      financials,
      rawFundamentals,
      analysts,
      insiderTransactions,
      statementCurrency,
    ] = await Promise.all([
      provider.getQuote(symbol),
      provider.getPriceHistory(symbol, "1y", "1d"),
      provider.getFinancials(symbol),
      provider.getFundamentalMetrics(symbol),
      provider.getAnalystConsensus?.(symbol) ?? Promise.resolve(null),
      provider.getInsiderTransactions?.(symbol) ?? Promise.resolve([]),
      provider.getStatementCurrency?.(symbol) ?? Promise.resolve(null),
    ]);

    // Second wave: needs the company name, and must not delay a 404.
    const found = rawQuote !== null || priceHistory.length > 0;
    const indianListing = /\.(NS|BO)$/i.test(symbol);
    const [liveRate, news, shareholding, filings, regime, usMacro] =
      found && !sample
        ? await Promise.all([
            getRiskFreeRate(),
            getNews(symbol, rawQuote?.name ?? ""),
            getShareholding(symbol),
            getCompanyFilings(symbol),
            getMarketRegime(indianListing ? "IN" : "US"),
            indianListing ? Promise.resolve([]) : getMacro(),
          ])
        : [null, found ? sampleNews(symbol) : null, [], [], null, []];

    const macro = regime
      ? {
          vix: regime.vix,
          indexTrend: regime.indexTrend,
          indexName: regime.indexName,
          curveSpread: usMacro.find((series) => series.id === "T10Y2Y")?.value ?? null,
        }
      : null;

    const indian = rawQuote?.currency === "INR";
    const riskFreeRate = indian
      ? // No free, current source for the Indian G-sec yield was found.
        { value: INDIA_RISK_FREE_RATE, source: "assumed India 10-year G-sec yield" }
      : liveRate !== null
        ? { value: liveRate, source: "US 3-month Treasury (FRED)" }
        : { value: DEFAULT_RISK_FREE_RATE, source: "assumed default" };

    const notes: string[] = [];

    // Banks and insurers file no gross profit or operating income: lending is
    // their operating activity, so free cash flow, EV/EBITDA and Altman's Z
    // do not describe them.
    const latest = financials[0];
    const financialSector =
      latest !== undefined &&
      latest.revenue !== null &&
      latest.grossProfit === null &&
      latest.operatingIncome === null;

    // Statements in one currency and a price in another (Infosys: USD
    // statements, INR price) make any per-share valuation meaningless.
    const currencyMismatch =
      statementCurrency !== null &&
      rawQuote !== null &&
      statementCurrency !== rawQuote.currency;

    let fundamentals = rawFundamentals;
    if (financialSector) {
      fundamentals = { ...fundamentals, fcfYield: null, fcfPerShare: null };
      notes.push(
        "This looks like a bank or insurer: free-cash-flow metrics, the DCF and Altman Z are left out because they are not meaningful for lenders.",
      );
    }
    if (currencyMismatch) {
      notes.push(
        `Statements are reported in ${statementCurrency} but the shares trade in ${rawQuote.currency}, so FCF yield, Altman Z and the DCF are left out rather than mixing currencies.`,
      );
    }

    // Some quote sources carry no volume. Fill it from the bars we already
    // have: last session's volume and the three-month (63-session) average.
    let quote = rawQuote;
    if (quote && (quote.volume === null || quote.avgVolume === null)) {
      const volumes = priceHistory
        .map((bar) => bar.volume)
        .filter((v): v is number => v !== null && v > 0);
      const recent = volumes.slice(-63);
      quote = {
        ...quote,
        volume: quote.volume ?? volumes[volumes.length - 1] ?? null,
        avgVolume:
          quote.avgVolume ??
          (recent.length > 0
            ? recent.reduce((a, b) => a + b, 0) / recent.length
            : null),
      };
    }

    // A symbol with neither a quote nor any price history does not exist as far
    // as the provider is concerned — or the provider refused every call.
    if (!quote && priceHistory.length === 0) {
      return json(
        {
          success: false,
          error: `No data found for "${symbol}". Check the ticker — Indian listings need an .NS or .BO suffix.`,
          timestamp,
        },
        404,
      );
    }

    // Indicators are pure maths over the bars we already have, so they add
    // no latency and are computed here rather than in the client.
    const technicals =
      priceHistory.length > 0
        ? computeTechnicalIndicators(priceHistory)
        : null;

    // Interpretation reuses those indicators rather than recomputing them.
    const technicalSignals =
      technicals === null
        ? []
        : interpretTechnicals(priceHistory, technicals);

    const risk =
      priceHistory.length > 0
        ? computeRiskMetrics(priceHistory, {
            beta: quote?.beta ?? null,
            riskFreeRate: riskFreeRate.value,
          })
        : null;

    const composite = computeComposite({
      fundamentals,
      technicalSignals,
      risk,
      analysts,
      news,
      macro,
      ownership: shareholding,
      now: timestamp,
    });

    const assumptions = financialSector || currencyMismatch ? null : defaultDcfAssumptions({
      financials,
      marketCap: quote?.marketCap ?? null,
      price: quote?.price ?? null,
      beta: quote?.beta ?? null,
      riskFreeRate: riskFreeRate.value,
    });
    const dcfResult = assumptions
      ? computeDcf(assumptions, quote?.price ?? null)
      : null;

    return json<StockRouteData>(
      {
        success: true,
        data: {
          symbol,
          quote,
          priceHistory,
          financials,
          fundamentals,
          technicals,
          technicalSignals,
          risk,
          analysts,
          insiderTransactions,
          composite,
          news,
          dcf: assumptions && dcfResult ? { assumptions, result: dcfResult } : null,
          riskFreeRate,
          shareholding,
          filings,
          statementCurrency,
          notes,
          provider: {
            id: provider.id,
            label: provider.label,
            sampleData: sample,
          },
        },
        timestamp,
      },
      200,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/stock] unhandled:", message);
    return json({ success: false, error: message, timestamp }, 500);
  }
}
