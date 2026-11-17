/**
 * Headline sentiment by word list.
 *
 * A deliberately simple, transparent scorer: count finance-specific positive
 * and negative words in a headline, honour a preceding negation, and report
 * `(pos − neg) / (pos + neg)`. The lists are a small subset in the spirit of
 * the Loughran–McDonald financial dictionary, chosen because general-purpose
 * sentiment lists misread finance text ("liability", "tax" and "debt" are not
 * negative news).
 *
 * This is NOT a language model. It cannot read sarcasm, context or whether a
 * "cut" is a rate cut (good) or a guidance cut (bad). Treat it as a rough
 * tilt across many headlines, never as a verdict on one.
 */

import type { SentimentData, SentimentHeadline } from "@/types/stock";

export const POSITIVE = new Set([
  "beat", "beats", "beating", "surge", "surges", "surged", "soar", "soars",
  "soared", "jump", "jumps", "jumped", "rally", "rallies", "rallied", "gain",
  "gains", "gained", "rise", "rises", "rose", "climb", "climbs", "climbed",
  "record", "upgrade", "upgrades", "upgraded", "outperform", "outperforms",
  "strong", "stronger", "growth", "profit", "profits", "profitable", "boost",
  "boosts", "boosted", "bullish", "buy", "raises", "raised", "tops", "topped",
  "exceeds", "exceeded", "wins", "win", "approval", "approved", "breakthrough",
  "expands", "expansion", "rebound", "rebounds", "recovery", "optimism",
  "optimistic", "upbeat", "dividend", "buyback", "milestone", "high", "highs",
]);

export const NEGATIVE = new Set([
  "miss", "misses", "missed", "plunge", "plunges", "plunged", "slump",
  "slumps", "slumped", "fall", "falls", "fell", "drop", "drops", "dropped",
  "sink", "sinks", "sank", "tumble", "tumbles", "tumbled", "slide", "slides",
  "slid", "crash", "crashes", "crashed", "downgrade", "downgrades",
  "downgraded", "underperform", "weak", "weaker", "loss", "losses", "decline",
  "declines", "declined", "bearish", "sell", "selloff", "cut", "cuts",
  "lawsuit", "probe", "investigation", "fraud", "recall", "layoffs", "layoff",
  "warning", "warns", "warned", "fears", "fear", "risk", "risks", "concern",
  "concerns", "slowdown", "recession", "default", "bankruptcy", "penalty",
  "fine", "fined", "ban", "banned", "delay", "delays", "delayed", "low", "lows",
  "worst", "plummet", "plummets", "plummeted", "crisis", "tariff", "tariffs",
]);

const NEGATIONS = new Set(["not", "no", "never", "without", "fails", "failed"]);

/** Score one headline in [−1, 1], or `null` when no listed word appears. */
export function scoreHeadline(title: string): number | null {
  const words = title.toLowerCase().match(/[a-z']+/g) ?? [];
  let positive = 0;
  let negative = 0;
  words.forEach((word, i) => {
    const negated = i > 0 && NEGATIONS.has(words[i - 1]);
    if (POSITIVE.has(word)) {
      if (negated) negative += 1;
      else positive += 1;
    } else if (NEGATIVE.has(word)) {
      if (negated) positive += 1;
      else negative += 1;
    }
  });
  const total = positive + negative;
  return total === 0 ? null : (positive - negative) / total;
}

/** Aggregate scored headlines into the platform's sentiment shape. */
export function summariseSentiment(
  headlines: SentimentHeadline[],
  source: string,
): SentimentData {
  const scored = headlines
    .map((h) => h.sentiment)
    .filter((s): s is number => s !== null);
  const positive = scored.filter((s) => s > 0).length;
  const negative = scored.filter((s) => s < 0).length;
  return {
    overall:
      scored.length === 0
        ? 0
        : scored.reduce((a, b) => a + b, 0) / scored.length,
    positive,
    negative,
    // Headlines with no listed word, or with the two sides in balance.
    neutral: headlines.length - positive - negative,
    source,
    headlines,
  };
}
