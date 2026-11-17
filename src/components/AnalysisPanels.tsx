"use client";

/**
 * Analysis panels for the stock page: composite score, price chart,
 * technical signals, risk metrics, analyst consensus and insider trades.
 *
 * Purely presentational — every figure arrives computed from the API route.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AnalystConsensus,
  CompositeScore,
  InsiderTransaction,
  PriceData,
  RiskMetrics,
  SignalDirection,
  TechnicalSignal,
} from "@/types/stock";
import { formatNumber, formatPercent, formatRatio } from "@/lib/format";

function Panel({
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
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

const DIRECTION_STYLE: Record<
  SignalDirection,
  { text: string; bar: string; label: string }
> = {
  bullish: { text: "text-emerald-400", bar: "bg-emerald-500", label: "Bullish" },
  bearish: { text: "text-red-400", bar: "bg-red-500", label: "Bearish" },
  neutral: { text: "text-gray-400", bar: "bg-gray-500", label: "Neutral" },
};

function scoreColor(score: number): string {
  if (score >= 60) return "text-emerald-400";
  if (score <= 40) return "text-red-400";
  return "text-amber-300";
}

function scoreBar(score: number): string {
  if (score >= 60) return "bg-emerald-500";
  if (score <= 40) return "bg-red-500";
  return "bg-amber-400";
}

/* ------------------------------------------------------------------ */
/* Composite                                                           */
/* ------------------------------------------------------------------ */

export function CompositeCard({
  composite,
}: {
  composite: CompositeScore | null;
}) {
  if (!composite) return null;
  const missing = 100 - composite.confidence;

  return (
    <Panel
      title="QuantIQ score"
      subtitle="Weighted across the analysis layers that have data. A model output, not investment advice."
    >
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="flex flex-col items-center justify-center rounded-lg border border-gray-800 bg-gray-950 p-5">
          <p
            className={`font-mono text-5xl font-bold ${scoreColor(composite.totalScore)}`}
          >
            {composite.totalScore}
          </p>
          <p className="text-xs text-gray-500">out of 100</p>
          <p
            className={`mt-3 text-lg font-semibold ${scoreColor(composite.totalScore)}`}
          >
            {composite.signal}
          </p>
          <p className="mt-2 text-center text-xs text-gray-500">
            Model coverage {composite.confidence}%
          </p>
        </div>

        <div className="space-y-4">
          {composite.layers.map((layer) => (
            <div key={layer.layer}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-gray-200">
                  {layer.layer}
                  <span className="ml-2 text-xs text-gray-500">
                    weight {layer.weight}
                  </span>
                </span>
                <span
                  className={`font-mono font-semibold ${scoreColor(layer.score)}`}
                >
                  {layer.score}
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-800">
                <div
                  className={`h-full rounded-full ${scoreBar(layer.score)}`}
                  style={{ width: `${layer.score}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {layer.signals.map((s) => (
                  <span
                    key={s.indicator}
                    title={s.description}
                    className="rounded border border-gray-800 bg-gray-950 px-2 py-0.5 text-xs text-gray-400"
                  >
                    {s.indicator}{" "}
                    {layer.layer === "Technical" ? (
                      <span className={DIRECTION_STYLE[s.signal].text}>
                        {DIRECTION_STYLE[s.signal].label}
                      </span>
                    ) : (
                      <span className={`font-mono ${scoreColor(s.strength)}`}>
                        {s.strength}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {missing > 0 && (
            <p className="text-xs text-gray-500">
              {missing}% of the full model had no data for this security and is
              left out rather than counted as neutral (for example, promoter
              stake applies only to NSE listings, and only when it moved).
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Price chart                                                         */
/* ------------------------------------------------------------------ */

export function PriceChart({
  history,
  currencySymbol,
}: {
  history: PriceData[];
  currencySymbol: string;
}) {
  const points = history
    .filter((bar) => bar.close !== null)
    .map((bar) => ({ date: bar.date, close: bar.close as number }));
  if (points.length < 2) return null;

  const first = points[0].close;
  const last = points[points.length - 1].close;
  const stroke = last >= first ? "#34d399" : "#f87171";
  const change = last / first - 1;

  return (
    <Panel
      title="Price"
      subtitle={`${points[0].date} to ${points[points.length - 1].date} · ${
        change >= 0 ? "+" : ""
      }${(change * 100).toFixed(1)}% over the window`}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1f2937" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              tickFormatter={(d: string) => d.slice(0, 7)}
              minTickGap={60}
              axisLine={{ stroke: "#374151" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "#6b7280", fontSize: 11 }}
              tickFormatter={(v: number) => `${currencySymbol}${v.toFixed(0)}`}
              width={64}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "#030712",
                border: "1px solid #374151",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: "#9ca3af" }}
              formatter={(value) => [
                `${currencySymbol}${Number(value).toFixed(2)}`,
                "Close",
              ]}
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke={stroke}
              strokeWidth={2}
              fill="url(#priceFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Technical signals                                                   */
/* ------------------------------------------------------------------ */

export function SignalsCard({ signals }: { signals: TechnicalSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <Panel
      title="Technical signals"
      subtitle="Computed from the daily bars. Strength is 0 to 100."
    >
      <ul className="divide-y divide-gray-800/60">
        {signals.map((s) => {
          const style = DIRECTION_STYLE[s.signal];
          return (
            <li
              key={s.indicator}
              className="grid gap-2 py-3 sm:grid-cols-[170px_90px_1fr] sm:items-center"
            >
              <span className="text-sm font-medium text-gray-200">
                {s.indicator}
              </span>
              <span
                className={`text-xs font-semibold uppercase tracking-wider ${style.text}`}
              >
                {style.label}
              </span>
              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-gray-800">
                  <div
                    className={`h-full rounded-full ${style.bar}`}
                    style={{ width: `${Math.max(4, s.strength)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-500">{s.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Risk                                                                */
/* ------------------------------------------------------------------ */

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
      <p className="text-xs uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  );
}

export function RiskCard({
  risk,
  riskFreeRate,
}: {
  risk: RiskMetrics | null;
  riskFreeRate?: { value: number; source: string };
}) {
  if (!risk || risk.volatility === null) return null;
  const rate = riskFreeRate
    ? `${(riskFreeRate.value * 100).toFixed(2)}% risk-free rate (${riskFreeRate.source})`
    : "an assumed 4% risk-free rate";
  return (
    <Panel
      title="Risk"
      subtitle={`One year of daily returns, annualised over 252 sessions. Sharpe and Sortino use ${rate}.`}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Sharpe"
          value={formatRatio(risk.sharpeRatio)}
          hint="Excess return per unit of volatility"
        />
        <Stat
          label="Sortino"
          value={formatRatio(risk.sortinoRatio)}
          hint="Same, counting only downside moves"
        />
        <Stat
          label="Volatility"
          value={formatPercent(risk.volatility)}
          hint="Annualised standard deviation"
        />
        <Stat
          label="Max drawdown"
          value={formatPercent(risk.maxDrawdown)}
          hint="Worst fall from a prior peak"
        />
        <Stat
          label="VaR 95% (1 day)"
          value={formatPercent(risk.var95)}
          hint="Loss exceeded on the worst 5% of days"
        />
        <Stat
          label="CVaR 95% (1 day)"
          value={formatPercent(risk.cvar95)}
          hint="Average loss on those days"
        />
        <Stat
          label="Calmar"
          value={formatRatio(risk.calmarRatio)}
          hint="Annual return over max drawdown"
        />
        <Stat
          label="Beta"
          value={formatRatio(risk.beta)}
          hint="Sensitivity to the market"
        />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Analysts and insiders                                               */
/* ------------------------------------------------------------------ */

export function AnalystCard({
  analysts,
}: {
  analysts: AnalystConsensus | null;
}) {
  if (!analysts) return null;
  const rows: { label: string; count: number; color: string }[] = [
    { label: "Strong buy", count: analysts.strongBuy, color: "bg-emerald-500" },
    { label: "Buy", count: analysts.buy, color: "bg-emerald-700" },
    { label: "Hold", count: analysts.hold, color: "bg-gray-500" },
    { label: "Sell", count: analysts.sell, color: "bg-red-700" },
    { label: "Strong sell", count: analysts.strongSell, color: "bg-red-500" },
  ];
  return (
    <Panel
      title="Analyst consensus"
      subtitle={`${analysts.total} sell-side ratings, ${analysts.period.slice(0, 7)}`}
    >
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[90px_1fr_32px] items-center gap-3 text-sm"
          >
            <span className="text-gray-400">{row.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-gray-800">
              <div
                className={`h-full rounded-full ${row.color}`}
                style={{ width: `${(row.count / analysts.total) * 100}%` }}
              />
            </div>
            <span className="text-right font-mono text-gray-200">
              {row.count}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function InsiderCard({ trades }: { trades: InsiderTransaction[] }) {
  if (trades.length === 0) return null;
  return (
    <Panel
      title="Insider transactions"
      subtitle="Open-market buys and sells from SEC Form 4 filings, newest first"
    >
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Insider</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Shares</th>
              <th className="px-3 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {trades.map((t, i) => (
              <tr
                key={`${t.date}-${t.name}-${i}`}
                className="hover:bg-gray-800/30"
              >
                <td className="px-3 py-2 font-mono text-gray-400">{t.date}</td>
                <td className="px-3 py-2 text-gray-200">{t.name}</td>
                <td
                  className={`px-3 py-2 font-semibold ${
                    t.transactionType === "Buy"
                      ? "text-emerald-400"
                      : "text-red-400"
                  }`}
                >
                  {t.transactionType}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-300">
                  {formatNumber(t.shares)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-300">
                  {formatNumber(t.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
