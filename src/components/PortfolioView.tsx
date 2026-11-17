"use client";

import { useEffect, useRef, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { APIResponse } from "@/types/stock";
import type { PortfolioRouteData } from "@/app/api/portfolio/route";
import type { BaseCurrency } from "@/analysis/portfolio";
import { holdingsToCsv, parseHoldingsCsv, type CsvHolding } from "@/lib/portfolioCsv";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { formatPercent, formatRatio } from "@/lib/format";
import {
  formatChange,
  formatMoney,
  Panel,
  SampleBadge,
  Tile,
  toneClass,
} from "@/components/ui/primitives";

const COLORS = [
  "#34d399", "#60a5fa", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c",
  "#22d3ee", "#a3e635", "#f87171", "#94a3b8",
];

const EMPTY: CsvHolding[] = [];

/** Red for strongly correlated pairs (little diversification), green for negative. */
function correlationStyle(value: number | null): React.CSSProperties {
  if (value === null) return {};
  const alpha = Math.min(0.75, Math.abs(value) * 0.75);
  return {
    backgroundColor:
      value >= 0 ? `rgba(248, 113, 113, ${alpha})` : `rgba(52, 211, 153, ${alpha})`,
  };
}

export function PortfolioView({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [holdings, setHoldings] = useLocalStorage<CsvHolding[]>("quantiq.holdings", EMPTY);
  const [base, setBase] = useLocalStorage<BaseCurrency>("quantiq.base", "INR");
  const [analysis, setAnalysis] = useState<PortfolioRouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState("");
  const [suffix, setSuffix] = useState<"" | ".NS" | ".BO">(".NS");
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const payload = JSON.stringify({ holdings, base });

  useEffect(() => {
    if (holdings.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/portfolio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        const body: APIResponse<PortfolioRouteData> = await res.json();
        if (body.success) {
          setAnalysis(body.data);
          setError(null);
        } else setError(body.error);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Could not reach the portfolio API.");
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `payload` already encodes both holdings and base.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  function addHolding(e: React.FormEvent) {
    e.preventDefault();
    const s = symbol.trim().toUpperCase();
    const q = Number(quantity);
    const c = Number(cost);
    if (!/^[A-Z0-9.^=&-]{1,20}$/.test(s) || !(q > 0) || !(c >= 0)) {
      setError("Enter a ticker, a positive quantity and an average cost.");
      return;
    }
    setHoldings((list) => [...list, { symbol: s, quantity: q, averageCost: c }].slice(0, 40));
    setSymbol("");
    setQuantity("");
    setCost("");
    setError(null);
  }

  async function importFile(file: File) {
    const result = parseHoldingsCsv(await file.text(), suffix);
    if (result.error) {
      setImportNote(result.error);
      return;
    }
    setHoldings(result.holdings.slice(0, 40));
    setImportNote(
      `Imported ${result.holdings.length} holdings${
        result.skipped > 0 ? `, skipped ${result.skipped} rows` : ""
      }.`,
    );
  }

  function exportFile() {
    const blob = new Blob([holdingsToCsv(holdings)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "quantiq-holdings.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const shown = holdings.length > 0 ? analysis : null;
  const pie = (shown?.positions ?? [])
    .filter((p) => p.value !== null && p.value > 0)
    .map((p) => ({ name: p.symbol, value: p.value as number }));

  return (
    <div className="space-y-6">
      <Panel
        title="Holdings"
        subtitle="Stored only in this browser. Use Yahoo-style tickers: AAPL, RELIANCE.NS, TCS.BO."
        action={
          <div className="flex items-center gap-2">
            {shown?.sampleData && <SampleBadge />}
            <div className="flex overflow-hidden rounded-md border border-gray-700 text-xs">
              {(["INR", "USD"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setBase(code)}
                  className={`px-2.5 py-1 ${
                    base === code ? "bg-emerald-500 font-semibold text-gray-950" : "text-gray-400"
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <form onSubmit={addHolding} className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Ticker"
            aria-label="Ticker"
            className="rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
          />
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Quantity"
            aria-label="Quantity"
            inputMode="decimal"
            className="rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
          />
          <input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="Average cost"
            aria-label="Average cost per share, in the stock's own currency"
            inputMode="decimal"
            className="rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-emerald-400"
          >
            Add holding
          </button>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-800 pt-4 text-sm">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-gray-700 px-3 py-1.5 text-gray-200 hover:border-emerald-500 hover:text-emerald-300"
          >
            Import broker CSV
          </button>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Tickers without a suffix are
            <select
              value={suffix}
              onChange={(e) => setSuffix(e.target.value as "" | ".NS" | ".BO")}
              className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200"
            >
              <option value=".NS">NSE (.NS)</option>
              <option value=".BO">BSE (.BO)</option>
              <option value="">US listings</option>
            </select>
          </label>
          {holdings.length > 0 && (
            <>
              <button
                type="button"
                onClick={exportFile}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-gray-200 hover:border-emerald-500 hover:text-emerald-300"
              >
                Export CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Remove all holdings from this browser?")) setHoldings([]);
                }}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-gray-400 hover:border-red-500 hover:text-red-300"
              >
                Clear all
              </button>
            </>
          )}
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {importNote ??
            "Importing replaces the current list. Any CSV with symbol, quantity and average-cost columns works, including a Zerodha Console holdings export. Live broker sync is not available: broker APIs need your own paid or approved app credentials."}
        </p>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      </Panel>

      {holdings.length === 0 && (
        <p className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">
          Add a holding or import a CSV to see value, profit and loss, allocation, risk and
          correlation.
        </p>
      )}

      {holdings.length > 0 && !shown && (
        <p className="text-sm text-gray-500">{loading ? "Pricing holdings…" : ""}</p>
      )}

      {shown && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Current value" value={formatMoney(shown.totals.value, base)} />
            <Tile label="Invested" value={formatMoney(shown.totals.invested, base)} />
            <Tile
              label="Total P&L"
              value={formatMoney(shown.totals.pnl, base)}
              sub={formatChange(shown.totals.pnlPercent)}
              tone={shown.totals.pnl}
            />
            <Tile
              label="Day change"
              value={formatMoney(shown.totals.dayChange, base)}
              sub={formatChange(shown.totals.dayChangePercent)}
              tone={shown.totals.dayChange}
            />
          </div>
          {shown.unpriced.length > 0 && (
            <p className="text-xs text-amber-300">
              Could not price {shown.unpriced.join(", ")} — excluded from the totals. Check the
              ticker and its exchange suffix.
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr]">
            <Panel
              title="Positions"
              subtitle={`Values in ${base}${
                shown.usdInr ? ` at USD/INR ${shown.usdInr.toFixed(2)}` : ""
              }. Price and average cost are in each stock's own currency.`}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-xs uppercase tracking-wider text-gray-500">
                      <th className="px-2 py-2 text-left font-medium">Holding</th>
                      <th className="px-2 py-2 text-right font-medium">Qty</th>
                      <th className="px-2 py-2 text-right font-medium">Avg cost</th>
                      <th className="px-2 py-2 text-right font-medium">Price</th>
                      <th className="px-2 py-2 text-right font-medium">Value</th>
                      <th className="px-2 py-2 text-right font-medium">P&amp;L</th>
                      <th className="px-2 py-2 text-right font-medium">Day</th>
                      <th className="px-2 py-2 text-right font-medium">Weight</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {shown.positions.map((p) => (
                      <tr key={p.symbol} className="hover:bg-gray-800/30">
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => onAnalyze(p.symbol)}
                            className="text-left hover:text-emerald-300"
                          >
                            <span className="block font-mono font-semibold text-emerald-400">
                              {p.symbol}
                            </span>
                            <span className="block max-w-44 truncate text-xs text-gray-500">
                              {p.name}
                            </span>
                          </button>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">
                          {p.quantity}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">
                          {formatMoney(p.averageCost, p.currency, 2)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-white">
                          {formatMoney(p.price, p.currency, 2)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-white">
                          {formatMoney(p.value, base)}
                        </td>
                        <td className={`px-2 py-2 text-right font-mono ${toneClass(p.pnl)}`}>
                          {formatMoney(p.pnl, base)}
                          <span className="block text-xs">{formatChange(p.pnlPercent)}</span>
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono text-xs ${toneClass(p.dayChange)}`}
                        >
                          {formatChange(p.dayChangePercent)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">
                          {p.weight === null ? "—" : `${(p.weight * 100).toFixed(1)}%`}
                        </td>
                        <td className="px-1 py-2 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setHoldings((list) => list.filter((h) => h.symbol !== p.symbol))
                            }
                            aria-label={`Remove ${p.symbol}`}
                            className="rounded px-1.5 text-gray-600 hover:bg-gray-800 hover:text-red-400"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Allocation" subtitle="Share of current value">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pie}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="90%"
                      paddingAngle={1}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {pie.map((slice, i) => (
                        <Cell key={slice.name} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "#030712",
                        border: "1px solid #374151",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      itemStyle={{ color: "#e5e7eb" }}
                      formatter={(value) => formatMoney(Number(value), base)}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="mt-3 space-y-1 text-xs">
                {pie.map((slice, i) => (
                  <li key={slice.name} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-gray-300">
                      <span
                        className="h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: COLORS[i % COLORS.length] }}
                      />
                      {slice.name}
                    </span>
                    <span className="font-mono text-gray-400">
                      {((slice.value / shown.totals.value) * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          {shown.risk && shown.risk.volatility !== null && (
            <Panel
              title="Portfolio risk"
              subtitle={`Today's weights applied to the ${shown.overlapDays} sessions all holdings share over the past year. Local-currency returns: currency moves are not included.`}
            >
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <Tile label="Volatility" value={formatPercent(shown.risk.volatility)} />
                <Tile label="Sharpe" value={formatRatio(shown.risk.sharpeRatio)} />
                <Tile label="Sortino" value={formatRatio(shown.risk.sortinoRatio)} />
                <Tile label="Max drawdown" value={formatPercent(shown.risk.maxDrawdown)} />
                <Tile label="VaR 95% (1d)" value={formatPercent(shown.risk.var95)} />
                <Tile label="CVaR 95% (1d)" value={formatPercent(shown.risk.cvar95)} />
              </div>
              {shown.risk.var95 !== null && (
                <p className="mt-3 text-xs text-gray-500">
                  On the worst 5% of days in this window, a portfolio like this lost at least{" "}
                  {formatMoney(shown.totals.value * shown.risk.var95, base)} in a day.
                </p>
              )}
            </Panel>
          )}

          {shown.correlation && (
            <Panel
              title="Correlation"
              subtitle="Daily-return correlation between holdings. Red pairs move together and add little diversification; green pairs offset each other."
            >
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr>
                      <th />
                      {shown.correlation.symbols.map((s) => (
                        <th key={s} className="px-2 py-1 font-mono font-medium text-gray-400">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.correlation.matrix.map((row, i) => (
                      <tr key={shown.correlation!.symbols[i]}>
                        <th className="px-2 py-1 text-right font-mono font-medium text-gray-400">
                          {shown.correlation!.symbols[i]}
                        </th>
                        {row.map((value, j) => (
                          <td
                            key={j}
                            style={i === j ? undefined : correlationStyle(value)}
                            className="h-9 min-w-14 rounded border border-gray-900 text-center font-mono text-gray-100"
                          >
                            {value === null ? "—" : value.toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
