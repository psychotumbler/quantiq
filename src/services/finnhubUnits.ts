/**
 * Finnhub unit conversions — the one place Finnhub's scales are decoded.
 *
 * Finnhub returns **mixed units inside a single response**, and every one of
 * them is a plausible-looking number in the wrong scale. Nothing here is taken
 * from the documentation; each conversion below is pinned to an observed value
 * from `.scratch/finnhub-probe-results.json` (AAPL, 2026-11-15), and the tests
 * re-derive them arithmetically.
 *
 * ## `/stock/profile2` — values are in MILLIONS
 *
 * Observed for AAPL:
 *
 *     marketCapitalization : 5177380.424341398
 *     shareOutstanding     : 14594.18
 *
 * Neither is an absolute count. The proof is internal to the payload:
 *
 *     5177380.424341398 / 14594.18 = 354.76
 *
 * and `/quote` for the same symbol reported `pc` (previous close) **354.88**.
 * Market cap divided by share count must equal price per share, and it does —
 * to 0.03% — only if **both** are in millions. So `marketCapitalization` is
 * millions of the profile's `currency` (here USD 5.177 trillion) and
 * `shareOutstanding` is millions of shares (14.59 billion).
 *
 * **Why this matters more than the usual unit nit:** these two feed `fcfYield`
 * (FCF / market cap) and the Altman Z-Score's X4 term (market equity / total
 * liabilities), while free cash flow and total liabilities arrive from
 * `/stock/financials-reported` as **absolute** currency units. Mixing the two
 * scales understates `fcfYield` by 1e6 and overstates X4 by the same factor —
 * six orders of magnitude, with both results still rendering as ordinary
 * numbers. A Z-Score would simply come out enormous and be read as "very
 * safe".
 *
 * ## `/stock/metric` — units differ PER KEY
 *
 * 133 keys came back for AAPL, and they do not share a convention:
 *
 * | Key | Observed | Unit |
 * |---|---|---|
 * | `grossMarginTTM` | 48.79 | **percent** |
 * | `roeTTM` | 127.61 | **percent** |
 * | `dividendYieldIndicatedAnnual` | 0.50534 | **percent** (0.5%, not 50%) |
 * | `totalDebt/totalEquityAnnual` | 0.7277 | **plain ratio** |
 * | `netInterestCoverageTTM` | 622.5082 | **plain multiple** |
 * | `beta` | 1.0899 | **plain** |
 *
 * `FundamentalMetrics` uses decimal fractions for margins and yields, so the
 * percent keys need dividing by 100 and the ratio keys must be left alone.
 * `dividendYieldIndicatedAnnual` is the nastiest: 0.50534 is already small
 * enough to pass for a fraction, and treating it as one would report a 50.5%
 * dividend yield for a stock that pays 0.5%.
 */

/** Finnhub's profile figures are quoted in millions. */
export const FINNHUB_PROFILE_SCALE = 1_000_000;

/** Reject anything that cannot be used in arithmetic. */
function usable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Absolute market capitalisation from `/stock/profile2`.
 *
 * Input is **millions of the profile currency**; the result is in whole
 * currency units, matching `/stock/financials-reported`.
 */
export function marketCapFromProfile(raw: unknown): number | null {
  const value = usable(raw);
  // 0 means "not reported" here, not a company worth nothing.
  if (value === null || value === 0) return null;
  return value * FINNHUB_PROFILE_SCALE;
}

/**
 * Absolute shares outstanding from `/stock/profile2`.
 *
 * Input is **millions of shares**; the result is a share count, so it can be
 * divided into an absolute free cash flow for `fcfPerShare`.
 */
export function sharesFromProfile(raw: unknown): number | null {
  const value = usable(raw);
  if (value === null || value === 0) return null;
  return value * FINNHUB_PROFILE_SCALE;
}

/**
 * Decimal fraction from a Finnhub percent value: `48.79` becomes `0.4879`.
 *
 * Use for every key marked **percent** in `METRIC_UNITS`. A genuine `0` is
 * preserved — a zero margin is a real datum.
 */
export function fractionFromPercent(raw: unknown): number | null {
  const value = usable(raw);
  return value === null ? null : value / 100;
}

/**
 * A value already in the unit we want, passed through unchanged.
 *
 * Exists so that "this key needs no conversion" is an explicit, greppable
 * decision in `METRIC_UNITS` rather than an omission that cannot be told
 * apart from an oversight.
 */
export function asIs(raw: unknown): number | null {
  return usable(raw);
}

/** How a `/stock/metric` value must be interpreted. */
export type MetricUnit = "percent" | "ratio" | "currency" | "plain";

/**
 * Unit for each `/stock/metric` key the analysis layer reads.
 *
 * Confirmed present and non-zero for AAPL in the probe run. Extend only from
 * observed output — an unlisted key must not be assumed to be a fraction.
 */
export const METRIC_UNITS = {
  // --- percent: divide by 100 for FundamentalMetrics ---
  grossMarginTTM: "percent",
  operatingMarginTTM: "percent",
  netProfitMarginTTM: "percent",
  roeTTM: "percent",
  roaTTM: "percent",
  roiTTM: "percent",
  dividendYieldIndicatedAnnual: "percent",
  // --- already ratios/multiples: do NOT divide ---
  "totalDebt/totalEquityAnnual": "ratio",
  currentRatioAnnual: "ratio",
  quickRatioAnnual: "ratio",
  netInterestCoverageTTM: "ratio",
  peBasicExclExtraTTM: "ratio",
  pbAnnual: "ratio",
  psTTM: "ratio",
  // --- plain numbers and prices ---
  beta: "plain",
  "52WeekHigh": "currency",
  "52WeekLow": "currency",
} as const satisfies Record<string, MetricUnit>;

/** A `/stock/metric` key with a confirmed unit. */
export type KnownMetricKey = keyof typeof METRIC_UNITS;

/**
 * Read a `/stock/metric` value and convert it by its declared unit.
 *
 * Going through this rather than reading `metric[key]` directly is what
 * prevents a percent key being treated as a fraction. Percent keys become
 * decimal fractions; everything else passes through.
 */
export function readMetric(
  metric: Record<string, unknown> | null | undefined,
  key: KnownMetricKey,
): number | null {
  if (!metric) return null;
  const unit: MetricUnit = METRIC_UNITS[key];
  return unit === "percent"
    ? fractionFromPercent(metric[key])
    : asIs(metric[key]);
}
