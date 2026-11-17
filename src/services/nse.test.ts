import { describe, expect, it } from "vitest";
import { buildPulse, MATERIAL_FILING, nseSymbol, parseFilings, parseNseTime, parseShareholding } from "@/services/nse";
import { scoreMacro, scoreOwnership, computeComposite } from "@/analysis/composite";
import { filingToHeadline, buildNexus } from "@/services/newsNexus";
import { parseAllListed } from "@/services/universe";
import { dealKindForFiling, themeForIndustry } from "@/analysis/themes";

describe("NSE parsers", () => {
  it("reads IST timestamps", () => {
    expect(parseNseTime("17-Nov-2026 12:55:28")).toBe("2026-11-17T07:25:28.000Z");
    expect(parseNseTime("30-SEP-2026")).toBe("2026-09-29T18:30:00.000Z");
    expect(parseNseTime("garbage")).toBe("");
  });

  it("maps tickers to NSE symbols", () => {
    expect(nseSymbol("RELIANCE.NS")).toBe("RELIANCE");
    expect(nseSymbol("M&M.BO")).toBe("M&M");
    expect(nseSymbol("AAPL")).toBeNull();
  });

  it("builds the pulse from the real payload shapes", () => {
    const all = {
      timestamp: "17-Nov-2026 12:53", advances: 5329, declines: 4216, unchanged: 100,
      data: [
        { key: "INDICES ELIGIBLE IN DERIVATIVES", index: "NIFTY 50", pe: "20.6", pb: "3.1", dy: "1.37" },
        { key: "SECTORAL INDICES", index: "NIFTY PSU BANK", percentChange: 1.91, perChange30d: 5, perChange365d: -2, pe: "8.1" },
        { key: "SECTORAL INDICES", index: "NIFTY MIDSMALL IT & TELECOM", percentChange: -0.31 },
        { key: "SECTORAL INDICES", index: "NIFTY FINANCIAL SERVICES 25/50", percentChange: 0.81 },
      ],
    };
    const gainers = { NIFTY: { data: [{ symbol: "ASIANPAINT", ltp: 2649.1, perChange: 2.96 }] } };
    const flows = [{ category: "FII/FPI", date: "16-Nov-2026", buyValue: "15636.88", sellValue: "10772.2", netValue: "4864.68" }];
    const pulse = buildPulse(all, gainers, null, flows);
    expect(pulse.breadth).toEqual({ advances: 5329, declines: 4216, unchanged: 100 });
    expect(pulse.valuation).toEqual({ pe: 20.6, pb: 3.1, dividendYield: 1.37 });
    expect(pulse.sectors.map((s) => s.name)).toEqual(["PSU Bank", "Financial Services"]);
    expect(pulse.sectors[0].change).toBeCloseTo(0.0191);
    expect(pulse.gainers[0]).toEqual({ symbol: "ASIANPAINT.NS", price: 2649.1, change: 0.0296 });
    expect(pulse.losers).toEqual([]);
    expect(pulse.flows[0].net).toBeCloseTo(4864.68);
  });

  it("parses shareholding newest first and drops duplicates", () => {
    const rows = parseShareholding([
      { date: "30-JUN-2026", pr_and_prgrp: "50.48", public_val: "49.52" },
      { date: "30-SEP-2026", pr_and_prgrp: "50.44", public_val: "49.56" },
      { date: "30-SEP-2026", pr_and_prgrp: "50.44", public_val: "49.56" },
      { date: "bad", pr_and_prgrp: "1", public_val: "1" },
    ]);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-30", "2026-06-30"]);
    expect(rows[0].promoter).toBe(50.44);
  });

  it("cleans filings and keeps only material categories", () => {
    const filings = parseFilings([
      { symbol: "LT", sm_name: "Larsen & Toubro Limited", smIndustry: "Engineering", desc: "Bagging/Receiving of orders/contracts",
        attchmntText: "Larsen & Toubro Limited has informed the Exchange about Bagging/Receiving of orders/contracts",
        attchmntFile: "https://nsearchives.nseindia.in/x.pdf", an_dt: "09-Nov-2026 10:37:33" },
      { symbol: "X", sm_name: "X Ltd", desc: "Copy of Newspaper Publication", attchmntText: "", attchmntFile: "https://a/b.pdf", an_dt: "09-Nov-2026 10:00:00" },
      { symbol: "Y", sm_name: "Y Ltd", desc: "Press Release", attchmntText: "", attchmntFile: "", an_dt: "" },
    ]);
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({ symbol: "LT.NS", industry: "Engineering", text: "Bagging/Receiving of orders/contracts" });
    expect(filings.filter((f) => MATERIAL_FILING.test(f.category)).map((f) => f.symbol)).toEqual(["LT.NS"]);
  });

  it("reads the full equity list", () => {
    const list = parseAllListed("SYMBOL,NAME OF COMPANY, SERIES\n20MICRONS,20 Microns Limited,EQ\nM&M,Mahindra & Mahindra Limited,EQ\n");
    expect(list.map((c) => c.symbol)).toEqual(["20MICRONS.NS", "M&M.NS"]);
    expect(list.every((c) => c.core === false)).toBe(true);
  });
});

describe("filings in the nexus", () => {
  it("credits the filing company, its industry theme and deal kind", () => {
    const h = filingToHeadline({
      symbol: "NEWGEN.NS", company: "Newgen Software Technologies Limited", industry: "Software",
      category: "Bagging/Receiving of orders/contracts",
      text: "The Company has received and accepted a Letter of Award from a customer in Ghana",
      url: "https://n/x.pdf", publishedAt: "2026-11-17T07:23:26.000Z",
    });
    const nexus = buildNexus([h], [{ symbol: "NEWGEN.NS", name: "Newgen Software Technologies Limited", industry: "Software", market: "IN", core: false }]);
    expect(nexus.deals).toHaveLength(1);
    expect(nexus.deals[0]).toMatchObject({ official: true, companies: ["NEWGEN.NS"], themes: ["it"] });
    expect(nexus.deals[0].deal!.kind).toBe("Order or contract");
    expect(dealKindForFiling("Copy of Newspaper Publication")).toBeNull();
    expect(themeForIndustry("Pharmaceuticals")).toBe("pharma");
  });
});

describe("macro and ownership layers", () => {
  it("scores the regime from VIX, trend and curve", () => {
    const calm = scoreMacro({ vix: 12, indexTrend: 0.08, indexName: "Nifty 50", curveSpread: null })!;
    expect(calm.score).toBe(100);
    const stressed = scoreMacro({ vix: 35, indexTrend: -0.08, indexName: "S&P 500", curveSpread: -0.5 })!;
    expect(stressed.score).toBe(0);
    expect(scoreMacro({ vix: null, indexTrend: null, indexName: "x", curveSpread: null })).toBeNull();
  });

  it("scores promoter stake only when it moved", () => {
    const q = (p: number[]) => p.map((promoter, i) => ({ date: `q${i}`, promoter }));
    // Reliance's real path: 50.01 → 50.44 is +0.43 points, scored as a mild positive.
    const reliance = scoreOwnership(q([50.44, 50.48, 50, 50.01, 50.01]))!;
    expect(reliance.score).toBe(Math.round(((0.43 + 3) / 6) * 100));
    expect(scoreOwnership(q([50.1, 50.1, 50, 50, 50]))).toBeNull(); // +0.1: no signal
    expect(scoreOwnership(q([40, 41, 42]))).toBeNull(); // under five quarters
  });

  it("renormalises over all six layers", () => {
    const c = computeComposite({
      fundamentals: null, technicalSignals: [], risk: null, analysts: null,
      macro: { vix: 12, indexTrend: 0.08, indexName: "Nifty 50", curveSpread: null },
      ownership: [50, 49, 48, 47, 46].map((promoter, i) => ({ date: `q${i}`, promoter })),
    })!;
    expect(c.layers.map((l) => l.layer)).toEqual(["Institutional", "Macro"]);
    expect(c.confidence).toBe(35);
    expect(c.totalScore).toBe(100);
  });
});
