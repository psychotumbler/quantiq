import { describe, expect, it } from "vitest";
import { bareConcept, indexReport, parsePeriod } from "@/services/finnhub";
import { parseTwelveData } from "@/services/twelveData";

const row = (concept: string, value: number) => ({ concept, value, unit: "usd", label: concept });

/** Shaped like /stock/financials-reported; AAPL's tags from the probe. */
const filing = {
  year: 2025,
  endDate: "2025-09-27 00:00:00",
  report: {
    ic: [
      row("us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax", 400),
      row("us-gaap_CostOfGoodsAndServicesSold", 220),
      row("us-gaap_GrossProfit", 180),
      row("us-gaap_OperatingIncomeLoss", 120),
      row("us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", 125),
      row("us-gaap_IncomeTaxExpenseBenefit", 20),
      row("us-gaap_NetIncomeLoss", 105),
    ],
    bs: [
      row("us-gaap_Assets", 360),
      row("us-gaap_Liabilities", 290),
      row("us-gaap_StockholdersEquity", 70),
      row("us-gaap_AssetsCurrent", 150),
      row("us-gaap_LiabilitiesCurrent", 145),
      row("us-gaap_LongTermDebtNoncurrent", 80),
      row("us-gaap_LongTermDebtCurrent", 12),
      row("us-gaap_CommercialPaper", 8),
      row("us-gaap_CashAndCashEquivalentsAtCarryingValue", 30),
      row("us-gaap_RetainedEarningsAccumulatedDeficit", -15),
    ],
    cf: [
      row("us-gaap_NetCashProvidedByUsedInOperatingActivities", 115),
      row("us-gaap_PaymentsToAcquirePropertyPlantAndEquipment", 11),
      row("us-gaap_DepreciationDepletionAndAmortization", 12),
    ],
  },
};

describe("finnhub as-reported parsing", () => {
  it("strips the taxonomy prefix in either separator style", () => {
    expect(bareConcept("us-gaap_GrossProfit")).toBe("GrossProfit");
    expect(bareConcept("us-gaap:GrossProfit")).toBe("GrossProfit");
    expect(bareConcept("GrossProfit")).toBe("GrossProfit");
  });

  it("keeps the first occurrence of a repeated concept", () => {
    const index = indexReport({ ic: [row("us-gaap_Revenues", 10), row("us-gaap_Revenues", 3)] });
    expect(index.get("Revenues")).toBe(10);
  });

  it("maps a full filing onto the statement shape", () => {
    const parsed = parsePeriod(filing)!;
    expect(parsed.hasBalanceSheet).toBe(true);
    expect(parsed.statement).toMatchObject({
      date: "2025-09-27",
      revenue: 400,
      grossProfit: 180,
      operatingIncome: 120,
      netIncome: 105,
      ebitda: 132, // 120 + 12, reconstructed
      totalAssets: 360,
      totalLiabilities: 290,
      totalEquity: 70,
      totalDebt: 100, // 80 + 12 + 8
      cashAndEquivalents: 30,
      operatingCashFlow: 115,
      capitalExpenditure: 11,
      freeCashFlow: 104, // 115 − 11
    });
    expect(parsed.inputs.workingCapital).toBe(5);
    expect(parsed.inputs.retainedEarnings).toBe(-15);
    expect(parsed.inputs.ebit).toBe(120);
  });

  it("falls back across revenue tags and derives gross profit", () => {
    const parsed = parsePeriod({
      endDate: "2024-12-31",
      report: { ic: [row("us-gaap_Revenues", 50), row("us-gaap_CostOfRevenue", 30)] },
    })!;
    expect(parsed.statement.revenue).toBe(50);
    expect(parsed.statement.grossProfit).toBe(20);
  });

  it("leaves balance-sheet lines null when the filing has no balance sheet", () => {
    const parsed = parsePeriod({ endDate: "2026-09-26", report: { ic: filing.report.ic, bs: [], cf: filing.report.cf } })!;
    expect(parsed.hasBalanceSheet).toBe(false);
    expect(parsed.statement.totalAssets).toBeNull();
    expect(parsed.statement.totalDebt).toBeNull();
    expect(parsed.statement.revenue).toBe(400);
  });

  it("derives liabilities when only the combined total is filed", () => {
    const parsed = parsePeriod({
      endDate: "2024-12-31",
      report: { bs: [row("us-gaap_Assets", 100), row("us-gaap_LiabilitiesAndStockholdersEquity", 100), row("us-gaap_StockholdersEquity", 40)] },
    })!;
    expect(parsed.statement.totalLiabilities).toBe(60);
  });

  it("returns null for an empty report", () => {
    expect(parsePeriod({ report: {} })).toBeNull();
  });
});

describe("twelve data parsing", () => {
  it("parses strings and reverses newest-first to oldest-first", () => {
    const bars = parseTwelveData({
      values: [
        { datetime: "2026-11-13", open: "357.96", high: "360.83", low: "355.75", close: "356.26999", volume: "39985300" },
        { datetime: "2026-11-12", open: "350.1", high: "355.0", low: "349.0", close: "354.88", volume: "41000000" },
      ],
    });
    expect(bars.map((b) => b.date)).toEqual(["2026-11-12", "2026-11-13"]);
    expect(bars[1].close).toBeCloseTo(356.26999);
    expect(bars[1].adjClose).toBe(bars[1].close);
    expect(bars[1].volume).toBe(39985300);
  });

  it("returns [] for an error body", () => {
    expect(parseTwelveData({ status: "error", code: 401 })).toEqual([]);
  });
});
