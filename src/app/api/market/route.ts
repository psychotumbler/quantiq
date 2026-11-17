/**
 * GET /api/market — cross-asset snapshot for the ribbon and dashboard.
 */

import { connection } from "next/server";
import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import {
  getMarketSnapshot,
  sampleMarketSnapshot,
  type MarketQuote,
} from "@/services/market";

export interface MarketRouteData {
  quotes: MarketQuote[];
  sampleData: boolean;
}

export async function GET(): Promise<Response> {
  // Always rendered at request time: this is live market data.
  await connection();
  const timestamp = new Date().toISOString();
  try {
    const sampleData = isSampleData(getProvider().id);
    const quotes = sampleData ? sampleMarketSnapshot() : await getMarketSnapshot();
    const body: APIResponse<MarketRouteData> = {
      success: true,
      data: { quotes, sampleData },
      timestamp,
    };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/market] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
