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
  /** Why a headline company was demoted from subject to mention, if it was:
   *  the customer of an order, the source of a report, a group name. */
  demotedAs?: DemotionReason;
}

const PRIMARY_THRESHOLD = 0.5;

/** True legal suffixes. "Corp"/"Corporation"/"Company" are handled separately:
 *  in "Jai Corp" and "Birla Corporation" they are the distinctive part, and
 *  stripping them leaves "Jai" and "Birla" - which then match "Jai Balaji" and
 *  "Aditya Birla Group". The audit found exactly those two errors. */
const LEGAL_SUFFIX = /\s*\b(limited|ltd\.?|incorporated|inc\.?|plc|pvt\.?|private)(?=\W|$)\.?/gi;
const CORP_WORDS = /\s*\b(corporation|corp\.?|company|co\.?)(?=\W|$)\.?/gi;

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

/** A surface made only of these is ordinary English, not a name. "Total
 *  Transport Systems" and "Wealth First Portfolio Managers" are real listed
 *  companies whose names would otherwise match the words "total" and "wealth". */
const GENERIC = new Set([
  ...STOP_TOKENS, "asset", "assets", "reconstruction", "transport", "transportation", "wealth",
  "portfolio", "managers", "management", "total", "micro", "solar", "green", "digital", "data",
  "network", "networks", "media", "trading", "exports", "agro", "foods", "food", "products",
  "packaging", "logistics", "housing", "realty", "developers", "properties", "metals", "mining",
  "minerals", "petroleum", "gas", "oil", "fertilizers", "sugar", "paper", "glass", "tubes",
  "pipes", "wires", "cables", "electric", "electricals", "electronics", "controls", "devices",
  "instruments", "tools", "machines", "vehicles", "components", "software", "tech", "infotech",
  "consultancy", "advisory", "ventures", "credit", "leasing", "trust", "fund", "money",
  "payments", "assurance", "health", "healthcare", "hospitals", "medical", "sciences", "care",
  "retail", "fashion", "apparel", "jewellery", "gold", "silver", "iron", "alloys", "paints",
  "home", "education", "entertainment", "communications", "telecom", "mobile", "cloud",
  "security", "defence", "aerospace", "aviation", "shipping", "ports", "marine", "rail",
  "highway", "highways", "builders", "engineers", "renewable", "renewables", "wind", "water",
  "environment", "research", "world", "universal", "standard", "premier", "prime", "royal",
  "supreme", "star", "sun", "smart", "future", "modern", "best", "top", "one", "corporation",
  "company", "authority", "development", "industrial", "commercial", "marketing", "agencies",
]);

/** Trailing words a headline drops: "Astra Microwave Products" -> "Astra Microwave". */
const TRAILING_DROPPABLE = /^(industries|industry|products|mobility|engineering|systems|microsystems|india|enterprises|ventures|solutions|services|technologies|technology|holdings|international|projects|infraprojects|infrastructure|global|works|manufacturing|electricals|energy|renewable|renewables|tubes|pipes|of|the|and|&)$/i;

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bInfrastructure\b/i, "Infra"], [/\bInfraprojects\b/i, "Infra"],
  [/\bPharmaceuticals?\b/i, "Pharma"], [/\bTechnologies\b/i, "Tech"], [/\bLaboratories\b/i, "Labs"],
];

/** Exchanges and acronyms that are also tickers. "Listed on BSE" is a venue,
 *  not news about BSE Ltd. */
const TICKER_BLOCKLIST = new Set(["BSE", "MCX", "IEX", "ITI", "NSE", "CEO", "IPO", "GST", "RBI", "EPC"]);

export function canonical(name: string): string {
  let s = name.replace(/\([^)]*\)/g, " ").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^the\s+/i, "").replace(/[.,]+$/, "").trim();
  const without = s.replace(CORP_WORDS, " ").replace(/\s+/g, " ").trim();
  if (without.split(/\s+/).length >= 2) s = without;
  return s.replace(/[.,&\s]+$/, "").trim();
}

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9&\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Tokens distinctive enough to index a company under. */
function indexTokens(surface: string): string[] {
  return tokens(surface).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

function isGeneric(surface: string): boolean {
  const t = tokens(surface).filter((x) => x !== "&");
  return t.length > 0 && t.every((x) => GENERIC.has(x));
}

/** Shorter names a headline might use for this company. */
function shortForms(canon: string): string[] {
  const forms = new Set<string>();
  const collapsed = canon.replace(/\b([A-Z])\s+(?=[A-Z]\b)/g, "$1"); // "G R Infra" -> "GR Infra"
  const bases = new Set([canon, collapsed]);
  for (const b of [...bases]) for (const [re, rep] of ABBREVIATIONS) if (re.test(b)) bases.add(b.replace(re, rep));
  for (const b of bases) {
    forms.add(b);
    let t = b.split(/\s+/);
    while (t.length > 2 && TRAILING_DROPPABLE.test(t[t.length - 1])) t = t.slice(0, -1);
    while (t.length > 1 && /^(&|and|of|the)$/i.test(t[t.length - 1])) t = t.slice(0, -1);
    if (t.length >= 2) forms.add(t.join(" "));
  }
  forms.delete(canon);
  return [...forms].filter((f) => f.split(/\s+/).length >= 2 && !isGeneric(f) && /[A-Za-z0-9]{3}/.test(f));
}

interface Surface {
  text: string;
  /** Single-token forms only count in strong positions (headline or lead). */
  strict: boolean;
  /** Tickers match case-sensitively: "TOTAL" the ticker, not "total" the word. */
  caseSensitive: boolean;
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

function makeSurface(text: string, company: NamedCompany, opts: { ticker?: boolean } = {}): Surface {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).length;
  if (opts.ticker) {
    return { text: trimmed, strict: true, caseSensitive: true,
             pattern: new RegExp(`(?<![\\w&-])${escape(trimmed)}(?![\\w&]|-[A-Z]?[a-z])`) };
  }
  // A single short token (HAL, BEL, SBI) collides with ordinary words and
  // acronyms, so it only counts when the company is widely covered.
  const strict = words === 1 && (trimmed.length <= 4 || !company.core);
  const body = escape(trimmed).replace(/\\?&/g, "(?:&|and)").replace(/\\\./g, "\\.?").replace(/['’]/g, "['’]?").replace(/\s+and\s+/gi, " (?:and|&) ").replace(/\s+/g, "\\s+");
  return { text: trimmed, strict, caseSensitive: false,
           pattern: new RegExp(`(?<![\\w])${body}(?![\\w])`, "i") };
}

export function buildIndex(universe: NamedCompany[], aliases: Record<string, string[]> = {}): EntityIndex {
  const byToken = new Map<string, Set<number>>();
  const surfaces: Surface[][] = [];

  // Short forms are only safe if exactly one company generates them.
  const shortCount = new Map<string, number>();
  const canonSet = new Set<string>();
  const shorts = universe.map((c) => {
    const canon = canonical(c.name);
    canonSet.add(canon.toLowerCase());
    const sf = shortForms(canon);
    for (const f of sf) shortCount.set(f.toLowerCase(), (shortCount.get(f.toLowerCase()) ?? 0) + 1);
    return sf;
  });

  // Single-token brand names ("UltraTech") are safe only for well-known
  // companies, and only if no other company in the universe uses that word.
  const tokenOwners = new Map<string, number>();
  for (const c of universe) for (const t of new Set(tokens(canonical(c.name)))) {
    tokenOwners.set(t, (tokenOwners.get(t) ?? 0) + 1);
  }

  universe.forEach((company, i) => {
    const canon = canonical(company.name);
    const forms = new Set<string>();
    if (!isGeneric(company.name)) forms.add(company.name);
    if (!isGeneric(canon)) forms.add(canon);
    for (const f of shorts[i]) {
      const k = f.toLowerCase();
      if (shortCount.get(k) === 1 && !canonSet.has(k)) forms.add(f);
    }
    let brand: string | null = null;
    if (company.core) {
      const first = canon.split(/\s+/)[0];
      const k = first.toLowerCase();
      if (first.length >= 6 && tokenOwners.get(k) === 1 && !GENERIC.has(k)) brand = first;
    }
    for (const a of aliases[company.symbol] ?? []) forms.add(a);

    const list: Surface[] = [];
    for (const f of forms) {
      if (f && f.length >= 2) list.push(makeSurface(f, company));
    }
    // A one-word brand ("UltraTech", "Action") must be written as a name:
    // capitalised, so "enterprise action" is not Action Construction.
    if (brand) {
      // Capital first letter, any case after ("RailTel" for "Railtel").
      const rest = [...brand.slice(1)].map((ch) => /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escape(ch)).join("");
      list.push({ text: brand, strict: false, caseSensitive: true,
                  pattern: new RegExp(`(?<![\\w])${brand[0].toUpperCase()}${rest}(?![\\w])`) });
      forms.add(brand);
    }
    // "Highway Infrastructure" is all generic words; only trust it written
    // exactly as a name (Title Case) in the headline or lead.
    if (isGeneric(canon) && canon.split(/\s+/).length >= 2) {
      list.push({ text: canon, strict: true, caseSensitive: true,
                  pattern: new RegExp(`(?<![\\w])${escape(canon).replace(/\s+/g, "\\s+")}(?![\\w])`) });
      forms.add(canon); // for token indexing
    }
    const bare = company.symbol.replace(/\.(NS|BO)$/, "");
    if (bare.length >= 3 && /^[A-Z0-9&-]+$/.test(bare) && !TICKER_BLOCKLIST.has(bare)) {
      list.push(makeSurface(bare, company, { ticker: true }));
    }
    surfaces.push(list);

    const toks = new Set<string>();
    for (const f of forms) {
      const it = indexTokens(f);
      // "GR Infra": every token is short or a stopword, so index the first
      // token anyway; the surface regex still has to match in full.
      if (it.length === 0) { const first = tokens(f)[0]; if (first && first.length >= 2) toks.add(first); }
      for (const t of it) toks.add(t);
    }
    toks.add(bare.toLowerCase());
    for (const t of toks) {
      if (!byToken.has(t)) byToken.set(t, new Set());
      byToken.get(t)!.add(i);
    }
  });

  return { byToken, companies: universe, surfaces };
}

/**
 * Many Indian listed companies are subsidiaries that share a name with a far
 * larger global parent: Sanofi India, Siemens India, 3M India, Bosch, ABB.
 * A wire story about the parent ("Sanofi strikes $41bn deal to acquire US
 * drugmaker Insmed") must not be attributed to the Indian subsidiary, whose
 * entire market cap is a fraction of that number.
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

/* ------------------------------------------------------------------ */
/* Roles from position in the headline                                 */
/* ------------------------------------------------------------------ */

const ORDER_NOUN = /\b(orders?|contracts?|tenders?|projects?|mandates?|LoAs?|letters? of (award|intent))\b/i;
const WINNER_VERB = /\b(wins?|won|winning|bags?|bagged|bagging|secures?|secured|securing|receives?|received|clinch(es|ed)?|lands?|landed|gets?|got|emerges?)\b/i;
const PERSON_BEFORE = /\b(CEO|CFO|COO|CTO|MD|chairman|chairperson|founder|co-founder|chief|director|president|Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+$/i;
const SUB_BRAND = /^\s+(Mutual\s+Fund|MF\b|AMC\b|Asset\s+Management|Life\s+Insurance|General\s+Insurance|Cards?\b|Securities\b|Pension\b|Foundation\b)/i;

export type DemotionReason = "customer" | "source" | "group" | "sub-brand" | "contained" | "selling-shareholder";

/**
 * The audit's largest error class: in "Astra Microwave secures Rs 2,205 crore
 * HAL order", HAL is the CUSTOMER. Crediting HAL means showing a green arrow on
 * the company that placed the order. Eleven of 27 false subjects were this.
 */
function demotionFor(title: string, span: [number, number], company: NamedCompany, matched: string): DemotionReason | null {
  const before = title.slice(Math.max(0, span[0] - 70), span[0]);
  const after = title.slice(span[1], span[1] + 50);

  // "order from HAL", "contract awarded by ONGC"
  if (/\b(from|by|of)\s+(the\s+)?$/i.test(before) && ORDER_NOUN.test(before)) return "customer";
  // "order ... for NTPC's battery project"
  if (/\bfor\s+$/i.test(before) && ORDER_NOUN.test(before) && WINNER_VERB.test(title.slice(0, span[0])) && /^\s*['’]s\b/.test(after)) return "customer";
  // "wins Rs 855 crore SAIL contract" - a company naming the order that
  // someone else just won. Requires the win verb before it, so "HAL order"
  // with no other winner is left alone.
  const named = /^\s*(?:'s\s+)?((?:[\w-]+\s+){0,2}?)(orders?|contracts?|tenders?)\b(?!\s*(book|backlog|inflow|wins?))/i.exec(after);
  if (named && !WINNER_VERB.test(named[1]) && WINNER_VERB.test(title.slice(0, span[0]))) return "customer";

  // "...profitability under pressure: Crisil" - the report's source.
  const lastDelim = Math.max(title.lastIndexOf(":"), title.lastIndexOf(" | "), title.lastIndexOf(" - "));
  if (lastDelim >= 0 && span[0] > lastDelim && title.slice(lastDelim + 1).trim().split(/\s+/).length <= 4) return "source";
  if (/\b(says|said|according to|report by|reports?|survey by|data from|study by)\s+$/i.test(before)) return "source";

  // "Aditya Birla Group", "Tata Group" - a conglomerate, not a listed company.
  // A unique one-word brand ("Brigade Group") is the company itself.
  if (/^\s+Group\b/i.test(after) && /\s/.test(matched.trim())) return "group";

  // "IPO; SBI and GIC Re among selling shareholders" - not the issuer.
  const cStart = Math.max(...[";", ":", "|"].map((d) => title.lastIndexOf(d, span[0]))) + 1;
  const ends = [";", ":", "|"].map((d) => title.indexOf(d, span[1])).filter((x) => x >= 0);
  const clauseText = title.slice(cStart, ends.length ? Math.min(...ends) : title.length);
  if (/selling\s+shareholders?/i.test(clauseText)) return "selling-shareholder";

  // "SBI Mutual Fund" is not State Bank of India.
  const sb = SUB_BRAND.exec(after);
  if (sb && !new RegExp(sb[1].replace(/\s+/g, "\\s+"), "i").test(company.name)) return "sub-brand";

  return null;
}

/**
 * Resolve companies in one article.
 * `title` is weighted far more heavily than `body` - a name in the headline is
 * what the story is about; a name in paragraph nine usually is not.
 */
export function resolveEntities(title: string, body: string, index: EntityIndex): ResolvedEntity[] {
  const text = `${title}\n${body}`;
  const lead = body.slice(0, 220);
  // In an ALL-CAPS headline every word looks like a ticker.
  const letters = title.replace(/[^A-Za-z]/g, "");
  const shouting = letters.length > 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7;

  // Narrow to plausible candidates via the token index.
  const candidates = new Set<number>();
  for (const t of new Set(tokens(text))) {
    const hits = index.byToken.get(t);
    if (hits) for (const i of hits) candidates.add(i);
  }

  type Found = ResolvedEntity & { span: [number, number] | null; reason?: DemotionReason };
  const found: Found[] = [];

  for (const i of candidates) {
    const company = index.companies[i];
    let best: Surface | null = null;
    let bestSpan: [number, number] | null = null;
    let inTitle = false;
    let mentions = 0;

    for (const s of index.surfaces[i]) {
      if (s.caseSensitive && shouting) continue;
      let mTitle = s.pattern.exec(title);
      let hitBody = s.pattern.test(body);
      if (s.caseSensitive && /^[A-Z0-9&-]+$/.test(s.text)) {
        // "E2E Transportation Infrastructure" is a different company from E2E Networks.
        const nameTail = (src: string, m: RegExpExecArray | null) => {
          if (!m) return false;
          const nxt = /^\s+([A-Z][a-z]+)/.exec(src.slice(m.index + m[0].length));
          return !!nxt && GENERIC.has(nxt[1].toLowerCase()) && !new RegExp(`\\b${nxt[1]}\\b`, "i").test(company.name);
        };
        if (nameTail(title, mTitle)) mTitle = null;
        if (hitBody && nameTail(body, s.pattern.exec(body))) hitBody = false;
        if (!mTitle && !hitBody) continue;
      }
      if (!mTitle && !hitBody) continue;

      const oneWord = !/\s/.test(s.text);
      // "Flipkart CEO Kalyan Krishnamurthy": a brand word used as a person's name.
      if (oneWord && mTitle && PERSON_BEFORE.test(title.slice(Math.max(0, mTitle.index - 30), mTitle.index))) mTitle = null;
      // Short acronyms of less-covered companies (MPS, INA, ACE) collide with
      // ordinary acronyms ("MPS norms"). Ask for corroboration: a share/stock
      // cue next to it, or a longer form of the name somewhere in the text.
      if (oneWord && s.text.length <= 4 && !company.core) {
        const longer = index.surfaces[i].some((o) => o !== s && /\s/.test(o.text) && o.pattern.test(text));
        const cue = (src: string, m: RegExpExecArray | null) => !!m &&
          (/^\s+(shares?|stock|share price|Ltd|Limited|Q[1-4]|IPO|order|wins?|bags?|secures?)\b/i.test(src.slice(m.index + m[0].length)) ||
           /\b(shares of|stock of)\s+$/i.test(src.slice(Math.max(0, m.index - 12), m.index)));
        if (!longer && !cue(title, mTitle)) mTitle = null;
        if (!longer && hitBody && !cue(body, s.pattern.exec(body))) hitBody = false;
      }
      // "BSE nod", "NSE approval": the exchange acting as regulator.
      if (mTitle && /^(BSE|NSE|MCX)$/i.test(s.text) && /^\s+(nod|approval|listing|circular|filing|data|notice)/i.test(title.slice(mTitle.index + mTitle[0].length))) mTitle = null;
      if (!mTitle && !hitBody) continue;

      // A strict (short) surface only counts from the headline or the lead,
      // where an acronym is overwhelmingly likely to be the company.
      if (s.strict && !mTitle && !s.pattern.test(lead)) continue;

      mentions += countAll(s.pattern, text);
      if (mTitle) inTitle = true;
      const longer = !best || s.text.length > best.text.length;
      if (mTitle && (longer || !bestSpan)) bestSpan = [mTitle.index, mTitle.index + mTitle[0].length];
      if (longer) best = s;
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

    found.push({
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
      span: bestSpan,
    });
  }

  // A match inside a longer match is an artifact: "Reliance" inside
  // "Reliance Infra", "Alembic" inside "Alembic Pharmaceuticals".
  const kept = found.filter((a) => !a.span || !found.some((b) =>
    b !== a && b.span && b.span[0] <= a.span![0] && b.span[1] >= a.span![1] &&
    (b.span[1] - b.span[0]) > (a.span![1] - a.span![0])));

  for (const e of kept) {
    if (e.role !== "primary" || !e.span) continue;
    const company = index.companies.find((c) => c.symbol === e.symbol)!;
    const reason = demotionFor(title, e.span, company, e.matchedAs);
    if (reason) { e.role = "mentioned"; e.demotedAs = reason; }
  }

  return kept
    .map(({ span: _span, reason: _r, ...rest }) => { void _span; void _r; return rest; })
    .sort((a, b) => (a.role === b.role ? b.salience - a.salience : a.role === "primary" ? -1 : 1));
}

function countAll(pattern: RegExp, text: string): number {
  const g = new RegExp(pattern.source, "gi");
  return (text.match(g) ?? []).length;
}
