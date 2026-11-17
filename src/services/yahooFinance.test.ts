/**
 * Service-layer tests for the parsing and transformation seam.
 *
 * These cover the glue where a wrong Yahoo type name fails *silently*: an
 * unrecognised name is dropped by Yahoo, so the metric it feeds becomes `null`
 * with no HTTP error anywhere. The tests therefore assert on which inputs
 * reach `fundamentalInputs`, not just on the arithmetic above it.
 *
 * `__fixtures__/aapl-timeseries.json` is a **real** captured response (from
 * Aryaveer's browser, Nov 2026). It carries exactly five types, which is why
 * only five entries in `TS` are marked CONFIRMED.
 */

import { describe, expect, it } from "vitest";
import {
  TS,
  buildFundamentals,
  buildStatements,
  fundamentalInputs,
  marketFromExchange,
  marketFromSymbol,
  parseTimeseriesPayload,
} from "@/services/yahooFinance";
import payload from "@/services/__fixtures__/aapl-timeseries.json";

/** Build a series map directly, for cases the captured payload does not cover. */
function seriesOf(
  entries: Record<string, Record<string, number>>,
): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(entries).map(([type, byDate]) => [
      type,
      new Map(Object.entries(byDate)),
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* parseTimeseriesPayload                                             */
/* ------------------------------------------------------------------ */

describe("parseTimeseriesPayload against the real captured payload", () => {
  it("extracts exactly the five types the payload carries", () => {
    const { series } = parseTimeseriesPayload(payload);
    expect([...series.keys()].sort()).toEqual([
      "annualEBITDA",
      "annualNetIncome",
      "annualStockholdersEquity",
      "annualTotalDebt",
      "annualTotalRevenue",
    ]);
  });

  it("reads reportedValue.raw keyed by asOfDate", () => {
    const { series } = parseTimeseriesPayload(payload);
    const revenue = series.get("annualTotalRevenue")!;
    expect(revenue.size).toBe(4);
    expect(revenue.get("2023-09-30")).toBe(383_285_000_000);
    expect(revenue.get("2026-09-30")).toBe(478_834_000_000);
  });

  it("picks up the reporting currency", () => {
    expect(parseTimeseriesPayload(payload).currency).toBe("USD");
  });

  it("merges batched responses into one map", () => {
    // Batching is how the real fetch works; a merge bug would drop a batch.
    const { series } = parseTimeseriesPayload(payload);
    const before = series.size;
    parseTimeseriesPayload(
      {
        timeseries: {
          result: [
            {
              meta: { type: ["annualEBIT"] },
              annualEBIT: [
                {
                  asOfDate: "2026-09-30",
                  currencyCode: "USD",
                  reportedValue: { raw: 1234 },
                },
              ],
            },
          ],
        },
      },
      series,
    );
    expect(series.size).toBe(before + 1);
    expect(series.get("annualEBIT")!.get("2026-09-30")).toBe(1234);
    // The earlier batch survives.
    expect(series.get("annualTotalRevenue")!.size).toBe(4);
  });

  it("tolerates junk without throwing", () => {
    for (const junk of [null, undefined, {}, { timeseries: {} }, { timeseries: { result: null } }]) {
      expect(parseTimeseriesPayload(junk).series.size).toBe(0);
    }
  });

  it("ignores an entry Yahoo returned with no rows", () => {
    // This is exactly what a dropped/unknown type looks like in a response.
    const { series } = parseTimeseriesPayload({
      timeseries: {
        result: [
          { meta: { type: ["annualMadeUpName"] }, annualMadeUpName: [null, null] },
          { meta: { type: ["annualOther"] } },
        ],
      },
    });
    expect(series.size).toBe(0);
  });

  it("skips rows with a non-finite or absent value", () => {
    const { series } = parseTimeseriesPayload({
      timeseries: {
        result: [
          {
            meta: { type: ["annualRevenueX"] },
            annualRevenueX: [
              { asOfDate: "2025-03-31", reportedValue: { raw: Number.NaN } },
              { asOfDate: "2026-03-31", reportedValue: {} },
              { asOfDate: "2024-03-31", reportedValue: { raw: 500 } },
            ],
          },
        ],
      },
    });
    expect([...series.get("annualRevenueX")!.entries()]).toEqual([
      ["2024-03-31", 500],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* buildStatements                                                    */
/* ------------------------------------------------------------------ */

describe("buildStatements", () => {
  it("returns periods most recent first", () => {
    const { series } = parseTimeseriesPayload(payload);
    const statements = buildStatements(series);
    expect(statements.map((s) => s.date)).toEqual([
      "2026-09-30",
      "2025-09-30",
      "2024-09-30",
      "2023-09-30",
    ]);
  });

  it("aligns lines by fiscal period, not by array index", () => {
    // The hazard the rewrite removed: unequal-length series. Revenue has three
    // periods, equity only the oldest one. An index merge would attribute
    // 2024's equity to 2026's revenue.
    const series = seriesOf({
      [TS.revenue]: { "2024-03-31": 100, "2025-03-31": 200, "2026-03-31": 300 },
      [TS.totalEquity]: { "2024-03-31": 50 },
    });
    const statements = buildStatements(series);
    expect(statements[0]).toMatchObject({
      date: "2026-03-31",
      revenue: 300,
      totalEquity: null,
    });
    expect(statements[2]).toMatchObject({
      date: "2024-03-31",
      revenue: 100,
      totalEquity: 50,
    });
  });

  it("falls back to operating cash flow plus capex when FCF is absent", () => {
    // Capex is reported negative, so this is an addition.
    const series = seriesOf({
      [TS.operatingCashFlow]: { "2026-03-31": 1000 },
      [TS.capex]: { "2026-03-31": -300 },
    });
    expect(buildStatements(series)[0].freeCashFlow).toBe(700);
  });

  it("prefers Yahoo's reported FCF over the fallback", () => {
    const series = seriesOf({
      [TS.freeCashFlow]: { "2026-03-31": 650 },
      [TS.operatingCashFlow]: { "2026-03-31": 1000 },
      [TS.capex]: { "2026-03-31": -300 },
    });
    expect(buildStatements(series)[0].freeCashFlow).toBe(650);
  });

  it("leaves FCF null when neither the line nor both fallbacks exist", () => {
    expect(buildStatements(seriesOf({ [TS.revenue]: { "2026-03-31": 1 } }))[0]
      .freeCashFlow).toBeNull();
  });

  it("returns an empty array for an empty series", () => {
    expect(buildStatements(new Map())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* fundamentalInputs — the silent-failure seam                        */
/* ------------------------------------------------------------------ */

describe("fundamentalInputs", () => {
  it("takes each line from the most recent period that reports it", () => {
    // Staggered reporting is normal; the newest value must win per line.
    const series = seriesOf({
      [TS.ebit]: { "2025-03-31": 10, "2026-03-31": 20 },
      [TS.retainedEarnings]: { "2025-03-31": 99 }, // not reported in 2026
    });
    const inputs = fundamentalInputs(series);
    expect(inputs.ebit).toBe(20);
    expect(inputs.retainedEarnings).toBe(99);
  });

  it("reports every unmapped line as null rather than 0", () => {
    // The distinction this whole phase rests on: absent must not become zero.
    const inputs = fundamentalInputs(new Map());
    for (const [name, value] of Object.entries(inputs)) {
      expect(value, name).toBeNull();
    }
  });

  it("derives free cash flow from OCF plus capex", () => {
    const series = seriesOf({
      [TS.operatingCashFlow]: { "2026-03-31": 900 },
      [TS.capex]: { "2026-03-31": -250 },
    });
    expect(fundamentalInputs(series).freeCashFlow).toBe(650);
  });

  it("maps every input through a TS entry that exists", () => {
    // A typo'd key in the TS map would make the corresponding input
    // permanently null. Round-trip each one through a synthetic series.
    const sentinel = 4242;
    const inputKeys = Object.keys(fundamentalInputs(new Map())) as Array<
      keyof ReturnType<typeof fundamentalInputs>
    >;
    const byInput: Partial<Record<string, string>> = {
      ebit: TS.ebit,
      pretaxIncome: TS.pretaxIncome,
      taxProvision: TS.taxProvision,
      interestExpense: TS.interestExpense,
      revenue: TS.revenue,
      totalAssets: TS.totalAssets,
      totalLiabilities: TS.totalLiabilities,
      totalEquity: TS.totalEquity,
      totalDebt: TS.totalDebt,
      retainedEarnings: TS.retainedEarnings,
      workingCapital: TS.workingCapital,
      currentAssets: TS.currentAssets,
      currentLiabilities: TS.currentLiabilities,
      freeCashFlow: TS.freeCashFlow,
      shares: TS.shares,
    };
    // Every input must be accounted for, or this test is silently incomplete.
    expect(Object.keys(byInput).sort()).toEqual([...inputKeys].sort());

    for (const [input, type] of Object.entries(byInput)) {
      const series = seriesOf({ [type!]: { "2026-03-31": sentinel } });
      const inputs = fundamentalInputs(series) as unknown as Record<
        string,
        number | null
      >;
      expect(inputs[input], `${input} <- ${type}`).toBe(sentinel);
    }
  });
});

/* ------------------------------------------------------------------ */
/* buildFundamentals — Phase 2c wiring                                */
/* ------------------------------------------------------------------ */

describe("buildFundamentals", () => {
  /** The round-numbered company from fundamentals.test.ts, as a series map. */
  function completeSeries() {
    const d = "2026-03-31";
    return seriesOf({
      [TS.revenue]: { [d]: 10_000 },
      [TS.grossProfit]: { [d]: 4000 },
      [TS.operatingIncome]: { [d]: 1100 },
      [TS.netIncome]: { [d]: 675 },
      [TS.ebit]: { [d]: 1000 },
      [TS.pretaxIncome]: { [d]: 900 },
      [TS.taxProvision]: { [d]: 225 },
      [TS.interestExpense]: { [d]: 125 },
      [TS.totalAssets]: { [d]: 5000 },
      [TS.totalLiabilities]: { [d]: 2500 },
      [TS.totalEquity]: { [d]: 3000 },
      [TS.totalDebt]: { [d]: 2000 },
      [TS.retainedEarnings]: { [d]: 1500 },
      [TS.workingCapital]: { [d]: 500 },
      [TS.currentAssets]: { [d]: 1200 },
      [TS.currentLiabilities]: { [d]: 700 },
      [TS.inventory]: { [d]: 200 },
      [TS.freeCashFlow]: { [d]: 400 },
      [TS.shares]: { [d]: 100 },
    });
  }

  it("populates the three Phase 2c metrics that need no market cap", () => {
    const m = buildFundamentals(completeSeries(), "US");
    expect(m.roic).toBeCloseTo(0.15, 12);
    expect(m.fcfPerShare).toBe(4);
    expect(m.interestCoverage).toBe(8);
  });

  it("leaves the two market-cap-dependent metrics null", () => {
    // Not a silent gap: `getDerivedFundamentals` reports these as
    // `requires-quote`. The flat wire shape just cannot carry the reason.
    const m = buildFundamentals(completeSeries(), "US");
    expect(m.fcfYield).toBeNull();
    expect(m.altmanZScore).toBeNull();
  });

  it("still computes the Phase 1 ratios", () => {
    const m = buildFundamentals(completeSeries(), "US");
    expect(m.grossMargin).toBe(0.4);
    expect(m.netMargin).toBe(0.0675);
    expect(m.roe).toBe(0.225);
    expect(m.roa).toBe(0.135);
    expect(m.debtToEquity).toBeCloseTo(2000 / 3000, 12);
    expect(m.currentRatio).toBeCloseTo(1200 / 700, 12);
    expect(m.quickRatio).toBeCloseTo(1000 / 700, 12);
  });

  it("returns all nulls for an empty series", () => {
    const m = buildFundamentals(new Map(), "IN");
    expect(Object.values(m).every((v) => v === null)).toBe(true);
  });

  it("defaults the market to US when not supplied", () => {
    expect(() => buildFundamentals(completeSeries())).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Market resolution                                                  */
/* ------------------------------------------------------------------ */

describe("market resolution", () => {
  it("maps a ticker suffix to a market", () => {
    expect(marketFromSymbol("AAPL")).toBe("US");
    expect(marketFromSymbol("RELIANCE.NS")).toBe("IN");
    expect(marketFromSymbol("RELIANCE.BO")).toBe("IN");
    expect(marketFromSymbol("reliance.ns")).toBe("IN");
    expect(marketFromSymbol("0700.HK")).toBe("CN");
    expect(marketFromSymbol("600519.SS")).toBe("CN");
    expect(marketFromSymbol("BP.L")).toBe("EU");
    expect(marketFromSymbol("SAP.DE")).toBe("EU");
    // Unknown suffixes fall back to US, matching Yahoo's own convention.
    expect(marketFromSymbol("FOO.ZZZ")).toBe("US");
    expect(marketFromSymbol("")).toBe("US");
  });

  it("maps an exchange code to a market", () => {
    expect(marketFromExchange("NMS")).toBe("US");
    expect(marketFromExchange("NSI")).toBe("IN");
    expect(marketFromExchange("nse")).toBe("IN");
    expect(marketFromExchange("HKG")).toBe("CN");
    expect(marketFromExchange("LSE")).toBe("EU");
    expect(marketFromExchange("")).toBe("US");
  });
});

/* ------------------------------------------------------------------ */
/* TS map honesty                                                     */
/* ------------------------------------------------------------------ */

describe("TS type-name map", () => {
  it("confirms exactly the five names the captured payload proves", () => {
    // Guard against a name being marked CONFIRMED on the strength of a probe
    // that did not actually return data. If the probe is re-run successfully,
    // update this list in the same commit as the TS comments.
    const { series } = parseTimeseriesPayload(payload);
    const confirmed = [
      TS.revenue,
      TS.netIncome,
      TS.ebitda,
      TS.totalDebt,
      TS.totalEquity,
    ];
    for (const name of confirmed) {
      expect(series.has(name), `${name} should be in the captured payload`).toBe(
        true,
      );
    }
    expect(series.size).toBe(confirmed.length);
  });

  it("uses Yahoo's all-caps spelling for the acronym types", () => {
    expect(TS.ebitda).toBe("annualEBITDA");
    expect(TS.ebit).toBe("annualEBIT");
  });

  it("has no duplicate type names", () => {
    const names = Object.values(TS);
    expect(new Set(names).size).toBe(names.length);
  });
});
