/**
 * Accuracy floor for the NLP engine, against hand-labelled gold sets.
 *
 * fixtures/dev.json       200 articles (seed 20261126), the set the rules were tuned on
 * fixtures/heldout1.json  194 articles (seed 20261127), labelled blind before scoring;
 *                         first measured untouched, then also used for tuning
 *
 * Gold labels were written from the headline/body only, without looking at
 * engine output. If a change drops any
 * metric below its floor, this test fails: fix the regression or explain why
 * the floor should move.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASES_FOR_NLP, type NamedCompany } from "@/analysis/themes";
import { buildIndex } from "@/nlp/entities";
import { buildPeerMap } from "@/nlp/pipeline";
import { understand } from "@/nlp/understand";

type Amount = null | "*" | { unit: "cr" | "usd_m"; value: number | [number, number] };
interface Gold { subjects: string[]; event: string | string[] | null; amount: Amount; roundup: boolean }
interface Fixture {
  articles: { sid: string; title: string; body: string | null; source: string; publishedAt: string | null; sector: string | null; trust: number | null }[];
  gold: Record<string, Gold>;
  sym: Record<string, string[] | null>;
}

const DIR = join(__dirname, "fixtures");
const rows: [string, string, string, string, number][] = JSON.parse(readFileSync(join(DIR, "universe.json"), "utf8"));
const universe: NamedCompany[] = rows.map(([symbol, name, industry, market, core]) => ({
  symbol, name, industry, market: market as "IN" | "US", core: !!core,
}));
const ctx = { index: buildIndex(universe, ALIASES_FOR_NLP), peers: buildPeerMap(universe) };

function usdRange(a: Exclude<Amount, null | "*">): [number, number] {
  let [lo, hi] = Array.isArray(a.value) ? a.value : [a.value, a.value];
  if (a.unit === "cr") { lo = (lo * 10) / 88; hi = (hi * 10) / 88; }
  const tol = lo === hi ? 0.1 : 0.05;
  return [lo * (1 - tol), hi * (1 + tol)];
}

function score(f: Fixture) {
  let tp = 0, fp = 0, req = 0, found = 0, evOk = 0, amtOk = 0, amtN = 0, ruTp = 0, ruFp = 0, ruFn = 0;
  for (const a of f.articles) {
    const g = f.gold[a.sid];
    if (!g) continue;
    const u = understand({ id: a.sid, title: a.title, body: a.body ?? "", source: a.source, url: "",
      publishedAt: a.publishedAt, sector: a.sector ?? undefined, trust: a.trust ?? undefined }, ctx);

    const ok = new Set<string>(), required = new Set<string>();
    for (const n of g.subjects) {
      const syms = f.sym[n.replace(/^\?/, "")];
      if (!syms) continue;
      syms.forEach((s) => ok.add(s));
      if (!n.startsWith("?")) required.add(syms[0]);
    }
    const primary = new Set(u.primary.map((p) => p.symbol));
    for (const p of primary) (ok.has(p) ? tp++ : fp++);
    req += required.size;
    for (const r of required) if (primary.has(r)) found++;

    const got = u.event?.type ?? null;
    if (g.event === "*" || (Array.isArray(g.event) ? g.event.includes(got as string) : g.event === got)) evOk++;

    if (g.amount !== "*") {
      amtN++;
      const v = u.amount && !u.amount.isValuation ? u.amount.usdMillion : null;
      if (g.amount === null) { if (v === null) amtOk++; }
      else if (v !== null) { const [lo, hi] = usdRange(g.amount); if (v >= lo && v <= hi) amtOk++; }
    }

    if (u.isRoundup && g.roundup) ruTp++;
    else if (u.isRoundup) ruFp++;
    else if (g.roundup) ruFn++;
  }
  return {
    subjectPrecision: tp / (tp + fp), subjectRecall: found / req,
    eventAccuracy: evOk / f.articles.length, amountAccuracy: amtOk / amtN,
    roundupRecall: ruTp / Math.max(1, ruTp + ruFn), roundupPrecision: ruTp / Math.max(1, ruTp + ruFp),
  };
}

const FLOORS = {
  subjectPrecision: 0.95, subjectRecall: 0.9, eventAccuracy: 0.9,
  amountAccuracy: 0.93, roundupRecall: 0.8, roundupPrecision: 0.8,
};

describe("NLP accuracy floors", () => {
  for (const name of ["dev", "heldout1"]) {
    it(`${name} set stays above floor`, () => {
      const f: Fixture = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
      const m = score(f);
      console.log(name, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${(v * 100).toFixed(1)}%`])));
      for (const [k, floor] of Object.entries(FLOORS)) expect(m[k as keyof typeof m], k).toBeGreaterThanOrEqual(floor);
    });
  }
});
