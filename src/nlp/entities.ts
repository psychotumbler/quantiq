/**
 * Entity resolution: company mention -> listed ticker, with salience.
 *
 * Two things the old keyword matcher got wrong.
 *
 * First, it treated every match equally. An article headlined "HAL wins
 * Rs 8,000 crore order" and an article that mentions HAL once in a list of
 * forty defence stocks both produced "HAL". They are not the same signal.
 * We score salience so the engine can tell the subject of a story from a
 * passing reference.
 *
 * Second, it tested every company pattern against every article. At a few
 * hundred headlines that is fine; at several thousand it is 2.5 million regex
 * executions per sweep. We build an inverted token index and only test
 * companies whose distinctive tokens actually appear in the text.
 */

import type { NamedCompany } from "@/analysis/themes";

export interface ResolvedEntity {
  symbol: string;
  name: string;
  industry: string;
  market: "IN" | "US";
  /** 0-1. Above PRIMARY_THRESHOLD the company is what the story is about. */
  salience: number;
  role: "primary" | "mentioned";
  /** The surface form that actually matched, for auditability. */
  matchedAs: string;
  inTitle: boolean;
  mentions: number;
  /** True when this looks like a story about the global parent, not the
   *  Indian listed entity that happens to share its name. */
  parentStory?: boolean;
}

const PRIMARY_THRESHOLD = 0.5;

const LEGAL_SUFFIX =
  /\s*\b(limited|ltd\.?|incorporated|inc\.?|corporation|corp\.?|company|co\.?|plc|pvt\.?|private)\b\.?/gi;

/** Words that are real company tokens but far too common to index on. */
const STOP_TOKENS = new Set([
  "the", "and", "of", "for", "india", "indian", "bharat", "national", "new",
  "group", "industries", "enterprises", "holdings", "services", "systems",
  "technologies", "solutions", "international", "global", "finance",
  "financial", "bank", "power", "energy", "steel", "motors", "auto", "pharma",
  "labs", "laboratories", "chemicals", "cement", "textiles", "infra",
  "infrastructure", "projects", "construction", "engineering", "capital",
  "investments", "securities", "insurance", "life", "general", "first",
  "united", "state", "central", "south", "north", "east", "west",
]);

export function canonical(name: string): string {
  return name.replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9&\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Tokens distinctive enough to index a company under. */
function indexTokens(surface: string): string[] {
  return tokens(canonical(surface)).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

interface Surface {
  /** The text to look for. */
  text: string;
  /** Short forms ("HAL") only count in strong positions; long names count anywhere. */
  strict: boolean;
  pattern: RegExp;
}

export interface EntityIndex {
  byToken: Map<string, Set<number>>;
  companies: NamedCompany[];
  surfaces: Surface[][];
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeSurface(text: string, company: NamedCompany): Surface {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).length;
  // A single short token (HAL, BEL, SBI) collides with ordinary words and
  // acronyms, so it only counts when the company is widely covered.
  const strict = words === 1 && (trimmed.length <= 4 || !company.core);
  const body = escape(trimmed).replace(/\\?&/g, "(?:&|and)").replace(/\s+/g, "\\s+");
  return { text: trimmed, strict, pattern: new RegExp(`(?<![\\w])${body}(?![\\w])`, "i") };
}

export function buildIndex(universe: NamedCompany[], aliases: Record<string, string[]> = {}): EntityIndex {
  const byToken = new Map<string, Set<number>>();
  const surfaces: Surface[][] = [];

  universe.forEach((company, i) => {
    const forms = new Set<string>([company.name, canonical(company.name)]);
    for (const a of aliases[company.symbol] ?? []) forms.add(a);
    // Bare ticker ("RELIANCE" from RELIANCE.NS) is a legitimate surface form.
    const bare = company.symbol.replace(/\.(NS|BO)$/, "");
    if (bare.length >= 4) forms.add(bare);

    const list: Surface[] = [];
    for (const f of forms) {
      if (f && f.length >= 2) list.push(makeSurface(f, company));
    }
    surfaces.push(list);

    const toks = new Set<string>();
    for (const f of forms) for (const t of indexTokens(f)) toks.add(t);
    for (const t of toks) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t)!.add(i);
    }
  });

  return { byToken, companies: universe, surfaces };
}

/**
 * Resolve companies in one article.
 * `title` is weighted far more heavily than `body` - a name in the headline is
 * what the story is about; a name in paragraph nine usually is not.
 */

/**
 * Many Indian listed companies are subsidiaries that share a name with a far
 * larger global parent: Sanofi India, Siemens India, 3M India, Bosch, ABB.
 * A wire story about the parent ("Sanofi strikes $41bn deal to acquire US
 * drugmaker Insmed") must not be attributed to the Indian subsidiary, whose
 * entire market cap is a fraction of that number. Getting this wrong is the
 * kind of error that destroys trust in a signal instantly.
 *
 * The rule is general rather than a hardcoded brand list: if the listed
 * entity's registered name carries "India" but the article names only the bare
 * brand and talks about foreign markets, it is a parent-company story.
 */
const FOREIGN_CUE =
  /\b(US|U\.S\.|American|Europe(an)?|UK|British|German|French|Japan(ese)?|China|Chinese|global(ly)?|worldwide|international markets?|Nasdaq|NYSE|FTSE)\b/;
const INDIA_CUE = /\b(India|Indian|Mumbai|Delhi|NSE|BSE|Nifty|Sensex|crore|lakh|rupee)\b/i;

function isParentCompanyStory(companyName: string, matchedAs: string, text: string): boolean {
  if (!/\bIndia\b/i.test(companyName)) return false;
  if (/\bIndia\b/i.test(matchedAs)) return false;
  return FOREIGN_CUE.test(text) && !INDIA_CUE.test(text);
}

export function resolveEntities(title: string, body: string, index: EntityIndex): ResolvedEntity[] {
  const text = `${title}\n${body}`;
  const lead = body.slice(0, 220);

  // Narrow to plausible candidates via the token index.
  const candidates = new Set<number>();
  for (const t of new Set(tokens(text))) {
    const hits = index.byToken.get(t);
    if (hits) for (const i of hits) candidates.add(i);
  }

  const out: ResolvedEntity[] = [];
  for (const i of candidates) {
    const company = index.companies[i];
    let best: Surface | null = null;
    let inTitle = false;
    let mentions = 0;

    for (const s of index.surfaces[i]) {
      const hitTitle = s.pattern.test(title);
      const hitBody = s.pattern.test(body);
      if (!hitTitle && !hitBody) continue;

      // A strict (short) surface only counts from the headline or the lead,
      // where an acronym is overwhelmingly likely to be the company.
      if (s.strict && !hitTitle && !s.pattern.test(lead)) continue;

      mentions += countAll(s.pattern, text);
      if (hitTitle) inTitle = true;
      if (!best || s.text.length > best.text.length) best = s;
    }

    if (!best) continue;

    let salience = 0;
    if (inTitle) salience += 0.55;
    if (best.pattern.test(lead)) salience += 0.2;
    salience += Math.min(0.2, (mentions - 1) * 0.07);
    // Multi-word matches are far less likely to be coincidence.
    if (best.text.split(/\s+/).length > 1) salience += 0.1;
    // The Indian-subsidiary guard: demote hard rather than drop, so the
    // company still surfaces as a mention and the call stays auditable.
    const parentStory = isParentCompanyStory(company.name, best.text, text);
    if (parentStory) salience *= 0.3;

    salience = Math.min(1, Number(salience.toFixed(3)));

    out.push({
      symbol: company.symbol,
      name: company.name,
      industry: company.industry,
      market: company.market,
      salience,
      role: salience >= PRIMARY_THRESHOLD ? "primary" : "mentioned",
      matchedAs: best.text,
      inTitle,
      mentions,
      parentStory,
    });
  }

  return out.sort((a, b) => b.salience - a.salience);
}

function countAll(pattern: RegExp, text: string): number {
  const g = new RegExp(pattern.source, "gi");
  return (text.match(g) ?? []).length;
}
