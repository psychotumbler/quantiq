/**
 * National Stock Exchange of India — official market data.
 *
 * Endpoints on `www.nseindia.com/api`, all confirmed reachable from a local
 * machine on 2026-11-17 with a plain browser User-Agent, Accept and Referer:
 *
 *   allIndices                         every NSE index: level, % change, P/E,
 *                                      advances/declines
 *   live-analysis-variations           top gainers and losers
 *   fiidiiTradeReact                   FII and DII cash-market flows
 *   corporate-announcements            exchange filings, incl. order wins
 *   corporate-share-holdings-master    quarterly promoter / public holding
 *
 * These power NSE's own website and are not a published, supported API: the
 * shapes can change and NSE may refuse datacenter IPs. Every call fails soft
 * and is cached, so the dashboard degrades to "unavailable" rather than
 * breaking.
 */

import axios from "axios";

const BASE = "https://www.nseindia.com/api";
const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json",
  Referer: "https://www.nseindia.com/",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const cache = new Map<string, { at: number; value: Json }>();

async function nseGet(path: string, ttlMs: number): Promise<Json> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const { data } = await axios.get(`${BASE}/${path}`, { timeout: 15_000, headers: HEADERS });
    // A block page arrives as HTML with status 200.
    if (typeof data === "string") throw new Error("non-JSON body");
    cache.set(path, { at: Date.now(), value: data });
    return data;
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[nse] ${path.split("?")[0]} failed${status ? ` (HTTP ${status})` : ""}`);
    return hit?.value ?? null;
  }
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** `17-Nov-2026 12:55:28` (IST) → ISO 8601 UTC. `""` if unparseable. Exported for tests. */
export function parseNseTime(text: unknown): string {
  const m = String(text ?? "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (!m || !month) return "";
  const ms = Date.parse(`${m[3]}-${month}-${m[1]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+05:30`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** `30-SEP-2026` → `2026-09-30`, with no timezone shift. `""` if unparseable. */
export function parseNseDate(text: unknown): string {
  const m = String(text ?? "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4})/);
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  return m && month ? `${m[3]}-${month}-${m[1]}` : "";
}

/* ------------------------------------------------------------------ */
/* Market pulse                                                        */
/* ------------------------------------------------------------------ */

export interface SectorMove {
  name: string;
  /** Decimal fractions: 0.012 is +1.2%. */
  change: number | null;
  change30d: number | null;
  change1y: number | null;
  pe: number | null;
}

export interface Mover {
  symbol: string;
  price: number | null;
  change: number | null;
}

export interface FlowDay {
  category: string;
  date: string;
  /** ₹ crore. */
  buy: number | null;
  sell: number | null;
  net: number | null;
}

export interface IndiaPulse {
  asOf: string;
  breadth: { advances: number; declines: number; unchanged: number } | null;
  /** Nifty 50 trailing P/E, P/B and dividend yield (%), as published by NSE. */
  valuation: { pe: number | null; pb: number | null; dividendYield: number | null } | null;
  sectors: SectorMove[];
  gainers: Mover[];
  losers: Mover[];
  flows: FlowDay[];
}

const pct = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : n / 100;
};

/** Short display name: "NIFTY PSU BANK" → "PSU Bank". */
function sectorLabel(index: string): string {
  return index
    .replace(/^NIFTY500\s+|^NIFTY\s+/i, "")
    .replace(/\s+INDEX$/i, "")
    .replace(/\s+25\/50$/, "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bIt\b/, "IT").replace(/\bFmcg\b/, "FMCG").replace(/\bPsu\b/, "PSU")
    .replace(/\bReits\b/, "REITs");
}

/** Sector indices that duplicate a broader one already shown. */
const SKIP_SECTOR = /MIDSMALL|NIFTY500|EX-BANK|REITS/i;

/** Build the pulse from raw bodies. Pure; exported for tests. */
export function buildPulse(all: Json, gainers: Json, losers: Json, flows: Json): IndiaPulse {
  const rows: Json[] = Array.isArray(all?.data) ? all.data : [];
  const nifty = rows.find((r) => r?.index === "NIFTY 50");

  const movers = (body: Json): Mover[] =>
    (Array.isArray(body?.NIFTY?.data) ? body.NIFTY.data : []).slice(0, 8).map((r: Json) => ({
      symbol: `${String(r?.symbol ?? "")}.NS`,
      price: num(r?.ltp),
      change: pct(r?.perChange ?? r?.net_price),
    }));

  const advances = num(all?.advances);
  const declines = num(all?.declines);

  return {
    asOf: parseNseTime(all?.timestamp),
    breadth:
      advances === null || declines === null
        ? null
        : { advances, declines, unchanged: num(all?.unchanged) ?? 0 },
    valuation: nifty
      ? { pe: num(nifty.pe), pb: num(nifty.pb), dividendYield: num(nifty.dy) }
      : null,
    sectors: rows
      .filter((r) => r?.key === "SECTORAL INDICES" && !SKIP_SECTOR.test(String(r?.index)))
      .map((r) => ({
        name: sectorLabel(String(r.index)),
        change: pct(r.percentChange),
        change30d: pct(r.perChange30d),
        change1y: pct(r.perChange365d),
        pe: num(r.pe),
      })),
    gainers: movers(gainers),
    losers: movers(losers),
    flows: (Array.isArray(flows) ? flows : []).map((r: Json) => ({
      category: String(r?.category ?? ""),
      date: String(r?.date ?? ""),
      buy: num(r?.buyValue),
      sell: num(r?.sellValue),
      net: num(r?.netValue),
    })),
  };
}

export async function getIndiaPulse(): Promise<IndiaPulse | null> {
  const [all, gainers, losers, flows] = await Promise.all([
    nseGet("allIndices", 2 * 60_000),
    nseGet("live-analysis-variations?index=gainers", 2 * 60_000),
    // NSE's own spelling.
    nseGet("live-analysis-variations?index=loosers", 2 * 60_000),
    nseGet("fiidiiTradeReact", 30 * 60_000),
  ]);
  if (!all) return null;
  return buildPulse(all, gainers, losers, flows);
}

/* ------------------------------------------------------------------ */
/* Shareholding                                                        */
/* ------------------------------------------------------------------ */

export interface HoldingQuarter {
  /** Quarter end, `YYYY-MM-DD`. */
  date: string;
  /** Percent of shares held by promoters and promoter group. */
  promoter: number;
  public: number;
}

/** Newest first, de-duplicated by quarter. Pure; exported for tests. */
export function parseShareholding(body: Json): HoldingQuarter[] {
  const seen = new Set<string>();
  return (Array.isArray(body) ? body : [])
    .map((r: Json) => ({
      date: parseNseDate(r?.date),
      promoter: num(r?.pr_and_prgrp),
      public: num(r?.public_val),
    }))
    .filter(
      (q): q is HoldingQuarter =>
        q.date !== "" && q.promoter !== null && q.public !== null &&
        (seen.has(q.date) ? false : (seen.add(q.date), true)),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12);
}

/** `RELIANCE.NS` / `RELIANCE.BO` → `RELIANCE`; `null` for non-Indian tickers. */
export function nseSymbol(symbol: string): string | null {
  const m = symbol.toUpperCase().match(/^([A-Z0-9&-]+)\.(NS|BO)$/);
  return m ? m[1] : null;
}

export async function getShareholding(symbol: string): Promise<HoldingQuarter[]> {
  const root = nseSymbol(symbol);
  if (!root) return [];
  const body = await nseGet(
    `corporate-share-holdings-master?symbol=${encodeURIComponent(root)}&index=equities`,
    12 * 60 * 60_000,
  );
  return parseShareholding(body);
}

/* ------------------------------------------------------------------ */
/* Exchange filings                                                    */
/* ------------------------------------------------------------------ */

export interface Filing {
  symbol: string;
  company: string;
  industry: string;
  /** NSE's own category, e.g. "Bagging/Receiving of orders/contracts". */
  category: string;
  text: string;
  /** Link to the filed PDF on NSE's archive. */
  url: string;
  publishedAt: string;
}

/** Categories that report a commercial event rather than routine compliance. */
export const MATERIAL_FILING =
  /^(bagging|awarding)\b.*order|^acquisition|^agreements?$|execution of .*agreement|joint venture|^fund ?raising|raising of funds|capacity addition|^press release/i;

/** Pure; exported for tests. */
export function parseFilings(body: Json): Filing[] {
  return (Array.isArray(body) ? body : [])
    .map((r: Json) => {
      const company = String(r?.sm_name ?? "").trim();
      // "X Limited has informed the Exchange about …" → keep the substance.
      const text = String(r?.attchmntText ?? "")
        .replace(/^.*?has informed the exchange (?:about|regarding|that)\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        symbol: `${String(r?.symbol ?? "").toUpperCase()}.NS`,
        company,
        industry: String(r?.smIndustry ?? "").replace(/^null$/, ""),
        category: String(r?.desc ?? "").trim(),
        text: text.charAt(0).toUpperCase() + text.slice(1),
        url: String(r?.attchmntFile ?? ""),
        publishedAt: parseNseTime(r?.an_dt),
      };
    })
    .filter((f) => f.symbol !== ".NS" && f.company !== "" && /^https?:\/\//.test(f.url));
}

function ddmmyyyy(date: Date): string {
  // Format in IST, the exchange's calendar.
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  return `${String(ist.getUTCDate()).padStart(2, "0")}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${ist.getUTCFullYear()}`;
}

/** Material filings across the whole exchange for the last `days` days. */
export async function getMarketFilings(days = 5): Promise<Filing[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const body = await nseGet(
    `corporate-announcements?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(now)}`,
    15 * 60_000,
  );
  return parseFilings(body).filter((f) => MATERIAL_FILING.test(f.category));
}

/** The most recent filings for one company, any category. */
export async function getCompanyFilings(symbol: string, limit = 12): Promise<Filing[]> {
  const root = nseSymbol(symbol);
  if (!root) return [];
  const body = await nseGet(
    `corporate-announcements?index=equities&symbol=${encodeURIComponent(root)}`,
    30 * 60_000,
  );
  return parseFilings(body).slice(0, limit);
}
