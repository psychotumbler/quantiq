/**
 * The orchestrator: article in, structured understanding out.
 *
 * This is the piece that answers "what can we know from this article" rather
 * than "which article is this". Everything it emits carries its own evidence -
 * the trigger phrase, the matched name, the reason a score moved - because an
 * unexplainable signal pointed at money is worthless.
 *
 * On second-order effects, one honest limitation up front: we infer them from
 * shared industry classification, not from a real supply-chain graph. We can
 * say "these are the listed companies in the same business, so a large order
 * for one is competitive news for the others". We cannot yet say "this company
 * supplies that one" - that needs relationship data we do not have. The code
 * labels the difference rather than blurring it.
 */

import type { ResolvedEntity, EntityIndex } from "@/nlp/entities";
import { resolveEntities } from "@/nlp/entities";
import type { DetectedEvent, Direction, EventType, Amount } from "@/nlp/events";
import { detectEvents, extractAmount, extractCounterparty } from "@/nlp/events";

export interface EntityImplication {
  symbol: string;
  name: string;
  direction: Direction;
  /** Plain English, always. This is shown to a human. */
  why: string;
  relation: "subject" | "sector-peer";
  confidence: number;
}

export interface Materiality {
  score: number;
  band: "high" | "medium" | "low";
  drivers: string[];
  sizeVsMcapPct: number | null;
}

export interface ArticleUnderstanding {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string | null;
  sector?: string;
  /** Multi-company wrap: no single subject, no amount attribution. */
  isRoundup: boolean;

  event: DetectedEvent | null;
  secondaryEvents: DetectedEvent[];
  counterparty: string | null;
  amount: Amount | null;

  primary: ResolvedEntity[];
  mentioned: ResolvedEntity[];

  implications: EntityImplication[];
  materiality: Materiality;
  /** One line a human can read without decoding anything. */
  summary: string;
}

export interface ArticleInput {
  id: string;
  title: string;
  body?: string;
  source: string;
  url: string;
  publishedAt?: string | null;
  sector?: string;
  trust?: number;
}

export interface UnderstandContext {
  index: EntityIndex;
  /** "Now", in ms. Fixed per sweep so every article is aged against the same clock. */
  asOf?: number;
  /** symbol -> market cap in USD millions, when known. */
  marketCaps?: Map<string, number>;
  /** symbol -> peers in the same industry. */
  peers?: Map<string, { symbol: string; name: string }[]>;
}

const fmtUsd = (m: number): string =>
  m >= 1000 ? `$${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}bn` : `$${m.toFixed(m < 10 ? 1 : 0)}m`;

/** How the subject of the story is affected, given the event. */
function directionFor(event: DetectedEvent | null): Direction {
  return event ? event.polarity : "neutral";
}

/** Competitors read a rival's win as pressure, and a rival's penalty as relief. */
function peerDirection(subject: Direction, type: EventType): Direction {
  if (type === "policy" || type === "expansion") return subject; // sector-wide tailwind
  if (subject === "positive") return "negative";
  if (subject === "negative") return "positive";
  return "neutral";
}

/**
 * News value decays. A day-old order win is actionable; a week-old one has
 * been priced, discussed and forgotten. Articles past MAX_AGE_DAYS never get
 * here - the pipeline drops them - so this only orders the recent ones.
 */
function recencyFactor(publishedAt: string | null | undefined, asOf: number): { factor: number; days: number | null } {
  if (!publishedAt) return { factor: 1, days: null };
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return { factor: 1, days: null };
  const days = Math.max(0, (asOf - t) / 86_400_000);
  const factor = days <= 2 ? 1 : days <= 4 ? 0.9 : days <= 7 ? 0.75 : 0.5;
  return { factor, days };
}

function scoreMateriality(
  event: DetectedEvent | null,
  amount: Amount | null,
  primary: ResolvedEntity[],
  trust: number,
  mcapPct: number | null,
  recency: { factor: number; days: number | null },
): Materiality {
  const drivers: string[] = [];
  let score = 0;

  if (event) {
    score += event.weight * 40;
    drivers.push(`${event.label} (${Math.round(event.weight * 100)}% base weight)`);
  } else {
    drivers.push("No clear event detected");
  }

  if (mcapPct !== null) {
    const sizePts = Math.min(30, mcapPct * 3);
    score += sizePts;
    drivers.push(`Deal is ${mcapPct.toFixed(1)}% of market cap`);
  } else if (amount && !amount.isValuation) {
    const sizePts = Math.min(22, Math.log10(amount.usdMillion + 1) * 8);
    score += sizePts;
    drivers.push(`Amount ${fmtUsd(amount.usdMillion)} (market cap unknown)`);
  }

  if (primary.length === 1) {
    score += 12;
    drivers.push("Single clear subject company");
  } else if (primary.length > 3) {
    score -= 6;
    drivers.push(`Diffuse: ${primary.length} companies, likely a roundup`);
  } else if (primary.length === 0) {
    score -= 10;
    drivers.push("No listed company identified as the subject");
  }

  score += trust * 18;
  drivers.push(`Source trust ${Math.round(trust * 100)}%`);

  if (recency.days !== null && recency.factor < 1) {
    score *= recency.factor;
    drivers.push(`Published ${Math.floor(recency.days)} days ago (x${recency.factor})`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    band: score >= 65 ? "high" : score >= 35 ? "medium" : "low",
    drivers,
    sizeVsMcapPct: mcapPct,
  };
}

function writeSummary(
  event: DetectedEvent | null,
  primary: ResolvedEntity[],
  amount: Amount | null,
  counterparty: string | null,
  mcapPct: number | null,
): string {
  if (!event) {
    return primary.length
      ? `Mentions ${primary[0].name} but no specific corporate event was detected.`
      : "No listed company or corporate event identified.";
  }

  const who = primary.length ? primary[0].name : "An unnamed company";
  const parts: string[] = [];

  switch (event.type) {
    case "order-win":
      parts.push(`${who} won an order${amount && !amount.isValuation ? ` worth about ${fmtUsd(amount.usdMillion)}` : ""}${counterparty ? ` from ${counterparty}` : ""}.`);
      break;
    case "order-cancel":
      parts.push(`An order or contract${primary.length ? ` held by ${who}` : ""} was cancelled${amount ? ` (about ${fmtUsd(amount.usdMillion)})` : ""}.`);
      break;
    case "m&a":
      parts.push(`${who} is involved in an acquisition or stake deal${amount ? ` of about ${fmtUsd(amount.usdMillion)}` : ""}.`);
      break;
    case "fundraise":
      parts.push(`${who} is raising${amount ? ` about ${fmtUsd(amount.usdMillion)}` : " capital"}.`);
      break;
    case "approval":
      parts.push(`${who} received a regulatory approval${counterparty ? ` from ${counterparty}` : ""}.`);
      break;
    case "enforcement":
      parts.push(`${who} faces regulatory action${amount ? ` involving ${fmtUsd(amount.usdMillion)}` : ""}.`);
      break;
    case "earnings":
      parts.push(`${who} reported results.`);
      break;
    case "expansion":
      parts.push(`${who} is expanding capacity or investing${amount ? ` about ${fmtUsd(amount.usdMillion)}` : ""}.`);
      break;
    case "policy":
      parts.push(`A policy or government action affecting ${primary.length ? who : "the sector"}.`);
      break;
    default:
      parts.push(`${who}: ${event.label.toLowerCase()}.`);
  }

  if (mcapPct !== null) {
    parts.push(
      mcapPct >= 10 ? `That is ${mcapPct.toFixed(0)}% of its market value — large enough to matter on its own.`
      : mcapPct >= 2 ? `That is about ${mcapPct.toFixed(1)}% of its market value — material but not transformative.`
      : `That is under ${Math.max(0.1, mcapPct).toFixed(1)}% of its market value — small relative to the company.`,
    );
  }

  return parts.join(" ");
}


/**
 * Round-ups list several companies and several unrelated numbers. Attributing
 * the largest amount in the article to whichever company happened to resolve
 * first produces confident nonsense - "Vikram Solar, $2.8bn" from a wrap whose
 * headline was actually about Waaree. When we detect one, nothing gets treated
 * as the subject and no amount is pinned to anyone.
 */
const ROUNDUP_TITLE =
  /\b(round[-\s]?up|roundup|wrap|at a glance|stocks? (to watch|in focus|in news|to buy)|movers|top (gainers|losers|picks|stocks)|top \d+|\d+ (stocks|companies|shares|smallcaps|midcaps)|companies including|market live|news briefs?|digest|what to watch|buzzing stocks|results calendar|earnings calendar)\b/i;

function looksLikeRoundup(title: string, body: string, primaryCount: number): boolean {
  if (ROUNDUP_TITLE.test(title)) return true;
  // Several companies each paired with their own action verb in one headline.
  const actions = (title.match(/\b(wins?|bags?|secures?|gets?|rises?|falls?|jumps?|slips?|gains?)\b/gi) ?? []).length;
  if (actions >= 2 && primaryCount >= 2) return true;
  if (primaryCount >= 3) return true;
  return primaryCount >= 4 && body.length < 400;
}

export function understand(article: ArticleInput, ctx: UnderstandContext): ArticleUnderstanding {
  const body = article.body ?? "";
  const text = `${article.title}\n${body}`;
  const trust = article.trust ?? 0.6;

  const entities = resolveEntities(article.title, body, ctx.index);
  let primary = entities.filter((e) => e.role === "primary");
  let mentioned = entities.filter((e) => e.role === "mentioned");

  const isRoundup = looksLikeRoundup(article.title, body, primary.length);
  if (isRoundup) {
    // No single subject: everything becomes a mention.
    mentioned = [...primary, ...mentioned];
    primary = [];
  }

  const events = detectEvents(text);
  const event = events[0] ?? null;
  // In a round-up the amount belongs to some company, but we cannot say which.
  // Results, approvals and appointments carry numbers (profit, market size)
  // that are not the size of an event, so we do not pin one.
  const amountless = event && ["earnings", "approval", "management", "guidance"].includes(event.type);
  const amount = isRoundup || amountless ? null : extractAmount(text);
  const counterparty = event ? extractCounterparty(text, event.trigger) : null;

  // Size relative to the company is the difference between "big number" and
  // "big deal". A Rs 500 crore order is routine for Reliance and transformative
  // for a small-cap.
  let mcapPct: number | null = null;
  const subject = primary[0];
  if (subject && amount && !amount.isValuation && ctx.marketCaps) {
    const mcap = ctx.marketCaps.get(subject.symbol);
    if (mcap && mcap > 0) mcapPct = Number(((amount.usdMillion / mcap) * 100).toFixed(2));
  }

  const subjectDir = directionFor(event);
  const implications: EntityImplication[] = [];

  for (const e of primary) {
    implications.push({
      symbol: e.symbol,
      name: e.name,
      direction: subjectDir,
      why: event
        ? `Subject of ${event.label.toLowerCase()} — "${event.trigger}"`
        : "Named in the headline, no clear event",
      relation: "subject",
      confidence: Number((e.salience * (event?.confidence ?? 0.3)).toFixed(3)),
    });
  }

  // Second order, from shared industry only - labelled as such.
  if (event && subject && ctx.peers) {
    const dir = peerDirection(subjectDir, event.type);
    if (dir !== "neutral") {
      for (const p of (ctx.peers.get(subject.symbol) ?? []).slice(0, 5)) {
        if (primary.some((x) => x.symbol === p.symbol)) continue;
        implications.push({
          symbol: p.symbol,
          name: p.name,
          direction: dir,
          why: dir === "negative"
            ? `Competes with ${subject.name} in ${subject.industry} — a rival win is competitive pressure`
            : `Same sector as ${subject.name} (${subject.industry}) — likely to read across`,
          relation: "sector-peer",
          confidence: Number(((event.confidence ?? 0.5) * 0.35).toFixed(3)),
        });
      }
    }
  }

  return {
    id: article.id,
    isRoundup,
    title: article.title,
    source: article.source,
    url: article.url,
    publishedAt: article.publishedAt ?? null,
    sector: article.sector,
    event,
    secondaryEvents: events.slice(1, 3),
    counterparty,
    amount,
    primary,
    mentioned: mentioned.slice(0, 8),
    implications,
    materiality: scoreMateriality(event, amount, primary, trust, mcapPct,
      recencyFactor(article.publishedAt, ctx.asOf ?? Date.now())),
    summary: writeSummary(event, primary, amount, counterparty, mcapPct),
  };
}
