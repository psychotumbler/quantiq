"use client";

import { useEffect, useState } from "react";
import type { APIResponse, SentimentData } from "@/types/stock";
import type { MarketGroup, MarketQuote } from "@/services/market";
import type { LiteQuote } from "@/app/api/quotes/route";
import type { MacroRouteData } from "@/app/api/macro/route";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { PulseSection } from "@/components/PulseSection";
import {
  formatChange,
  formatLevel,
  Panel,
  Sparkline,
  toneClass,
} from "@/components/ui/primitives";

export const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "RELIANCE.NS", "TCS.NS", "INFY.NS"];

const BOARDS: { title: string; groups: MarketGroup[] }[] = [
  { title: "India", groups: ["India"] },
  { title: "United States", groups: ["US"] },
  { title: "Commodities", groups: ["Commodities"] },
  { title: "Global, currencies and crypto", groups: ["Global", "Currencies", "Crypto", "Rates"] },
];

function QuoteRow({
  label,
  sub,
  price,
  unit,
  changePercent,
  change,
  spark,
  onClick,
  trailing,
}: {
  label: string;
  sub?: string;
  price: number | null;
  unit?: string;
  changePercent: number | null;
  change: number | null;
  spark: number[];
  onClick?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-gray-800/60 py-2.5 last:border-0">
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 text-left transition hover:text-emerald-300"
      >
        <span className="block truncate text-sm font-medium text-gray-100">{label}</span>
        {sub && <span className="block truncate text-xs text-gray-500">{sub}</span>}
      </button>
      <Sparkline values={spark} width={72} height={24} />
      <div className="w-24 text-right">
        <span className="block font-mono text-sm text-white">
          {formatLevel(price)}
          {unit === "%" ? "%" : ""}
        </span>
        <span className={`block font-mono text-xs ${toneClass(change)}`}>
          {formatChange(changePercent)}
        </span>
      </div>
      {trailing}
    </div>
  );
}

function Watchlist({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [symbols, setSymbols] = useLocalStorage<string[]>("quantiq.watchlist", DEFAULT_WATCHLIST);
  const [quotes, setQuotes] = useState<Record<string, LiteQuote>>({});
  const [draft, setDraft] = useState("");
  const key = symbols.join(",");

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(key)}`, {
          signal: controller.signal,
        });
        const body: APIResponse<LiteQuote[]> = await res.json();
        if (body.success) {
          setQuotes(Object.fromEntries(body.data.map((q) => [q.symbol, q])));
        }
      } catch {
        // Leave the previous quotes in place; rows show a dash when missing.
      }
    })();
    return () => controller.abort();
  }, [key]);

  const add = () => {
    const symbol = draft.trim().toUpperCase();
    if (!/^[A-Z0-9.^=&-]{1,20}$/.test(symbol)) return;
    setSymbols((list) => (list.includes(symbol) ? list : [...list, symbol].slice(0, 30)));
    setDraft("");
  };

  return (
    <Panel
      title="Watchlist"
      subtitle="Saved in this browser. Click a name to analyse it."
      action={
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add ticker"
            aria-label="Add a ticker to the watchlist"
            className="w-28 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-500 px-3 py-1 text-sm font-semibold text-gray-950 hover:bg-emerald-400"
          >
            Add
          </button>
        </form>
      }
    >
      {symbols.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing here yet. Add a ticker above.</p>
      ) : (
        symbols.map((symbol) => {
          const q = quotes[symbol];
          return (
            <QuoteRow
              key={symbol}
              label={symbol}
              sub={q?.name && q.name !== symbol ? q.name : undefined}
              price={q?.price ?? null}
              changePercent={q?.changePercent ?? null}
              change={q?.change ?? null}
              spark={q?.spark ?? []}
              onClick={() => onAnalyze(symbol)}
              trailing={
                <button
                  type="button"
                  onClick={() => setSymbols((list) => list.filter((s) => s !== symbol))}
                  aria-label={`Remove ${symbol} from the watchlist`}
                  className="rounded px-1.5 text-gray-600 hover:bg-gray-800 hover:text-red-400"
                >
                  ×
                </button>
              }
            />
          );
        })
      )}
    </Panel>
  );
}

function MacroPanel() {
  const [data, setData] = useState<MacroRouteData | null | undefined>(undefined);
  const [country, setCountry] = useState<"IN" | "US">("IN");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/macro", { signal: controller.signal });
        const body: APIResponse<MacroRouteData> = await res.json();
        setData(body.success ? body.data : null);
      } catch {
        setData(null);
      }
    })();
    return () => controller.abort();
  }, []);

  const india = (data?.india ?? []).filter((s) => s.value !== null);
  const us = (data?.series ?? []).filter((s) => s.value !== null);
  // Sample mode has no India figures, so fall back to the US set.
  const showing = country === "IN" && india.length > 0 ? "IN" : "US";
  const available = showing === "IN" ? india : us;
  const spread = us.find((s) => s.id === "T10Y2Y")?.value ?? null;

  return (
    <Panel
      title="Macro"
      subtitle={
        showing === "IN"
          ? "India, annual: IMF World Economic Outlook"
          : "United States: FRED (Federal Reserve Bank of St. Louis)"
      }
      action={
        <div className="flex overflow-hidden rounded-md border border-gray-700 text-xs">
          {(["IN", "US"] as const).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setCountry(code)}
              className={`px-2.5 py-1 ${
                showing === code ? "bg-emerald-500 font-semibold text-gray-950" : "text-gray-400"
              }`}
            >
              {code === "IN" ? "India" : "US"}
            </button>
          ))}
        </div>
      }
    >
      {data === undefined ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : available.length === 0 ? (
        <p className="text-sm text-gray-500">Macro data is unavailable right now.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {available.map((s) => (
              <div
                key={s.id}
                title={s.note}
                className="rounded-lg border border-gray-800 bg-gray-950 p-3"
              >
                <p className="text-xs text-gray-500">{s.label}</p>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <p className="font-mono text-lg font-semibold text-white">
                    {s.value!.toFixed(2)}
                    <span className="ml-0.5 text-sm text-gray-500">
                      {s.unit === "%" ? "%" : s.id === "NGDPD" ? "" : "pp"}
                    </span>
                  </p>
                  <Sparkline values={s.history.map((h) => h.value)} width={64} height={22} />
                </div>
                {s.change !== null && (
                  <p className="mt-1 font-mono text-xs text-gray-400">
                    {s.change > 0 ? "+" : ""}
                    {s.change.toFixed(2)} {s.changeLabel}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-600">{s.date}</p>
              </div>
            ))}
          </div>
          {showing === "US" && spread !== null && (
            <p className="mt-3 text-xs text-gray-500">
              Yield curve:{" "}
              <span className={spread < 0 ? "text-red-400" : "text-emerald-400"}>
                {spread < 0 ? "inverted" : "upward sloping"}
              </span>{" "}
              (10-year minus 2-year is {spread.toFixed(2)} points). An inverted curve has
              preceded most US recessions, with long and variable lags.
            </p>
          )}
          {showing === "IN" && (
            <p className="mt-3 text-xs text-gray-500">
              Annual figures; the current year is an IMF projection until it closes. Hover a
              tile for the next-year projection. Live India readings (Nifty, India VIX,
              USD/INR) are on the boards above.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

export function ToneDot({ sentiment }: { sentiment: number | null }) {
  const color =
    sentiment === null || sentiment === 0
      ? "bg-gray-600"
      : sentiment > 0
        ? "bg-emerald-400"
        : "bg-red-400";
  const label =
    sentiment === null || sentiment === 0 ? "Neutral" : sentiment > 0 ? "Positive" : "Negative";
  return <span title={`${label} tone`} className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

export function HeadlineList({ news, limit = 10 }: { news: SentimentData; limit?: number }) {
  return (
    <ul className="divide-y divide-gray-800/60">
      {news.headlines.slice(0, limit).map((h, i) => (
        <li key={`${h.url}-${i}`} className="flex gap-3 py-2.5">
          <ToneDot sentiment={h.sentiment} />
          <div className="min-w-0">
            <a
              href={h.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-200 hover:text-emerald-300"
            >
              {h.title}
            </a>
            <p className="mt-0.5 text-xs text-gray-500">
              {h.source}
              {h.publishedAt ? ` · ${h.publishedAt.slice(0, 10)}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function MarketNews() {
  const [news, setNews] = useState<SentimentData | null | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/news", { signal: controller.signal });
        const body: APIResponse<SentimentData> = await res.json();
        setNews(body.success ? body.data : null);
      } catch {
        setNews(null);
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <Panel title="Market headlines" subtitle={news?.source ?? "Latest market news"}>
      {news === undefined ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !news || news.headlines.length === 0 ? (
        <p className="text-sm text-gray-500">No headlines available right now.</p>
      ) : (
        <HeadlineList news={news} limit={9} />
      )}
    </Panel>
  );
}

export function DashboardView({
  quotes,
  loading,
  onAnalyze,
}: {
  quotes: MarketQuote[];
  loading: boolean;
  onAnalyze: (symbol: string) => void;
}) {
  const stale = quotes.some((q) => q.stale);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
        {BOARDS.map((board) => {
          const rows = quotes.filter((q) => board.groups.includes(q.group) && q.price !== null);
          return (
            <Panel key={board.title} title={board.title}>
              {rows.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {loading ? "Loading…" : "Unavailable right now."}
                </p>
              ) : (
                rows.map((q) => (
                  <QuoteRow
                    key={q.symbol}
                    label={q.label}
                    price={q.price}
                    unit={q.unit}
                    changePercent={q.changePercent}
                    change={q.change}
                    spark={q.spark}
                    onClick={() => onAnalyze(q.symbol)}
                  />
                ))
              )}
            </Panel>
          );
        })}
      </div>
      {stale && (
        <p className="text-xs text-amber-300">
          Some quotes could not be refreshed and show the last value received.
        </p>
      )}

      <PulseSection onAnalyze={onAnalyze} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Watchlist onAnalyze={onAnalyze} />
        <MacroPanel />
        <MarketNews />
      </div>

      <p className="text-xs text-gray-600">
        Day change compares the latest price with the previous session&apos;s close. Sparklines
        show about one month of daily closes. Index, commodity, currency and crypto quotes come
        from Yahoo Finance&apos;s chart feed and may be delayed.
      </p>
    </div>
  );
}
