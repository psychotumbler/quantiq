/**
 * Derived fundamentals (Phase 2c) — pure functions over reported statement
 * lines.
 *
 * No I/O and no provider coupling: everything takes a `FundamentalInputs`
 * record and returns `MetricResult`s, so it is deterministic and testable.
 *
 * ## Why these return `MetricResult`, not `number | null`
 *
 * These five metrics have between two and seven inputs each, and on non-US
 * listings any one of them can be absent. A `null` return cannot distinguish:
 *
 * - the provider reported a genuine zero,
 * - the provider reported nothing for this period,
 * - the line item is not reported for this market at all,
 * - the ratio is mathematically unbounded (zero interest expense, say).
 *
 * In a UI all four render identically, and the fourth — a company with no
 * interest expense, i.e. excellent health — would read as a coverage ratio of
 * zero, i.e. insolvency. So every metric here returns a discriminated union
 * carrying the reason. `collapseDerived` flattens to nullable numbers at the
 * edge, where the wire format demands it.
 *
 * Conventions:
 * - `roic` is a decimal fraction (0.18 = 18%), matching `FundamentalMetrics`.
 * - `fcfYield` is a decimal fraction.
 * - `interestCoverage` and `altmanZScore` are plain multiples/scores.
 * - Interest expense is reported positive by Yahoo; its sign is normalised.
 */

import type {
  DerivedFundamentals,
  FundamentalMetrics,
  Market,
  MetricResult,
  MetricUnavailable,
  MetricUnavailableReason,
} from "@/types/stock";

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

/**
 * The statement lines these metrics need, for one fiscal period.
 *
 * Every field is `number | null` because that is what the provider layer
 * produces; turning those nulls into *explained* unavailability is this
 * module's job.
 */
export interface FundamentalInputs {
  // Income statement
  ebit: number | null;
  pretaxIncome: number | null;
  taxProvision: number | null;
  interestExpense: number | null;
  revenue: number | null;
  // Balance sheet
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  retainedEarnings: number | null;
  workingCapital: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  // Cash flow
  freeCashFlow: number | null;
  shares: number | null;
}

/** Market context plus the live figures that some metrics require. */
export interface FundamentalContext {
  market: Market;
  /** Live market capitalisation. `null` makes price-dependent metrics `requires-quote`. */
  marketCap: number | null;
  /**
   * Markets the *active* provider does not cover, defaulting to
   * `MARKETS_WITHOUT_PROVIDER`.
   *
   * Overridable because coverage is a property of the provider in use, not of
   * the platform: the demoted `yahooProvider` nominally reaches every market,
   * so a local-dev run against it should not be told that Indian listings have
   * no provider. Pass `[]` to disable the check.
   */
  marketsWithoutProvider?: readonly Market[];
}

/** An all-null input record, for tests and for callers with nothing to supply. */
export function emptyInputs(): FundamentalInputs {
  return {
    ebit: null,
    pretaxIncome: null,
    taxProvision: null,
    interestExpense: null,
    revenue: null,
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: null,
    totalDebt: null,
    retainedEarnings: null,
    workingCapital: null,
    currentAssets: null,
    currentLiabilities: null,
    freeCashFlow: null,
    shares: null,
  };
}

/* ------------------------------------------------------------------ */
/* Market coverage                                                     */
/* ------------------------------------------------------------------ */

/**
 * Markets with **no configured data provider**, as of the Finnhub migration.
 *
 * This is a coarser statement than `MARKET_INPUT_GAPS`: it says nothing about
 * which line items exist, only that nothing is wired up to fetch them. A
 * metric for such a market returns `no-provider-for-market`, which tells the
 * UI to say "not covered yet" instead of implying a data quality problem with
 * a listing the platform never attempted to load.
 *
 * - **IN** — Finnhub's free tier does not serve Indian fundamentals or market
 *   data. Deliberately **not** papered over: Indian equities are deferred to a
 *   market-specific provider (NSE/BSE direct), which Phase 3 already needs for
 *   institutional flows and promoter holdings. See PROGRESS.md.
 * - **CN**, **EU** — no provider has ever been written for these. They are
 *   listed in the `Market` union for completeness, not because they work.
 *
 * `US` is absent from this list: it is the market the active provider covers.
 *
 * This reflects the **default** provider. `FundamentalContext.marketsWithoutProvider`
 * overrides it, because the demoted `yahooProvider` nominally reaches every
 * market. A `supportedMarkets` field on `DataProvider` would let the registry
 * supply this automatically — a worthwhile follow-up, not done here.
 */
export const MARKETS_WITHOUT_PROVIDER: readonly Market[] = ["IN", "CN", "EU"];

/* ------------------------------------------------------------------ */
/* Market input gaps                                                   */
/* ------------------------------------------------------------------ */

/**
 * Statement lines known **not** to be reported for a given market, so that a
 * missing value can be attributed to the market rather than to a transient
 * provider gap.
 *
 * ## Currently empty on purpose
 *
 * Filling this in requires a successful run of `scripts/probe-yahoo-types.mjs`
 * against both a US and an Indian listing. The run of 2026-11-14 returned
 * HTTP 429 for every request, so it established nothing: all 51 probed type
 * names were recorded as "dropped" for *both* symbols, which is the signature
 * of a rate-limited probe, not of a real divergence.
 *
 * Declaring a gap here on a guess would be worse than leaving it empty: a
 * wrongly-declared gap produces a confident "not reported in this market"
 * message for a line item that is in fact available, which is harder to
 * notice and harder to undo than a plain `missing-inputs`. Until the probe
 * runs clean, every absent input is honestly reported as `missing-inputs`.
 *
 * See PROGRESS.md for the specific divergences to check for first.
 */
export const MARKET_INPUT_GAPS: Readonly<
  Record<Market, readonly (keyof FundamentalInputs)[]>
> = {
  US: [],
  IN: [],
  CN: [],
  EU: [],
};

/* ------------------------------------------------------------------ */
/* Result helpers                                                      */
/* ------------------------------------------------------------------ */

function ok(value: number): MetricResult {
  return { status: "ok", value };
}

function unavailable(
  reason: MetricUnavailableReason,
  missing: string[],
  detail: string,
): MetricUnavailable {
  return { status: "unavailable", reason, missing, detail };
}

/** Human-readable market names for the `unavailable-for-market` detail line. */
const MARKET_NAMES: Record<Market, string> = {
  US: "US",
  IN: "Indian",
  CN: "Chinese",
  EU: "European",
};

/**
 * Check that every named input is present.
 *
 * Returns `null` when all are available, otherwise the `MetricUnavailable` to
 * return. An absent input that is a *declared* gap for this market is reported
 * as `unavailable-for-market` — a permanent condition the caller should not
 * retry — and anything else as `missing-inputs`.
 *
 * `gaps` is a parameter rather than a direct `MARKET_INPUT_GAPS` lookup so the
 * market-attribution path can be tested while the real table is still empty
 * (see `MARKET_INPUT_GAPS`). Production callers use the default.
 */
export function requireInputs(
  inputs: FundamentalInputs,
  market: Market,
  names: readonly (keyof FundamentalInputs)[],
  gaps: readonly (keyof FundamentalInputs)[] = MARKET_INPUT_GAPS[market] ?? [],
  marketsWithoutProvider: readonly Market[] = MARKETS_WITHOUT_PROVIDER,
): MetricUnavailable | null {
  const absent = names.filter((name) => inputs[name] === null);
  if (absent.length === 0) return null;

  // Coarsest explanation first: if nothing fetches this market, saying which
  // individual lines are missing would imply we tried and they were absent.
  if (marketsWithoutProvider.includes(market)) {
    return unavailable(
      "no-provider-for-market",
      absent.map(String),
      `No data provider is configured for ${MARKET_NAMES[market]} listings yet.`,
    );
  }

  const marketGaps = absent.filter((name) => gaps.includes(name));

  if (marketGaps.length > 0) {
    return unavailable(
      "unavailable-for-market",
      marketGaps.map(String),
      `Not reported for ${MARKET_NAMES[market]} listings: ${marketGaps.join(", ")}.`,
    );
  }

  return unavailable(
    "missing-inputs",
    absent.map(String),
    `The provider reported no value for: ${absent.join(", ")}.`,
  );
}

/**
 * `requireInputs` with the market gaps and provider coverage taken from a
 * `FundamentalContext`.
 *
 * Every metric goes through this rather than calling `requireInputs`
 * directly, so a context that overrides `marketsWithoutProvider` is honoured
 * everywhere instead of in whichever metric remembered to pass it.
 */
function requireFrom(
  inputs: FundamentalInputs,
  context: FundamentalContext,
  names: readonly (keyof FundamentalInputs)[],
): MetricUnavailable | null {
  return requireInputs(
    inputs,
    context.market,
    names,
    MARKET_INPUT_GAPS[context.market] ?? [],
    context.marketsWithoutProvider ?? MARKETS_WITHOUT_PROVIDER,
  );
}

/** Working capital, preferring the reported line and falling back to CA - CL. */
export function workingCapitalOf(inputs: FundamentalInputs): number | null {
  if (inputs.workingCapital !== null) return inputs.workingCapital;
  if (inputs.currentAssets === null || inputs.currentLiabilities === null) {
    return null;
  }
  return inputs.currentAssets - inputs.currentLiabilities;
}

/** Guard against a non-finite result slipping out of an otherwise valid division. */
function finite(value: number, detail: string): MetricResult {
  return Number.isFinite(value)
    ? ok(value)
    : unavailable("not-meaningful", [], detail);
}

/* ------------------------------------------------------------------ */
/* Metrics                                                            */
/* ------------------------------------------------------------------ */

/**
 * Effective tax rate, `taxProvision / pretaxIncome`, clamped to [0, 1].
 *
 * Clamping matters: a loss-making year gives a negative pretax income and a
 * ratio that can be negative or far above 1, which would flip the sign of
 * NOPAT. A rate outside [0, 1] is not a meaningful tax rate, so it is pinned
 * to the nearest bound rather than propagated.
 */
export function effectiveTaxRate(
  inputs: FundamentalInputs,
): number | null {
  const { pretaxIncome, taxProvision } = inputs;
  if (pretaxIncome === null || taxProvision === null) return null;
  if (pretaxIncome === 0) return null;
  const rate = taxProvision / pretaxIncome;
  if (!Number.isFinite(rate)) return null;
  return Math.min(1, Math.max(0, rate));
}

/**
 * Return on invested capital: `NOPAT / (total debt + total equity)`.
 *
 * NOPAT is `EBIT × (1 - effective tax rate)`. The tax rate is *required*, not
 * defaulted to zero: an untaxed NOPAT overstates ROIC by the full tax rate
 * (typically 20-30%), which is a large enough error to change an investment
 * read. Better to say "unavailable" than to publish a number that flattering.
 */
export function roic(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): MetricResult {
  const missing = requireFrom(inputs, context, [
    "ebit",
    "pretaxIncome",
    "taxProvision",
    "totalDebt",
    "totalEquity",
  ]);
  if (missing) return missing;

  const taxRate = effectiveTaxRate(inputs);
  if (taxRate === null) {
    return unavailable(
      "not-meaningful",
      ["pretaxIncome"],
      "Pretax income is zero, so no effective tax rate can be derived.",
    );
  }

  const investedCapital = inputs.totalDebt! + inputs.totalEquity!;
  if (investedCapital === 0) {
    return unavailable(
      "not-meaningful",
      [],
      "Invested capital (debt + equity) is zero.",
    );
  }

  const nopat = inputs.ebit! * (1 - taxRate);
  return finite(nopat / investedCapital, "ROIC is not finite.");
}

/**
 * Free cash flow yield: `free cash flow / market capitalisation`.
 *
 * A negative result is meaningful (cash-burning company) and is returned as a
 * value, not suppressed.
 */
export function fcfYield(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): MetricResult {
  const missing = requireFrom(inputs, context, ["freeCashFlow"]);
  if (missing) return missing;

  if (context.marketCap === null) {
    return unavailable(
      "requires-quote",
      ["marketCap"],
      "Needs a live market capitalisation, which was not supplied.",
    );
  }
  if (context.marketCap <= 0) {
    return unavailable(
      "not-meaningful",
      [],
      "Market capitalisation is zero or negative.",
    );
  }

  return finite(
    inputs.freeCashFlow! / context.marketCap,
    "FCF yield is not finite.",
  );
}

/** Free cash flow per share, on the weighted average share count. */
export function fcfPerShare(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): MetricResult {
  const missing = requireFrom(inputs, context, [
    "freeCashFlow",
    "shares",
  ]);
  if (missing) return missing;

  if (inputs.shares! === 0) {
    return unavailable("not-meaningful", [], "Share count is zero.");
  }

  return finite(
    inputs.freeCashFlow! / inputs.shares!,
    "FCF per share is not finite.",
  );
}

/**
 * Interest coverage: `EBIT / |interest expense|`.
 *
 * ### The zero-interest case
 *
 * A debt-free company reports no interest expense, so coverage is unbounded —
 * the strongest possible reading. Returning `null` for it (as the old flat
 * `number | null` shape did) renders in a UI as "—" at best and as a coverage
 * ratio of zero at worst, i.e. exactly backwards. It is therefore returned as
 * `not-meaningful` with an explicit detail line, so the UI can say so.
 */
export function interestCoverage(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): MetricResult {
  const missing = requireFrom(inputs, context, [
    "ebit",
    "interestExpense",
  ]);
  if (missing) return missing;

  const interest = Math.abs(inputs.interestExpense!);
  if (interest === 0) {
    return unavailable(
      "not-meaningful",
      [],
      "No interest expense reported, so interest coverage is unbounded — not zero.",
    );
  }

  return finite(inputs.ebit! / interest, "Interest coverage is not finite.");
}

/** The five Altman Z-Score factors, exposed for inspection and testing. */
export interface AltmanFactors {
  /** Working capital / total assets. */
  x1: number;
  /** Retained earnings / total assets. */
  x2: number;
  /** EBIT / total assets. */
  x3: number;
  /** Market value of equity / total liabilities. */
  x4: number;
  /** Revenue / total assets (asset turnover). */
  x5: number;
}

/** Altman's original coefficients for public manufacturers. */
const ALTMAN_WEIGHTS = { x1: 1.2, x2: 1.4, x3: 3.3, x4: 0.6, x5: 1.0 } as const;

/** Combine the five factors into the score. */
export function altmanFromFactors(f: AltmanFactors): number {
  return (
    ALTMAN_WEIGHTS.x1 * f.x1 +
    ALTMAN_WEIGHTS.x2 * f.x2 +
    ALTMAN_WEIGHTS.x3 * f.x3 +
    ALTMAN_WEIGHTS.x4 * f.x4 +
    ALTMAN_WEIGHTS.x5 * f.x5
  );
}

/**
 * Altman Z-Score, classic five-factor form:
 *
 * `Z = 1.2·X1 + 1.4·X2 + 3.3·X3 + 0.6·X4 + 1.0·X5`
 *
 * Interpretation (public manufacturers): above 2.99 is the "safe" zone, 1.81
 * to 2.99 the "grey" zone, below 1.81 the "distress" zone. The score is *not*
 * clamped — a distressed company legitimately scores negative.
 *
 * X4 uses the **market** value of equity, per the original model, so this
 * metric needs a live quote. Substituting book equity would be a different
 * model (the Z''-Score) with different coefficients and a different scale, so
 * it is not silently swapped in.
 */
export function altmanZScore(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): MetricResult {
  // Working capital may be derived, so it is checked separately from the rest.
  const wc = workingCapitalOf(inputs);

  const missing = requireFrom(inputs, context, [
    "retainedEarnings",
    "ebit",
    "revenue",
    "totalAssets",
    "totalLiabilities",
  ]);
  if (missing) return missing;

  if (wc === null) {
    return requireFrom(inputs, context, [
      "workingCapital",
      "currentAssets",
      "currentLiabilities",
    ]) ?? unavailable(
      "missing-inputs",
      ["workingCapital"],
      "Working capital could not be determined.",
    );
  }

  if (context.marketCap === null) {
    return unavailable(
      "requires-quote",
      ["marketCap"],
      "The Z-Score's X4 factor needs the market value of equity.",
    );
  }

  const totalAssets = inputs.totalAssets!;
  const totalLiabilities = inputs.totalLiabilities!;

  if (totalAssets === 0) {
    return unavailable(
      "not-meaningful",
      [],
      "Total assets are zero, so four of the five Z-Score factors are undefined.",
    );
  }
  if (totalLiabilities === 0) {
    return unavailable(
      "not-meaningful",
      [],
      "Total liabilities are zero, so the X4 factor is unbounded.",
    );
  }

  const factors: AltmanFactors = {
    x1: wc / totalAssets,
    x2: inputs.retainedEarnings! / totalAssets,
    x3: inputs.ebit! / totalAssets,
    x4: context.marketCap / totalLiabilities,
    x5: inputs.revenue! / totalAssets,
  };

  return finite(altmanFromFactors(factors), "Z-Score is not finite.");
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

/** Compute all five derived fundamentals. */
export function computeDerivedFundamentals(
  inputs: FundamentalInputs,
  context: FundamentalContext,
): DerivedFundamentals {
  return {
    roic: roic(inputs, context),
    fcfYield: fcfYield(inputs, context),
    fcfPerShare: fcfPerShare(inputs, context),
    interestCoverage: interestCoverage(inputs, context),
    altmanZScore: altmanZScore(inputs, context),
  };
}

/** The value of a `MetricResult`, or `null` when it is unavailable. */
export function metricValue(result: MetricResult): number | null {
  return result.status === "ok" ? result.value : null;
}

/**
 * Flatten to the nullable-number shape `FundamentalMetrics` uses.
 *
 * Lossy by design — the reasons are discarded. Use it only at an edge that
 * cannot carry the richer type, and prefer passing `DerivedFundamentals`
 * through so the UI can explain itself.
 */
export function collapseDerived(
  derived: DerivedFundamentals,
): Pick<
  FundamentalMetrics,
  "roic" | "fcfYield" | "fcfPerShare" | "interestCoverage" | "altmanZScore"
> {
  return {
    roic: metricValue(derived.roic),
    fcfYield: metricValue(derived.fcfYield),
    fcfPerShare: metricValue(derived.fcfPerShare),
    interestCoverage: metricValue(derived.interestCoverage),
    altmanZScore: metricValue(derived.altmanZScore),
  };
}
