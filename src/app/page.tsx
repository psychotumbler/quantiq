"use client";

/**
 * QuantIQ shell: market ribbon, navigation and the four views.
 *
 * The views are client-rendered and switched with local state mirrored to the
 * URL hash, so a refresh or a shared link reopens the same view and symbol.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { APIResponse } from "@/types/stock";
import type { MarketQuote } from "@/services/market";
import type { MarketRouteData } from "@/app/api/market/route";
import { TickerRibbon } from "@/components/TickerRibbon";
import { DashboardView } from "@/components/DashboardView";
import { StockView } from "@/components/StockView";
import { PortfolioView } from "@/components/PortfolioView";
import { ToolsView } from "@/components/ToolsView";
import { NexusView } from "@/components/NexusView";
import { CompareView } from "@/components/CompareView";
import { AlgoView } from "@/components/AlgoView";

type View = "markets" | "nexus" | "analyze" | "compare" | "portfolio" | "algo" | "tools";

const TABS: { id: View; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "nexus", label: "News Nexus" },
  { id: "analyze", label: "Analyze" },
  { id: "compare", label: "Compare" },
  { id: "portfolio", label: "Portfolio" },
  { id: "algo", label: "Algo" },
  { id: "tools", label: "Tools" },
];

const REFRESH_MS = 3 * 60 * 1000;

function subscribeHash(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

/** `#analyze/AAPL` → `{ view: "analyze", symbol: "AAPL" }`. */
function parseHash(hash: string): { view: View; symbol: string } {
  const [rawView, rawSymbol = ""] = hash.replace(/^#/, "").split("/");
  const view = TABS.some((tab) => tab.id === rawView) ? (rawView as View) : "markets";
  let symbol = "";
  try {
    symbol = decodeURIComponent(rawSymbol).toUpperCase();
  } catch {
    // A malformed escape in a hand-edited URL: ignore the symbol.
  }
  // Compare carries a comma-separated list.
  return { view, symbol: /^[A-Z0-9.^=&,-]{1,90}$/.test(symbol) ? symbol : "" };
}

export default function Home() {
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  const { view, symbol } = parseHash(hash);

  const [market, setMarket] = useState<MarketRouteData | null>(null);
  const [marketFailed, setMarketFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/market");
        const body: APIResponse<MarketRouteData> = await res.json();
        if (cancelled) return;
        if (body.success) {
          setMarket(body.data);
          setMarketFailed(false);
        } else setMarketFailed(true);
      } catch {
        if (!cancelled) setMarketFailed(true);
      }
    }
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const go = useCallback((next: View, nextSymbol = "") => {
    window.location.hash = nextSymbol
      ? `${next}/${encodeURIComponent(nextSymbol)}`
      : next;
    window.scrollTo({ top: 0 });
  }, []);

  const analyze = useCallback((s: string) => go("analyze", s), [go]);

  const quotes: MarketQuote[] = market?.quotes ?? [];
  const sampleData = market?.sampleData === true;
  const live = market !== null && !sampleData && quotes.some((q) => q.price !== null);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="sticky top-0 z-30">
        <TickerRibbon quotes={quotes} sampleData={sampleData} />

        <header className="border-b border-gray-800 bg-gray-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <button type="button" onClick={() => go("markets")} className="text-left">
              <span className="block text-xl font-bold tracking-tight">
                <span className="text-emerald-400">Quant</span>
                <span className="text-white">IQ</span>
              </span>
              <span className="block text-[11px] text-gray-500">
                Investment Intelligence Platform
              </span>
            </button>

            <nav aria-label="Views" className="flex gap-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => go(tab.id, tab.id === view ? symbol : "")}
                  aria-current={view === tab.id ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    view === tab.id
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "text-gray-400 hover:bg-gray-900 hover:text-gray-100"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-3 text-xs">
              <span className="hidden text-gray-500 md:inline">Built by Aryaveer</span>
              {sampleData ? (
                <span className="flex items-center gap-1.5 font-medium text-amber-400">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  Sample data
                </span>
              ) : live ? (
                <span className="flex items-center gap-1.5 text-gray-400">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-gray-500">
                  <span className="h-2 w-2 rounded-full bg-gray-600" />
                  {marketFailed || market ? "Market feed offline" : "Connecting"}
                </span>
              )}
            </div>
          </div>
        </header>
      </div>

      {sampleData && (
        <div role="status" className="border-b border-amber-500/40 bg-amber-500/10">
          <p className="mx-auto max-w-[1500px] px-4 py-2 text-sm text-amber-200 sm:px-6">
            <span className="font-semibold text-amber-300">
              Sample data — not live market data.
            </span>{" "}
            No <code className="rounded bg-amber-500/15 px-1">FINNHUB_API_KEY</code> is set, so
            every figure is fabricated. Do not use it for any decision.
          </p>
        </div>
      )}

      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
        {view === "markets" && (
          <DashboardView quotes={quotes} loading={market === null} onAnalyze={analyze} />
        )}
        {view === "nexus" && <NexusView onAnalyze={analyze} />}
        {view === "analyze" && <StockView key={symbol || "blank"} initialSymbol={symbol} />}
        {view === "compare" && <CompareView key={symbol || "blank"} initial={symbol} onAnalyze={analyze} />}
        {view === "portfolio" && <PortfolioView onAnalyze={analyze} />}
        {view === "algo" && <AlgoView onAnalyze={analyze} />}
        {view === "tools" && <ToolsView />}
      </main>

      <footer className="border-t border-gray-900 px-4 py-6 text-center text-xs text-gray-600">
        For education and research. Scores, valuations and backtests are model outputs built on
        stated assumptions, not investment advice. Data: Finnhub, Yahoo Finance chart feed,
        FRED, public news RSS.
      </footer>
    </div>
  );
}
