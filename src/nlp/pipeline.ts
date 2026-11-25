/**
 * The sweep: fetch every source, understand every article, rank what matters.
 *
 * Design notes that matter at this volume:
 *
 * - Deduplication is by normalised title, not URL. The same story reaches us
 *   from Google News, the publisher's own feed and a syndication partner with
 *   three different URLs. Counting it three times would fake importance, which
 *   is the exact failure mode a materiality score exists to prevent.
 *
 * - Feeds fail constantly - publishers block datacenter IPs, feeds move, hosts
 *   time out. One dead feed must never fail a sweep, so every fetch is
 *   independently caught and the result reports what worked.
 *
 * - Understanding runs on the headline plus the feed summary, not the full
 *   article. Fetching several thousand article bodies is slow, rude to the
 *   publishers and mostly unnecessary: financial headlines are unusually
 *   information-dense. The LLM layer fetches bodies only for the few stories
 *   that justify it.
 */

import { pooled } from "@/services/market";
import { fetchFeedRich, type RichHeadline } from "@/services/news";
import { ALL_FEEDS, type FeedSource } from "@/nlp/sources";
import { buildIndex, type EntityIndex } from "@/nlp/entities";
import { understand, type ArticleInput, type ArticleUnderstanding, type UnderstandContext } from "@/nlp/understand";
import type { NamedCompany } from "@/analysis/themes";

export interface SweepStats {
  feedsTried: number;
  feedsOk: number;
  feedsFailed: number;
  rawHeadlines: number;
  uniqueHeadlines: number;
  understood: number;
  withEvent: number;
  withCompany: number;
  highMateriality: number;
  /** Stories re-scored once the subject's market cap was known. */
  rescoredWithMarketCap: number;
  elapsedMs: number;
  failures: { source: string; reason: string }[];
}

export interface SweepResult {
  articles: ArticleUnderstanding[];
  /** Raw inputs, indexed by article id ("a12" -> inputs[12]). Kept so an
   *  article can be re-run later, audited, or archived exactly as read. */
  inputs: ArticleInput[];
  stats: SweepStats;
  generatedAt: string;
}

/** Title normalisation for dedup: strip source suffixes, punctuation, case. */
export function dedupKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, "") // " - Economic Times"
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|a|an|of|for|to|in|on|at|is|are|says|said)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function fetchOne(feed: FeedSource): Promise<{ feed: FeedSource; items: RichHeadline[]; error?: string }> {
  try {
    const items = await fetchFeedRich(feed.url, feed.source);
    return { feed, items };
  } catch (e) {
    return { feed, items: [], error: (e as Error).message?.slice(0, 80) ?? "failed" };
  }
}

export interface SweepOptions {
  feeds?: FeedSource[];
  universe: NamedCompany[];
  aliases?: Record<string, string[]>;
  marketCaps?: Map<string, number>;
  /** Extra headlines (exchange filings) already fetched elsewhere. */
  extra?: { item: RichHeadline; trust: number; sector?: string }[];
  concurrency?: number;
  /**
   * Optional second pass. Market cap is what separates "big number" from
   * "big deal", but fetching it for every company named across five thousand
   * headlines would be absurd. So we rank once without it, then look up sizes
   * only for the subjects of the stories that already look material, and
   * re-score just those.
   */
  fetchMarketCaps?: (symbols: string[]) => Promise<Map<string, number>>;
  /** How many top stories get the second pass. */
  rescoreTop?: number;
}

/** Industry peers, derived from the universe we already have. */
export function buildPeerMap(universe: NamedCompany[], maxPeers = 8): Map<string, { symbol: string; name: string }[]> {
  const byIndustry = new Map<string, NamedCompany[]>();
  for (const c of universe) {
    if (!c.industry) continue;
    if (!byIndustry.has(c.industry)) byIndustry.set(c.industry, []);
    byIndustry.get(c.industry)!.push(c);
  }
  const peers = new Map<string, { symbol: string; name: string }[]>();
  for (const [, list] of byIndustry) {
    if (list.length < 2) continue;
    for (const c of list) {
      peers.set(
        c.symbol,
        list.filter((p) => p.symbol !== c.symbol).slice(0, maxPeers)
            .map((p) => ({ symbol: p.symbol, name: p.name })),
      );
    }
  }
  return peers;
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const started = Date.now();
  const feeds = opts.feeds ?? ALL_FEEDS;

  const results = await pooled(feeds, opts.concurrency ?? 12, fetchOne);

  const failures: { source: string; reason: string }[] = [];
  let raw = 0;
  const seen = new Set<string>();
  const queue: { item: RichHeadline; trust: number; sector?: string }[] = [];

  for (const r of results) {
    if (r.error) failures.push({ source: r.feed.source, reason: r.error });
    for (const item of r.items) {
      raw += 1;
      const key = dedupKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      queue.push({ item, trust: r.feed.trust, sector: r.feed.sector });
    }
  }

  for (const e of opts.extra ?? []) {
    const key = dedupKey(e.item.title);
    raw += 1;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queue.push(e);
  }

  const index: EntityIndex = buildIndex(opts.universe, opts.aliases ?? {});
  const ctx: UnderstandContext = {
    index,
    marketCaps: opts.marketCaps,
    peers: buildPeerMap(opts.universe),
  };

  const inputs: ArticleInput[] = queue.map((q, i) => ({
    id: `a${i}`,
    title: q.item.title,
    body: q.item.summary ?? "",
    source: q.item.source,
    url: q.item.url,
    publishedAt: q.item.publishedAt ?? null,
    sector: q.sector,
    trust: q.trust,
  }));
  const articles = inputs.map((input) => understand(input, ctx));

  articles.sort((a, b) => b.materiality.score - a.materiality.score);

  let rescored = 0;
  if (opts.fetchMarketCaps) {
    const topN = opts.rescoreTop ?? 40;
    const symbols = [...new Set(
      articles.slice(0, topN).flatMap((a) => a.primary.slice(0, 1).map((p) => p.symbol)),
    )];
    if (symbols.length) {
      const caps = await opts.fetchMarketCaps(symbols).catch(() => new Map<string, number>());
      if (caps.size) {
        const withCaps: UnderstandContext = { ...ctx, marketCaps: caps };
        for (let i = 0; i < Math.min(topN, articles.length); i += 1) {
          const a = articles[i];
          if (!a.primary.length || !caps.has(a.primary[0].symbol)) continue;
          const input = inputs[Number(a.id.slice(1))];
          if (!input) continue;
          articles[i] = understand(input, withCaps);
          rescored += 1;
        }
        articles.sort((x, y) => y.materiality.score - x.materiality.score);
      }
    }
  }

  const stats: SweepStats = {
    feedsTried: feeds.length,
    feedsOk: results.filter((r) => !r.error).length,
    feedsFailed: failures.length,
    rawHeadlines: raw,
    uniqueHeadlines: queue.length,
    understood: articles.length,
    withEvent: articles.filter((a) => a.event).length,
    withCompany: articles.filter((a) => a.primary.length > 0).length,
    highMateriality: articles.filter((a) => a.materiality.band === "high").length,
    rescoredWithMarketCap: rescored,
    elapsedMs: Date.now() - started,
    failures: failures.slice(0, 20),
  };

  return { articles, inputs, stats, generatedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Aggregations                                                        */
/* ------------------------------------------------------------------ */

export interface CompanyRollup {
  symbol: string;
  name: string;
  industry: string;
  articles: number;
  netDirection: number;      // -1..1
  topMateriality: number;
  events: Record<string, number>;
  headlines: { title: string; url: string; score: number; summary: string }[];
}

export function rollupByCompany(articles: ArticleUnderstanding[], limit = 40): CompanyRollup[] {
  const map = new Map<string, CompanyRollup>();

  for (const a of articles) {
    for (const imp of a.implications) {
      if (imp.relation !== "subject") continue;
      const ent = a.primary.find((p) => p.symbol === imp.symbol);
      if (!ent) continue;

      if (!map.has(imp.symbol)) {
        map.set(imp.symbol, {
          symbol: imp.symbol, name: imp.name, industry: ent.industry,
          articles: 0, netDirection: 0, topMateriality: 0, events: {}, headlines: [],
        });
      }
      const r = map.get(imp.symbol)!;
      r.articles += 1;
      r.netDirection += imp.direction === "positive" ? 1 : imp.direction === "negative" ? -1 : 0;
      r.topMateriality = Math.max(r.topMateriality, a.materiality.score);
      if (a.event) r.events[a.event.label] = (r.events[a.event.label] ?? 0) + 1;
      if (r.headlines.length < 5) {
        r.headlines.push({ title: a.title, url: a.url, score: a.materiality.score, summary: a.summary });
      }
    }
  }

  for (const r of map.values()) {
    r.netDirection = Number((r.netDirection / Math.max(1, r.articles)).toFixed(2));
  }

  return [...map.values()]
    .sort((a, b) => b.topMateriality - a.topMateriality || b.articles - a.articles)
    .slice(0, limit);
}

export interface SectorRollup {
  sector: string;
  articles: number;
  highMateriality: number;
  netDirection: number;
  topEvent: string | null;
}

export function rollupBySector(articles: ArticleUnderstanding[]): SectorRollup[] {
  const map = new Map<string, { n: number; high: number; dir: number; events: Map<string, number> }>();

  for (const a of articles) {
    const sector = a.sector ?? a.primary[0]?.industry;
    if (!sector) continue;
    if (!map.has(sector)) map.set(sector, { n: 0, high: 0, dir: 0, events: new Map() });
    const s = map.get(sector)!;
    s.n += 1;
    if (a.materiality.band === "high") s.high += 1;
    const d = a.event?.polarity;
    s.dir += d === "positive" ? 1 : d === "negative" ? -1 : 0;
    if (a.event) s.events.set(a.event.label, (s.events.get(a.event.label) ?? 0) + 1);
  }

  return [...map.entries()]
    .map(([sector, s]) => ({
      sector,
      articles: s.n,
      highMateriality: s.high,
      netDirection: Number((s.dir / Math.max(1, s.n)).toFixed(2)),
      topEvent: [...s.events.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.highMateriality - a.highMateriality || b.articles - a.articles);
}
