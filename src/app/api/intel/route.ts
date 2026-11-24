/**
 * GET /api/intel - the news intelligence sweep.
 *
 * Reads every source, understands each article, and returns what matters
 * ranked by materiality rather than by recency. Recency ordering is why most
 * news feeds are useless for decisions: the biggest story of the day is
 * whatever happened most recently, which is not the same thing.
 *
 * The sweep is cached. It is expensive (around 85 feeds) and the underlying
 * news does not change minute to minute, so repeated page loads must not
 * repeatedly hammer publishers.
 */

import { connection } from "next/server";
import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getUniverse } from "@/services/universe";
import { getMarketFilings } from "@/services/nse";
import { getMarketCapsUsdMillions } from "@/services/yahooFinance";
import { filingToHeadline } from "@/services/newsNexus";
import { ALIASES_FOR_NLP } from "@/analysis/themes";
import { sweep, rollupByCompany, rollupBySector, type SweepStats } from "@/nlp/pipeline";
import { CORE_FEEDS, SECTOR_FEEDS, feedStats } from "@/nlp/sources";
import type { ArticleUnderstanding } from "@/nlp/understand";
import type { NamedCompany } from "@/analysis/themes";

// A full sweep needs more than the default serverless budget.
export const maxDuration = 60;

export interface IntelRouteData {
  articles: ArticleUnderstanding[];
  companies: ReturnType<typeof rollupByCompany>;
  sectors: ReturnType<typeof rollupBySector>;
  stats: SweepStats;
  feeds: ReturnType<typeof feedStats>;
  generatedAt: string;
  sampleData: boolean;
}

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; value: Promise<IntelRouteData> } | null = null;

async function run(depth: "core" | "full"): Promise<IntelRouteData> {
  const feeds = depth === "core" ? CORE_FEEDS : [...CORE_FEEDS, ...SECTOR_FEEDS];

  const [listed, filings] = await Promise.all([
    getUniverse(),
    getMarketFilings(5).catch(() => []),
  ]);

  // Filings name companies the downloaded equity lists can miss (new listings,
  // or the fallback list is in use). Fold them in so they resolve.
  const universe: NamedCompany[] = [...listed];
  const known = new Set(universe.map((c) => c.symbol));
  for (const f of filings) {
    if (!known.has(f.symbol)) {
      known.add(f.symbol);
      universe.push({ symbol: f.symbol, name: f.company, industry: f.industry, market: "IN", core: false });
    }
  }

  const result = await sweep({
    feeds,
    universe,
    aliases: ALIASES_FOR_NLP,
    // Exchange filings are primary documents, so they carry the highest trust.
    extra: filings.map((f) => ({ item: filingToHeadline(f), trust: 0.95 })),
    fetchMarketCaps: (symbols) => getMarketCapsUsdMillions(symbols),
    rescoreTop: 40,
  });

  return {
    articles: result.articles.slice(0, 300),
    companies: rollupByCompany(result.articles),
    sectors: rollupBySector(result.articles),
    stats: result.stats,
    feeds: feedStats(),
    generatedAt: result.generatedAt,
    sampleData: false,
  };
}

export async function GET(request: Request): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  const url = new URL(request.url);
  const depth = url.searchParams.get("depth") === "core" ? "core" : "full";
  const fresh = url.searchParams.get("fresh") === "1";

  try {
    if (isSampleData(getProvider().id)) {
      const body: APIResponse<IntelRouteData> = {
        success: true,
        data: {
          articles: [], companies: [], sectors: [],
          stats: { feedsTried: 0, feedsOk: 0, feedsFailed: 0, rawHeadlines: 0,
                   uniqueHeadlines: 0, understood: 0, withEvent: 0, withCompany: 0,
                   highMateriality: 0, rescoredWithMarketCap: 0, elapsedMs: 0, failures: [] },
          feeds: feedStats(), generatedAt: timestamp, sampleData: true,
        },
        timestamp,
      };
      return Response.json(body);
    }

    if (fresh || !cached || Date.now() - cached.at > TTL_MS) {
      cached = { at: Date.now(), value: run(depth) };
    }

    const data = await cached.value;
    // An empty sweep is a failed download, not a quiet news day: retry next call.
    if (data.stats.uniqueHeadlines === 0) cached = null;

    return Response.json({ success: true, data, timestamp } satisfies APIResponse<IntelRouteData>);
  } catch (error) {
    cached = null;
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/intel] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
