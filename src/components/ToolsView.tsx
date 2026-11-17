"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { projectSip, requiredSip } from "@/lib/sip";
import { formatMoney, Panel, Tile } from "@/components/ui/primitives";

function NumberField({
  label,
  value,
  onChange,
  suffix,
  min = 0,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  min?: number;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-400">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-gray-700 bg-gray-950 focus-within:border-emerald-500">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-transparent px-3 py-2 font-mono text-sm text-gray-100 outline-none"
        />
        {suffix && <span className="pr-3 text-xs text-gray-500">{suffix}</span>}
      </div>
    </label>
  );
}

function compact(value: number): string {
  if (value >= 1e7) return `${(value / 1e7).toFixed(1)} Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(1)} L`;
  return value.toFixed(0);
}

export function ToolsView() {
  const [monthly, setMonthly] = useState(10000);
  const [rate, setRate] = useState(12);
  const [years, setYears] = useState(15);
  const [stepUp, setStepUp] = useState(0);
  const [target, setTarget] = useState(10_000_000);

  const safeYears = Math.min(50, Math.max(1, Math.round(years) || 1));
  const sip = projectSip(Math.max(0, monthly), rate / 100, safeYears, stepUp / 100);
  const needed = requiredSip(Math.max(0, target), rate / 100, safeYears);

  return (
    <div className="space-y-6">
      <Panel
        title="SIP calculator"
        subtitle="Monthly contributions made at the start of each month, compounding monthly at a constant assumed return."
      >
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <NumberField label="Monthly investment" value={monthly} onChange={setMonthly} suffix="₹" step={500} />
            <NumberField label="Expected annual return" value={rate} onChange={setRate} suffix="%" step={0.5} />
            <NumberField label="Years" value={years} onChange={setYears} min={1} />
            <NumberField label="Yearly step-up" value={stepUp} onChange={setStepUp} suffix="%" />
          </div>
          <div>
            <div className="grid grid-cols-3 gap-3">
              <Tile label="Invested" value={formatMoney(sip.totalInvested, "INR")} />
              <Tile label="Projected value" value={formatMoney(sip.projectedValue, "INR")} />
              <Tile label="Gains" value={formatMoney(sip.totalGains, "INR")} tone={sip.totalGains} />
            </div>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sip.yearlyBreakdown} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#1f2937" vertical={false} />
                  <XAxis
                    dataKey="year"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "#374151" }}
                  />
                  <YAxis
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickFormatter={(v: number) => compact(v)}
                    width={56}
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
                    labelFormatter={(year) => `Year ${year}`}
                    formatter={(value, name) => [
                      formatMoney(Number(value), "INR"),
                      name === "value" ? "Value" : "Invested",
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#34d399"
                    fill="#34d399"
                    fillOpacity={0.2}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="invested"
                    stroke="#6b7280"
                    fill="#6b7280"
                    fillOpacity={0.25}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Goal planner"
        subtitle={`Monthly SIP needed to reach a target in ${safeYears} years at ${rate}% a year, with no step-up.`}
      >
        <div className="grid gap-6 sm:grid-cols-[320px_1fr] sm:items-end">
          <NumberField label="Target amount" value={target} onChange={setTarget} suffix="₹" step={100000} />
          <Tile label="Required monthly SIP" value={formatMoney(needed, "INR")} />
        </div>
      </Panel>

      <p className="text-xs text-gray-600">
        Projections assume a constant return every month. Real returns vary year to year and
        can be negative; treat these as arithmetic, not forecasts.
      </p>
    </div>
  );
}
