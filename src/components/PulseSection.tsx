"use client";

/**
 * Market pulse: sector heatmaps, breadth, top movers and institutional flows.
 */

import { useEffect, useState } from "react";
import type { APIResponse } from "@/types/stock";
import type { PulseRouteData } from "@/app/api/pulse/route";
import type { SectorQuote } from "@/services/market";
import { formatChange, Panel, toneClass } from "@/components/ui/primitives";

/** Heatmap colour for a day's move: ±2% saturates. */
function heat(change: number | null): React.CSSProperties {
  if (change === null) return { backgroundColor: "#111827" };
  const t = Math.min(1, Math.abs(change) / 0.02);
  return {
    backgroundColor:
      change >= 0
        ? `rgba(16, 185, 129, ${0.12 + t * 0.6})`
        : `rgba(239, 68, 68, ${0.12 + t * 0.6})`,
  };
}

type Horizon = "change" | "change30d" | "change1y";

function Heatmap({
  sectors,
  horizon,
}: {
  sectors: SectorQuote[];
  horizon: Horizon;
}) {
  // The colour scale is per-day; stretch it for longer windows.
  const scale = horizon === "change" ? 1 : horizon === "change30d" ? 4 : 10;
  const sorted = [...sectors]
    .filter((s) => s[horizon] !== null)
    .sort((a, b) => (b[horizon] ?? 0) - (a[horizon] ?? 0));
  if (sorted.length === 0) return <p className="text-sm text-gray-500">Not available for this window.</p>;
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
      {sorted.map((s) => {
        const v = s[horizon];
        return (
          <div
            key={s.name}
            style={heat(v === null ? null : v / scale)}
            className="rounded-md border border-black/20 px-2.5 py-2"
            title={s.pe ? `P/E ${s.pe.toFixed(1)}` : undefined}
          >
            <p className="truncate text-xs font-medium text-gray-100">{s.name}</p>
            <p className="font-mono text-sm font-semibold text-white">{formatChange(v)}</p>
          </div>
        );
      })}
    </div>
  );
}

function HorizonToggle({
  value,
  onChange,
  options,
}: {
  value: Horizon;
  onChange: (h: Horizon) => void;
  options: [Horizon, string][];
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-gray-700 text-xs">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`px-2.5 py-1 ${value === id ? "bg-emerald-500 font-semibold text-gray-950" : "text-gray-400"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function PulseSection({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [data, setData] = useState<PulseRouteData | null | undefined>(undefined);
  const [inHorizon, setInHorizon] = useState<Horizon>("change");
  const [usHorizon, setUsHorizon] = useState<Horizon>("change");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/pulse");
        const body: APIResponse<PulseRouteData> = await res.json();
        if (!cancelled) setData(body.success ? body.data : null);
      } catch {
        if (!cancelled) setData(null);
      }
    }
    void load();
    const timer = setInterval(load, 3 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (data === undefined) {
    return <div className="h-64 animate-pulse rounded-xl bg-gray-900" />;
  }
  if (data === null) {
    return <p className="text-sm text-gray-500">Market pulse is unavailable right now.</p>;
  }

  const india = data.india;
  const breadth = india?.breadth;
  const totalBreadth = breadth ? breadth.advances + breadth.declines + breadth.unchanged : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="India sectors"
          subtitle={india?.asOf ? `NSE sectoral indices · ${new Date(india.asOf).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST` : "NSE sectoral indices"}
          action={
            <HorizonToggle
              value={inHorizon}
              onChange={setInHorizon}
              options={[["change", "1D"], ["change30d", "1M"], ["change1y", "1Y"]]}
            />
          }
        >
          {india ? <Heatmap sectors={india.sectors} horizon={inHorizon} /> : (
            <p className="text-sm text-gray-500">NSE data is unavailable right now.</p>
          )}
        </Panel>
        <Panel
          title="US sectors"
          subtitle="SPDR sector ETFs"
          action={
            <HorizonToggle
              value={usHorizon === "change1y" ? "change" : usHorizon}
              onChange={setUsHorizon}
              options={[["change", "1D"], ["change30d", "1M"]]}
            />
          }
        >
          <Heatmap sectors={data.usSectors} horizon={usHorizon} />
        </Panel>
      </div>

      {india && (
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
          <Panel title="Market breadth" subtitle="All NSE securities today">
            {breadth ? (
              <>
                <div className="flex h-3 overflow-hidden rounded-full bg-gray-800">
                  <div className="bg-emerald-500" style={{ width: `${(breadth.advances / totalBreadth) * 100}%` }} />
                  <div className="bg-gray-600" style={{ width: `${(breadth.unchanged / totalBreadth) * 100}%` }} />
                  <div className="bg-red-500" style={{ width: `${(breadth.declines / totalBreadth) * 100}%` }} />
                </div>
                <div className="mt-3 flex justify-between font-mono text-sm">
                  <span className="text-emerald-400">▲ {breadth.advances.toLocaleString("en-IN")}</span>
                  <span className="text-red-400">▼ {breadth.declines.toLocaleString("en-IN")}</span>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Advance/decline ratio {(breadth.advances / Math.max(1, breadth.declines)).toFixed(2)}.
                  Above 1 means most stocks rose, whatever the index did.
                </p>
              </>
            ) : <p className="text-sm text-gray-500">Unavailable.</p>}
            {india.valuation && (
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-800 pt-3 text-center">
                {[["Nifty P/E", india.valuation.pe], ["P/B", india.valuation.pb], ["Div. yield", india.valuation.dividendYield]].map(([label, v]) => (
                  <div key={String(label)}>
                    <p className="text-[11px] text-gray-500">{label}</p>
                    <p className="font-mono text-sm text-white">{v === null ? "—" : `${Number(v).toFixed(2)}${label === "Div. yield" ? "%" : ""}`}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {[["Top gainers", india.gainers], ["Top losers", india.losers]].map(([title, list]) => (
            <Panel key={String(title)} title={String(title)} subtitle="Nifty 50 constituents">
              {(list as typeof india.gainers).length === 0 ? (
                <p className="text-sm text-gray-500">Unavailable.</p>
              ) : (
                <ul className="space-y-1.5">
                  {(list as typeof india.gainers).slice(0, 6).map((m) => (
                    <li key={m.symbol} className="flex items-center justify-between gap-2">
                      <button type="button" onClick={() => onAnalyze(m.symbol)} className="font-mono text-sm text-gray-200 hover:text-emerald-300">
                        {m.symbol.replace(/\.NS$/, "")}
                      </button>
                      <span className="font-mono text-xs text-gray-400">₹{m.price?.toLocaleString("en-IN")}</span>
                      <span className={`w-16 text-right font-mono text-sm ${toneClass(m.change)}`}>{formatChange(m.change)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ))}

          <Panel title="Institutional flows" subtitle="Cash market, ₹ crore, last session">
            {india.flows.length === 0 ? (
              <p className="text-sm text-gray-500">Unavailable.</p>
            ) : (
              <ul className="space-y-3">
                {india.flows.map((f) => (
                  <li key={f.category}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium text-gray-200">{f.category === "DII" ? "Domestic institutions" : "Foreign investors"}</span>
                      <span className={`font-mono text-sm font-semibold ${toneClass(f.net)}`}>
                        {f.net !== null && f.net > 0 ? "+" : ""}{f.net?.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Bought {f.buy?.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · sold {f.sell?.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · {f.date}
                    </p>
                  </li>
                ))}
                <p className="text-xs text-gray-500">
                  Net buying by foreign investors is often read as support for the market; domestic
                  funds frequently take the other side.
                </p>
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
