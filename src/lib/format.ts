/**
 * Display formatters.
 *
 * Shared by every view, so a figure is never formatted two different ways in
 * two different cards. All of them are total: `null`, `undefined`, `NaN` and
 * `Infinity` render as `"N/A"` rather than leaking into the UI.
 */

export const NA = "N/A";

/** True only for a real, finite number. */
function isUsable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** Compact magnitude with a T/B/M/K suffix. Negatives keep their sign. */
export function formatNumber(value: number | null | undefined): string {
  if (!isUsable(value)) return NA;

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];

  for (const [size, suffix] of units) {
    if (abs >= size) return `${sign}${(abs / size).toFixed(2)}${suffix}`;
  }
  return `${sign}${abs.toFixed(2)}`;
}

/**
 * Render a decimal fraction as a percentage: `0.4213` becomes `"42.13%"`.
 * Providers report margins, yields and daily change as fractions.
 */
export function formatPercent(value: number | null | undefined): string {
  return isUsable(value) ? `${(value * 100).toFixed(2)}%` : NA;
}

/** Plain two-decimal ratio, for P/E, beta, current ratio and friends. */
export function formatRatio(value: number | null | undefined): string {
  return isUsable(value) ? value.toFixed(2) : NA;
}

/** `₹` for Indian listings, `$` otherwise. */
export function currencySymbol(currency: string): string {
  return currency?.toUpperCase() === "INR" ? "₹" : "$";
}

/** Price with a thousands-separated mantissa and its currency symbol. */
export function formatPrice(
  value: number | null | undefined,
  currency: string,
): string {
  if (!isUsable(value)) return NA;
  return `${currencySymbol(currency)}${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Tailwind text colour for a signed value. */
export function changeColor(value: number | null | undefined): string {
  if (!isUsable(value)) return "text-gray-400";
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-gray-400";
}

/** A signed value with an explicit `+` when positive. */
export function withSign(value: number | null | undefined): string {
  if (!isUsable(value)) return NA;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** Fiscal period end date reduced to its year label. */
export function fiscalYear(date: string): string {
  return date ? date.slice(0, 4) : NA;
}
