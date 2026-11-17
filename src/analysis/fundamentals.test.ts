/**
 * Phase 2c tests — derived fundamentals.
 *
 * Standard matched from 2a: exact hand-computed values first, then limit and
 * sign properties, then the unavailability paths. The last group is the point
 * of this module, so it is tested at least as hard as the arithmetic: for
 * every metric, an absent input must produce a *reason*, and a legitimate zero
 * must stay a zero.
 */

import { describe, expect, it } from "vitest";
import type { FundamentalContext, FundamentalInputs } from "@/analysis/fundamentals";
import {
  MARKETS_WITHOUT_PROVIDER,
  MARKET_INPUT_GAPS,
  altmanFromFactors,
  altmanZScore,
  collapseDerived,
  computeDerivedFundamentals,
  effectiveTaxRate,
  emptyInputs,
  fcfPerShare,
  fcfYield,
  interestCoverage,
  metricValue,
  requireInputs,
  roic,
  workingCapitalOf,
} from "@/analysis/fundamentals";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * A deliberately round company, so every expected value below is exact
 * arithmetic a reader can check by hand rather than a recorded output.
 *
 *   tax rate      = 225 / 900          = 0.25
 *   NOPAT         = 1000 x (1 - 0.25)  = 750
 *   invested cap  = 2000 + 3000        = 5000
 *   roic          = 750 / 5000         = 0.15
 *   fcfYield      = 400 / 8000         = 0.05
 *   fcfPerShare   = 400 / 100          = 4
 *   coverage      = 1000 / 125         = 8
 *
 *   X1 = 500 / 5000    = 0.1
 *   X2 = 1500 / 5000   = 0.3
 *   X3 = 1000 / 5000   = 0.2
 *   X4 = 8000 / 2500   = 3.2
 *   X5 = 10000 / 5000  = 2.0
 *   Z  = 1.2(0.1) + 1.4(0.3) + 3.3(0.2) + 0.6(3.2) + 1.0(2.0)
 *      = 0.12 + 0.42 + 0.66 + 1.92 + 2.00 = 5.12
 */
function company(): FundamentalInputs {
  return {
    ebit: 1000,
    pretaxIncome: 900,
    taxProvision: 225,
    interestExpense: 125,
    revenue: 10_000,
    totalAssets: 5000,
    totalLiabilities: 2500,
    totalEquity: 3000,
    totalDebt: 2000,
    retainedEarnings: 1500,
    workingCapital: 500,
    currentAssets: 1200,
    currentLiabilities: 700,
    freeCashFlow: 400,
    shares: 100,
  };
}

const US: FundamentalContext = { market: "US", marketCap: 8000 };
const IN: FundamentalContext = { market: "IN", marketCap: 8000 };
/** No quote supplied — exercises the `requires-quote` path. */
const NO_QUOTE: FundamentalContext = { market: "US", marketCap: null };

/** Assert `ok` and return the value, so tests read as plain arithmetic. */
function value(result: ReturnType<typeof roic>): number {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("unreachable");
  return result.value;
}

/** Assert `unavailable` and return it. */
function why(result: ReturnType<typeof roic>) {
  expect(result.status).toBe("unavailable");
  if (result.status !== "unavailable") throw new Error("unreachable");
  return result;
}

/* ------------------------------------------------------------------ */
/* Exact values                                                       */
/* ------------------------------------------------------------------ */

describe("exact hand-computed values", () => {
  it("effectiveTaxRate is taxProvision / pretaxIncome", () => {
    expect(effectiveTaxRate(company())).toBe(0.25);
  });

  it("roic is NOPAT / (debt + equity)", () => {
    expect(value(roic(company(), US))).toBeCloseTo(0.15, 12);
  });

  it("fcfYield is FCF / market cap", () => {
    expect(value(fcfYield(company(), US))).toBe(0.05);
  });

  it("fcfPerShare is FCF / shares", () => {
    expect(value(fcfPerShare(company(), US))).toBe(4);
  });

  it("interestCoverage is EBIT / |interest|", () => {
    expect(value(interestCoverage(company(), US))).toBe(8);
  });

  it("altmanZScore matches the five weighted factors", () => {
    expect(value(altmanZScore(company(), US))).toBeCloseTo(5.12, 12);
  });

  it("altmanFromFactors applies Altman's original coefficients", () => {
    // Each factor isolated, so a transposed weight cannot pass.
    expect(altmanFromFactors({ x1: 1, x2: 0, x3: 0, x4: 0, x5: 0 })).toBe(1.2);
    expect(altmanFromFactors({ x1: 0, x2: 1, x3: 0, x4: 0, x5: 0 })).toBe(1.4);
    expect(altmanFromFactors({ x1: 0, x2: 0, x3: 1, x4: 0, x5: 0 })).toBe(3.3);
    expect(altmanFromFactors({ x1: 0, x2: 0, x3: 0, x4: 1, x5: 0 })).toBe(0.6);
    expect(altmanFromFactors({ x1: 0, x2: 0, x3: 0, x4: 0, x5: 1 })).toBe(1);
    expect(altmanFromFactors({ x1: 0, x2: 0, x3: 0, x4: 0, x5: 0 })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Sign and limit properties                                          */
/* ------------------------------------------------------------------ */

describe("sign and limit properties", () => {
  it("clamps a negative effective tax rate to 0", () => {
    // Loss-making year: a tax credit against negative pretax income gives a
    // nonsense negative rate that would otherwise inflate NOPAT above EBIT.
    const loss = { ...company(), pretaxIncome: -500, taxProvision: 100 };
    expect(effectiveTaxRate(loss)).toBe(0);
    // NOPAT therefore equals EBIT: 1000 / 5000 = 0.2
    expect(value(roic(loss, US))).toBeCloseTo(0.2, 12);
  });

  it("clamps an effective tax rate above 1 to 1", () => {
    const overTaxed = { ...company(), pretaxIncome: 100, taxProvision: 150 };
    expect(effectiveTaxRate(overTaxed)).toBe(1);
    // NOPAT is fully taxed away, so ROIC is a genuine, computed zero.
    const result = roic(overTaxed, US);
    expect(result).toEqual({ status: "ok", value: 0 });
  });

  it("keeps a negative fcfYield rather than suppressing it", () => {
    const burning = { ...company(), freeCashFlow: -800 };
    expect(value(fcfYield(burning, US))).toBe(-0.1);
  });

  it("keeps a negative interest coverage for a loss-making company", () => {
    const loss = { ...company(), ebit: -250 };
    expect(value(interestCoverage(loss, US))).toBe(-2);
  });

  it("normalises the sign of interest expense", () => {
    // Yahoo reports interest expense positive; other sources report it
    // negative. Coverage must not flip sign with the provider.
    const negative = { ...company(), interestExpense: -125 };
    expect(value(interestCoverage(negative, US))).toBe(8);
  });

  it("does not clamp a distressed Z-Score to zero", () => {
    const distressed = {
      ...company(),
      workingCapital: -2000,
      retainedEarnings: -4000,
      ebit: -500,
      revenue: 1000,
    };
    const z = value(altmanZScore(distressed, { market: "US", marketCap: 100 }));
    // X1 -0.4, X2 -0.8, X3 -0.1, X4 0.04, X5 0.2
    // 1.2(-0.4) + 1.4(-0.8) + 3.3(-0.1) + 0.6(0.04) + 1.0(0.2)
    //  = -0.48 - 1.12 - 0.33 + 0.024 + 0.2 = -1.706
    expect(z).toBeCloseTo(-1.706, 12);
    expect(z).toBeLessThan(0);
  });

  it("derives working capital from current assets less current liabilities", () => {
    expect(workingCapitalOf(company())).toBe(500);
    const derived = { ...company(), workingCapital: null };
    expect(workingCapitalOf(derived)).toBe(500); // 1200 - 700
    const neither = { ...company(), workingCapital: null, currentAssets: null };
    expect(workingCapitalOf(neither)).toBeNull();
  });

  it("uses the derived working capital in the Z-Score", () => {
    // Reported WC removed; CA - CL gives the same 500, so Z is unchanged.
    const derived = { ...company(), workingCapital: null };
    expect(value(altmanZScore(derived, US))).toBeCloseTo(5.12, 12);
  });
});

/* ------------------------------------------------------------------ */
/* Unavailability — the point of the module                           */
/* ------------------------------------------------------------------ */

describe("unavailability is explained, never a bare null", () => {
  it("reports every absent input by name", () => {
    const bad = { ...company(), ebit: null, taxProvision: null };
    const result = why(roic(bad, US));
    expect(result.reason).toBe("missing-inputs");
    expect(result.missing).toEqual(["ebit", "taxProvision"]);
    expect(result.detail).toContain("ebit");
  });

  it("marks price-dependent metrics requires-quote, not missing-inputs", () => {
    // The distinction is actionable: one is fixed by supplying a quote, the
    // other cannot be fixed at all.
    expect(why(fcfYield(company(), NO_QUOTE)).reason).toBe("requires-quote");
    expect(why(altmanZScore(company(), NO_QUOTE)).reason).toBe("requires-quote");
    // ...while metrics that need no price still compute.
    expect(value(roic(company(), NO_QUOTE))).toBeCloseTo(0.15, 12);
    expect(value(fcfPerShare(company(), NO_QUOTE))).toBe(4);
    expect(value(interestCoverage(company(), NO_QUOTE))).toBe(8);
  });

  it("treats zero interest expense as unbounded coverage, not zero", () => {
    // The regression this module exists to prevent: a debt-free company is
    // the healthiest case, and must never render as coverage 0.
    const debtFree = { ...company(), interestExpense: 0 };
    const result = why(interestCoverage(debtFree, US));
    expect(result.reason).toBe("not-meaningful");
    expect(result.detail).toContain("unbounded");
    expect(result.detail).toContain("not zero");
  });

  it("distinguishes a reported zero from a missing value", () => {
    // freeCashFlow 0 is a real datum: yield and per-share are both 0.
    const flat = { ...company(), freeCashFlow: 0 };
    expect(fcfYield(flat, US)).toEqual({ status: "ok", value: 0 });
    expect(fcfPerShare(flat, US)).toEqual({ status: "ok", value: 0 });

    // freeCashFlow null is not.
    const absent = { ...company(), freeCashFlow: null };
    expect(why(fcfYield(absent, US)).missing).toEqual(["freeCashFlow"]);
    expect(why(fcfPerShare(absent, US)).missing).toEqual(["freeCashFlow"]);
  });

  it("reports a zero denominator as not-meaningful", () => {
    expect(
      why(roic({ ...company(), totalDebt: 0, totalEquity: 0 }, US)).reason,
    ).toBe("not-meaningful");
    expect(why(fcfPerShare({ ...company(), shares: 0 }, US)).reason).toBe(
      "not-meaningful",
    );
    expect(
      why(altmanZScore({ ...company(), totalAssets: 0 }, US)).reason,
    ).toBe("not-meaningful");
    expect(
      why(altmanZScore({ ...company(), totalLiabilities: 0 }, US)).reason,
    ).toBe("not-meaningful");
    expect(
      why(fcfYield(company(), { market: "US", marketCap: 0 })).reason,
    ).toBe("not-meaningful");
  });

  it("reports a zero pretax income as not-meaningful for roic", () => {
    const result = why(roic({ ...company(), pretaxIncome: 0 }, US));
    expect(result.reason).toBe("not-meaningful");
    expect(result.detail).toContain("tax rate");
  });

  it("returns an explained result for every metric when nothing is available", () => {
    // US, so this exercises the missing-inputs / requires-quote paths rather
    // than collapsing to no-provider-for-market (covered separately below).
    const derived = computeDerivedFundamentals(emptyInputs(), {
      market: "US",
      marketCap: null,
    });
    for (const [name, result] of Object.entries(derived)) {
      expect(result.status, name).toBe("unavailable");
      if (result.status !== "unavailable") continue;
      // Each one must carry a usable explanation, not an empty shell.
      expect(result.detail.length, name).toBeGreaterThan(0);
      expect(result.reason, name).not.toBe("not-meaningful");
    }
  });

  it("computes all five for a complete company", () => {
    const derived = computeDerivedFundamentals(company(), US);
    expect(Object.values(derived).every((r) => r.status === "ok")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Market attribution                                                 */
/* ------------------------------------------------------------------ */

describe("market attribution", () => {
  it("lists IN, CN and EU as having no configured provider, and not US", () => {
    expect([...MARKETS_WITHOUT_PROVIDER].sort()).toEqual(["CN", "EU", "IN"]);
    expect(MARKETS_WITHOUT_PROVIDER).not.toContain("US");
  });

  it("has no declared input-level gaps yet", () => {
    // Guards the honesty constraint: until a probe runs clean, no individual
    // line item may be attributed to a market. If this fails, a gap was
    // declared and the PROGRESS.md note must be updated to match.
    for (const market of ["US", "IN", "CN", "EU"] as const) {
      expect(MARKET_INPUT_GAPS[market]).toEqual([]);
    }
  });

  it("reports no-provider-for-market for an Indian listing", () => {
    // Not `missing-inputs`: nothing is configured to fetch Indian data, so
    // naming the absent lines would imply we tried and they were absent.
    const result = why(altmanZScore({ ...company(), retainedEarnings: null }, IN));
    expect(result.reason).toBe("no-provider-for-market");
    expect(result.detail).toContain("Indian");
    expect(result.detail).toContain("No data provider");
  });

  it("reports no-provider-for-market for every metric on an Indian listing", () => {
    const derived = computeDerivedFundamentals(emptyInputs(), {
      market: "IN",
      marketCap: null,
    });
    for (const [name, result] of Object.entries(derived)) {
      expect(result.status, name).toBe("unavailable");
      if (result.status !== "unavailable") continue;
      expect(result.reason, name).toBe("no-provider-for-market");
    }
  });

  it("still reports missing-inputs for a US listing", () => {
    const result = why(altmanZScore({ ...company(), retainedEarnings: null }, US));
    expect(result.reason).toBe("missing-inputs");
  });

  it("honours a context that overrides provider coverage", () => {
    // The demoted yahooProvider nominally reaches every market, so a local-dev
    // run against it must not be told India has no provider.
    const covered: FundamentalContext = {
      market: "IN",
      marketCap: 8000,
      marketsWithoutProvider: [],
    };
    const result = why(
      altmanZScore({ ...company(), retainedEarnings: null }, covered),
    );
    expect(result.reason).toBe("missing-inputs");

    // And with complete inputs it computes normally.
    expect(value(altmanZScore(company(), covered))).toBeCloseTo(5.12, 12);
  });

  it("ranks no-provider above a declared input gap", () => {
    // Precedence: no-provider-for-market > unavailable-for-market >
    // missing-inputs. The coarsest true statement wins.
    const result = requireInputs(
      { ...company(), retainedEarnings: null },
      "IN",
      ["retainedEarnings"],
      ["retainedEarnings"], // declared as an input-level gap too
      ["IN"],
    );
    expect(result!.reason).toBe("no-provider-for-market");
  });

  it("attributes an absent input to the market once a gap is declared", () => {
    // Drives requireInputs with a hypothetical gap list and a covered market,
    // so the attribution path is proven before the real table is populated.
    const result = requireInputs(
      { ...company(), retainedEarnings: null },
      "IN",
      ["retainedEarnings", "totalAssets"],
      ["retainedEarnings"],
      [], // market IS covered
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("unavailable-for-market");
    expect(result!.missing).toEqual(["retainedEarnings"]);
    expect(result!.detail).toContain("Indian");
  });

  it("prefers the market gap when inputs are both absent and declared", () => {
    const result = requireInputs(
      { ...company(), retainedEarnings: null, ebit: null },
      "IN",
      ["retainedEarnings", "ebit"],
      ["retainedEarnings"],
      [],
    );
    expect(result!.reason).toBe("unavailable-for-market");
  });

  it("ignores a declared gap when the input actually arrived", () => {
    // A provider that starts reporting a previously-missing line must not
    // keep being told the market does not report it.
    expect(
      requireInputs(company(), "IN", ["retainedEarnings"], ["retainedEarnings"], []),
    ).toBeNull();
  });

  it("returns null when nothing is absent", () => {
    expect(requireInputs(company(), "US", ["ebit", "revenue"])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Collapse to the wire shape                                         */
/* ------------------------------------------------------------------ */

describe("collapseDerived", () => {
  it("flattens ok values to numbers", () => {
    expect(collapseDerived(computeDerivedFundamentals(company(), US))).toEqual({
      roic: 0.15,
      fcfYield: 0.05,
      fcfPerShare: 4,
      interestCoverage: 8,
      altmanZScore: expect.closeTo(5.12, 12),
    });
  });

  it("flattens unavailable to null", () => {
    const empty = computeDerivedFundamentals(emptyInputs(), NO_QUOTE);
    expect(collapseDerived(empty)).toEqual({
      roic: null,
      fcfYield: null,
      fcfPerShare: null,
      interestCoverage: null,
      altmanZScore: null,
    });
  });

  it("metricValue mirrors the collapse for a single metric", () => {
    expect(metricValue({ status: "ok", value: 7 })).toBe(7);
    expect(
      metricValue({
        status: "unavailable",
        reason: "missing-inputs",
        missing: ["ebit"],
        detail: "x",
      }),
    ).toBeNull();
  });
});
