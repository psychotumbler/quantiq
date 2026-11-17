"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { APIResponse } from "@/types/stock";
import type { CompareEntry, CompareRouteData } from "@/app/api/compare/route";
import { formatNumber, formatPercent, formatRatio } from "@/lib/format";
import { Panel, SampleBadge, toneClass } from "@/components/ui/primitives";

const COLORS = ["#34d399", "#60a5fa", "#fbbf24", "#f472b6"];

const PRESETS: { label: string; symbols: string[] }[] = [
  { label: "Indian IT", symbols: ["TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS"] },
  { label: "Indian banks", symbols: ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS"] },
  { label: "AI chips", symbols: ["NVDA", "AMD", "TSM", "AVGO"] },
  { label: "Big Tech", symbols: ["AAPL", "MSFT", "GOOGL", "AMZN"] },
  { label: "Defence", symbols: ["HAL.NS", "BEL.NS", "BDL.NS", "MAZDOCK.NS"] },
  { label: "Nifty vs S&P vs gold", symbols: ["^NSEI", "^GSPC", "GC=F", "BTC-USD"] },
];

type Row = {
  label: string;
  get: (e: CompareEntry) => number | null;
  format: (v: number | null) => string;
  /** Which end is better, for highlighting. */
  better?: "high" | "low";
};

const ROWS: Row[] = [
  { label: "1-year return", get: (e) => e.return1y, format: formatPercent, better: "high" },
  { label: "Market cap", get: (e) => e.marketCap, format: formatNumber },
  { label: "P/E", get: (e) => e.fundamentals.peRatio, format: formatRatio, better: "low" },
  { label: "Price / book", get: (e) => e.fundamentals.priceToBook, format: formatRatio, better: "low" },
  { label: "EV / EBITDA", get: (e) => e.fundamentals.evToEbitda, format: formatRatio, better: "low" },
  { label: "Net margin", get: (e) => e.fundamentals.netMargin, format: formatPercent, better: "high" },
  { label: "ROE", get: (e) => e.fundamentals.roe, format: formatPercent, better: "high" },
  { label: "ROIC", get: (e) => e.fundamentals.roic, format: formatPercent, better: "high" },
  { label: "FCF yield", get: (e) => e.fundamentals.fcfYield, format: formatPercent, better: "high" },
  { label: "Debt / equity", get: (e) => e.fundamentals.debtToEquity, format: formatRatio, better: "low" },
  { label: "Volatility", get: (e) => e.risk.volatility, format: formatPercent, better: "low" },
  { label: "Sharpe", get: (e) => e.risk.sharpeRatio, format: formatRatio, better: "high" },
  { label: "Max drawdown", get: (e) => e.risk.maxDrawdown, format: formatPercent, better: "low" },
  { label: "Beta", get: (e) => e.risk.beta, format: formatRatio },
];

export function CompareView({
  initial,
  onAnalyze,
}: {
  initial: string;
  onAnalyze: (symbol: string) => void;
}) {
  const start = initial ? initial.split(",").filter(Boolean).slice(0, 4) : PRESETS[0].symbols;
  const [symbols, setSymbols] = useState<string[]>(start);
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<CompareRouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = symbols.join(",");

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/compare?symbols=${encodeURIComponent(key)}`, { signal: controller.signal });
        const body: APIResponse<CompareRouteData> = await res.json();
        if (body.success) { setData(body.data); setError(null); }
        else setError(body.error);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Could not reach the compare API.");
      } finally {
        setLoading(false);
      }
    }, 0);
    // Keep the URL shareable.
    if (window.location.hash !== `#compare/${encodeURIComponent(key)}`) {
      history.replaceState(null, "", `#compare/${encodeURIComponent(key)}`);
    }
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key]);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const s = draft.trim().toUpperCase();
    if (/^[A-Z0-9.^=&-]{1,20}$/.test(s) && !symbols.includes(s) && symbols.length < 4) {
      setSymbols([...symbols, s]);
    }
    setDraft("");
  };

  return (
    <div className="space-y-6">
      <Panel
        title="Compare"
        subtitle="Up to four stocks, indices, commodities or coins. Prices are rebased to 100 on the first shared day, so lines show relative performance regardless of currency."
        action={data?.sampleData ? <SampleBadge /> : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          {symbols.map((s, i) => (
            <span
              key={s}
              className="flex items-center gap-2 rounded-full border border-gray-700 bg-gray-950 py-1 pl-3 pr-1.5 text-sm"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[i] }} />
              <span className="font-mono text-gray-100">{s}</span>
              <button
                type="button"
                onClick={() => setSymbols(symbols.filter((x) => x !== s))}
                aria-label={`Remove ${s}`}
                className="rounded-full px-1.5 text-gray-500 hover:bg-gray-800 hover:text-red-400"
              >
                ×
              </button>
            </span>
          ))}
          {symbols.length < 4 && (
            <form onSubmit={add} className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add ticker"
                aria-label="Add a ticker to compare"
                className="w-32 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
              />
              <button type="submit" className="rounded-md bg-emerald-500 px-3 py-1 text-sm font-semibold text-gray-950">
                Add
              </button>
            </form>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="text-xs text-gray-500">Try:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setSymbols(p.symbols)}
              className="rounded-full border border-gray-800 px-3 py-0.5 text-xs text-gray-400 hover:border-emerald-500 hover:text-emerald-300"
            >
              {p.label}
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        {data && data.notFound.length > 0 && (
          <p className="mt-3 text-sm text-amber-300">No price history for {data.notFound.join(", ")}.</p>
        )}
      </Panel>

      {loading && !data && <div className="h-80 animate-pulse rounded-xl bg-gray-900" />}

      {data && data.entries.length > 0 && (
        <>
          <Panel
            title="One year, rebased to 100"
            subtitle={loading ? "Updating…" : `${data.series.length} shared trading days`}
          >
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#1f2937" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickFormatter={(d: string) => d.slice(0, 7)}
                    minTickGap={60}
                    tickLine={false}
                    axisLine={{ stroke: "#374151" }}
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    width={44}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{ background: "#030712", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#9ca3af" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {data.entries.map((e, i) => (
                    <Line
                      key={e.symbol}
                      type="monotone"
                      dataKey={e.symbol}
                      stroke={COLORS[i]}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Side by side" subtitle="The best value in each row is highlighted where better has a direction. Blank means the figure is not available or not meaningful for that security.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500" />
                    {data.entries.map((e, i) => (
                      <th key={e.symbol} className="px-3 py-2 text-right">
                        <button type="button" onClick={() => onAnalyze(e.symbol)} className="hover:underline">
                          <span className="block font-mono font-semibold" style={{ color: COLORS[i] }}>{e.symbol}</span>
                          <span className="block max-w-40 truncate text-xs font-normal text-gray-500">{e.name}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60">
                  {ROWS.map((row) => {
                    const values = data.entries.map((e) => row.get(e));
                    const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
                    const best =
                      row.better && present.length > 1
                        ? row.better === "high" ? Math.max(...present) : Math.min(...present)
                        : null;
                    return (
                      <tr key={row.label}>
                        <td className="px-3 py-2 text-gray-400">{row.label}</td>
                        {values.map((v, i) => (
                          <td
                            key={i}
                            className={`px-3 py-2 text-right font-mono ${
                              v !== null && v === best ? "font-semibold text-emerald-300" : row.label === "1-year return" ? toneClass(v) : "text-gray-200"
                            }`}
                          >
                            {v === null ? "—" : row.format(v)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Market caps are in each security&apos;s own currency. Lower P/E or higher margin is not
              automatically better — compare within an industry.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
