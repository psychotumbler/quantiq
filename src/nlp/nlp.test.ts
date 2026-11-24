import { describe, it, expect } from "vitest";
import { buildIndex, resolveEntities, canonical } from "@/nlp/entities";
import { detectEvents, extractAmount, extractCounterparty } from "@/nlp/events";
import { understand } from "@/nlp/understand";
import type { NamedCompany } from "@/analysis/themes";

const UNIVERSE: NamedCompany[] = [
  { symbol: "HAL.NS", name: "Hindustan Aeronautics Limited", industry: "Defence", market: "IN", core: true },
  { symbol: "BEL.NS", name: "Bharat Electronics Limited", industry: "Defence", market: "IN", core: true },
  { symbol: "BDL.NS", name: "Bharat Dynamics Limited", industry: "Defence", market: "IN" },
  { symbol: "RELIANCE.NS", name: "Reliance Industries Limited", industry: "Energy", market: "IN", core: true },
  { symbol: "TCS.NS", name: "Tata Consultancy Services", industry: "IT", market: "IN", core: true },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharmaceutical Industries", industry: "Pharma", market: "IN", core: true },
];
const ALIASES = {
  "HAL.NS": ["HAL", "Hindustan Aeronautics"],
  "BEL.NS": ["BEL", "Bharat Electronics"],
  "TCS.NS": ["TCS"],
  "SUNPHARMA.NS": ["Sun Pharma"],
};
const index = buildIndex(UNIVERSE, ALIASES);
const peers = new Map([
  ["HAL.NS", [{ symbol: "BEL.NS", name: "Bharat Electronics Limited" }, { symbol: "BDL.NS", name: "Bharat Dynamics Limited" }]],
]);
const marketCaps = new Map([["HAL.NS", 20000], ["BEL.NS", 15000]]); // USD millions

describe("entity resolution", () => {
  it("treats a headline company as the subject, not a passing mention", () => {
    const r = resolveEntities(
      "HAL wins Rs 8,000 crore order from Defence Ministry",
      "The contract covers aircraft supply.", index);
    const hal = r.find((e) => e.symbol === "HAL.NS");
    expect(hal?.role).toBe("primary");
    expect(hal!.salience).toBeGreaterThan(0.5);
  });

  it("demotes companies that only appear deep in a roundup", () => {
    const body = "Among defence stocks, analysts also tracked " + "filler ".repeat(60) + " Bharat Dynamics Limited today.";
    const r = resolveEntities("Defence stocks in focus", body, index);
    const bdl = r.find((e) => e.symbol === "BDL.NS");
    expect(bdl?.role).toBe("mentioned");
  });

  it("strips legal suffixes when canonicalising", () => {
    expect(canonical("Hindustan Aeronautics Limited")).toBe("Hindustan Aeronautics");
    expect(canonical("Acme Corp.")).toBe("Acme");
  });

  it("does not invent companies that are absent", () => {
    const r = resolveEntities("RBI holds repo rate steady", "The MPC voted unanimously.", index);
    expect(r.length).toBe(0);
  });
});

describe("amount extraction", () => {
  it("converts crore to USD millions", () => {
    // 8,000 crore = 80bn INR; at 88/USD that is ~909 USD mn
    const a = extractAmount("HAL wins Rs 8,000 crore order");
    expect(a!.usdMillion).toBeGreaterThan(880);
    expect(a!.usdMillion).toBeLessThan(940);
  });

  it("treats rupee billions as rupees, not dollars", () => {
    const a = extractAmount("Company raises Rs 5 billion via NCDs");
    expect(a!.usdMillion).toBeGreaterThan(50);
    expect(a!.usdMillion).toBeLessThan(65);
  });

  it("keeps dollar billions as dollars", () => {
    const a = extractAmount("Deal valued at $5 billion in cash");
    expect(a!.usdMillion).toBe(5000);
  });

  it("prefers the deal size over a valuation figure", () => {
    const a = extractAmount("Startup raises Rs 500 crore at a valuation of Rs 10,000 crore");
    expect(a!.isValuation).toBe(false);
    expect(a!.usdMillion).toBeLessThan(100);
  });
});

describe("event detection", () => {
  it("detects an order win", () => {
    const e = detectEvents("BEL bags Rs 2,500 crore order from Indian Army");
    expect(e[0].type).toBe("order-win");
    expect(e[0].polarity).toBe("positive");
  });

  it("detects enforcement as negative", () => {
    const e = detectEvents("SEBI imposes penalty on the company for disclosure lapses");
    expect(e[0].type).toBe("enforcement");
    expect(e[0].polarity).toBe("negative");
  });

  it("detects regulatory approval", () => {
    const e = detectEvents("Sun Pharma receives USFDA approval for generic drug");
    expect(e.some((x) => x.type === "approval")).toBe(true);
  });

  it("returns nothing for a story with no corporate event", () => {
    expect(detectEvents("Mumbai weather update for the weekend")).toHaveLength(0);
  });

  it("pulls out the counterparty", () => {
    const text = "HAL wins Rs 8,000 crore order from the Ministry of Defence";
    const ev = detectEvents(text);
    expect(extractCounterparty(text, ev[0].trigger)).toMatch(/Ministry/i);
  });
});

describe("understanding", () => {
  const ctx = { index, marketCaps, peers };

  it("produces a readable summary with size context", () => {
    const u = understand({
      id: "1", title: "HAL wins Rs 8,000 crore order from Ministry of Defence",
      body: "The order covers aircraft supply over five years.",
      source: "Economic Times", url: "x", trust: 0.8,
    }, ctx);

    expect(u.event!.type).toBe("order-win");
    expect(u.primary[0].symbol).toBe("HAL.NS");
    expect(u.materiality.sizeVsMcapPct).toBeGreaterThan(0);
    expect(u.summary).toMatch(/HAL|Hindustan/i);
    expect(u.summary).toMatch(/market value/i);
  });

  it("reads a rival's win as competitive pressure on peers", () => {
    const u = understand({
      id: "2", title: "HAL wins Rs 8,000 crore order", body: "",
      source: "ET", url: "x", trust: 0.8,
    }, ctx);

    const peer = u.implications.find((i) => i.symbol === "BEL.NS");
    expect(peer?.relation).toBe("sector-peer");
    expect(peer?.direction).toBe("negative");
    const subject = u.implications.find((i) => i.symbol === "HAL.NS");
    expect(subject?.direction).toBe("positive");
  });

  it("scores a big single-company deal above a vague roundup", () => {
    const big = understand({
      id: "3", title: "HAL wins Rs 8,000 crore order from Ministry of Defence",
      body: "", source: "ET", url: "x", trust: 0.85 }, ctx);
    const vague = understand({
      id: "4", title: "Defence stocks in focus today",
      body: "Traders watched the sector.", source: "blog", url: "x", trust: 0.3 }, ctx);
    expect(big.materiality.score).toBeGreaterThan(vague.materiality.score + 25);
  });

  it("always explains why it scored what it did", () => {
    const u = understand({ id: "5", title: "BEL bags Rs 500 crore order", body: "", source: "ET", url: "x" }, ctx);
    expect(u.materiality.drivers.length).toBeGreaterThan(1);
    expect(u.implications.every((i) => i.why.length > 10)).toBe(true);
  });

  it("degrades gracefully on an article about nothing", () => {
    const u = understand({ id: "6", title: "Weekend market wrap", body: "Quiet session.", source: "x", url: "y" }, ctx);
    expect(u.event).toBeNull();
    expect(u.primary).toHaveLength(0);
    expect(u.materiality.band).toBe("low");
    expect(u.summary.length).toBeGreaterThan(5);
  });
});

describe("attribution guards", () => {
  const ctx = { index, marketCaps, peers };

  it("does not pin a global parent's deal on the Indian subsidiary", () => {
    const idx = buildIndex(
      [{ symbol: "SANOFI.NS", name: "Sanofi India Limited", industry: "Pharma", market: "IN", core: true }],
      { "SANOFI.NS": ["Sanofi"] });
    const u = understand({
      id: "p1",
      title: "Sanofi strikes $41 billion deal to acquire US drugmaker Insmed",
      body: "The French group said the transaction would close next year.",
      source: "Reuters", url: "x", trust: 0.85,
    }, { index: idx });

    expect(u.primary.find((p) => p.symbol === "SANOFI.NS")).toBeUndefined();
    const m = u.mentioned.find((p) => p.symbol === "SANOFI.NS");
    expect(m?.parentStory).toBe(true);
  });

  it("still attributes a genuine India story to the Indian entity", () => {
    const idx = buildIndex(
      [{ symbol: "SANOFI.NS", name: "Sanofi India Limited", industry: "Pharma", market: "IN", core: true }],
      { "SANOFI.NS": ["Sanofi"] });
    const u = understand({
      id: "p2",
      title: "Sanofi India wins approval for new plant in Mumbai",
      body: "The company said the Rs 400 crore facility will start next year.",
      source: "ET", url: "x", trust: 0.8,
    }, { index: idx });
    expect(u.primary.some((p) => p.symbol === "SANOFI.NS")).toBe(true);
  });

  it("refuses to pin an amount to one company in a round-up", () => {
    const u = understand({
      id: "r1",
      title: "INDIA ROUND-UP: Waaree wins 300MW EPC contract, Gujarat bags Rs 2,000 crore order",
      body: "Several renewable names were active.", source: "trade", url: "x", trust: 0.5,
    }, ctx);

    expect(u.isRoundup).toBe(true);
    expect(u.amount).toBeNull();
    expect(u.primary).toHaveLength(0);
  });

  it("detects a wrap from two companies each with their own verb", () => {
    const u = understand({
      id: "r2",
      title: "HAL wins order, Reliance gains 3% on results",
      body: "", source: "x", url: "y", trust: 0.6,
    }, ctx);
    expect(u.isRoundup).toBe(true);
  });

  it("leaves a normal single-company story alone", () => {
    const u = understand({
      id: "r3", title: "HAL wins Rs 8,000 crore order from Ministry of Defence",
      body: "", source: "ET", url: "x", trust: 0.8 }, ctx);
    expect(u.isRoundup).toBe(false);
    expect(u.primary[0].symbol).toBe("HAL.NS");
    expect(u.amount).not.toBeNull();
  });
});

describe("counterparty filtering", () => {
  it("does not report a month as the counterparty", () => {
    const text = "L&T bags order worth Rs 5,000 crore from July deliveries onward";
    const ev = detectEvents(text);
    expect(extractCounterparty(text, ev[0].trigger)).toBeNull();
  });

  it("still finds a real organisation", () => {
    const text = "BEML secures Rs 5,400 crore order from NHSRCL for the corridor";
    const ev = detectEvents(text);
    expect(extractCounterparty(text, ev[0].trigger)).toMatch(/NHSRCL/);
  });

  it("rejects a bare number as a counterparty", () => {
    const text = "Company wins contract from 2026 onwards";
    const ev = detectEvents(text);
    expect(extractCounterparty(text, ev[0].trigger)).toBeNull();
  });
});
