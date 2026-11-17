/**
 * Tests for the Finnhub unit conversions.
 *
 * These are pinned to the real values observed in the 2026-11-15 probe run,
 * and the key assertion re-derives the millions scale from the payload itself
 * rather than trusting the documentation: market cap over share count must
 * equal price per share, which only holds if both are in millions.
 */

import { describe, expect, it } from "vitest";
import {
  FINNHUB_PROFILE_SCALE,
  METRIC_UNITS,
  asIs,
  fractionFromPercent,
  marketCapFromProfile,
  readMetric,
  sharesFromProfile,
} from "@/services/finnhubUnits";

/** Observed for AAPL, .scratch/finnhub-probe-results.json, 2026-11-15. */
const OBSERVED = {
  marketCapitalization: 5_177_380.424341398,
  shareOutstanding: 14_594.18,
  /** From /quote for the same symbol in the same run. */
  previousClose: 354.88,
  close: 356.27,
} as const;

describe("profile2 millions scale", () => {
  it("re-derives the scale from the payload: cap / shares == price", () => {
    // This is the proof that both fields are in millions. If either were
    // absolute, the ratio would be off by 1e6 and this would fail.
    const impliedPrice =
      OBSERVED.marketCapitalization / OBSERVED.shareOutstanding;
    expect(impliedPrice).toBeCloseTo(OBSERVED.previousClose, 0);
    // Within a fraction of a percent of the quoted previous close.
    expect(
      Math.abs(impliedPrice - OBSERVED.previousClose) / OBSERVED.previousClose,
    ).toBeLessThan(0.005);
  });

  it("converts market cap to whole currency units", () => {
    // 5,177,380.42 millions == $5.177 trillion.
    expect(marketCapFromProfile(OBSERVED.marketCapitalization)).toBeCloseTo(
      5.177380424341398e12,
      -3,
    );
    expect(marketCapFromProfile(1)).toBe(1_000_000);
  });

  it("converts shares to a whole share count", () => {
    // 14,594.18 millions == 14.59 billion shares.
    expect(sharesFromProfile(OBSERVED.shareOutstanding)).toBeCloseTo(
      1.459418e10,
      -3,
    );
    expect(sharesFromProfile(1)).toBe(1_000_000);
  });

  it("keeps converted cap and shares consistent with each other", () => {
    // The scale must be applied to BOTH or neither — applying it to one is the
    // 1e6 bug this module exists to prevent.
    const cap = marketCapFromProfile(OBSERVED.marketCapitalization)!;
    const shares = sharesFromProfile(OBSERVED.shareOutstanding)!;
    expect(cap / shares).toBeCloseTo(OBSERVED.previousClose, 0);
  });

  it("produces a sane fcfYield at the converted scale", () => {
    // AAPL FCF is order $1e11 absolute. Against a $5.18e12 cap that is ~2%.
    const cap = marketCapFromProfile(OBSERVED.marketCapitalization)!;
    const absoluteFcf = 1.08e11;
    const yieldFraction = absoluteFcf / cap;
    expect(yieldFraction).toBeGreaterThan(0.005);
    expect(yieldFraction).toBeLessThan(0.1);

    // And the bug it guards: forgetting the scale gives 20,000% rather than 2%.
    const unscaled = absoluteFcf / OBSERVED.marketCapitalization;
    expect(unscaled).toBeGreaterThan(1_000);
  });

  it("treats zero as not-reported, not as a real value", () => {
    // A company does not have a market cap of zero or zero shares; Finnhub
    // uses 0 for "absent", and a 0 here would make fcfYield not-meaningful
    // instead of unavailable.
    expect(marketCapFromProfile(0)).toBeNull();
    expect(sharesFromProfile(0)).toBeNull();
  });

  it("rejects unusable inputs", () => {
    for (const bad of [null, undefined, Number.NaN, Infinity, "5", {}, []]) {
      expect(marketCapFromProfile(bad), String(bad)).toBeNull();
      expect(sharesFromProfile(bad), String(bad)).toBeNull();
    }
  });

  it("exposes the scale as a named constant", () => {
    expect(FINNHUB_PROFILE_SCALE).toBe(1_000_000);
  });
});

describe("metric percent vs ratio", () => {
  it("converts percent keys to decimal fractions", () => {
    const metric = {
      grossMarginTTM: 48.79,
      operatingMarginTTM: 33.01,
      netProfitMarginTTM: 27.6,
      roeTTM: 127.61,
      roaTTM: 34.37,
    };
    expect(readMetric(metric, "grossMarginTTM")).toBeCloseTo(0.4879, 12);
    expect(readMetric(metric, "operatingMarginTTM")).toBeCloseTo(0.3301, 12);
    expect(readMetric(metric, "netProfitMarginTTM")).toBeCloseTo(0.276, 12);
    // ROE above 100% is real for AAPL (buybacks shrink equity), so the
    // conversion must not clamp.
    expect(readMetric(metric, "roeTTM")).toBeCloseTo(1.2761, 12);
    expect(readMetric(metric, "roaTTM")).toBeCloseTo(0.3437, 12);
  });

  it("leaves ratio keys alone", () => {
    const metric = {
      "totalDebt/totalEquityAnnual": 0.7277,
      currentRatioAnnual: 1.0232,
      netInterestCoverageTTM: 622.5082,
      peBasicExclExtraTTM: 39.1706,
    };
    // Dividing these by 100 was the Yahoo debtToEquity bug in a new costume.
    expect(readMetric(metric, "totalDebt/totalEquityAnnual")).toBe(0.7277);
    expect(readMetric(metric, "currentRatioAnnual")).toBe(1.0232);
    expect(readMetric(metric, "netInterestCoverageTTM")).toBe(622.5082);
    expect(readMetric(metric, "peBasicExclExtraTTM")).toBe(39.1706);
  });

  it("handles the dividend yield, which looks like a fraction but is percent", () => {
    // 0.50534 is AAPL's yield in PERCENT, i.e. 0.5%. Passing it through as a
    // fraction would claim a 50.5% yield -- a 100x error that still renders
    // as an ordinary-looking percentage.
    const metric = { dividendYieldIndicatedAnnual: 0.50534 };
    const asFraction = readMetric(metric, "dividendYieldIndicatedAnnual")!;
    expect(asFraction).toBeCloseTo(0.0050534, 12);
    expect(asFraction * 100).toBeCloseTo(0.50534, 10);
    // Sanity: a large-cap dividend yield belongs under 10%.
    expect(asFraction).toBeLessThan(0.1);
  });

  it("passes plain and price keys through", () => {
    const metric = { beta: 1.0898671, "52WeekHigh": 360.83, "52WeekLow": 243.42 };
    expect(readMetric(metric, "beta")).toBe(1.0898671);
    expect(readMetric(metric, "52WeekHigh")).toBe(360.83);
    expect(readMetric(metric, "52WeekLow")).toBe(243.42);
  });

  it("declares a unit for every key it claims to know", () => {
    // An unlisted key must never be read; this guards against a key being
    // added to a consumer without its unit being established.
    for (const [key, unit] of Object.entries(METRIC_UNITS)) {
      expect(["percent", "ratio", "currency", "plain"], key).toContain(unit);
    }
    expect(Object.keys(METRIC_UNITS).length).toBeGreaterThan(10);
  });

  it("returns null for an absent key or absent metric block", () => {
    expect(readMetric({}, "grossMarginTTM")).toBeNull();
    expect(readMetric(null, "grossMarginTTM")).toBeNull();
    expect(readMetric(undefined, "beta")).toBeNull();
    // freeCashFlowPerShareTTM was ABSENT in the probe run -- confirm an
    // absent value does not become 0.
    expect(readMetric({ beta: null }, "beta")).toBeNull();
  });

  it("preserves a genuine zero", () => {
    expect(fractionFromPercent(0)).toBe(0);
    expect(asIs(0)).toBe(0);
    expect(readMetric({ grossMarginTTM: 0 }, "grossMarginTTM")).toBe(0);
  });

  it("preserves negative values", () => {
    // A loss-making company has negative margins.
    expect(readMetric({ netProfitMarginTTM: -12.5 }, "netProfitMarginTTM")).toBeCloseTo(
      -0.125,
      12,
    );
  });
});
