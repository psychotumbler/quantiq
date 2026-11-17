"use client";

/**
 * Valuation, backtest and news panels for the stock view.
 */

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { APIResponse, DCFResult, SentimentData } from "@/types/stock";
import type { Filing, HoldingQuarter } from "@/services/nse";
import { computeDcf, type DcfAssumptions } from "@/analysis/dcf";
import type { BacktestResult } from "@/analysis/backtest";
import type { BacktestRouteData } from "@/app/api/backtest/[symbol]/route";
import { formatNumber } from "@/lib/format";
import {
  formatChange,
  Panel,
  Tile,
  toneClass,
} from "@/components/ui/primitives";
import { HeadlineList } from "@/components/DashboardView";

/* ------------------------------------------------------------------ */
/* DCF                                                                 */
/* ------------------------------------------------------------------ */

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-gray-400">
        <span>{label}</span>
        <span className="font-mono text-gray-100">
          {(value * 100).toFixed(1)}%
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-emerald-500"
      />
    </label>
  );
}

export function DcfCard({
  dcf,
  price,
  currencySymbol,
}: {
  dcf: { assumptions: DcfAssumptions; result: DCFResult } | null;
  price: number | null;
  currencySymbol: string;
}) {
  const [overrides, setOverrides] = useState<Partial<DcfAssumptions>>({});
  if (!dcf) return null;

  const assumptions = { ...dcf.assumptions, ...overrides };
  const result = computeDcf(assumptions, price);
  const money = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `${currencySymbol}${v.toFixed(2)}`;

  // Sensitivity: intrinsic value across nearby discount and growth rates.
  const discountSteps = [-0.01, 0, 0.01].map(
    (d) => assumptions.discountRate + d,
  );
  const growthSteps = [-0.02, 0, 0.02].map((g) =>
    Math.max(0, assumptions.growthRate + g),
  );

  return (
    <Panel
      title="Valuation — discounted cash flow"
      subtitle="Five years of free cash flow plus a terminal value, discounted at WACC. Move the sliders: the answer is only as good as these three assumptions."
      action={
        Object.keys(overrides).length > 0 ? (
          <button
            type="button"
            onClick={() => setOverrides({})}
            className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-emerald-500 hover:text-emerald-300"
          >
            Reset
          </button>
        ) : undefined
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-4">
          <Slider
            label="FCF growth, years 1–5"
            value={assumptions.growthRate}
            min={0}
            max={0.25}
            step={0.005}
            onChange={(growthRate) =>
              setOverrides((o) => ({ ...o, growthRate }))
            }
          />
          <Slider
            label="Discount rate (WACC)"
            value={assumptions.discountRate}
            min={0.05}
            max={0.16}
            step={0.0025}
            onChange={(discountRate) =>
              setOverrides((o) => ({ ...o, discountRate }))
            }
          />
          <Slider
            label="Terminal growth"
            value={assumptions.terminalGrowth}
            min={0}
            max={0.04}
            step={0.0025}
            onChange={(terminalGrowth) =>
              setOverrides((o) => ({ ...o, terminalGrowth }))
            }
          />
          <p className="text-xs text-gray-500">
            Starting free cash flow {currencySymbol}
            {formatNumber(assumptions.baseFcf)}, net debt {currencySymbol}
            {formatNumber(assumptions.netDebt)},{" "}
            {formatNumber(assumptions.sharesOutstanding)} shares. Defaults:
            growth from the company&apos;s own history capped at 15%, WACC from
            CAPM with a 5% equity risk premium.
          </p>
        </div>

        <div>
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Tile
                  label="Value per share"
                  value={money(result.intrinsicValue)}
                />
                <Tile label="Market price" value={money(price)} />
                <Tile
                  label="Implied upside"
                  value={formatChange(result.upside)}
                  tone={result.upside}
                />
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="mb-2 text-left text-xs text-gray-500">
                    Value per share by discount rate (rows) and growth (columns)
                  </caption>
                  <thead>
                    <tr className="text-xs text-gray-500">
                      <th className="px-2 py-1 text-left font-medium">
                        WACC \ growth
                      </th>
                      {growthSteps.map((g, i) => (
                        <th
                          key={i}
                          className="px-2 py-1 text-right font-medium"
                        >
                          {(g * 100).toFixed(1)}%
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {discountSteps.map((d, row) => (
                      <tr key={row} className="border-t border-gray-800/60">
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-400">
                          {(d * 100).toFixed(2)}%
                        </td>
                        {growthSteps.map((g, col) => {
                          const cell = computeDcf(
                            { ...assumptions, discountRate: d, growthRate: g },
                            price,
                          );
                          return (
                            <td
                              key={col}
                              className={`px-2 py-1.5 text-right font-mono ${
                                row === 1 && col === 1 ? "font-bold" : ""
                              } ${toneClass(cell?.upside ?? null)}`}
                            >
                              {money(cell?.intrinsicValue)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-amber-300">
              These assumptions do not produce a value: terminal growth must be
              below the discount rate.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Backtest                                                            */
/* ------------------------------------------------------------------ */

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function StatRow({
  label,
  strategy,
  benchmark,
}: {
  label: string;
  strategy: string;
  benchmark: string;
}) {
  return (
    <tr className="border-t border-gray-800/60">
      <td className="px-3 py-2 text-gray-400">{label}</td>
      <td className="px-3 py-2 text-right font-mono text-white">{strategy}</td>
      <td className="px-3 py-2 text-right font-mono text-gray-300">
        {benchmark}
      </td>
    </tr>
  );
}

export function BacktestCard({ symbol }: { symbol: string }) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "done"; data: BacktestRouteData }
  >({ status: "idle" });
  const [selected, setSelected] = useState(0);

  async function run() {
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/backtest/${encodeURIComponent(symbol)}`);
      const body: APIResponse<BacktestRouteData> = await res.json();
      if (body.success) {
        setSelected(0);
        setState({ status: "done", data: body.data });
      } else setState({ status: "error", message: body.error });
    } catch {
      setState({
        status: "error",
        message: "Could not reach the backtest API.",
      });
    }
  }

  const result: BacktestResult | null =
    state.status === "done" ? (state.data.results[selected] ?? null) : null;

  return (
    <Panel
      title="Strategy backtest"
      subtitle="Simple technical rules on up to five years of daily closes, against buying and holding. Signals trade the day after they fire; each trade costs 0.10%."
      action={
        <button
          type="button"
          onClick={run}
          disabled={state.status === "loading"}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {state.status === "loading"
            ? "Running…"
            : state.status === "done"
              ? "Run again"
              : "Run backtest"}
        </button>
      }
    >
      {state.status === "idle" && (
        <p className="text-sm text-gray-500">
          Tests three rules on {symbol}: a 50/200-day trend filter, RSI mean
          reversion and a MACD crossover.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-red-300">{state.message}</p>
      )}
      {state.status === "done" && state.data.results.length === 0 && (
        <p className="text-sm text-amber-300">
          Only {state.data.bars} daily bars came back, which is not enough
          history to warm up any of the rules.
        </p>
      )}

      {state.status === "done" && result && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {state.data.results.map((r, i) => (
              <button
                key={r.strategy}
                type="button"
                onClick={() => setSelected(i)}
                className={`rounded-md border px-3 py-1 text-sm ${
                  i === selected
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                    : "border-gray-700 text-gray-400 hover:text-gray-200"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mb-3 text-xs text-gray-500">
            {result.rule} {result.from} to {result.to}.
          </p>

          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={result.curve}
                    margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid stroke="#1f2937" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "#6b7280", fontSize: 11 }}
                      tickFormatter={(d: string) => d.slice(0, 7)}
                      minTickGap={70}
                      tickLine={false}
                      axisLine={{ stroke: "#374151" }}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fill: "#6b7280", fontSize: 11 }}
                      tickFormatter={(v: number) => v.toFixed(0)}
                      width={44}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#030712",
                        border: "1px solid #374151",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "#9ca3af" }}
                      formatter={(value, name) => [
                        Number(value).toFixed(1),
                        name === "strategy" ? "Strategy" : "Buy and hold",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="benchmark"
                      stroke="#6b7280"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="strategy"
                      stroke="#34d399"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                <span className="text-emerald-400">━</span> Strategy{" "}
                <span className="ml-3 text-gray-400">━</span> Buy and hold ·
                both start at 100
              </p>
            </div>

            <table className="h-fit w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2 text-left font-medium" />
                  <th className="px-3 py-2 text-right font-medium">Strategy</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Buy &amp; hold
                  </th>
                </tr>
              </thead>
              <tbody>
                <StatRow
                  label="Total return"
                  strategy={pct(result.strategyStats.totalReturn)}
                  benchmark={pct(result.benchmarkStats.totalReturn)}
                />
                <StatRow
                  label="Annualised"
                  strategy={pct(result.strategyStats.cagr)}
                  benchmark={pct(result.benchmarkStats.cagr)}
                />
                <StatRow
                  label="Max drawdown"
                  strategy={pct(result.strategyStats.maxDrawdown)}
                  benchmark={pct(result.benchmarkStats.maxDrawdown)}
                />
                <StatRow
                  label="Return / volatility"
                  strategy={result.strategyStats.sharpe?.toFixed(2) ?? "—"}
                  benchmark={result.benchmarkStats.sharpe?.toFixed(2) ?? "—"}
                />
                <StatRow
                  label="Time invested"
                  strategy={pct(result.exposure)}
                  benchmark="100.0%"
                />
                <StatRow
                  label="Round trips"
                  strategy={`${result.trades}${
                    result.winRate === null
                      ? ""
                      : ` (${pct(result.winRate)} won)`
                  }`}
                  benchmark="—"
                />
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            One security, one period, no out-of-sample test: a rule that beat
            buy-and-hold here has not been shown to work. Excludes slippage and
            taxes
            {state.data.sampleData ? "; run on sample data" : ""}.
          </p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* News                                                                */
/* ------------------------------------------------------------------ */

export function NewsCard({ news }: { news: SentimentData | null }) {
  if (!news || news.headlines.length === 0) return null;
  const scored = news.positive + news.negative;
  return (
    <Panel
      title="News"
      subtitle={`${news.source} · tone scored by a finance word list, not a language model`}
    >
      <p className="mb-2 text-xs text-gray-400">
        <span className="text-emerald-400">{news.positive} positive</span> ·{" "}
        <span className="text-red-400">{news.negative} negative</span> ·{" "}
        {news.neutral} neutral
        {scored > 0 && (
          <>
            {" "}
            · net tone{" "}
            <span className={`font-mono ${toneClass(news.overall)}`}>
              {news.overall > 0 ? "+" : ""}
              {news.overall.toFixed(2)}
            </span>
          </>
        )}
      </p>
      <HeadlineList news={news} limit={10} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Ownership, filings, caveats                                         */
/* ------------------------------------------------------------------ */

export function OwnershipCard({ quarters }: { quarters: HoldingQuarter[] }) {
  if (quarters.length === 0) return null;
  const series = [...quarters].reverse().map((q) => ({ date: q.date.slice(0, 7), promoter: q.promoter }));
  const latest = quarters[0];
  const yearAgo = quarters[4] ?? quarters[quarters.length - 1];
  const change = latest.promoter - yearAgo.promoter;
  return (
    <Panel
      title="Shareholding"
      subtitle="Promoter and promoter-group holding by quarter, as filed with NSE"
    >
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="space-y-3">
          <Tile label="Promoters" value={`${latest.promoter.toFixed(2)}%`} sub={`as of ${latest.date}`} />
          <Tile label="Public" value={`${latest.public.toFixed(2)}%`} />
          <Tile
            label={`Change since ${yearAgo.date.slice(0, 7)}`}
            value={`${change > 0 ? "+" : ""}${change.toFixed(2)} pts`}
            tone={Math.abs(change) < 0.01 ? 0 : change}
          />
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1f2937" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#374151" }} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                width={52}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{ background: "#030712", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                formatter={(value) => [`${Number(value).toFixed(2)}%`, "Promoters"]}
              />
              <Line type="stepAfter" dataKey="promoter" stroke="#34d399" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        A rising promoter stake is commonly read as insiders backing the business; a falling one can
        mean selling or pledging — check the filings before drawing a conclusion.
      </p>
    </Panel>
  );
}

export function FilingsCard({ filings }: { filings: Filing[] }) {
  if (filings.length === 0) return null;
  return (
    <Panel title="Exchange filings" subtitle="The company's latest announcements to NSE, newest first">
      <ul className="max-h-96 divide-y divide-gray-800/60 overflow-auto pr-1">
        {filings.map((f, i) => (
          <li key={`${f.url}-${i}`} className="py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 font-medium ${
                  /order|contract|acquisition|agreement/i.test(f.category)
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-gray-800 text-gray-400"
                }`}
              >
                {f.category}
              </span>
              <span className="text-gray-500">{f.publishedAt.slice(0, 10)}</span>
            </div>
            <a href={f.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-sm text-gray-200 hover:text-emerald-300">
              {f.text || f.category}
              <span className="ml-1 text-xs text-gray-500">PDF ↗</span>
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function NotesCard({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
      <p className="text-sm font-semibold text-sky-300">Read this first</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-gray-300">
        {notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
}
