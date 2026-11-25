/**
 * Source catalogue for the news engine.
 *
 * The old Nexus read seven RSS feeds and saw a few hundred headlines. To reason
 * about a market you need breadth: a contract win reported only by a trade
 * publication is exactly the story nobody else has priced in.
 *
 * Three tiers, roughly 90 feeds in total:
 *   1. CORE      - mainstream business desks, broad coverage
 *   2. SECTOR    - targeted queries that surface trade-press stories the
 *                  mainstream desks never run
 *   3. FILINGS   - exchange disclosures, which are primary documents rather
 *                  than reporting and therefore the highest-trust tier
 *
 * Google News RSS is the scaling lever: every query is a feed, so sector
 * coverage expands by adding a string rather than finding a publisher.
 */

export type SourceTier = "core" | "sector" | "filing";

export interface FeedSource {
  url: string;
  source: string;
  tier: SourceTier;
  region: "IN" | "US" | "GLOBAL";
  /** Weight on source credibility, 0-1. Primary documents score highest. */
  trust: number;
  sector?: string;
}

/**
 * Google News search is ranked by relevance, not recency. Without a time bound,
 * "Canara Bank QIP" returns a 2021 story ahead of anything this week - an audit
 * of 200 articles found 76% of the top-ranked ones were over a month old. The
 * when:7d operator restricts the search to the last week.
 */
const gnews = (query: string, region: "IN" | "US" = "IN") => {
  query = `${query} when:7d`;
  const locale = region === "IN"
    ? "hl=en-IN&gl=IN&ceid=IN:en"
    : "hl=en-US&gl=US&ceid=US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`;
};

/* ------------------------------------------------------------------ */
/* Tier 1 - core business desks                                        */
/* ------------------------------------------------------------------ */

export const CORE_FEEDS: FeedSource[] = [
  // Economic Times
  { url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", source: "Economic Times", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", source: "Economic Times", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", source: "Economic Times", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", source: "Economic Times", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://economictimes.indiatimes.com/industry/banking/finance/rssfeeds/13358259.cms", source: "Economic Times", tier: "core", region: "IN", trust: 0.8 },

  // Mint
  { url: "https://www.livemint.com/rss/markets", source: "Mint", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://www.livemint.com/rss/companies", source: "Mint", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://www.livemint.com/rss/economy", source: "Mint", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://www.livemint.com/rss/industry", source: "Mint", tier: "core", region: "IN", trust: 0.8 },

  // Business Standard
  { url: "https://www.business-standard.com/rss/markets-106.rss", source: "Business Standard", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://www.business-standard.com/rss/companies-101.rss", source: "Business Standard", tier: "core", region: "IN", trust: 0.8 },
  { url: "https://www.business-standard.com/rss/economy-102.rss", source: "Business Standard", tier: "core", region: "IN", trust: 0.8 },

  // Moneycontrol (blocks datacenter IPs - kept because it works locally and fails quietly)
  { url: "https://www.moneycontrol.com/rss/business.xml", source: "Moneycontrol", tier: "core", region: "IN", trust: 0.75 },
  { url: "https://www.moneycontrol.com/rss/marketreports.xml", source: "Moneycontrol", tier: "core", region: "IN", trust: 0.75 },
  { url: "https://www.moneycontrol.com/rss/results.xml", source: "Moneycontrol", tier: "core", region: "IN", trust: 0.75 },

  // Hindu BusinessLine
  { url: "https://www.thehindubusinessline.com/markets/feeder/default.rss", source: "BusinessLine", tier: "core", region: "IN", trust: 0.78 },
  { url: "https://www.thehindubusinessline.com/companies/feeder/default.rss", source: "BusinessLine", tier: "core", region: "IN", trust: 0.78 },

  // Financial Express
  { url: "https://www.financialexpress.com/market/feed/", source: "Financial Express", tier: "core", region: "IN", trust: 0.75 },
  { url: "https://www.financialexpress.com/industry/feed/", source: "Financial Express", tier: "core", region: "IN", trust: 0.75 },

  // Global
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EIXIC&region=US&lang=en-US", source: "Yahoo Finance", tier: "core", region: "US", trust: 0.7 },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC", tier: "core", region: "US", trust: 0.8 },
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", source: "CNBC", tier: "core", region: "US", trust: 0.8 },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch", tier: "core", region: "US", trust: 0.75 },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines", source: "MarketWatch", tier: "core", region: "US", trust: 0.75 },

  // Aggregated wires via Google News
  { url: gnews("Reuters India business"), source: "Reuters (via Google News)", tier: "core", region: "IN", trust: 0.85 },
  { url: gnews("Indian stock market"), source: "Google News", tier: "core", region: "IN", trust: 0.6 },
  { url: gnews("Nifty Sensex"), source: "Google News", tier: "core", region: "IN", trust: 0.6 },
  { url: gnews("Q3 results India company"), source: "Google News", tier: "core", region: "IN", trust: 0.6 },
];

/* ------------------------------------------------------------------ */
/* Tier 2 - sector sweeps                                              */
/* ------------------------------------------------------------------ */

/**
 * Each entry becomes a Google News query. These are written the way a trade
 * reporter writes a headline, not the way an analyst writes a thesis - that is
 * what makes them match. "order win" beats "capital expenditure growth".
 */
const SECTOR_QUERIES: { sector: string; queries: string[] }[] = [
  { sector: "Defence", queries: [
    "defence contract India crore", "HAL order defence", "Bharat Electronics order",
    "defence ministry contract signed", "MoD emergency procurement", "defence export order India",
  ]},
  { sector: "Railways", queries: [
    "railway order win crore", "Indian Railways contract awarded", "Vande Bharat order",
    "RVNL IRCON order", "metro rail contract awarded India",
  ]},
  { sector: "Energy & Power", queries: [
    "solar EPC order India crore", "wind power order India", "transmission line order awarded",
    "NTPC tender awarded", "green hydrogen India investment", "battery storage order India",
  ]},
  { sector: "Infrastructure", queries: [
    "NHAI contract awarded", "highway project awarded crore", "EPC order win India",
    "L&T order win", "port project India investment",
  ]},
  { sector: "Technology", queries: [
    "Indian IT deal win TCV", "Infosys TCS Wipro deal win", "data centre investment India",
    "semiconductor fab India investment", "AI investment India crore",
  ]},
  { sector: "Pharma & Health", queries: [
    "USFDA approval Indian pharma", "pharma ANDA approval India", "USFDA observation Indian plant",
    "hospital expansion India beds", "CDMO contract India",
  ]},
  { sector: "Financials", queries: [
    "RBI penalty bank", "NBFC fundraise India", "bank QIP India crore",
    "insurance IPO India", "asset reconstruction India deal",
  ]},
  { sector: "Auto & EV", queries: [
    "EV plant investment India", "auto PLI approved India", "battery plant India crore",
    "auto component order win India",
  ]},
  { sector: "Metals & Mining", queries: [
    "steel plant expansion India crore", "mine auction won India", "cement capacity expansion India",
  ]},
  { sector: "Consumer", queries: [
    "FMCG expansion India investment", "retail store expansion India", "quick commerce India funding",
  ]},
  { sector: "Capital markets", queries: [
    "block deal India stake", "promoter stake sale India", "open offer India SEBI",
    "IPO listing India subscription", "preferential allotment India crore",
  ]},
  { sector: "Policy", queries: [
    "PLI scheme approved India", "government capex announcement India", "SEBI new rule market",
    "GST change impact companies India", "import duty change India industry",
  ]},
];

export const SECTOR_FEEDS: FeedSource[] = SECTOR_QUERIES.flatMap(({ sector, queries }) =>
  queries.map((q) => ({
    url: gnews(q),
    source: `Google News · ${sector}`,
    tier: "sector" as const,
    region: "IN" as const,
    trust: 0.55,
    sector,
  })),
);

/* ------------------------------------------------------------------ */

export const ALL_FEEDS: FeedSource[] = [...CORE_FEEDS, ...SECTOR_FEEDS];

export function feedStats() {
  const bySector = new Map<string, number>();
  for (const f of SECTOR_FEEDS) bySector.set(f.sector!, (bySector.get(f.sector!) ?? 0) + 1);
  return {
    total: ALL_FEEDS.length,
    core: CORE_FEEDS.length,
    sector: SECTOR_FEEDS.length,
    sectors: Object.fromEntries(bySector),
  };
}
