/**
 * GET /api/compare?symbols=AAPL,MSFT,TCS.NS — side-by-side comparison.
 *
 * Up to four securities: a year of prices rebased to 100, plus the headline
 * fundamentals and risk figures for each.
 */

import type { APIResponse, FundamentalMetrics, RiskMetrics } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { computeRiskMetrics } from "@/analysis/risk";

export interface CompareEntry {
  symbol: string;
  name: string;
  currency: string;
  price: number | null;
  marketCap: number | null;
  /** Total price change over the window, decimal. */
  return1y: number | null;
  fundamentals: FundamentalMetrics;
  risk: RiskMetrics;
}

export interface CompareRouteData {
  entries: CompareEntry[];
  /** One row per date all securities traded; each symbol rebased to 100. */
  series: Record<string, number | string>[];
  notFound: string[];
  sampleData: boolean;
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
    ].slice(0, 4);
    if (symbols.length === 0) {
      return Response.json(
        { success: false, error: "Give between one and four ticker symbols.", timestamp },
        { status: 400 },
      );
    }

    const provider = getProvider();
    const loaded = await Promise.all(
      symbols.map(async (symbol) => {
        const [quote, history, fundamentals] = await Promise.all([
          provider.getQuote(symbol),
          provider.getPriceHistory(symbol, "1y", "1d"),
          provider.getFundamentalMetrics(symbol),
        ]);
        return { symbol, quote, history, fundamentals };
      }),
    );

    const found = loaded.filter((item) => item.history.length > 1);
    const notFound = loaded.filter((item) => item.history.length <= 1).map((item) => item.symbol);

    // Rebase on the dates every security shares, so the lines start together.
    const maps = found.map(
      (item) =>
        new Map(
          item.history
            .filter((bar) => bar.close !== null)
            .map((bar) => [bar.date, bar.close as number]),
        ),
    );
    const dates =
      maps.length === 0
        ? []
        : [...maps[0].keys()].filter((date) => maps.every((map) => map.has(date))).sort();
    const series = dates.map((date) => {
      const row: Record<string, number | string> = { date };
      found.forEach((item, i) => {
        const base = maps[i].get(dates[0]) as number;
        row[item.symbol] = Math.round(((maps[i].get(date) as number) / base) * 10000) / 100;
      });
      return row;
    });

    const entries: CompareEntry[] = found.map((item, i) => {
      const first = dates.length > 0 ? (maps[i].get(dates[0]) as number) : null;
      const last = dates.length > 0 ? (maps[i].get(dates[dates.length - 1]) as number) : null;
      return {
        symbol: item.symbol,
        name: item.quote?.name ?? item.symbol,
        currency: item.quote?.currency ?? "",
        price: item.quote?.price ?? last,
        marketCap: item.quote?.marketCap ?? null,
        return1y: first && last ? last / first - 1 : null,
        fundamentals: item.fundamentals,
        risk: computeRiskMetrics(item.history, { beta: item.quote?.beta ?? null }),
      };
    });

    const body: APIResponse<CompareRouteData> = {
      success: true,
      data: { entries, series, notFound, sampleData: isSampleData(provider.id) },
      timestamp,
    };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/compare] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
