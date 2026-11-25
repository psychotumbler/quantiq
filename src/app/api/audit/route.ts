/**
 * GET /api/audit - raw material for measuring and archiving the news engine.
 *
 *   ?kind=audit&n=200&seed=N   a reproducible, stratified sample of articles
 *                              with their raw text, plus the exact company
 *                              universe the engine resolved against. This is
 *                              what gets hand-labelled into a gold standard.
 *
 *   ?kind=collect              every article the engine found an event or a
 *                              company in, raw text plus engine output, for the
 *                              scheduled archive. History is what lets us later
 *                              ask whether materiality predicted anything.
 *
 * Read-only, and serves nothing that is not already on the public feeds.
 */

import { connection } from "next/server";
import { ALIASES_FOR_NLP } from "@/analysis/themes";
import { gatherInputs } from "@/nlp/inputs";
import { sweep, dedupKey } from "@/nlp/pipeline";
import { getMarketCapsUsdMillions } from "@/services/yahooFinance";
import type { ArticleInput, ArticleUnderstanding } from "@/nlp/understand";

export const maxDuration = 60;

const BODY_CAP = 700;

/** Deterministic PRNG so the same seed always draws the same sample. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function engineView(a: ArticleUnderstanding) {
  return {
    event: a.event?.type ?? null,
    trigger: a.event?.trigger ?? null,
    primary: a.primary.map((p) => p.symbol),
    mentioned: a.mentioned.map((p) => p.symbol),
    amountUsdM: a.amount && !a.amount.isValuation ? Number(a.amount.usdMillion.toFixed(2)) : null,
    amountRaw: a.amount?.raw ?? null,
    counterparty: a.counterparty,
    isRoundup: a.isRoundup,
    materiality: a.materiality.score,
    sizeVsMcapPct: a.materiality.sizeVsMcapPct,
  };
}

function rawView(i: ArticleInput) {
  return {
    title: i.title,
    body: (i.body ?? "").slice(0, BODY_CAP),
    source: i.source,
    url: i.url,
    publishedAt: i.publishedAt ?? null,
    sector: i.sector ?? null,
    trust: i.trust ?? null,
  };
}

export async function GET(request: Request): Promise<Response> {
  await connection();
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "collect";
  const engineVersion = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

  try {
    const { universe, extra } = await gatherInputs();
    // Collected records keep size-vs-market-cap, which the Tier 2 backtest needs.
    // Audits skip it so a sample is reproducible from the text alone.
    const result = await sweep({
      universe, aliases: ALIASES_FOR_NLP, extra,
      ...(kind === "collect" ? { fetchMarketCaps: (s: string[]) => getMarketCapsUsdMillions(s), rescoreTop: 60 } : {}),
    });

    if (kind === "audit") {
      const n = Math.min(400, Math.max(20, Number(url.searchParams.get("n")) || 200));
      const seed = Number(url.searchParams.get("seed")) || 20261126;
      const rand = mulberry32(seed);

      // Half from what users actually see (the top of the ranking), half from
      // the long tail - the tail is where missed companies and false events
      // hide, and a sample of only top stories would flatter the engine.
      const top = result.articles.slice(0, 300);
      const tail = result.articles.slice(300);
      const pick = [
        ...shuffled(top, rand).slice(0, Math.floor(n / 2)),
        ...shuffled(tail, rand).slice(0, n - Math.floor(n / 2)),
      ];

      const sample = pick.map((a, k) => {
        const input = result.inputs[Number(a.id.slice(1))];
        return {
          sid: `s${String(k).padStart(3, "0")}`,
          stratum: result.articles.indexOf(a) < 300 ? "top" : "tail",
          raw: rawView(input),
          engine: engineView(a),
        };
      });

      return Response.json({
        success: true,
        data: {
          kind, seed, engineVersion, generatedAt: result.generatedAt,
          stats: result.stats,
          sample,
          universe: universe.map((c) => [c.symbol, c.name, c.industry ?? "", c.market, c.core ? 1 : 0]),
        },
      });
    }

    // kind=collect
    const records = result.articles
      .filter((a) => a.event || a.primary.length > 0)
      .map((a) => {
        const input = result.inputs[Number(a.id.slice(1))];
        return { key: dedupKey(a.title), ...rawView(input), engine: engineView(a) };
      });

    return Response.json({
      success: true,
      data: { kind, engineVersion, generatedAt: result.generatedAt, stats: result.stats, records },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
