/**
 * POST /api/algo — run a set of paper-trading bots over live prices.
 *
 * Body: `{ bots: BotConfig[] }`. Bots live in the browser; nothing is stored
 * server-side. Each bot's whole history is recomputed from current prices, so
 * it is always up to date through the latest session — there is no running
 * state to persist or corrupt.
 */

import type { APIResponse, PriceData } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getChart, pooled } from "@/services/market";
import { runPaperBot, type BotConfig, type BotResult } from "@/algo/engine";

const MAX_BOTS = 12;
const MAX_SYMBOLS = 20;
const STRATEGIES = new Set(["sma-cross", "rsi-reversion", "macd-cross"]);

export interface AlgoRouteData {
  results: BotResult[];
  sampleData: boolean;
}

function parseBots(body: unknown): BotConfig[] | null {
  const list = (body as { bots?: unknown })?.bots;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BOTS) return null;

  const bots: BotConfig[] = [];
  for (const item of list) {
    const b = item as Partial<BotConfig>;
    const symbols = Array.isArray(b.symbols)
      ? [...new Set(b.symbols.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=&-]{1,20}$/.test(s)))].slice(0, MAX_SYMBOLS)
      : [];
    if (
      typeof b.id !== "string" ||
      typeof b.name !== "string" ||
      !STRATEGIES.has(String(b.strategy)) ||
      symbols.length === 0 ||
      !(Number(b.startingCapital) > 0) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(b.startDate))
    ) {
      return null;
    }
    bots.push({
      id: b.id.slice(0, 64),
      name: b.name.slice(0, 80),
      strategy: b.strategy as BotConfig["strategy"],
      symbols,
      startingCapital: Math.min(1e12, Number(b.startingCapital)),
      startDate: String(b.startDate),
      costBps: Number(b.costBps) >= 0 ? Math.min(500, Number(b.costBps)) : undefined,
      currency: typeof b.currency === "string" ? b.currency.slice(0, 8).toUpperCase() : undefined,
    });
  }
  return bots;
}

export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const body: unknown = await request.json().catch(() => null);
    const bots = parseBots(body);
    if (!bots) {
      return Response.json(
        { success: false, error: `Send 1–${MAX_BOTS} bots, each with a strategy, symbols, positive capital and a start date.`, timestamp },
        { status: 400 },
      );
    }

    const provider = getProvider();
    const sample = isSampleData(provider.id);

    // One price download per unique symbol, shared across bots.
    const symbols = [...new Set(bots.flatMap((b) => b.symbols))];
    const bars = new Map<string, PriceData[]>();
    const currency = new Map<string, string>();

    if (sample) {
      await Promise.all(
        symbols.map(async (symbol) => {
          const [history, quote] = await Promise.all([
            provider.getPriceHistory(symbol, "5y", "1d"),
            provider.getQuote(symbol),
          ]);
          bars.set(symbol, history);
          currency.set(symbol, quote?.currency ?? "");
        }),
      );
    } else {
      await pooled(symbols, 5, async (symbol) => {
        const { bundle } = await getChart(symbol, "5y");
        bars.set(symbol, bundle?.bars ?? []);
        currency.set(symbol, bundle?.currency ?? "");
      });
    }

    const results = bots.map((bot) => {
      const barsBySymbol = Object.fromEntries(bot.symbols.map((s) => [s, bars.get(s) ?? []]));
      const result = runPaperBot(bot, barsBySymbol);
      const priced = bot.symbols.find((s) => !result.skipped.includes(s));

      // A bot holds one cash pool, so mixing currencies (e.g. INR + USD) would
      // add unlike prices together. Flag it rather than show a nonsense curve.
      const currencies = [...new Set(bot.symbols.map((s) => currency.get(s)).filter(Boolean))];
      let warning: string | undefined;
      if (currencies.length > 1) {
        warning = `This bot mixes ${currencies.join(" and ")}. A paper account holds one currency, so returns across currencies aren't meaningful — use one market per bot.`;
      } else if (!sample && result.skipped.length > 0 && result.skipped.every((s) => (bars.get(s)?.length ?? 0) === 0)) {
        warning = `No price data came back for ${result.skipped.join(", ")} — they may be mistyped or temporarily unavailable.`;
      }

      // The user's chosen currency wins for display; else infer from the data.
      const displayCurrency = bot.currency || (priced ? (currency.get(priced) ?? "") : "");
      return { ...result, currency: displayCurrency, warning };
    });

    const data: AlgoRouteData = { results, sampleData: sample };
    const response: APIResponse<AlgoRouteData> = { success: true, data, timestamp };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/algo] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
