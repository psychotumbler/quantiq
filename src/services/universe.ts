/**
 * The equity universe: every company listed on NSE, plus large US names.
 *
 * Sources, both official NSE files confirmed reachable on 2026-11-17:
 *   - `ind_nifty500list.csv` — the Nifty 500 with each company's industry
 *   - `EQUITY_L.csv`         — all ~2,600 listed equities (no industry)
 * Cached for a day; if the downloads fail, a short built-in list of the
 * largest names keeps search and news matching working.
 *
 * Used for ticker search (Yahoo's index is patchy for Indian names) and by
 * the news engine to recognise companies and their industries.
 */

import axios from "axios";
import { splitCsvLine } from "@/lib/portfolioCsv";

export interface ListedCompany {
  /** Yahoo-style ticker, e.g. `RELIANCE.NS`. */
  symbol: string;
  name: string;
  industry: string;
  market: "IN" | "US";
  /**
   * In the Nifty 500 (or the curated US list). Core names are matched in news
   * by their short name; the long tail must be named in full.
   */
  core: boolean;
}

/** Every NSE-listed equity: symbol and registered name, no industry. */
const ALL_LISTED_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

const NIFTY500_URL =
  "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv";

/** Used only when the NSE file cannot be downloaded. */
const FALLBACK_IN: [string, string, string][] = [
  ["RELIANCE", "Reliance Industries Ltd.", "Oil Gas & Consumable Fuels"],
  ["TCS", "Tata Consultancy Services Ltd.", "Information Technology"],
  ["HDFCBANK", "HDFC Bank Ltd.", "Financial Services"],
  ["ICICIBANK", "ICICI Bank Ltd.", "Financial Services"],
  ["INFY", "Infosys Ltd.", "Information Technology"],
  ["BHARTIARTL", "Bharti Airtel Ltd.", "Telecommunication"],
  ["SBIN", "State Bank of India", "Financial Services"],
  ["ITC", "ITC Ltd.", "Fast Moving Consumer Goods"],
  ["LT", "Larsen & Toubro Ltd.", "Construction"],
  ["HINDUNILVR", "Hindustan Unilever Ltd.", "Fast Moving Consumer Goods"],
  ["BAJFINANCE", "Bajaj Finance Ltd.", "Financial Services"],
  ["KOTAKBANK", "Kotak Mahindra Bank Ltd.", "Financial Services"],
  ["AXISBANK", "Axis Bank Ltd.", "Financial Services"],
  ["MARUTI", "Maruti Suzuki India Ltd.", "Automobile and Auto Components"],
  ["SUNPHARMA", "Sun Pharmaceutical Industries Ltd.", "Healthcare"],
  ["TATAMOTORS", "Tata Motors Ltd.", "Automobile and Auto Components"],
  ["NTPC", "NTPC Ltd.", "Power"],
  ["ONGC", "Oil & Natural Gas Corporation Ltd.", "Oil Gas & Consumable Fuels"],
  ["ADANIENT", "Adani Enterprises Ltd.", "Metals & Mining"],
  ["HAL", "Hindustan Aeronautics Ltd.", "Capital Goods"],
  ["BEL", "Bharat Electronics Ltd.", "Capital Goods"],
  ["WIPRO", "Wipro Ltd.", "Information Technology"],
  ["TATASTEEL", "Tata Steel Ltd.", "Metals & Mining"],
  ["POWERGRID", "Power Grid Corporation of India Ltd.", "Power"],
];

/** Large US names, for news matching. Search for US tickers goes to Finnhub. */
const US_NAMES: [string, string, string][] = [
  ["AAPL", "Apple", "Technology"], ["MSFT", "Microsoft", "Technology"],
  ["NVDA", "Nvidia", "Semiconductors"], ["GOOGL", "Alphabet", "Technology"],
  ["AMZN", "Amazon", "Consumer & Cloud"], ["META", "Meta Platforms", "Technology"],
  ["TSLA", "Tesla", "Automobile"], ["AMD", "Advanced Micro Devices", "Semiconductors"],
  ["AVGO", "Broadcom", "Semiconductors"], ["TSM", "Taiwan Semiconductor", "Semiconductors"],
  ["INTC", "Intel", "Semiconductors"], ["MU", "Micron", "Semiconductors"],
  ["ORCL", "Oracle", "Technology"], ["CRM", "Salesforce", "Technology"],
  ["PLTR", "Palantir", "Technology"], ["NFLX", "Netflix", "Media"],
  ["JPM", "JPMorgan", "Financial Services"], ["GS", "Goldman Sachs", "Financial Services"],
  ["BAC", "Bank of America", "Financial Services"], ["XOM", "Exxon Mobil", "Oil & Gas"],
  ["CVX", "Chevron", "Oil & Gas"], ["LLY", "Eli Lilly", "Healthcare"],
  ["PFE", "Pfizer", "Healthcare"], ["JNJ", "Johnson & Johnson", "Healthcare"],
  ["UNH", "UnitedHealth", "Healthcare"], ["BA", "Boeing", "Aerospace & Defence"],
  ["LMT", "Lockheed Martin", "Aerospace & Defence"], ["RTX", "RTX", "Aerospace & Defence"],
  ["WMT", "Walmart", "Retail"], ["COST", "Costco", "Retail"],
  ["VRT", "Vertiv", "Capital Goods"], ["GEV", "GE Vernova", "Power"],
  ["CEG", "Constellation Energy", "Power"], ["NEE", "NextEra Energy", "Power"],
];

/** Parse NSE's constituent CSV. Pure; exported for tests. */
export function parseNseList(csv: string): ListedCompany[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const nameAt = header.findIndex((h) => h.startsWith("company"));
  const industryAt = header.findIndex((h) => h.startsWith("industry"));
  const symbolAt = header.findIndex((h) => h === "symbol");
  if (nameAt === -1 || symbolAt === -1) return [];

  return lines
    .slice(1)
    .map(splitCsvLine)
    .filter((cells) => /^[A-Z0-9&-]+$/.test(cells[symbolAt] ?? ""))
    .map((cells) => ({
      symbol: `${cells[symbolAt]}.NS`,
      name: cells[nameAt] ?? cells[symbolAt],
      industry: industryAt === -1 ? "" : (cells[industryAt] ?? ""),
      market: "IN" as const,
      core: true,
    }));
}

/** Parse NSE's full equity list (`EQUITY_L.csv`). Pure; exported for tests. */
export function parseAllListed(csv: string): ListedCompany[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const symbolAt = header.findIndex((h) => h === "symbol");
  const nameAt = header.findIndex((h) => h.startsWith("name"));
  if (symbolAt === -1 || nameAt === -1) return [];

  return lines
    .slice(1)
    .map(splitCsvLine)
    .filter((cells) => /^[A-Z0-9&-]+$/.test(cells[symbolAt] ?? "") && cells[nameAt])
    .map((cells) => ({
      symbol: `${cells[symbolAt]}.NS`,
      name: cells[nameAt],
      industry: "",
      market: "IN" as const,
      core: false,
    }));
}

const US_LIST: ListedCompany[] = US_NAMES.map(([symbol, name, industry]) => ({
  symbol, name, industry, market: "US", core: true,
}));
const FALLBACK_LIST: ListedCompany[] = FALLBACK_IN.map(([symbol, name, industry]) => ({
  symbol: `${symbol}.NS`, name, industry, market: "IN", core: true,
}));

const TTL_MS = 24 * 60 * 60 * 1000;
let cached: { at: number; value: Promise<ListedCompany[]> } | null = null;

/** Indian constituents first, then the US name list. */
export function getUniverse(): Promise<ListedCompany[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const download = async (url: string): Promise<string> => {
    try {
      const { data } = await axios.get(url, {
        timeout: 20_000,
        responseType: "text",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      return String(data);
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : null;
      console.error(`[universe] ${url.split("/").pop()} failed${status ? ` (HTTP ${status})` : ""}`);
      return "";
    }
  };

  const value = (async () => {
    const [nifty500Csv, allCsv] = await Promise.all([
      download(NIFTY500_URL),
      download(ALL_LISTED_URL),
    ]);
    let core = parseNseList(nifty500Csv);
    if (core.length <= 50) {
      console.error("[universe] Nifty 500 list unavailable; using the built-in fallback");
      core = FALLBACK_LIST;
      // Retry sooner than a day after a failure.
      if (cached) cached.at = Date.now() - TTL_MS + 10 * 60 * 1000;
    }
    const known = new Set(core.map((c) => c.symbol));
    const tail = parseAllListed(allCsv).filter((c) => !known.has(c.symbol));
    return [...core, ...tail, ...US_LIST];
  })();

  cached = { at: Date.now(), value };
  return value;
}

/** Rank universe matches for a search box: symbol prefix, then name prefix, then contains. */
export function searchUniverse(list: ListedCompany[], query: string, limit = 8): ListedCompany[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored: { rank: number; company: ListedCompany }[] = [];
  for (const company of list) {
    const symbol = company.symbol.toLowerCase().replace(/\.ns$/, "");
    const name = company.name.toLowerCase();
    const rank =
      symbol === q ? 0
      : symbol.startsWith(q) ? 1
      : name.startsWith(q) ? 2
      : name.split(/\s+/).some((word) => word.startsWith(q)) ? 3
      : name.includes(q) ? 4
      : -1;
    if (rank >= 0) scored.push({ rank, company });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, limit).map((s) => s.company);
}
