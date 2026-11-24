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
  | "guidance" | "policy" | "other";

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
  { type: "order-win", label: "Order or contract win", polarity: "positive", weight: 0.85, triggers: [
    /\b(bag(s|ged)?|win(s|ning)?|won|secure(s|d)?|receiv(e|es|ed)|award(ed)?|clinch(es|ed)?)\b[^.]{0,60}\b(order|contract|tender|project|mandate|LoA|letter of (award|intent)|work order)\b/i,
    /\b(order|contract|tender|project)\b[^.]{0,40}\b(award(ed)?|bagged|won|secured|granted)\b/i,
    /\bemerge(s|d)? as (the )?(lowest bidder|L1)\b/i,
  ]},
  { type: "m&a", label: "Acquisition, merger or stake", polarity: "mixed", weight: 0.9, triggers: [
    /\b(acquir(e|es|ed|ing)|acquisition|takeover|merge(r|s|d)?|buy(s|out)?|to buy)\b[^.]{0,50}\b(stake|shares|business|unit|company|arm|subsidiary|assets)\b/i,
    /\b(to acquire|has acquired|completes acquisition|signs definitive agreement|share purchase agreement|scheme of arrangement)\b/i,
    /\b(open offer|amalgamation|demerger|slump sale)\b/i,
  ]},
  { type: "fundraise", label: "Fundraise", polarity: "mixed", weight: 0.6, triggers: [
    /\b(rais(e|es|ed|ing)|fundrais\w+|mobilis\w+)\b[^.]{0,40}\b(crore|cr|billion|million|lakh|funds?|capital)\b/i,
    /\b(QIP|qualified institutional placement|preferential (allotment|issue)|rights issue|FPO|IPO|follow[- ]on)\b/i,
    /\bboard (approves|approved|to consider)\b[^.]{0,40}\b(fund rais|raising|issue of (equity|shares))/i,
  ]},
  { type: "earnings", label: "Results", polarity: "mixed", weight: 0.7, triggers: [
    /\b(Q[1-4]|quarter(ly)?|half[- ]year|annual|FY\d{2})\b[^.]{0,40}\b(results?|profit|revenue|earnings|PAT|EBITDA|net (profit|loss)|topline|bottomline)\b/i,
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
    /\b(invest(s|ment|ing)?|capex|set(s|ting)? up|commission\w+|expand\w+|new (plant|facility|factory|unit|capacity|line))\b[^.]{0,50}\b(crore|cr|billion|million|MW|GW|tonnes?|TPA|units?)\b/i,
    /\b(greenfield|brownfield|foundation stone|ground[- ]breaking|capacity (addition|expansion))\b/i,
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
  ]},
  { type: "guidance", label: "Guidance or outlook", polarity: "mixed", weight: 0.6, triggers: [
    /\b(guidance|outlook|forecast|target)\b[^.]{0,40}\b(rais\w+|cut(s)?|lower\w+|upgrad\w+|downgrad\w+|maintain\w+|reiterat\w+)\b/i,
    /\b(expects?|sees?|projects?)\b[^.]{0,30}\b(revenue|growth|margin|demand)\b[^.]{0,30}\b(\d+%|\d+ per cent)/i,
  ]},
  { type: "policy", label: "Policy or government action", polarity: "mixed", weight: 0.5, triggers: [
    /\b(cabinet|government|ministry|parliament|budget|GST council|RBI policy|MPC)\b[^.]{0,50}\b(approv\w+|announc\w+|clear\w+|notifi\w+|scheme|incentive|subsid\w+|duty|tariff|rate)\b/i,
    /\b(PLI|production linked incentive|import duty|export duty|anti[- ]dumping|safeguard duty|FDI (norms|policy))\b/i,
  ]},
];

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

const INR_PER_USD = 88;

const AMOUNT_RE =
  /(?:(₹|rs\.?|inr|usd|us\$|\$)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(lakh crore|lakh-crore|crore|cr\b|lakh|billion|bn\b|million|mn\b|trillion|tn\b)/gi;

/**
 * A number is a valuation only when the cue is immediately adjacent to it.
 * In "raises Rs 500 crore at a valuation of Rs 10,000 crore" the word
 * "valuation" sits after the first number but belongs to the second, so a
 * loose proximity test mislabels the deal size. Anchor both patterns.
 */
const VALUATION_BEFORE =
  /\b(valuation of|valued at|market cap(?: of)?|m-?cap(?: of)?|enterprise value(?: of)?|net worth(?: of)?|worth of)\s*(?:about|around|nearly|over|roughly|some)?\s*$/i;
const VALUATION_AFTER = /^\s*(valuation|market cap|m-?cap|enterprise value)\b/i;

export interface Amount {
  raw: string;
  usdMillion: number;
  isValuation: boolean;
}

const UNIT_MULTIPLIER: [RegExp, number][] = [
  // Value expressed in millions of whatever currency was written.
  [/^lakh[\s-]?crore/, 1_000_000],
  [/^crore|^cr$/, 10],
  [/^lakh/, 0.1],
  [/^trillion|^tn$/, 1_000_000],
  [/^billion|^bn$/, 1000],
  [/^million|^mn$/, 1],
];

/** Indian units are always rupees, whatever symbol precedes them. */
const INDIAN_UNIT = /^(lakh|crore|cr$)/;

function toUsdMillion(value: number, unit: string, currency: string | undefined): number {
  const u = unit.toLowerCase().trim();
  const mult = UNIT_MULTIPLIER.find(([re]) => re.test(u))?.[1];
  if (!mult) return 0;

  const inCurrencyMillions = value * mult;
  const isRupees = INDIAN_UNIT.test(u) || (currency ? /₹|rs|inr/i.test(currency) : false);
  return isRupees ? inCurrencyMillions / INR_PER_USD : inCurrencyMillions;
}

/** Largest non-valuation amount in the text, in USD millions. */
export function extractAmount(text: string): Amount | null {
  const found: Amount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [raw, currency, num, unit] = m;
    const value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) continue;

    const before = text.slice(Math.max(0, m.index! - 40), m.index!);
    const after = text.slice(m.index! + raw.length, m.index! + raw.length + 20);
    const isValuation = VALUATION_BEFORE.test(before) || VALUATION_AFTER.test(after);

    const usdMillion = toUsdMillion(value, unit, currency);
    if (usdMillion > 0) found.push({ raw: raw.trim(), usdMillion, isValuation });
  }
  if (!found.length) return null;
  const deal = found.filter((f) => !f.isValuation);
  const pool = deal.length ? deal : found;
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

export function detectEvents(text: string): DetectedEvent[] {
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

  // An event named in the headline beats one buried in the body.
  const head = text.split("\n")[0] ?? "";
  for (const h of hits) {
    const inHead = EVENTS.find((e) => e.type === h.type)!.triggers.some((r) => r.test(head));
    h.confidence = Number(Math.min(1, h.weight * (inHead ? 1 : 0.7) + (hits.length === 1 ? 0.1 : 0)).toFixed(3));
  }

  return hits.sort((a, b) => b.confidence - a.confidence);
}

export function extractCounterparty(text: string, trigger: string): string | null {
  const at = text.indexOf(trigger);
  const window = at >= 0 ? text.slice(at, at + 220) : text.slice(0, 220);
  const m = COUNTERPARTY_RE.exec(window);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, " ").trim().replace(/[.,;:]$/, "");
  return name.length >= 3 && name.length <= 60 ? name : null;
}
