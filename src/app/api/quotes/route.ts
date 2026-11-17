/**
 * GET /api/quotes?symbols=AAPL,TCS.NS — light quotes for a watchlist.
 *
 * One cached chart call per symbol; no fundamentals. Capped at 30 symbols.
 */

import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getChart, pooled } from "@/services/market";

export interface LiteQuote {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  spark: number[];
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const symbols = [
      ...new Set(
        (new URL(request.url).searchParams.get("symbols") ?? "")
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => /^[A-Z0-9.^=&-]{1,20}$/.test(s)),
      ),
    ].slice(0, 30);

    const provider = getProvider();
    let quotes: LiteQuote[];

    if (isSampleData(provider.id)) {
      quotes = await Promise.all(
        symbols.map(async (symbol) => {
          const [quote, bars] = await Promise.all([
            provider.getQuote(symbol),
            provider.getPriceHistory(symbol, "1mo", "1d"),
          ]);
          return {
            symbol,
            name: quote?.name ?? symbol,
            price: quote?.price ?? null,
            change: quote?.change ?? null,
            changePercent: quote?.changePercent ?? null,
            currency: quote?.currency ?? "",
            spark: bars.slice(-22).map((b) => b.close).filter((c): c is number => c !== null),
          };
        }),
      );
    } else {
      quotes = await pooled(symbols, 5, async (symbol) => {
        const { bundle } = await getChart(symbol, "1mo");
        return {
          symbol,
          name: bundle?.name ?? symbol,
          price: bundle?.price ?? null,
          change: bundle?.change ?? null,
          changePercent: bundle?.changePercent ?? null,
          currency: bundle?.currency ?? "",
          spark: bundle ? bundle.bars.map((b) => b.close as number) : [],
        };
      });
    }

    const body: APIResponse<LiteQuote[]> = { success: true, data: quotes, timestamp };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/quotes] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
