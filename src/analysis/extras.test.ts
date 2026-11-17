import { describe, expect, it } from "vitest";
import { cagr, computeDcf, defaultDcfAssumptions } from "@/analysis/dcf";
import { positions, rsiSeries, runBacktest, smaSeries } from "@/analysis/backtest";
import { alignedReturns, analyzePortfolio, fxRate, pearson } from "@/analysis/portfolio";
import { scoreHeadline, summariseSentiment } from "@/analysis/sentiment";
import { scoreSentiment } from "@/analysis/composite";
import { projectSip, requiredSip } from "@/lib/sip";
import { parseFredCsv, summarise, yearOverYear, MACRO_SERIES } from "@/services/fred";
import { parseRss } from "@/services/news";
import { parseChart, pooled } from "@/services/market";
import type { FinancialStatement, PriceData } from "@/types/stock";

const bars = (prices: number[], start = 0): PriceData[] =>
  prices.map((p, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + start + i)).toISOString().slice(0, 10),
    open: p, high: p, low: p, close: p, volume: 1000, adjClose: p,
  }));

describe("dcf", () => {
  it("matches a hand-computed two-stage value", () => {
    // FCF 100 growing 10% for 2 years, 10% discount, 0% terminal growth.
    // PV = 110/1.1 + 121/1.21 + (121/0.10)/1.21 = 100 + 100 + 1000 = 1200.
    const result = computeDcf(
      { baseFcf: 100, growthRate: 0.1, terminalGrowth: 0, discountRate: 0.1, years: 2, netDebt: 200, sharesOutstanding: 10 },
      50,
    )!;
    expect(result.projectedFCF).toEqual([110.00000000000001, 121.00000000000003]);
    expect(result.intrinsicValue).toBeCloseTo(100, 8); // (1200 − 200) / 10
    expect(result.upside).toBeCloseTo(1, 8);
  });

  it("refuses terminal growth at or above the discount rate, and negative FCF", () => {
    const base = { baseFcf: 100, growthRate: 0.05, terminalGrowth: 0.08, discountRate: 0.08, years: 5, netDebt: 0, sharesOutstanding: 1 };
    expect(computeDcf(base, 10)).toBeNull();
    expect(computeDcf({ ...base, terminalGrowth: 0.02, baseFcf: -5 }, 10)).toBeNull();
  });

  it("computes CAGR and rejects non-positive endpoints", () => {
    expect(cagr(121, 100, 2)).toBeCloseTo(0.1);
    expect(cagr(100, -5, 2)).toBeNull();
  });

  it("derives clamped default assumptions from filings", () => {
    const period = (date: string, fcf: number, debt: number | null, cash: number | null): FinancialStatement => ({
      date, revenue: null, grossProfit: null, operatingIncome: null, netIncome: null, ebitda: null,
      totalAssets: null, totalLiabilities: null, totalEquity: null, totalDebt: debt,
      cashAndEquivalents: cash, freeCashFlow: fcf, operatingCashFlow: null, capitalExpenditure: null,
    });
    const a = defaultDcfAssumptions({
      // Newest filing has no balance sheet; FCF tripled in two years.
      financials: [period("2026", 300, null, null), period("2025", 200, 100, 40), period("2024", 100, 90, 30)],
      marketCap: 900, price: 9, beta: 1, riskFreeRate: 0.04,
    })!;
    expect(a.baseFcf).toBe(300);
    expect(a.growthRate).toBe(0.15); // clamped from ~73%
    expect(a.netDebt).toBe(60); // from the newest period that has a balance sheet
    expect(a.sharesOutstanding).toBe(100);
    // Re = 0.04 + 1×0.05 = 0.09; Rd = 0.055×0.79 = 0.04345; weights 0.9 / 0.1.
    expect(a.discountRate).toBeCloseTo(0.9 * 0.09 + 0.1 * 0.04345, 10);
  });
});

describe("backtest", () => {
  it("computes a simple moving average series", () => {
    expect(smaSeries([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it("pins RSI at 100 on a series that only rises", () => {
    const rsi = rsiSeries(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(rsi[13]).toBeNull();
    expect(rsi[14]).toBe(100);
  });

  it("never acts on the bar that produced the signal", () => {
    // Flat for 260 days, then a one-day +50% jump on the final bar. No rule
    // can be long before the jump, so a look-ahead bug is the only way to
    // capture it.
    const prices = [...Array(260).fill(100), 150];
    for (const id of ["sma-cross", "macd-cross", "rsi-reversion"] as const) {
      const result = runBacktest(id, bars(prices), 0);
      if (result) expect(result.strategyStats.totalReturn).toBeCloseTo(0, 10);
    }
  });

  it("is fully invested in a steady uptrend and tracks buy-and-hold", () => {
    const prices = Array.from({ length: 500 }, (_, i) => 100 * 1.001 ** i);
    const result = runBacktest("sma-cross", bars(prices), 0)!;
    // Position at the first warmed-up close is long; entry happens that day.
    expect(result.exposure).toBe(1);
    expect(result.strategyStats.totalReturn).toBeCloseTo(result.benchmarkStats.totalReturn, 10);
    expect(result.curve[0]).toMatchObject({ strategy: 100, benchmark: 100 });
  });

  it("charges costs on entry", () => {
    const prices = Array.from({ length: 500 }, (_, i) => 100 * 1.001 ** i);
    const free = runBacktest("sma-cross", bars(prices), 0)!;
    const paid = runBacktest("sma-cross", bars(prices), 10)!;
    expect(paid.strategyStats.totalReturn).toBeLessThan(free.strategyStats.totalReturn);
    expect((1 + paid.strategyStats.totalReturn) / (1 + free.strategyStats.totalReturn)).toBeCloseTo(0.999, 10);
  });

  it("returns null without enough history to warm up", () => {
    expect(runBacktest("sma-cross", bars(Array(180).fill(100)))).toBeNull();
    expect(positions("sma-cross", [1, 2, 3])).toEqual([null, null, null]);
  });
});

describe("portfolio", () => {
  it("converts between INR and USD", () => {
    expect(fxRate("USD", "INR", 80)).toBe(80);
    expect(fxRate("INR", "USD", 80)).toBe(1 / 80);
    expect(fxRate("INR", "INR", null)).toBe(1);
    expect(fxRate("EUR", "INR", 80)).toBeNull();
  });

  it("correlates identical and mirrored series at +1 and −1", () => {
    const a = Array.from({ length: 30 }, (_, i) => Math.sin(i));
    expect(pearson(a, a)).toBeCloseTo(1);
    expect(pearson(a, a.map((v) => -v))).toBeCloseTo(-1);
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it("aligns returns on shared dates only", () => {
    const { dates, returns } = alignedReturns([
      { symbol: "A", bars: bars([100, 110, 121]) },
      { symbol: "B", bars: bars([50, 55], 1) }, // starts a day later
    ]);
    expect(dates).toHaveLength(1);
    expect(returns.A[0]).toBeCloseTo(0.1);
    expect(returns.B[0]).toBeCloseTo(0.1);
  });

  it("values a mixed-currency book in the base currency", () => {
    const analysis = analyzePortfolio(
      [
        { symbol: "US1", quantity: 10, averageCost: 90, name: "US One", currency: "USD", price: 100, previousClose: 99, bars: [] },
        { symbol: "IN1", quantity: 100, averageCost: 400, name: "India One", currency: "INR", price: 500, previousClose: 505, bars: [] },
        { symbol: "BAD", quantity: 1, averageCost: 1, name: "BAD", currency: "USD", price: null, previousClose: null, bars: [] },
      ],
      "INR",
      80,
    );
    // US1: 10×100×80 = 80,000 (cost 72,000). IN1: 50,000 (cost 40,000).
    expect(analysis.totals.value).toBe(130000);
    expect(analysis.totals.invested).toBe(112000);
    expect(analysis.totals.pnl).toBe(18000);
    expect(analysis.totals.dayChange).toBe(10 * 1 * 80 - 100 * 5);
    expect(analysis.positions[0].weight).toBeCloseTo(80000 / 130000);
    expect(analysis.unpriced).toEqual(["BAD"]);
  });
});

describe("sentiment", () => {
  it("scores by word list and honours negation", () => {
    expect(scoreHeadline("Shares surge after profit beats estimates")).toBe(1);
    expect(scoreHeadline("Stock plunges on fraud probe")).toBe(-1);
    expect(scoreHeadline("Company schedules annual meeting")).toBeNull();
    expect(scoreHeadline("Regulator finds no fraud")).toBe(1);
  });

  it("only feeds the composite once enough headlines are scored", () => {
    const make = (n: number) =>
      summariseSentiment(
        Array.from({ length: n }, () => ({ title: "Shares surge", url: "https://x", source: "s", publishedAt: "", sentiment: 1 })),
        "test",
      );
    expect(scoreSentiment(null, make(4))).toBeNull();
    expect(scoreSentiment(null, make(5))!.score).toBe(100);
  });
});

describe("sip", () => {
  it("matches the closed-form annuity-due value", () => {
    const r = 0.12 / 12;
    const n = 120;
    const expected = 10000 * (((1 + r) ** n - 1) / r) * (1 + r);
    const sip = projectSip(10000, 0.12, 10);
    expect(sip.projectedValue).toBeCloseTo(expected, 4);
    expect(sip.totalInvested).toBe(1_200_000);
    expect(sip.yearlyBreakdown).toHaveLength(10);
  });

  it("inverts to the required monthly amount", () => {
    const target = projectSip(7500, 0.1, 15).projectedValue;
    expect(requiredSip(target, 0.1, 15)).toBeCloseTo(7500, 6);
  });
});

describe("source parsers", () => {
  it("parses FRED CSV under either header and skips gaps", () => {
    expect(parseFredCsv("observation_date,DGS10\n2026-11-12,4.41\n2026-11-13,.\n2026-11-14,4.39\n")).toEqual([
      { date: "2026-11-12", value: 4.41 },
      { date: "2026-11-14", value: 4.39 },
    ]);
    expect(parseFredCsv("DATE,UNRATE\n2026-10-01,4.1")).toHaveLength(1);
  });

  it("turns an index into year-over-year percent", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ date: `m${i}`, value: i === 12 ? 103 : 100 }));
    expect(yearOverYear(rows)).toEqual([{ date: "m12", value: 3.0000000000000027 }]);
    const cpi = MACRO_SERIES.find((s) => s.id === "CPIAUCSL")!;
    expect(summarise(cpi, rows).value).toBeCloseTo(3);
  });

  it("parses RSS items, CDATA and the Google News publisher suffix", () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Apple shares rise &amp; hit record - Reuters]]></title><link>https://example.com/a</link><pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Broken</title><link>not-a-url</link></item>
    </channel></rss>`;
    const items = parseRss(xml, "Feed");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Apple shares rise & hit record", source: "Reuters", url: "https://example.com/a" });
    expect(items[0].publishedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(items[0].sentiment).toBe(1);
  });

  it("takes day change from the last two closes, not chartPreviousClose", () => {
    const body = { chart: { result: [{
      meta: { symbol: "^NSEI", currency: "INR", regularMarketPrice: 110, chartPreviousClose: 50 },
      timestamp: [1794500000, 1794586400, 1794672800],
      indicators: { quote: [{ close: [90, 100, 110] }] },
    }] } };
    const bundle = parseChart("^NSEI", body)!;
    expect(bundle.previousClose).toBe(100);
    expect(bundle.change).toBe(10);
    expect(bundle.changePercent).toBeCloseTo(0.1);
    expect(parseChart("X", { chart: { result: null } })).toBeNull();
  });

  it("runs a pool in order with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await pooled([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

import { holdingsToCsv, parseHoldingsCsv, splitCsvLine } from "@/lib/portfolioCsv";
import { isUS } from "@/services/liveProvider";

describe("holdings csv", () => {
  it("splits quoted fields containing commas", () => {
    expect(splitCsvLine('"TATA, MOTORS",10,"1,234.50"')).toEqual(["TATA, MOTORS", "10", "1,234.50"]);
  });

  it("reads a broker-style export and appends the exchange suffix", () => {
    const csv = `"Instrument","Qty.","Avg. cost","LTP"\n"RELIANCE",10,"1,250.50",1412.6\n"TCS",0,3500,4000\n"INFY",5,1500,1800`;
    const { holdings, skipped, error } = parseHoldingsCsv(csv, ".NS");
    expect(error).toBeNull();
    expect(skipped).toBe(1); // zero quantity
    expect(holdings).toEqual([
      { symbol: "RELIANCE.NS", quantity: 10, averageCost: 1250.5 },
      { symbol: "INFY.NS", quantity: 5, averageCost: 1500 },
    ]);
  });

  it("round-trips its own export", () => {
    const rows = [{ symbol: "AAPL", quantity: 3, averageCost: 190.25 }];
    expect(parseHoldingsCsv(holdingsToCsv(rows)).holdings).toEqual(rows);
  });

  it("explains a header it cannot map", () => {
    expect(parseHoldingsCsv("a,b,c\n1,2,3").error).toMatch(/symbol, quantity/);
  });
});

describe("US-equity routing", () => {
  it("sends only plain US tickers to Finnhub", () => {
    expect(isUS("AAPL")).toBe(true);
    expect(isUS("RELIANCE.NS")).toBe(false);
    expect(isUS("^NSEI")).toBe(false);
    expect(isUS("GC=F")).toBe(false);
    expect(isUS("BTC-USD")).toBe(false);
  });
});
