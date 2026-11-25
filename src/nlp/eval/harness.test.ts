/**
 * Runs the engine over a saved audit fixture and writes its outputs as JSON,
 * for scoring against hand-labelled gold data by an independent scorer.
 *
 *   EVAL_IN=path/to/sample.json EVAL_UNIVERSE=path/to/universe.json \
 *   EVAL_OUT=path/to/engine.json npx vitest run src/nlp/eval/harness
 *
 * Skipped unless EVAL_IN is set, so it never runs in the normal suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ALIASES_FOR_NLP, type NamedCompany } from "@/analysis/themes";
import { buildIndex } from "@/nlp/entities";
import { buildPeerMap } from "@/nlp/pipeline";
import { understand } from "@/nlp/understand";

const IN = process.env.EVAL_IN;

describe.skipIf(!IN)("eval harness", () => {
  it("runs the engine over the fixture", () => {
    const sample = JSON.parse(readFileSync(IN!, "utf8"));
    const rows: [string, string, string, string, number][] =
      JSON.parse(readFileSync(process.env.EVAL_UNIVERSE!, "utf8"));
    const universe: NamedCompany[] = rows.map(([symbol, name, industry, market, core]) => ({
      symbol, name, industry, market: market as "IN" | "US", core: !!core,
    }));
    const ctx = { index: buildIndex(universe, ALIASES_FOR_NLP), peers: buildPeerMap(universe) };

    const out = sample.map((s: { sid: string; raw: Record<string, string | number | null> }) => {
      const a = understand({
        id: s.sid,
        title: String(s.raw.title),
        body: String(s.raw.body ?? ""),
        source: String(s.raw.source),
        url: String(s.raw.url),
        publishedAt: (s.raw.publishedAt as string) ?? null,
        sector: (s.raw.sector as string) ?? undefined,
        trust: (s.raw.trust as number) ?? undefined,
      }, ctx);
      return {
        sid: s.sid,
        engine: {
          event: a.event?.type ?? null,
          trigger: a.event?.trigger ?? null,
          primary: a.primary.map((p) => p.symbol),
          mentioned: a.mentioned.map((p) => p.symbol),
          amountUsdM: a.amount && !a.amount.isValuation ? Number(a.amount.usdMillion.toFixed(2)) : null,
          amountRaw: a.amount?.raw ?? null,
          counterparty: a.counterparty,
          isRoundup: a.isRoundup,
          materiality: a.materiality.score,
        },
      };
    });
    writeFileSync(process.env.EVAL_OUT!, JSON.stringify(out, null, 1));
    expect(out.length).toBe(sample.length);
  });
});
