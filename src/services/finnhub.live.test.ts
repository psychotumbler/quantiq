import { beforeAll, describe, expect, it, vi } from "vitest";

/** AAPL-shaped payloads; profile/metric values are the probe's observed ones. */
const B = 1e9;
const row = (concept: string, value: number) => ({ concept: `us-gaap_${concept}`, value });
const responses: Record<string, unknown> = {
  "/quote": { c: 356.27, d: 1.39, dp: 0.3917, h: 360.83, l: 355.75, o: 357.96, pc: 354.88, t: 1794603600 },
  "/stock/profile2": { name: "Apple Inc.", currency: "USD", exchange: "NASDAQ NMS - GLOBAL MARKET", marketCapitalization: 5177380.424341398, shareOutstanding: 14594.18 },
  "/stock/metric": { metric: { peBasicExclExtraTTM: 39.1706, pbAnnual: 44.0587, psTTM: 10.8125, roeTTM: 127.61, roaTTM: 34.37, grossMarginTTM: 48.79, operatingMarginTTM: 33.01, netProfitMarginTTM: 27.6, currentRatioAnnual: 1.0232, quickRatioAnnual: 0.9376, "totalDebt/totalEquityAnnual": 0.7277, netInterestCoverageTTM: 622.5082, beta: 1.0898671, "52WeekHigh": 360.83, "52WeekLow": 243.42, dividendYieldIndicatedAnnual: 0.50534 } },
  "/stock/financials-reported": { data: [
    { year: 2026, endDate: "2026-09-26 00:00:00", report: { bs: [], ic: [row("RevenueFromContractWithCustomerExcludingAssessedTax", 440 * B), row("OperatingIncomeLoss", 140 * B), row("NetIncomeLoss", 120 * B)], cf: [row("NetCashProvidedByUsedInOperatingActivities", 125 * B), row("PaymentsToAcquirePropertyPlantAndEquipment", 12 * B), row("DepreciationDepletionAndAmortization", 12 * B)] } },
    { year: 2025, endDate: "2025-09-27 00:00:00", report: {
      ic: [row("RevenueFromContractWithCustomerExcludingAssessedTax", 416 * B), row("OperatingIncomeLoss", 133 * B), row("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", 133 * B), row("IncomeTaxExpenseBenefit", 21 * B), row("NetIncomeLoss", 112 * B)],
      bs: [row("Assets", 360 * B), row("Liabilities", 286 * B), row("StockholdersEquity", 74 * B), row("AssetsCurrent", 148 * B), row("LiabilitiesCurrent", 166 * B), row("LongTermDebtNoncurrent", 78 * B), row("LongTermDebtCurrent", 12 * B), row("CommercialPaper", 8 * B), row("CashAndCashEquivalentsAtCarryingValue", 36 * B), row("RetainedEarningsAccumulatedDeficit", -14 * B)],
      cf: [row("NetCashProvidedByUsedInOperatingActivities", 111 * B), row("PaymentsToAcquirePropertyPlantAndEquipment", 12.7 * B), row("DepreciationDepletionAndAmortization", 11.7 * B)] } },
  ] },
};

vi.mock("axios", () => {
  const get = vi.fn(async (path: string) => ({ data: responses[path] ?? null }));
  return { default: { create: () => ({ get }), isAxiosError: () => false } };
});

describe("finnhub provider end to end on AAPL-shaped payloads", () => {
  beforeAll(() => { process.env.FINNHUB_API_KEY = "test-key"; });

  it("builds a quote with scaled market cap and fractional change", async () => {
    const { getQuote } = await import("@/services/finnhub");
    const q = (await getQuote("AAPL"))!;
    expect(q.price).toBe(356.27);
    expect(q.changePercent).toBeCloseTo(0.003917);
    expect(q.marketCap).toBeCloseTo(5.17738e12, -8);
    expect(q.dividendYield).toBeCloseTo(0.0050534); // 0.5%, not 50%
    expect(q.eps).toBeCloseTo(356.27 / 39.1706);
  });

  it("keeps the newest period even with an empty balance sheet", async () => {
    const { getFinancials } = await import("@/services/finnhub");
    const periods = await getFinancials("AAPL");
    expect(periods.map((p) => p.date)).toEqual(["2026-09-26", "2025-09-27"]);
    expect(periods[0].totalAssets).toBeNull();
    expect(periods[0].freeCashFlow).toBe(113 * B);
  });

  it("derives fundamentals in consistent units", async () => {
    const { getFundamentalMetrics } = await import("@/services/finnhub");
    const f = await getFundamentalMetrics("AAPL");
    expect(f.grossMargin).toBeCloseTo(0.4879);
    expect(f.roe).toBeCloseTo(1.2761);
    expect(f.debtToEquity).toBeCloseTo(0.7277);
    // FCF 98.3B / cap 5.177T ≈ 1.9% — a dropped 1e6 scale would give ~19,000.
    expect(f.fcfYield).toBeGreaterThan(0.01);
    expect(f.fcfYield).toBeLessThan(0.03);
    // 98.3B / 14.594B shares ≈ $6.74
    expect(f.fcfPerShare).toBeCloseTo(98.3 / 14.59418, 1);
    expect(f.altmanZScore).toBeGreaterThan(3);
    expect(f.altmanZScore).toBeLessThan(40);
    expect(f.roic).toBeGreaterThan(0.3);
    expect(f.evToEbitda).toBeGreaterThan(20);
    expect(f.evToEbitda).toBeLessThan(45);
    console.log("derived", f);
  });
});
