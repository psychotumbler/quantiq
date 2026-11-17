"use client";

/** Small shared building blocks for the dashboard views. */

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-gray-800 bg-gray-900 p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Green for gains, red for losses, grey for flat or unknown. */
export function toneClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "text-gray-400";
  return value > 0 ? "text-emerald-400" : "text-red-400";
}

/** A level with sensible precision for its size: 24,850.30 / 86.41 / 1.0612. */
export function formatLevel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Signed percent from a decimal fraction: 0.0123 → "+1.23%". */
export function formatChange(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  return `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(2)}%`;
}

/** Money with a currency symbol and Indian or Western digit grouping. */
export function formatMoney(
  value: number | null | undefined,
  currency: string,
  digits = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const inr = currency === "INR";
  const body = Math.abs(value).toLocaleString(inr ? "en-IN" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value < 0 ? "−" : ""}${inr ? "₹" : "$"}${body}`;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="inline-block" style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={up ? "#34d399" : "#f87171"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: number | null;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-4">
      <p className="text-xs uppercase tracking-wider text-gray-500">{label}</p>
      <p
        className={`mt-1 font-mono text-xl font-semibold ${
          tone === undefined ? "text-white" : toneClass(tone)
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export function SampleBadge() {
  return (
    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
      Sample data
    </span>
  );
}
