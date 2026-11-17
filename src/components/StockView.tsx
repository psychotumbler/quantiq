"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalystConsensus,
  APIResponse,
  CompositeScore,
  DCFResult,
  SentimentData,
  FinancialStatement,
  InsiderTransaction,
  RiskMetrics,
  TechnicalSignal,
  FundamentalMetrics,
  PriceData,
  QuoteData,
  SearchResult,
} from "@/types/stock";
import {
  changeColor,
  fiscalYear,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRatio,
  withSign,
} from "@/lib/format";
import {
  AnalystCard,
  CompositeCard,
  InsiderCard,
  PriceChart,
  RiskCard,
  SignalsCard,
} from "@/components/AnalysisPanels";
import {
  BacktestCard,
  DcfCard,
  FilingsCard,
  NewsCard,
  NotesCard,
  OwnershipCard,
} from "@/components/StockExtras";
import type { Filing, HoldingQuarter } from "@/services/nse";
import type { DcfAssumptions } from "@/analysis/dcf";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { DEFAULT_WATCHLIST } from "@/components/DashboardView";

interface StockBundle {
  symbol: string;
  quote: QuoteData | null;
  priceHistory: PriceData[];
  financials: FinancialStatement[];
  fundamentals: FundamentalMetrics | null;
  technicalSignals?: TechnicalSignal[];
  risk?: RiskMetrics | null;
  analysts?: AnalystConsensus | null;
  insiderTransactions?: InsiderTransaction[];
  composite?: CompositeScore | null;
  news?: SentimentData | null;
  dcf?: { assumptions: DcfAssumptions; result: DCFResult } | null;
  riskFreeRate?: { value: number; source: string };
  shareholding?: HoldingQuarter[];
  filings?: Filing[];
  notes?: string[];
  /** Which source produced these figures. See the route's `provider` block. */
  provider?: {
    id: string;
    label: string;
    sampleData: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/**
 * One security, end to end. The shell remounts this with a new `key` whenever
 * a symbol is picked elsewhere (watchlist, portfolio, market board), so
 * `initialSymbol` only needs to be read once.
 */
export function StockView({ initialSymbol = "" }: { initialSymbol?: string }) {
  const [query, setQuery] = useState(initialSymbol);
  const [watchlist, setWatchlist] = useLocalStorage<string[]>(
    "quantiq.watchlist",
    DEFAULT_WATCHLIST,
  );
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StockBundle | null>(null);

  /**
   * Whether the figures on screen are fabricated.
   *
   * Taken from the response rather than from an env var, so the client cannot
   * disagree with the server about what it is displaying.
   */

  const searchRef = useRef<HTMLDivElement>(null);
  /** Identifies the latest analyse request so stale responses are ignored. */
  const requestIdRef = useRef(0);

  /* --- autocomplete: debounced 300ms ------------------------------- */
  useEffect(() => {
    const term = query.trim();
    const controller = new AbortController();

    // Clearing an emptied box happens inside the timer too, not in the effect
    // body: a synchronous setState here would trigger a cascading render.
    const timer = setTimeout(async () => {
      if (!term) {
        setSuggestions([]);
        setShowDropdown(false);
        return;
      }

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        const body: APIResponse<SearchResult[]> = await res.json();
        if (body.success) {
          setSuggestions(body.data);
          setShowDropdown(body.data.length > 0);
        }
      } catch {
        // An aborted or failed autocomplete is not worth surfacing — the
        // user is mid-keystroke and the Analyze button still works.
      }
    }, term ? 300 : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  /* --- close the dropdown on an outside click ---------------------- */
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  /* --- fetch one stock -------------------------------------------- */
  const analyze = useCallback(async (rawSymbol: string) => {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol) return;

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setShowDropdown(false);

    try {
      const res = await fetch(`/api/stock/${encodeURIComponent(symbol)}`);
      const body: APIResponse<StockBundle> = await res.json();

      // A slower earlier request must not overwrite a newer result.
      if (requestId !== requestIdRef.current) return;

      if (body.success) {
        setData(body.data);
      } else {
        setData(null);
        setError(body.error);
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setData(null);
      setError(
        "Could not reach the analysis API. Check that the dev server is running.",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  /* --- analyse the symbol this view was opened with ---------------- */
  useEffect(() => {
    if (!initialSymbol) return;
    // Deferred so the fetch's first setState is not synchronous in the effect.
    const timer = setTimeout(() => void analyze(initialSymbol), 0);
    return () => clearTimeout(timer);
  }, [initialSymbol, analyze]);

  const onSelectSuggestion = (result: SearchResult) => {
    setQuery(result.symbol);
    setSuggestions([]);
    void analyze(result.symbol);
  };

  const currency = data?.quote?.currency ?? "USD";
  /** Newest first, last 10 sessions. The service returns oldest first. */
  const recentBars = data ? data.priceHistory.slice(-10).reverse() : [];

  return (
    <div>

      <div className="pt-2">
        {/* ---------------- search ---------------- */}
        <div ref={searchRef} className="relative mx-auto max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void analyze(query);
            }}
          >
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setShowDropdown(suggestions.length > 0)}
                placeholder="Search a ticker or company — AAPL, RELIANCE.NS…"
                aria-label="Search for a stock"
                autoComplete="off"
                className="w-full rounded-xl border border-gray-800 bg-gray-900 py-4 pl-5 pr-28 text-base text-gray-100 placeholder-gray-500 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/40"
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-gray-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? "Loading…" : "Analyze"}
              </button>
            </div>
          </form>

          {showDropdown && suggestions.length > 0 && (
            <ul className="absolute z-30 mt-2 max-h-80 w-full overflow-auto rounded-xl border border-gray-800 bg-gray-900 py-1 shadow-2xl shadow-black/50">
              {suggestions.map((result) => (
                <li key={`${result.symbol}-${result.exchange}`}>
                  <button
                    type="button"
                    onClick={() => onSelectSuggestion(result)}
                    className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition hover:bg-gray-800"
                  >
                    <span className="flex min-w-0 items-baseline gap-3">
                      <span className="font-mono text-sm font-semibold text-emerald-400">
                        {result.symbol}
                      </span>
                      <span className="truncate text-sm text-gray-300">
                        {result.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-gray-500">
                      {result.exchange}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------------- states ---------------- */}
        {error && (
          <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-red-900 bg-red-950/40 p-5">
            <p className="text-sm font-semibold text-red-300">
              Analysis failed
            </p>
            <p className="mt-1 text-sm text-red-200/80">{error}</p>
          </div>
        )}

        {loading && <LoadingSkeleton />}

        {!loading && !data && !error && <EmptyState onPick={analyze} />}

        {!loading && data && (
          <div className="mt-10 space-y-6">
            <QuoteHeader quote={data.quote} symbol={data.symbol} />

            <div className="-mt-3 flex justify-end">
              <button
                type="button"
                onClick={() =>
                  setWatchlist((list) =>
                    list.includes(data.symbol)
                      ? list.filter((item) => item !== data.symbol)
                      : [...list, data.symbol].slice(0, 30),
                  )
                }
                className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-emerald-500 hover:text-emerald-300"
              >
                {watchlist.includes(data.symbol)
                  ? "✓ In watchlist — remove"
                  : "+ Add to watchlist"}
              </button>
            </div>

            <StatGrid quote={data.quote} currency={currency} />

            <NotesCard notes={data.notes ?? []} />

            <CompositeCard composite={data.composite ?? null} />

            <PriceChart
              history={data.priceHistory}
              currencySymbol={currency === "INR" ? "₹" : "$"}
            />

            <FundamentalsCard
              fundamentals={data.fundamentals}
              beta={data.quote?.beta ?? null}
            />

            {recentBars.length > 0 && (
              <Card title="Price history" subtitle="Last 10 trading sessions">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Open
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          High
                        </th>
                        <th className="px-3 py-2 text-right font-medium">Low</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Close
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          Volume
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/60">
                      {recentBars.map((bar) => (
                        <tr key={bar.date} className="hover:bg-gray-800/30">
                          <td className="px-3 py-2 font-mono text-gray-400">
                            {bar.date}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-300">
                            {formatRatio(bar.open)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-400">
                            {formatRatio(bar.high)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-red-400">
                            {formatRatio(bar.low)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-white">
                            {formatRatio(bar.close)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-400">
                            {formatNumber(bar.volume)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <SignalsCard signals={data.technicalSignals ?? []} />

            <RiskCard risk={data.risk ?? null} riskFreeRate={data.riskFreeRate} />

            <DcfCard
              key={`dcf-${data.symbol}`}
              dcf={data.dcf ?? null}
              price={data.quote?.price ?? null}
              currencySymbol={currency === "INR" ? "₹" : "$"}
            />

            <BacktestCard key={`bt-${data.symbol}`} symbol={data.symbol} />

            <OwnershipCard quarters={data.shareholding ?? []} />

            <div className="grid gap-6 xl:grid-cols-2">
              <NewsCard news={data.news ?? null} />
              <FilingsCard filings={data.filings ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <AnalystCard analysts={data.analysts ?? null} />
              <InsiderCard trades={data.insiderTransactions ?? []} />
            </div>

            {data.financials.length > 0 && (
              <Card title="Financials" subtitle="Annual periods">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500">
                        <th className="px-3 py-2 text-left font-medium">
                          Metric
                        </th>
                        {data.financials.map((period) => (
                          <th
                            key={period.date}
                            className="px-3 py-2 text-right font-medium"
                          >
                            {fiscalYear(period.date)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/60">
                      <FinancialRow
                        label="Revenue"
                        periods={data.financials}
                        field="revenue"
                      />
                      <FinancialRow
                        label="Net Income"
                        periods={data.financials}
                        field="netIncome"
                        colored
                      />
                      <FinancialRow
                        label="EBITDA"
                        periods={data.financials}
                        field="ebitda"
                      />
                      <FinancialRow
                        label="Free Cash Flow"
                        periods={data.financials}
                        field="freeCashFlow"
                        colored
                      />
                      <FinancialRow
                        label="Total Debt"
                        periods={data.financials}
                        field="totalDebt"
                      />
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presentational pieces                                               */
/* ------------------------------------------------------------------ */

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          {title}
        </h2>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function QuoteHeader({
  quote,
  symbol,
}: {
  quote: QuoteData | null;
  symbol: string;
}) {
  if (!quote) {
    return (
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <p className="text-sm text-gray-400">
          No quote available for{" "}
          <span className="font-mono text-emerald-400">{symbol}</span>. Price
          history may still be shown below.
        </p>
      </section>
    );
  }

  const { currency } = quote;

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-xs font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
              {quote.symbol}
            </span>
            {quote.exchange && (
              <span className="text-xs text-gray-500">{quote.exchange}</span>
            )}
          </div>
          <h2 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
            {quote.name}
          </h2>
        </div>

        <div className="text-right">
          <p className="text-3xl font-bold tabular-nums text-white sm:text-4xl">
            {formatPrice(quote.price, currency)}
          </p>
          <p
            className={`mt-1 text-sm font-semibold tabular-nums ${changeColor(
              quote.change,
            )}`}
          >
            {withSign(quote.change)}
            {" ("}
            {quote.changePercent !== null && quote.changePercent > 0 ? "+" : ""}
            {formatPercent(quote.changePercent)}
            {")"}
          </p>
        </div>
      </div>
    </section>
  );
}

function StatGrid({
  quote,
  currency,
}: {
  quote: QuoteData | null;
  currency: string;
}) {
  const stats: [string, string][] = [
    ["Market Cap", formatNumber(quote?.marketCap)],
    ["P/E Ratio", formatRatio(quote?.peRatio)],
    ["EPS", formatRatio(quote?.eps)],
    ["52W High", formatPrice(quote?.high52Week, currency)],
    ["52W Low", formatPrice(quote?.low52Week, currency)],
    ["Volume", formatNumber(quote?.volume)],
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {stats.map(([label, value]) => (
        <div
          key={label}
          className="rounded-xl border border-gray-800 bg-gray-900 p-4"
        >
          <p className="text-xs uppercase tracking-wider text-gray-500">
            {label}
          </p>
          <p className="mt-1.5 text-lg font-semibold tabular-nums text-white">
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

function FundamentalsCard({
  fundamentals,
  beta,
}: {
  fundamentals: FundamentalMetrics | null;
  /** Beta is reported on the quote, not among the fundamental ratios. */
  beta: number | null;
}) {
  if (!fundamentals) return null;

  const rows: [string, string][] = [
    ["Forward P/E", formatRatio(fundamentals.forwardPE)],
    ["PEG", formatRatio(fundamentals.pegRatio)],
    ["Price/Book", formatRatio(fundamentals.priceToBook)],
    ["EV/EBITDA", formatRatio(fundamentals.evToEbitda)],
    ["Gross Margin", formatPercent(fundamentals.grossMargin)],
    ["Operating Margin", formatPercent(fundamentals.operatingMargin)],
    ["Net Margin", formatPercent(fundamentals.netMargin)],
    ["ROE", formatPercent(fundamentals.roe)],
    ["ROA", formatPercent(fundamentals.roa)],
    // A true ratio now: we compute it as totalDebt / stockholdersEquity.
    ["Debt/Equity", formatRatio(fundamentals.debtToEquity)],
    ["Current Ratio", formatRatio(fundamentals.currentRatio)],
    ["Beta", formatRatio(beta)],
  ];

  return (
    <Card title="Fundamentals" subtitle="Trailing twelve months">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between border-b border-gray-800/60 py-2"
          >
            <dt className="text-sm text-gray-400">{label}</dt>
            <dd className="text-sm font-semibold tabular-nums text-white">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function FinancialRow({
  label,
  periods,
  field,
  colored = false,
}: {
  label: string;
  periods: FinancialStatement[];
  field: keyof FinancialStatement;
  colored?: boolean;
}) {
  return (
    <tr className="hover:bg-gray-800/30">
      <td className="px-3 py-2 text-left text-gray-400">{label}</td>
      {periods.map((period) => {
        const value = period[field];
        const numeric = typeof value === "number" ? value : null;
        return (
          <td
            key={period.date}
            className={`px-3 py-2 text-right font-mono tabular-nums ${
              colored ? changeColor(numeric) : "text-gray-200"
            }`}
          >
            {formatNumber(numeric)}
          </td>
        );
      })}
    </tr>
  );
}

function EmptyState({ onPick }: { onPick: (symbol: string) => void }) {
  const examples = ["AAPL", "TSLA", "RELIANCE.NS", "INFY.NS"];

  return (
    <div className="mt-20 flex flex-col items-center text-center">
      <span className="text-5xl" role="img" aria-label="Chart">
        📊
      </span>
      <p className="mt-4 text-lg font-medium text-gray-300">
        Search any stock to begin analysis
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {examples.map((symbol) => (
          <button
            key={symbol}
            type="button"
            onClick={() => onPick(symbol)}
            className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 font-mono text-sm text-emerald-400 transition hover:border-emerald-500/50 hover:bg-gray-800"
          >
            {symbol}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-gray-800 bg-gray-900 p-5"
        >
          <div className="h-3 w-24 rounded bg-gray-800" />
          <div className="mt-4 h-7 w-36 rounded bg-gray-800" />
          <div className="mt-3 h-3 w-full rounded bg-gray-800/70" />
        </div>
      ))}
    </div>
  );
}
