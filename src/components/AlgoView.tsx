"use client";

/**
 * Algo — paper-trading bots.
 *
 * Create a bot (a strategy, some stocks, virtual capital and a start date); it
 * replays that strategy over live prices and shows the equity curve against
 * buy-and-hold, the open positions, and every simulated trade. No real money
 * and no orders are placed: this is a live forward-test, the honest way to see
 * whether a rule holds up.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { APIResponse } from "@/types/stock";
import type { AlgoRouteData } from "@/app/api/algo/route";
import type { BotConfig, BotResult } from "@/algo/engine";
import { STRATEGIES, type StrategyId } from "@/analysis/backtest";
import { useLocalStorage } from "@/lib/useLocalStorage";
import {
  formatChange,
  formatMoney,
  Panel,
  SampleBadge,
  Tile,
  toneClass,
} from "@/components/ui/primitives";

const DEFAULT_BOTS: BotConfig[] = [
  {
    id: "demo-trend",
    name: "Nifty trend-follower",
    strategy: "sma-cross",
    symbols: ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS"],
    startingCapital: 100000,
    startDate: "2023-01-01",
    costBps: 20,
  },
];

const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/* ------------------------------------------------------------------ */
/* Bot builder                                                         */
/* ------------------------------------------------------------------ */

function BotBuilder({ onCreate }: { onCreate: (bot: BotConfig) => void }) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<StrategyId>("sma-cross");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [capital, setCapital] = useState(100000);
  const [startDate, setStartDate] = useState("2023-01-01");

  const addSymbol = () => {
    const s = draft.trim().toUpperCase();
    if (/^[A-Z0-9.^=&-]{1,20}$/.test(s) && !symbols.includes(s) && symbols.length < 20) {
      setSymbols([...symbols, s]);
    }
    setDraft("");
  };

  const create = () => {
    if (symbols.length === 0) return;
    onCreate({
      id: `bot-${Date.now()}`,
      name: name.trim() || `${STRATEGIES[strategy].label} bot`,
      strategy,
      symbols,
      startingCapital: Math.max(1000, capital),
      startDate,
      costBps: 20,
    });
    setName("");
    setSymbols([]);
  };

  return (
    <Panel
      title="New bot"
      subtitle="Pick a rule, the stocks it trades, how much virtual money it starts with, and when it begins."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-400">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My trend bot"
              className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
            />
          </label>

          <div>
            <span className="text-xs text-gray-400">Strategy</span>
            <div className="mt-1 space-y-1.5">
              {STRATEGY_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setStrategy(id)}
                  className={`block w-full rounded-md border px-3 py-2 text-left text-sm ${
                    strategy === id ? "border-emerald-500 bg-emerald-500/10" : "border-gray-700 hover:border-gray-500"
                  }`}
                >
                  <span className="font-medium text-gray-100">{STRATEGIES[id].label}</span>
                  <span className="block text-xs text-gray-500">{STRATEGIES[id].rule}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <span className="text-xs text-gray-400">Stocks</span>
            <form
              onSubmit={(e) => { e.preventDefault(); addSymbol(); }}
              className="mt-1 flex gap-2"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="RELIANCE.NS, AAPL…"
                className="flex-1 rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
              />
              <button type="submit" className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-gray-950">
                Add
              </button>
            </form>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {symbols.map((s) => (
                <span key={s} className="flex items-center gap-1 rounded-full border border-gray-700 bg-gray-950 py-0.5 pl-2.5 pr-1 text-xs">
                  <span className="font-mono text-gray-200">{s}</span>
                  <button type="button" onClick={() => setSymbols(symbols.filter((x) => x !== s))} className="px-1 text-gray-500 hover:text-red-400">×</button>
                </span>
              ))}
              {symbols.length === 0 && <span className="text-xs text-gray-600">Add one or more tickers.</span>}
            </div>
            {symbols.some((s) => /\.(NS|BO)$/.test(s)) && symbols.some((s) => !/\.(NS|BO)$/.test(s)) && (
              <p className="mt-1.5 text-xs text-amber-400">
                Looks like you&apos;re mixing Indian (.NS/.BO) and other tickers. A bot holds one
                currency — keep each bot to a single market.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400">Starting capital</span>
              <input
                type="number"
                value={capital}
                min={1000}
                step={10000}
                onChange={(e) => setCapital(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Start date</span>
              <input
                type="date"
                value={startDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 outline-none focus:border-emerald-500"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={create}
            disabled={symbols.length === 0}
            className="w-full rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-gray-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            Launch paper bot
          </button>
          <p className="text-xs text-gray-500">
            Virtual money only — no orders are placed. The bot replays its rule over real daily
            prices from the start date to today.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Bot card                                                            */
/* ------------------------------------------------------------------ */

function BotCard({
  result,
  onRemove,
  onAnalyze,
}: {
  result: BotResult;
  onRemove: () => void;
  onAnalyze: (symbol: string) => void;
}) {
  const [tab, setTab] = useState<"curve" | "positions" | "trades">("curve");
  const { config, stats, currency } = result;
  const money = (v: number | null | undefined, digits = 0) => formatMoney(v, currency || "USD", digits);
  const beat = result.totalReturn - result.benchmarkReturn;

  const curve = useMemo(
    () => result.equityCurve.map((p) => ({ date: p.date, Bot: Math.round(p.equity), "Buy & hold": Math.round(p.benchmark) })),
    [result.equityCurve],
  );

  return (
    <Panel
      title={config.name}
      subtitle={`${STRATEGIES[config.strategy].label} · ${config.symbols.join(", ")} · since ${result.from}`}
      action={
        <button type="button" onClick={onRemove} className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 hover:border-red-500 hover:text-red-300">
          Delete
        </button>
      }
    >
      {result.warning && (
        <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {result.warning}
        </p>
      )}
      {result.equityCurve.length === 0 ? (
        <p className="text-sm text-amber-300">
          Not enough price history to run this bot
          {result.skipped.length > 0 ? ` (no usable data for ${result.skipped.join(", ")})` : ""}.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Equity" value={money(result.equity)} sub={`from ${money(config.startingCapital)}`} />
            <Tile label="Total return" value={pct(result.totalReturn)} tone={result.totalReturn} />
            <Tile label="vs buy & hold" value={`${beat >= 0 ? "+" : ""}${(beat * 100).toFixed(1)} pts`} tone={beat} />
            <Tile label="Day change" value={formatChange(result.dayChange)} tone={result.dayChange} />
          </div>

          <div className="mt-4 flex gap-2">
            {(["curve", "positions", "trades"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md border px-3 py-1 text-sm capitalize ${
                  tab === t ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-gray-700 text-gray-400 hover:text-gray-200"
                }`}
              >
                {t === "curve" ? "Performance" : t === "positions" ? `Positions (${result.positions.length})` : `Trades (${result.trades.length})`}
              </button>
            ))}
          </div>

          {tab === "curve" && (
            <div className="mt-4">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={curve} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#1f2937" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 11 }} tickFormatter={(d: string) => d.slice(0, 7)} minTickGap={70} tickLine={false} axisLine={{ stroke: "#374151" }} />
                    <YAxis domain={["auto", "auto"]} tick={{ fill: "#6b7280", fontSize: 11 }} tickFormatter={(v: number) => money(v)} width={70} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "#030712", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#9ca3af" }} formatter={(v) => money(Number(v))} />
                    <Line type="monotone" dataKey="Buy & hold" stroke="#6b7280" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="Bot" stroke="#34d399" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Tile label="CAGR" value={pct(stats.cagr)} tone={stats.cagr} />
                <Tile label="Max drawdown" value={pct(stats.maxDrawdown)} />
                <Tile label="Sharpe" value={stats.sharpe === null ? "—" : stats.sharpe.toFixed(2)} />
                <Tile label="Win rate" value={pct(stats.winRate)} />
                <Tile label="Time invested" value={pct(stats.exposure)} />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                <span className="text-emerald-400">━</span> Bot ·{" "}
                <span className="text-gray-400">━</span> Buy &amp; hold of the same stocks ·{" "}
                {stats.tradeCount} completed trades. Each fill costs {(config.costBps ?? 20) / 100}%.
              </p>
            </div>
          )}

          {tab === "positions" && (
            <div className="mt-4">
              {result.positions.length === 0 ? (
                <p className="text-sm text-gray-500">No open positions — the bot is fully in cash ({money(result.cash)}).</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                      <th className="px-2 py-2 font-medium">Stock</th>
                      <th className="px-2 py-2 text-right font-medium">Shares</th>
                      <th className="px-2 py-2 text-right font-medium">Avg entry</th>
                      <th className="px-2 py-2 text-right font-medium">Last</th>
                      <th className="px-2 py-2 text-right font-medium">Value</th>
                      <th className="px-2 py-2 text-right font-medium">Unrealised</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {result.positions.map((p) => (
                      <tr key={p.symbol} className="hover:bg-gray-800/30">
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => onAnalyze(p.symbol)} className="font-mono font-semibold text-emerald-400 hover:underline">
                            {p.symbol.replace(/\.NS$/, "")}
                          </button>
                          <span className="block text-xs text-gray-500">since {p.since}</span>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">{p.shares}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">{money(p.avgEntry, 2)}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-100">{money(p.lastClose, 2)}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-100">{money(p.value)}</td>
                        <td className={`px-2 py-2 text-right font-mono ${toneClass(p.unrealisedPnl)}`}>
                          {money(p.unrealisedPnl)}
                          <span className="block text-xs">{formatChange(p.unrealisedPct)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-gray-500">Cash: {money(result.cash)}</p>
            </div>
          )}

          {tab === "trades" && (
            <div className="mt-4 max-h-96 overflow-auto">
              {result.trades.length === 0 ? (
                <p className="text-sm text-gray-500">No trades yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                      <th className="px-2 py-2 font-medium">Date</th>
                      <th className="px-2 py-2 font-medium">Stock</th>
                      <th className="px-2 py-2 font-medium">Side</th>
                      <th className="px-2 py-2 text-right font-medium">Shares</th>
                      <th className="px-2 py-2 text-right font-medium">Price</th>
                      <th className="px-2 py-2 text-right font-medium">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {result.trades.map((t, i) => (
                      <tr key={`${t.date}-${t.symbol}-${i}`} className="hover:bg-gray-800/30">
                        <td className="px-2 py-2 font-mono text-gray-400">{t.date}</td>
                        <td className="px-2 py-2 font-mono text-gray-200">{t.symbol.replace(/\.NS$/, "")}</td>
                        <td className={`px-2 py-2 font-semibold ${t.side === "BUY" ? "text-emerald-400" : "text-red-400"}`}>{t.side}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">{t.shares}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">{money(t.price, 2)}</td>
                        <td className={`px-2 py-2 text-right font-mono ${t.realised === null ? "text-gray-600" : toneClass(t.realised)}`}>
                          {t.realised === null ? "—" : money(t.realised)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function AlgoView({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [bots, setBots] = useLocalStorage<BotConfig[]>("quantiq.bots", DEFAULT_BOTS);
  const [data, setData] = useState<AlgoRouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payload = JSON.stringify(bots);
  const firstLoad = useRef(true);

  useEffect(() => {
    if (bots.length === 0) return;
    const controller = new AbortController();
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/algo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        const body: APIResponse<AlgoRouteData> = await res.json();
        if (body.success) { setData(body.data); setError(null); }
        else setError(body.error);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Could not reach the algo API.");
      } finally {
        setLoading(false);
        firstLoad.current = false;
      }
    };
    void run();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const byId = new Map((data?.results ?? []).map((r) => [r.config.id, r]));

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-emerald-950/30 p-5">
        <h1 className="text-2xl font-bold tracking-tight text-white">Algo <span className="text-emerald-400">bots</span></h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-400">
          Paper-trading bots that run a strategy on live prices with virtual money. No real orders
          are placed. Running a rule forward on real data — not just backtesting it — is the honest
          test of whether it works, because a backtest can always be overfit to the past.
        </p>
        {data?.sampleData && <div className="mt-3"><SampleBadge /></div>}
      </section>

      <BotBuilder onCreate={(bot) => setBots((list) => [...list, bot].slice(0, 12))} />

      {error && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</p>}

      {bots.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">
          No bots yet. Create one above to see how a strategy would have traded.
        </p>
      ) : loading && !data ? (
        <div className="h-96 animate-pulse rounded-xl bg-gray-900" />
      ) : (
        bots.map((bot) => {
          const result = byId.get(bot.id);
          return result ? (
            <BotCard key={bot.id} result={result} onRemove={() => setBots((list) => list.filter((b) => b.id !== bot.id))} onAnalyze={onAnalyze} />
          ) : (
            <div key={bot.id} className="h-40 animate-pulse rounded-xl bg-gray-900" />
          );
        })
      )}

      <p className="text-xs text-gray-600">
        A paper record is a simulation, not a promise. It fills at the daily close and models
        slippage and taxes only as a flat per-trade cost; it ignores dividends, intraday moves and
        liquidity. Treat it as a way to learn how a rule behaves, not as a signal to trade real money.
      </p>
    </div>
  );
}
