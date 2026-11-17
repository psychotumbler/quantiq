/**
 * GET /api/backtest/:symbol — every strategy over five years of daily bars.
 *
 * All strategies are returned at once: they share one price download, so the
 * client can switch between them without another request.
 */

import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import {
  downsample,
  runBacktest,
  STRATEGIES,
  type BacktestResult,
  type StrategyId,
} from "@/analysis/backtest";

export interface BacktestRouteData {
  symbol: string;
  bars: number;
  results: BacktestResult[];
  /** Strategies that need more history than the source returned. */
  skipped: { strategy: StrategyId; label: string }[];
  sampleData: boolean;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> },
): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const { symbol: raw } = await params;
    const symbol = decodeURIComponent(raw ?? "").trim().toUpperCase();
    if (!symbol) {
      return Response.json(
        { success: false, error: "A ticker symbol is required.", timestamp },
        { status: 400 },
      );
    }

    const provider = getProvider();
    const history = await provider.getPriceHistory(symbol, "5y", "1d");
    if (history.length === 0) {
      return Response.json(
        { success: false, error: `No price history for "${symbol}".`, timestamp },
        { status: 404 },
      );
    }

    const results: BacktestResult[] = [];
    const skipped: BacktestRouteData["skipped"] = [];
    for (const id of Object.keys(STRATEGIES) as StrategyId[]) {
      const result = runBacktest(id, history);
      if (result) results.push({ ...result, curve: downsample(result.curve) });
      else skipped.push({ strategy: id, label: STRATEGIES[id].label });
    }

    const body: APIResponse<BacktestRouteData> = {
      success: true,
      data: {
        symbol,
        bars: history.length,
        results,
        skipped,
        sampleData: isSampleData(provider.id),
      },
      timestamp,
    };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/backtest] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
