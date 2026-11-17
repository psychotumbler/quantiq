/**
 * News Nexus — gathers business headlines from several public RSS feeds and
 * maps them onto themes, the listed companies they name, and any deals they
 * report. The reading is done by the deterministic rules in
 * `analysis/themes.ts`; see that file for what this can and cannot infer.
 *
 * Sources:
 *   - NSE corporate announcements — the companies' own exchange filings, the
 *     authoritative record of order wins, acquisitions and fundraises.
 *   - Public RSS feeds, no key: Economic Times, Moneycontrol, Mint, Yahoo
 *     Finance, and Google News searches aimed at orders and contracts.
 */

import { scoreHeadline } from "@/analysis/sentiment";
import {
  buildMatchers,
  amountIn,
  companiesIn,
  dealIn,
  dealKindForFiling,
  themeForIndustry,
  THEMES,
  themesIn,
  type DealSignal,
  type NamedCompany,
} from "@/analysis/themes";
import { fetchFeedRich, googleFeed, type RichHeadline } from "@/services/news";
import { getUniverse } from "@/services/universe";
import { getMarketFilings, type Filing } from "@/services/nse";

export interface NexusHeadline {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment: number | null;
  themes: string[];
  /** Symbols of companies named in the headline or its summary. */
  companies: string[];
  deal: DealSignal | null;
  /** True for a filing made to the exchange by the company itself. */
  official: boolean;
}

export interface NexusCompany {
  symbol: string;
  name: string;
  industry: string;
  market: "IN" | "US";
  /** Headlines in this theme that name the company. 0 for exposure-only names. */
  mentions: number;
  /** Mean word-list tone of those headlines, or `null`. */
  tone: number | null;
}

export interface NexusTheme {
  id: string;
  label: string;
  count: number;
  tone: number | null;
  headlines: NexusHeadline[];
  /** Named in this theme's headlines. */
  companies: NexusCompany[];
  /** Curated: operates in the theme but was NOT named in the news. */
  exposure: NexusCompany[];
  deals: NexusHeadline[];
  chain: { stage: string; why: string; examples: { symbol: string; name: string }[] }[];
}

export interface NexusData {
  themes: NexusTheme[];
  deals: NexusHeadline[];
  headlineCount: number;
  sources: { name: string; count: number }[];
  generatedAt: string;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}

/** The whole pipeline after download. Pure; exported for tests. */
export function buildNexus(
  raw: RichHeadline[],
  universe: NamedCompany[],
  now: Date = new Date(),
): NexusData {
  const bySymbol = new Map(universe.map((c) => [c.symbol, c]));
  const matchers = buildMatchers(universe);

  // De-duplicate syndicated stories by normalised title.
  const seen = new Set<string>();
  const unique = raw.filter((h) => {
    const key = normaliseTitle(h.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const headlines: NexusHeadline[] = unique
    .map((h) => {
      const text = `${h.title}. ${h.summary}`;
      const official = h.filingCategory !== undefined;

      const themes = themesIn(text);
      // A filing states its company's industry; use it when the text itself
      // carries no theme keyword ("has received an order from a customer").
      const fallback = official && themes.length === 0 ? themeForIndustry(h.industry ?? "") : null;
      if (fallback) themes.push(fallback);

      const named = companiesIn(text, matchers).map((c) => c.symbol);
      const companies = [...new Set([...(h.symbols ?? []), ...named])].filter((s) => bySymbol.has(s));

      const filingKind = official ? dealKindForFiling(h.filingCategory as string) : null;
      return {
        title: h.title,
        url: h.url,
        source: h.source,
        publishedAt: h.publishedAt,
        sentiment: h.sentiment ?? scoreHeadline(h.title),
        themes,
        companies,
        // Deal size is read from the title only: a summary often cites an
        // unrelated figure.
        deal: filingKind ? { kind: filingKind, ...amountIn(h.title) } : dealIn(h.title),
        official,
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const toCompany = (symbol: string, in_: NexusHeadline[]): NexusCompany | null => {
    const company = bySymbol.get(symbol);
    if (!company) return null;
    const naming = in_.filter((h) => h.companies.includes(symbol));
    return {
      symbol,
      name: company.name,
      industry: company.industry,
      market: company.market,
      mentions: naming.length,
      tone: mean(naming.map((h) => h.sentiment).filter((s): s is number => s !== null)),
    };
  };

  const themes: NexusTheme[] = THEMES.map((def) => {
    const own = headlines.filter((h) => h.themes.includes(def.id));
    const mentioned = [...new Set(own.flatMap((h) => h.companies))]
      .map((symbol) => toCompany(symbol, own))
      .filter((c): c is NexusCompany => c !== null)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 14);
    const mentionedSet = new Set(mentioned.map((c) => c.symbol));

    return {
      id: def.id,
      label: def.label,
      count: own.length,
      tone: mean(own.map((h) => h.sentiment).filter((s): s is number => s !== null)),
      headlines: own.slice(0, 14),
      companies: mentioned,
      exposure: def.exposure
        .filter((symbol) => !mentionedSet.has(symbol))
        .map((symbol) => toCompany(symbol, []))
        .filter((c): c is NexusCompany => c !== null)
        .slice(0, 10),
      deals: own.filter((h) => h.deal !== null).slice(0, 8),
      chain: def.chain.map((link) => ({
        stage: link.stage,
        why: link.why,
        examples: link.examples
          .map((symbol) => bySymbol.get(symbol))
          .filter((c): c is NamedCompany => c !== undefined)
          .map((c) => ({ symbol: c.symbol, name: c.name })),
      })),
    };
  })
    .filter((theme) => theme.count > 0)
    .sort((a, b) => b.count - a.count);

  const deals = headlines
    .filter((h) => h.deal !== null)
    .sort(
      (a, b) =>
        (b.deal!.usdMillion ?? -1) - (a.deal!.usdMillion ?? -1) ||
        b.publishedAt.localeCompare(a.publishedAt),
    )
    .slice(0, 40);

  const counts = new Map<string, number>();
  for (const h of unique) counts.set(h.source, (counts.get(h.source) ?? 0) + 1);

  return {
    themes,
    deals,
    headlineCount: headlines.length,
    sources: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    generatedAt: now.toISOString(),
  };
}

const FEEDS: { url: string; source: string }[] = [
  { url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", source: "Economic Times" },
  { url: "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", source: "Economic Times" },
  { url: "https://www.moneycontrol.com/rss/business.xml", source: "Moneycontrol" },
  { url: "https://www.moneycontrol.com/rss/marketreports.xml", source: "Moneycontrol" },
  { url: "https://www.livemint.com/rss/markets", source: "Mint" },
  { url: "https://www.livemint.com/rss/companies", source: "Mint" },
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EIXIC&region=US&lang=en-US", source: "Yahoo Finance" },
  { url: googleFeed('"bags order" OR "wins order" OR "order worth" OR "contract worth" crore when:3d', true), source: "Google News" },
  { url: googleFeed('"awarded contract" OR "wins contract" OR "signs deal" billion when:3d', false), source: "Google News" },
  { url: googleFeed("stock market India when:1d", true), source: "Google News" },
  { url: googleFeed("Wall Street stocks when:1d", false), source: "Google News" },
];

/** Turn an exchange filing into a headline the pipeline can read. Exported for tests. */
export function filingToHeadline(filing: Filing): RichHeadline {
  const body = filing.text && filing.text.toLowerCase() !== filing.category.toLowerCase()
    ? filing.text
    : filing.category;
  const title = `${filing.company.replace(/\s+limited$/i, "")}: ${body}`;
  return {
    title: title.length > 240 ? `${title.slice(0, 237)}…` : title,
    url: filing.url,
    source: "NSE filing",
    publishedAt: filing.publishedAt,
    sentiment: null,
    summary: "",
    symbols: [filing.symbol],
    filingCategory: filing.category,
    industry: filing.industry,
  };
}

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; value: Promise<NexusData> } | null = null;

export function getNexus(): Promise<NexusData> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const value = (async () => {
    const [listed, filings, ...batches] = await Promise.all([
      getUniverse(),
      getMarketFilings(5),
      ...FEEDS.map((feed) => fetchFeedRich(feed.url, feed.source)),
    ]);

    // A filing can come from a company missing from the downloaded lists
    // (a new listing, or the fallback list is in use): add it from the filing.
    const universe: NamedCompany[] = [...listed];
    const known = new Set(universe.map((c) => c.symbol));
    for (const filing of filings) {
      if (!known.has(filing.symbol)) {
        known.add(filing.symbol);
        universe.push({
          symbol: filing.symbol, name: filing.company, industry: filing.industry,
          market: "IN", core: false,
        });
      }
    }
    // Filings carry an industry the equity list lacks: fill it in.
    const industryOf = new Map(filings.filter((f) => f.industry).map((f) => [f.symbol, f.industry]));
    for (const company of universe) {
      if (!company.industry && industryOf.has(company.symbol)) {
        company.industry = industryOf.get(company.symbol) as string;
      }
    }

    const data = buildNexus([...filings.map(filingToHeadline), ...batches.flat()], universe);
    // An empty result is a failed download, not news: retry on the next call.
    if (data.headlineCount === 0) cached = null;
    return data;
  })();

  cached = { at: Date.now(), value };
  return value;
}

/** Fabricated headlines for the fixture provider, run through the real pipeline. */
export function sampleNexus(): NexusData {
  const titles = [
    "HAL bags order worth Rs 6,200 crore from Ministry of Defence for fighter jet engines",
    "Bharat Electronics wins Rs 1,150 crore radar contract from the Navy",
    "Nvidia shares rise as AI chip demand lifts data center revenue to a record",
    "Microsoft to invest $3 billion in AI data centres in India",
    "TSMC warns chip export curbs could delay new fab",
    "NTPC wins 1,200 MW solar project in Rajasthan auction",
    "Suzlon secures 400 MW wind energy order; shares jump",
    "Power Grid board approves transmission investment of Rs 3,500 crore",
    "RBI holds repo rate; HDFC Bank and SBI shares gain",
    "Crude oil falls as OPEC signals higher output; ONGC shares slide",
    "L&T bags order worth Rs 2,500 crore for metro rail project",
    "RVNL receives letter of award for Rs 780 crore railway project",
    "Sun Pharma gets USFDA warning for generic drug plant",
    "Tata Motors EV sales rise 20% as festive season demand lifts car sales",
    "TCS wins $500 million outsourcing deal from UK insurer",
    "Tata Steel to acquire stake in iron ore miner for Rs 900 crore",
    "Inflation eases to 4.1% as rupee steadies against the dollar",
  ];
  const universe: NamedCompany[] = [
    ["HAL.NS", "Hindustan Aeronautics Ltd.", "Capital Goods"], ["BEL.NS", "Bharat Electronics Ltd.", "Capital Goods"],
    ["NTPC.NS", "NTPC Ltd.", "Power"], ["SUZLON.NS", "Suzlon Energy Ltd.", "Capital Goods"],
    ["POWERGRID.NS", "Power Grid Corporation of India Ltd.", "Power"], ["HDFCBANK.NS", "HDFC Bank Ltd.", "Financial Services"],
    ["SBIN.NS", "State Bank of India", "Financial Services"], ["ONGC.NS", "Oil & Natural Gas Corporation Ltd.", "Oil Gas & Consumable Fuels"],
    ["LT.NS", "Larsen & Toubro Ltd.", "Construction"], ["RVNL.NS", "Rail Vikas Nigam Ltd.", "Construction"],
    ["SUNPHARMA.NS", "Sun Pharmaceutical Industries Ltd.", "Healthcare"], ["TATAMOTORS.NS", "Tata Motors Ltd.", "Automobile and Auto Components"],
    ["TCS.NS", "Tata Consultancy Services Ltd.", "Information Technology"], ["TATASTEEL.NS", "Tata Steel Ltd.", "Metals & Mining"],
    ["TATAPOWER.NS", "Tata Power Co. Ltd.", "Power"], ["BDL.NS", "Bharat Dynamics Ltd.", "Capital Goods"],
    ["MAZDOCK.NS", "Mazagon Dock Shipbuilders Ltd.", "Capital Goods"], ["ADANIGREEN.NS", "Adani Green Energy Ltd.", "Power"],
  ].map(([symbol, name, industry]) => ({ symbol, name, industry, market: "IN" as const, core: true }));
  universe.push(
    { symbol: "NVDA", name: "Nvidia", industry: "Semiconductors", market: "US" },
    { symbol: "MSFT", name: "Microsoft", industry: "Technology", market: "US" },
    { symbol: "TSM", name: "Taiwan Semiconductor", industry: "Semiconductors", market: "US" },
    { symbol: "AMD", name: "Advanced Micro Devices", industry: "Semiconductors", market: "US" },
  );
  const raw: RichHeadline[] = [
    filingToHeadline({
      symbol: "MAZDOCK.NS", company: "Mazagon Dock Shipbuilders Limited", industry: "Shipbuilding",
      category: "Bagging/Receiving of orders/contracts",
      text: "Receipt of an order worth Rs 1,990 crore from the Ministry of Defence for submarine refit",
      url: "https://example.com/sample-filing.pdf",
      publishedAt: new Date(Date.UTC(2026, 0, 15, 9)).toISOString(),
    }),
    ...titles.map((title, i) => ({
    title,
    url: "https://example.com/sample-headline",
    source: "Sample wire",
    publishedAt: new Date(Date.UTC(2026, 0, 15, 12 - (i % 12))).toISOString(),
    sentiment: scoreHeadline(title),
    summary: "",
    })),
  ];
  return buildNexus(raw, universe, new Date(Date.UTC(2026, 0, 15, 13)));
}
