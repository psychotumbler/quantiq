/**
 * Headlines from public RSS feeds, scored by `analysis/sentiment`.
 *
 * Sources, tried in order — both are public RSS, no key:
 *   1. Yahoo Finance per-symbol headline feed
 *   2. Google News search feed
 *
 * UNVERIFIED from the build sandbox (no network). Each feed is parsed
 * defensively and a failure simply yields no headlines.
 */

import axios from "axios";
import type { SentimentData, SentimentHeadline } from "@/types/stock";
import { scoreHeadline, summariseSentiment } from "@/analysis/sentiment";

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
}

function tag(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decode(match[1]) : "";
}

export interface RichHeadline extends SentimentHeadline {
  /** The feed's description/summary text, tags stripped. May be empty. */
  summary: string;
  /** Set for exchange filings, which state their company outright. */
  symbols?: string[];
  /** Set for exchange filings: the filing's own category. */
  filingCategory?: string;
  /** Industry label supplied by the source, if any. */
  industry?: string;
}

/** RSS 2.0 item parser that also keeps each item's summary. Exported for tests. */
export function parseRssRich(xml: string, fallbackSource: string): RichHeadline[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return items
    .map((item) => {
      let title = tag(item, "title");
      let source = tag(item, "source");
      // Google News appends " - Publisher" to every title.
      const dash = title.lastIndexOf(" - ");
      if (!source && dash > 20) source = title.slice(dash + 3);
      if (source && title.endsWith(` - ${source}`)) {
        title = title.slice(0, -(source.length + 3));
      }
      const published = Date.parse(tag(item, "pubDate"));
      // Descriptions arrive HTML-escaped, so decode once more to strip tags.
      const summary = decode(tag(item, "description")).slice(0, 400);
      return {
        title,
        url: tag(item, "link"),
        source: source || fallbackSource,
        publishedAt: Number.isFinite(published)
          ? new Date(published).toISOString()
          : "",
        sentiment: scoreHeadline(title),
        // Google News summaries just repeat the title as a link.
        summary: summary.startsWith(title.slice(0, 30)) ? "" : summary,
      };
    })
    .filter((headline) => headline.title !== "" && /^https?:\/\//.test(headline.url));
}

/** Pure RSS 2.0 item parser. Exported for tests. */
export function parseRss(xml: string, fallbackSource: string): SentimentHeadline[] {
  return parseRssRich(xml, fallbackSource).map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    sentiment: item.sentiment,
  }));
}

/** Fetch and parse one feed; failures yield `[]`. */
export async function fetchFeedRich(url: string, source: string): Promise<RichHeadline[]> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10_000,
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return parseRssRich(String(data), source);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[news] ${source} failed${status ? ` (HTTP ${status})` : ""}`);
    return [];
  }
}

async function fetchFeed(url: string, source: string): Promise<SentimentHeadline[]> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10_000,
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return parseRss(String(data), source);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[news] ${source} failed${status ? ` (HTTP ${status})` : ""}`);
    return [];
  }
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: SentimentData }>();

/** "Reliance Industries Limited" → "Reliance Industries": what headlines actually say. */
export function searchableName(name: string): string {
  return name
    .replace(/\b(limited|ltd\.?|incorporated|inc\.?|corporation|corp\.?|company|co\.?|plc|s\.a\.|n\.v\.)\b/gi, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function googleFeed(query: string, india: boolean): string {
  const locale = india ? "hl=en-IN&gl=IN&ceid=IN:en" : "hl=en-US&gl=US&ceid=US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`;
}

/**
 * Headlines for one symbol, or for the market as a whole when `symbol` is
 * empty. `name` improves the fallback search for non-US tickers.
 */
export async function getNews(symbol: string, name = ""): Promise<SentimentData> {
  const key = symbol || "__market__";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const india = /\.(NS|BO)$/i.test(symbol);
  let headlines: SentimentHeadline[] = [];
  let source = "";

  if (symbol) {
    headlines = await fetchFeed(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
      "Yahoo Finance",
    );
    source = "Yahoo Finance RSS";
    if (headlines.length === 0) {
      // No quotes and no legal suffix: an exact-phrase search for
      // "Reliance Industries Limited" matched nothing.
      const subject = searchableName(name) || symbol.replace(/\..*$/, "");
      const query = `${subject} ${india ? "share" : "stock"} when:14d`;
      headlines = await fetchFeed(googleFeed(query, india), "Google News");
      source = "Google News RSS";
    }
  } else {
    headlines = await fetchFeed(
      googleFeed("stock market OR Nifty OR Sensex OR \"Wall Street\" when:2d", true),
      "Google News",
    );
    source = "Google News RSS";
  }

  const sorted = headlines
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 20);
  const value = summariseSentiment(sorted, source);
  if (sorted.length > 0) cache.set(key, { at: Date.now(), value });
  return value;
}

/** Fabricated headlines for the fixture provider. */
export function sampleNews(symbol: string): SentimentData {
  const subject = symbol || "Markets";
  const titles = [
    `${subject} shares rise as quarterly profit beats estimates`,
    `Analysts upgrade ${subject} on strong demand outlook`,
    `${subject} faces probe over supplier contracts`,
    `${subject} announces new product line for next year`,
    `Investors weigh ${subject} valuation after record rally`,
    `${subject} warns of slowdown in one overseas market`,
  ];
  const headlines = titles.map((title, i) => ({
    title,
    url: "https://example.com/sample-headline",
    source: "Sample wire",
    publishedAt: new Date(Date.UTC(2026, 0, 15 - i)).toISOString(),
    sentiment: scoreHeadline(title),
  }));
  return summariseSentiment(headlines, "Sample headlines (not real news)");
}
