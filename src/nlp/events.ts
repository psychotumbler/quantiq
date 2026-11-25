/**
 * Event extraction.
 *
 * The old engine answered "which companies are in this text". That is a lookup,
 * not understanding. This answers four harder questions:
 *
 *   what happened        -> event type, from trigger phrases
 *   to whom              -> actor vs counterparty
 *   how big              -> amount, normalised to USD millions
 *   so what              -> direction of effect, per entity
 *
 * Deliberately rules-driven rather than a model. Financial event language is
 * unusually formulaic ("bags order", "receives approval", "slapped with
 * penalty"), rules are auditable - you can always say why a label was applied,
 * which matters when the output is pointed at money - and they cost nothing to
 * run across thousands of articles. The LLM layer sits on top for the handful
 * of stories where nuance actually pays.
 */

export type EventType =
  | "order-win" | "m&a" | "fundraise" | "earnings" | "approval" | "enforcement"
  | "expansion" | "management" | "debt" | "legal" | "product" | "stake-change"
  | "guidance" | "policy" | "order-cancel" | "other";

export type Direction = "positive" | "negative" | "mixed" | "neutral";

export interface EventDef {
  type: EventType;
  label: string;
  triggers: RegExp[];
  /** Effect on the company the story is about. */
  polarity: Direction;
  /** Base materiality 0-1, before size and source adjustments. */
  weight: number;
}

export const EVENTS: readonly EventDef[] = [
  { type: "order-cancel", label: "Order or contract cancelled", polarity: "negative", weight: 0.9, triggers: [
    /\b(terminat\w+|cancel\w+|scrap\w+|revok\w+|withdraw\w*)\b[^.]{0,50}\b(orders?|contracts?|LoAs?|tenders?|letters? of (award|intent))\b/i,
    /\b(orders?|contracts?|LoA)\b[^.]{0,30}\b(terminated|cancelled|canceled|scrapped|revoked)\b/i,
  ]},
  { type: "order-win", label: "Order or contract win", polarity: "positive", weight: 0.85, triggers: [
    /\b(bag(s|ged|ging)?|win(s|ning)?|won|secur(e|es|ed|ing)|receiv(e|es|ed|ing)|award(ed)?|clinch(es|ed)?|land(s|ed)?)\b[^.]{0,60}\b(orders?|contracts?|tenders?|projects?|mandates?|LoAs?|letters? of (award|intent)|work orders?)\b/i,
    /\b(orders?|contracts?|tenders?|projects?)\b[^.]{0,40}\b(award(ed)?|bagged|won|secured|granted)\b/i,
    /\b(order|contract|project|deal)\s+wins?\b/i,
    /\bsign(s|ed|ing)?\b[^.]{0,50}\b(deals?|contracts?)\b[^.]{0,25}\bfor\b/i,
    /\b(contracts?|deals?) signed\b/i,
    /\bemerge(s|d)? as (the )?(lowest bidder|L1)\b/i,
  ]},
  { type: "m&a", label: "Acquisition, merger or stake", polarity: "mixed", weight: 0.9, triggers: [
    /\b(acquir(e|es|ed|ing)|acquisition|takeover|merge(r|s|d)?|buy(s|out)?|to buy)\b[^.]{0,50}\b(stake|shares|business|unit|company|arm|subsidiary|assets)\b/i,
    /\b(to acquire|has acquired|completes acquisition|signs definitive agreement|share purchase agreement|scheme of arrangement)\b/i,
    /\b(open offer|amalgamation|demerger|slump sale)\b/i,
    /(^|:\s*)Acquisitions?\b|\bacquisition of\b/im,
    /\binvest(s|ing)?\b[^.]{0,40}\bin\b[^.]{0,50}\b(arm|unit|subsidiary|business|startup)\b/i,
  ]},
  { type: "fundraise", label: "Fundraise", polarity: "mixed", weight: 0.6, triggers: [
    /\b(rais(e|es|ed|ing)|fundrais\w+|mobilis\w+)\b[^.]{0,40}\b(crore|cr|billion|million|lakh|funds?|capital)\b/i,
    /\b(QIP|qualified institutional placement|preferential (allotment|issue)|rights issue|FPO|IPO|follow[- ]on)\b/i,
    /\bboard (approves|approved|to consider)\b[^.]{0,40}\b(fund rais|raising|issue of (equity|shares))/i,
    /\b(secur\w+|rais\w+|bag\w*|gets?|receiv\w+)\b[^.]{0,30}\b(funding|from (\w+\s+){0,3}investors)\b/i,
  ]},
  { type: "earnings", label: "Results", polarity: "mixed", weight: 0.7, triggers: [
    /\b(Q[1-4](\s?FY\d{2})?|quarter(ly)?|half[- ]year|annual|FY\d{2})\b[^.]{0,40}\b(results?|profit|revenue|earnings|PAT|EBITDA|net (profit|loss)|topline|bottomline)\b/i,
    /\b(profit|revenue|net (profit|loss)|PAT|EBITDA)\b[^.]{0,30}\b(ris(e|es)|jump(s|ed)?|surge(s|d)?|fall(s)?|decline(s|d)?|drop(s|ped)?|up|down|grew|grow(s|th))\b[^.]{0,20}\d/i,
    /\b(beats?|miss(es|ed)?)\b[^.]{0,25}\b(estimates?|expectations?|street)\b/i,
  ]},
  { type: "approval", label: "Regulatory approval", polarity: "positive", weight: 0.75, triggers: [
    /\b(USFDA|US FDA|FDA|EMA|WHO|CDSCO|DCGI|CCI|NCLT|SEBI|RBI|TRAI|DGCA)\b[^.]{0,50}\b(approv\w+|nod|clearance|clear(s|ed)|green ?light|grant(s|ed)?|licen[cs]e)\b/i,
    /\b(receiv\w+|get(s)?|secur\w+|obtain\w+)\b[^.]{0,40}\b(approval|nod|clearance|licen[cs]e|certification|patent)\b/i,
    /\b(ANDA|NDA|tentative approval|final approval|EUA)\b[^.]{0,30}\bapprov/i,
  ]},
  { type: "enforcement", label: "Penalty or regulatory action", polarity: "negative", weight: 0.8, triggers: [
    /\b(penalt\w+|fine(s|d)?|show[- ]cause|notice|ban(s|ned)?|suspend\w+|revok\w+|strictures?|sanction\w+)\b[^.]{0,50}\b(SEBI|RBI|USFDA|FDA|CCI|ED|income tax|GST|NCLT|court|regulator|ministry)\b/i,
    /\b(SEBI|RBI|USFDA|FDA|CCI|ED|GST|DRI|CBI)\b[^.]{0,50}\b(penalt\w+|fine(s|d)?|bars?|barred|action against|raid(s|ed)?|search(es)?|summons|observations?|Form 483|warning letter|import alert)\b/i,
  ]},
  { type: "expansion", label: "Capex or expansion", polarity: "positive", weight: 0.65, triggers: [
    /\b(invest(s|ment|ing)?|capex|set(s|ting)? up|commission\w+|expan\w+|new (plant|facility|factory|unit|capacity|line))\b[^.]{0,50}\b(crore|cr|billion|million|MW|GW|tonnes?|TPA|MTPA|units?)\b/i,
    /\b(greenfield|brownfield|foundation stone|ground[- ]breaking|capacity (addition|expansion)|final investment decision)\b/i,
    /\b(crore|cr|billion|million|bn|mn)\b[^.]{0,15}\b(investment|capex|expansion)\b/i,
    /\b(plans?|eyes|announc\w+|unveil\w+)\b[^.]{0,30}\bexpansion\b/i,
    /\b(surpass\w*|cross\w*|reach\w*|eyes|target\w*|boost\w*)\b[^.]{0,30}\b(mtpa|capacity|million tonnes)\b/i,
    /\bopen(s|ed)?\b[^.]{0,30}\b(plant|facility|factory|manufacturing unit)\b/i,
  ]},
  { type: "management", label: "Management change", polarity: "neutral", weight: 0.45, triggers: [
    /\b(appoint\w+|nam(es|ed)|elevat\w+|resign\w+|step(s|ping) down|quit(s)?|exits?|take(s)? over as)\b[^.]{0,40}\b(CEO|CFO|MD|managing director|chairman|chairperson|director|CTO|COO|president)\b/i,
    /\b(CEO|CFO|MD|managing director|chairman)\b[^.]{0,30}\b(resign\w+|appoint\w+|quits?|exits?|steps? down)\b/i,
  ]},
  { type: "debt", label: "Debt or rating", polarity: "mixed", weight: 0.55, triggers: [
    /\b(CRISIL|ICRA|CARE Ratings|India Ratings|Moody'?s|S&P|Fitch)\b[^.]{0,50}\b(upgrad\w+|downgrad\w+|rating|outlook|affirm\w+|revis\w+)\b/i,
    /\b(NCD|bond(s)?|debenture|term loan|refinanc\w+|repay\w+|prepay\w+|default\w*|debt reduction)\b[^.]{0,40}\b(crore|cr|billion|million|issue|raise)\b/i,
  ]},
  { type: "legal", label: "Legal or insolvency", polarity: "negative", weight: 0.7, triggers: [
    /\b(lawsuit|sue(s|d)?|litigation|arbitration|tribunal|insolvency|bankruptcy|IBC|liquidation|winding up|contempt)\b/i,
    /\b(NCLT|NCLAT|Supreme Court|High Court)\b[^.]{0,40}\b(order|ruling|verdict|plea|petition|stay)\b/i,
  ]},
  { type: "product", label: "Product or launch", polarity: "positive", weight: 0.4, triggers: [
    /\b(launch\w+|unveil\w+|introduc\w+|roll(s|ed)? out|debut(s|ed)?)\b[^.]{0,40}\b(product|service|platform|model|variant|range|app|brand|offering)\b/i,
  ]},
  { type: "stake-change", label: "Stake or block deal", polarity: "mixed", weight: 0.6, triggers: [
    /\b(block deal|bulk deal|promoter(s)? (sell|sold|buy|bought|pledg\w+|rais\w+)|stake (sale|buy|purchase|increase|cut))\b/i,
    /\b(FII|FPI|DII|mutual fund)s?\b[^.]{0,30}\b(buy|bought|sell|sold|increase|cut|rais\w+|trim\w+)\b[^.]{0,20}\bstake\b/i,
    /\b(offload\w*|sell\w*|sold|trim\w*|reduc\w+|cut\w*|divest\w*|dilut\w+|pare\w*|hike\w*|increas\w+)\b[^.]{0,40}\bstakes?\b/i,
  ]},
  { type: "guidance", label: "Guidance or outlook", polarity: "mixed", weight: 0.6, triggers: [
    /\b(guidance|outlook|forecast|target)\b[^.]{0,40}\b(rais\w+|cut(s)?|lower\w+|upgrad\w+|downgrad\w+|maintain\w+|reiterat\w+)\b/i,
    /\b(expects?|sees?|projects?)\b[^.]{0,30}\b(revenue|growth|margin|demand)\b[^.]{0,30}\b(\d+%|\d+ per cent)/i,
  ]},
  { type: "policy", label: "Policy or government action", polarity: "mixed", weight: 0.5, triggers: [
    /\b(cabinet|government|ministry|parliament|budget|GST council|RBI policy|MPC)\b[^.]{0,50}\b(approv\w+|announc\w+|clear\w+|notifi\w+|scheme|incentive|subsid\w+|duty|tariff|rate)\b/i,
    /\b(PLI|production linked incentive|import duty|export duty|anti[- ]dumping|safeguard duty|FDI (norms|policy))\b/i,
    /\b(RBI|SEBI|IRDAI|PFRDA)\b[^.]{0,90}\b(Directions|Circular|Guidelines|Master Direction|Amendment)\b/,
    /\b(propos\w+|impos\w+|hik\w+|slap\w*|cut\w*|levy|levies|raises?)\b[^.]{0,30}\b(tariffs?|duty|duties)\b/i,
    /\ballocat\w+\b[^.]{0,50}\bbudget\b|\bbudget\b[^.]{0,40}\ballocat\w+/i,
  ]},
];

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

const INR_PER_USD = 88;

const AMOUNT_RE =
  /(?:(₹|rs\.?|inr|usd|us\$|\$|€|£)\s*)?(\d[\d,]*(?:\.\d+)?)[\s-]*(lakh crore|lakh-crore|crore|cr\b|lakh|billion|bn\b|million|mn\b|trillion|tn\b|m\b)/gi;

/**
 * A number is a valuation only when the cue is immediately adjacent to it.
 * In "raises Rs 500 crore at a valuation of Rs 10,000 crore" the word
 * "valuation" sits after the first number but belongs to the second, so a
 * loose proximity test mislabels the deal size. Anchor both patterns.
 */
const VALUATION_BEFORE =
  /\b(valuation of|valued at|market cap(?: of)?|m-?cap(?: of)?|enterprise value(?: of)?|net worth(?: of)?|worth of|valu(?:e|es|ing)\b[^.]{0,40}\bat)\s*(?:about|around|nearly|over|roughly|some|approximately|an estimated)?\s*$/i;
/** "Orders valued at Rs 730 crore" - that's the order size, not a valuation. */
const DEAL_VALUED = /\b(orders?|contracts?|deals?|projects?|tenders?)\s+(valued at|worth)\s*(?:about|around|nearly|over|roughly)?\s*$/i;
/** An order book or backlog is a stock, not the size of today's event. */
const STOCK_BEFORE = /\b(order ?book|orderbook|backlog|order pipeline|AUM|assets under management|revenue|turnover|sales|profit|PAT|EBITDA|net (profit|loss)|loss|market size|annual (US )?sales)\b[^.\d:;|]{0,25}$/i;
const STOCK_AFTER = /^\s*(order ?book|orderbook|backlog)\b/i;
/** "200 million tonnes", "2.77 crore shares" - a count, not money. */
const NOT_MONEY_AFTER = /^\s*(tonnes?|tons?|mt\b|units?|shares?|users?|customers?|subscribers?|people|barrels?|doses?|sq\.? ?ft|square feet|vehicles?|cars?|downloads?|passengers?|households?|accounts?|policies|kwh|mwh)\b/i;
const VALUATION_AFTER = /^\s*(valuation|market cap|m-?cap|enterprise value)\b/i;

export interface Amount {
  raw: string;
  usdMillion: number;
  isValuation: boolean;
  /** Order book, revenue, profit - real money, but not the event's size. */
  isStock?: boolean;
}

const UNIT_MULTIPLIER: [RegExp, number][] = [
  // Value expressed in millions of whatever currency was written.
  [/^lakh[\s-]?crore/, 1_000_000],
  [/^crore|^cr$/, 10],
  [/^lakh/, 0.1],
  [/^trillion|^tn$/, 1_000_000],
  [/^billion|^bn$/, 1000],
  [/^million|^mn$|^m$/, 1],
];

/** Indian units are always rupees, whatever symbol precedes them. */
const INDIAN_UNIT = /^(lakh|crore|cr$)/;

function toUsdMillion(value: number, unit: string, currency: string | undefined): number {
  const u = unit.toLowerCase().trim();
  const mult = UNIT_MULTIPLIER.find(([re]) => re.test(u))?.[1];
  if (!mult) return 0;

  const inCurrencyMillions = value * mult;
  const isRupees = INDIAN_UNIT.test(u) || (currency ? /₹|rs|inr/i.test(currency) : false);
  if (currency && /€/.test(currency)) return inCurrencyMillions * 1.08;
  if (currency && /£/.test(currency)) return inCurrencyMillions * 1.27;
  return isRupees ? inCurrencyMillions / INR_PER_USD : inCurrencyMillions;
}

/** Largest non-valuation amount in the text, in USD millions. */
export function extractAmount(text: string): Amount | null {
  const found: Amount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [raw, symbol, num, unit] = m;
    let value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    // A bare "m" is only money right after a currency symbol ("$105m").
    if (/^m$/i.test(unit) && !symbol) continue;

    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    const after = text.slice(m.index! + raw.length, m.index! + raw.length + 40);
    if (NOT_MONEY_AFTER.test(after)) continue;
    // "150 Billion Rupees", "25 billion rupees" - the currency comes after.
    let currency = symbol;
    const word = /^\s*(rupees|inr|dollars|usd|euros?)\b/i.exec(after);
    if (!currency && word) currency = /rupees|inr/i.test(word[1]) ? "inr" : /euro/i.test(word[1]) ? "€" : "$";
    // "Rs 120 crore per train" for "80 trains" - multiply out, or drop it.
    const per = /^\s*(?:per|each|a|\/)\s+([a-z]+?)s?\b/i.exec(after);
    if (per && !/^(year|annum|month|day|share|cent|unit)$/i.test(per[1])) {
      const n = new RegExp(`(\\d[\\d,]*)\\s+(?:[A-Za-z-]+\\s+){0,3}${per[1]}s\\b`, "i").exec(text);
      if (!n) continue;
      value *= Number(n[1].replace(/,/g, ""));
    }
    const isValuation = (VALUATION_BEFORE.test(before) && !DEAL_VALUED.test(before)) || VALUATION_AFTER.test(after);
    const isStock = STOCK_BEFORE.test(before) || STOCK_AFTER.test(after);

    const usdMillion = toUsdMillion(value, unit, currency);
    if (usdMillion > 0) found.push({ raw: raw.trim(), usdMillion, isValuation, isStock });
  }
  if (!found.length) return null;
  const deal = found.filter((f) => !f.isValuation && !f.isStock);
  // Never fall back to an order book; a valuation alone is still reported (flagged).
  const pool = deal.length ? deal : found.filter((f) => !f.isStock);
  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.usdMillion > a.usdMillion ? b : a));
}

/* ------------------------------------------------------------------ */

export interface DetectedEvent {
  type: EventType;
  label: string;
  polarity: Direction;
  weight: number;
  /** The phrase that fired, so a human can check the call. */
  trigger: string;
  confidence: number;
}

/** Counterparty: who the order came from, who is being acquired, who acted. */
const COUNTERPARTY_RE =
  /\b(?:from|by|with|for|against|awarded by|received from)\s+((?:the\s+)?(?:[A-Z][\w&.'-]*(?:\s+(?:of|the|and|&)?\s*)?){1,5})/;

export function detectEvents(rawText: string): DetectedEvent[] {
  // Triggers use [^.] to stay inside one sentence; decimals ("Rs 11.65 crore")
  // and abbreviations ("Rs.") would otherwise end the sentence early.
  const text = rawText.replace(/(\d)\.(\d)/g, "$1,$2").replace(/\b(Rs|No|Ltd|Co|Inc|Pvt|St|Mr|Ms|Dr)\./gi, "$1");
  const hits: DetectedEvent[] = [];
  for (const def of EVENTS) {
    for (const re of def.triggers) {
      const m = re.exec(text);
      if (!m) continue;
      hits.push({
        type: def.type,
        label: def.label,
        polarity: def.polarity,
        weight: def.weight,
        trigger: m[0].slice(0, 120).replace(/\s+/g, " ").trim(),
        confidence: 0,
      });
      break; // one hit per type is enough
    }
  }

  if (!hits.length) return [];

  const head = text.split("\n")[0] ?? "";
  // "wins arbitration award" is a legal outcome, not an order.
  if (/\b(arbitra\w+|tribunal|court)\b/i.test(head)) {
    const i = hits.findIndex((h) => h.type === "order-win");
    if (i >= 0 && hits.some((h) => h.type === "legal")) hits.splice(i, 1);
  }
  // A cancellation mentions the order; it isn't one.
  if (hits.some((h) => h.type === "order-cancel")) {
    const i = hits.findIndex((h) => h.type === "order-win");
    if (i >= 0) hits.splice(i, 1);
  }

  // An event named in the headline beats one buried in the body.
  for (const h of hits) {
    const inHead = EVENTS.find((e) => e.type === h.type)!.triggers.some((r) => r.test(head));
    h.confidence = Number(Math.min(1, h.weight * (inHead ? 1 : 0.7) + (hits.length === 1 ? 0.1 : 0)).toFixed(3));
  }

  return hits.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Words that follow "from"/"by" but are not organisations. Without this the
 * extractor happily reports that L&T won an order "from July".
 */
const NOT_A_COUNTERPARTY =
  /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Q[1-4]|FY\d*|The|This|That|Its|His|Her|Their|Rs|INR|USD|About|Around|Over|Nearly|Last|Next|Now|Today|Yesterday|Tomorrow|Year|Month|Week|Analysts?|Investors?|Shares?|Markets?)$/i;

export function extractCounterparty(text: string, trigger: string): string | null {
  const at = text.indexOf(trigger);
  const window = at >= 0 ? text.slice(at, at + 220) : text.slice(0, 220);
  const m = COUNTERPARTY_RE.exec(window);
  if (!m) return null;
  let name = m[1].replace(/\s+/g, " ").trim().replace(/[.,;:]$/, "");
  // Drop a leading article ("the Ministry of Defence" -> "Ministry of Defence")
  // before the checks below, which test the first real word.
  name = name.replace(/^(the|a|an)\s+/i, "").trim();
  // Trim a trailing stop-word the greedy capture pulled in.
  name = name.replace(/\s+(the|a|an|of|and|&|to|for|in|on|at)$/i, "").trim();

  if (!name || NOT_A_COUNTERPARTY.test(name)) return null;
  // A counterparty starting with a month/date word is a date phrase.
  if (NOT_A_COUNTERPARTY.test(name.split(/\s+/)[0])) return null;
  if (/^\d/.test(name)) return null;

  return name.length >= 3 && name.length <= 60 ? name : null;
}
