import { describe, expect, it } from "vitest";
import { buildMatchers, companiesIn, dealIn, themesIn, type NamedCompany } from "@/analysis/themes";
import { buildNexus, sampleNexus } from "@/services/newsNexus";
import { parseRssRich, searchableName } from "@/services/news";
import { parseNseList, searchUniverse } from "@/services/universe";
import { summariseImf, INDIA_SERIES } from "@/services/imf";
import { buildCompany, fresh, TS, VALUATION_TS } from "@/services/yahooFinance";

const co = (symbol: string, name: string, market: "IN" | "US" = "IN"): NamedCompany => ({ symbol, name, industry: "X", market });
const universe = [
  co("HAL.NS", "Hindustan Aeronautics Ltd."), co("BEL.NS", "Bharat Electronics Ltd."),
  co("TCS.NS", "Tata Consultancy Services Ltd."), co("TATAMOTORS.NS", "Tata Motors Ltd."),
  co("TATASTEEL.NS", "Tata Steel Ltd."), co("LT.NS", "Larsen & Toubro Ltd."),
  co("BANKINDIA.NS", "Bank of India"), co("AAPL", "Apple", "US"), co("NVDA", "Nvidia", "US"),
];
const matchers = buildMatchers(universe);
const names = (text: string) => companiesIn(text, matchers).map((c) => c.symbol);

describe("theme detection", () => {
  it("tags by keyword on word boundaries", () => {
    expect(themesIn("Nvidia unveils new AI chip for data centers")).toContain("ai");
    expect(themesIn("Navy orders new submarine")).toContain("defence");
    // "ai" inside a word, and "port" inside "report", must not fire.
    expect(themesIn("Company said it will maintain its annual report schedule")).toEqual([]);
  });
});

describe("company matching", () => {
  it("matches acronyms case-sensitively and names case-insensitively", () => {
    expect(names("HAL bags order from the Air Force")).toEqual(["HAL.NS"]);
    expect(names("The hall was half empty; belief was low")).toEqual([]);
    expect(names("tata motors and Tata Steel rally")).toEqual(["TATAMOTORS.NS", "TATASTEEL.NS"]);
    expect(names("L&T's order book grows")).toEqual(["LT.NS"]);
  });

  it("does not match a generic single word", () => {
    // "Apple" alone is too generic to rely on the registered name, but the
    // curated alias makes it match; "apple prices fall" is the accepted cost.
    expect(names("Nvidia and Apple lead gains")).toEqual(["AAPL", "NVDA"]);
    expect(names("India growth beats estimates")).toEqual([]);
  });
});

describe("deal extraction", () => {
  it("reads rupee and dollar amounts with their units", () => {
    const a = dealIn("HAL bags order worth Rs 6,200 crore from MoD")!;
    expect(a.kind).toBe("Order or contract");
    expect(a.amount).toBe("Rs 6,200 crore");
    expect(a.usdMillion).toBeCloseTo((6200 * 1e7) / 88 / 1e6, 6);

    const b = dealIn("Microsoft to invest $3 billion in India")!;
    expect(b.kind).toBe("Investment");
    expect(b.usdMillion).toBe(3000);

    expect(dealIn("TCS wins $500 million outsourcing deal")!.usdMillion).toBe(500);
    expect(dealIn("L&T secures 2,500-crore metro project order")!.amount).toMatch(/2,500-?crore/);
  });

  it("skips a valuation and takes the deal size", () => {
    expect(dealIn("Mahanadi Coalfields seeks ₹90,000 crore valuation in ₹8,981 crore IPO")!.amount).toBe("₹8,981 crore");
    expect(dealIn("Startup raises $200 million at a valuation of $5 billion")!.amount).toBe("$200 million");
    expect(dealIn("Claude maker eyes $1.33 trillion valuation in IPO")!.amount).toBeNull();
  });

  it("returns null when the headline is not a deal", () => {
    expect(dealIn("Sensex ends 200 points higher")).toBeNull();
    expect(dealIn("Company wins award for best workplace")).toBeNull();
  });

  it("keeps a deal with no stated size", () => {
    expect(dealIn("Infosys wins large contract from European bank")).toEqual({
      kind: "Order or contract", amount: null, usdMillion: null,
    });
  });
});

describe("nexus pipeline", () => {
  it("separates named companies from curated exposure", () => {
    const nexus = sampleNexus();
    const defence = nexus.themes.find((t) => t.id === "defence")!;
    expect(defence.companies.map((c) => c.symbol)).toEqual(expect.arrayContaining(["HAL.NS", "BEL.NS"]));
    // Named companies never repeat in the exposure list.
    const named = new Set(defence.companies.map((c) => c.symbol));
    expect(defence.exposure.every((c) => !named.has(c.symbol) && c.mentions === 0)).toBe(true);
    expect(defence.exposure.map((c) => c.symbol)).toContain("BDL.NS");
    // Largest stated deal ranks first: $3 billion outranks Rs 6,200 crore (~$0.7 billion).
    expect(nexus.deals[0].title).toMatch(/\$3 billion/);
    expect(nexus.deals[1].title).toMatch(/6,200 crore/);
  });

  it("drops duplicate stories and exposure tickers that are not listed", () => {
    const h = { url: "https://x", source: "A", publishedAt: "", sentiment: null, summary: "" };
    const nexus = buildNexus(
      [{ ...h, title: "HAL bags defence order" }, { ...h, title: "HAL bags defence order!", source: "B" }],
      [co("HAL.NS", "Hindustan Aeronautics Ltd.")],
    );
    expect(nexus.headlineCount).toBe(1);
    expect(nexus.themes[0].exposure).toEqual([]);
  });
});

describe("supporting parsers", () => {
  it("keeps an RSS summary and strips a title-echo", () => {
    const xml = `<rss><channel><item><title>NTPC wins solar bid</title><link>https://e.com/a</link><description>&lt;p&gt;State utility NTPC won a 1,200 MW auction.&lt;/p&gt;</description></item></channel></rss>`;
    expect(parseRssRich(xml, "F")[0].summary).toBe("State utility NTPC won a 1,200 MW auction.");
  });

  it("strips legal suffixes for search", () => {
    expect(searchableName("Reliance Industries Limited")).toBe("Reliance Industries");
    expect(searchableName("Tata Consultancy Services Ltd.")).toBe("Tata Consultancy Services");
  });

  it("parses the NSE constituent file and ranks search hits", () => {
    const list = parseNseList("Company Name,Industry,Symbol,Series,ISIN Code\nTata Motors Ltd.,Automobile,TATAMOTORS,EQ,INE1\nTata Steel Ltd.,Metals,TATASTEEL,EQ,INE2\nBharti Airtel Ltd.,Telecom,BHARTIARTL,EQ,INE3\n");
    expect(list.map((c) => c.symbol)).toEqual(["TATAMOTORS.NS", "TATASTEEL.NS", "BHARTIARTL.NS"]);
    expect(searchUniverse(list, "tata").map((c) => c.symbol)).toEqual(["TATAMOTORS.NS", "TATASTEEL.NS"]);
    expect(searchUniverse(list, "airtel")[0].symbol).toBe("BHARTIARTL.NS");
    expect(searchUniverse(list, "t")).toEqual([]);
  });

  it("labels the current IMF year as a projection", () => {
    const spec = INDIA_SERIES.find((s) => s.id === "NGDP_RPCH")!;
    const s = summariseImf(spec, { "2024": 7.2, "2025": 7.8, "2026": 7, "2027": 7 }, 2026);
    expect(s.value).toBe(7);
    expect(s.date).toBe("2026 (IMF projection)");
    expect(s.change).toBeCloseTo(-0.8);
    const gdp = summariseImf(INDIA_SERIES.find((x) => x.id === "NGDPD")!, { "2026": 4060.207 }, 2026);
    expect(gdp.value).toBeCloseTo(4.060207);
  });
});

describe("yahoo company bundle", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  const series = (entries: Record<string, Record<string, number>>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, new Map(Object.entries(v))]));

  it("ignores a stale valuation reading", () => {
    expect(fresh(new Map([["2021-04-01", 24.6]]), now)).toBeNull();
    expect(fresh(new Map([["2026-11-13", 22.1]]), now)).toBe(22.1);
  });

  const base = {
    [TS.revenue]: { "2026-03-31": 1000 }, [TS.netIncome]: { "2026-03-31": 100 },
    [TS.totalEquity]: { "2026-03-31": 500 }, [TS.freeCashFlow]: { "2026-03-31": 80 },
    [TS.ebit]: { "2026-03-31": 150 }, [TS.interestExpense]: { "2023-03-31": 10 },
    [VALUATION_TS.marketCap]: { "2026-11-13": 2000 }, [VALUATION_TS.pe]: { "2026-11-13": 20 },
  };

  it("computes price-based metrics when currencies agree", () => {
    const c = buildCompany(series(base), new Map([[TS.revenue, "INR"], [VALUATION_TS.marketCap, "INR"]]), "IN", now);
    expect(c.fundamentals.fcfYield).toBeCloseTo(0.04);
    expect(c.fundamentals.peRatio).toBe(20);
    expect(c.financials.map((p) => p.date)).toEqual(["2026-03-31", "2023-03-31"]);
    // Interest expense last reported in 2023 must not be paired with 2026 EBIT.
    expect(c.fundamentals.interestCoverage).toBeNull();
  });

  it("drops price-based metrics when statements and price differ in currency", () => {
    const c = buildCompany(series(base), new Map([[TS.revenue, "USD"], [VALUATION_TS.marketCap, "INR"]]), "IN", now);
    expect(c.fundamentals.fcfYield).toBeNull();
    expect(c.marketCap).toBe(2000);
    expect(c.currency).toBe("USD");
  });
});
