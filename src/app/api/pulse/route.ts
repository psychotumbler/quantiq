/**
 * GET /api/pulse — sector moves, breadth, movers and institutional flows.
 */

import { connection } from "next/server";
import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getUsSectors, type SectorQuote } from "@/services/market";
import { getIndiaPulse, type IndiaPulse } from "@/services/nse";

export interface PulseRouteData {
  india: IndiaPulse | null;
  usSectors: SectorQuote[];
  sampleData: boolean;
}

function samplePulse(): PulseRouteData {
  const sectors = ["Auto", "Bank", "FMCG", "IT", "Metal", "Pharma", "PSU Bank", "Realty", "Oil & Gas", "Media"];
  const moves = [1.1, 0.8, -0.2, -0.4, 0.5, 0.4, 1.9, 2.2, 0.3, -0.9];
  return {
    india: {
      asOf: "2026-01-15T09:30:00.000Z",
      breadth: { advances: 1820, declines: 1240, unchanged: 110 },
      valuation: { pe: 21.4, pb: 3.3, dividendYield: 1.3 },
      sectors: sectors.map((name, i) => ({
        name, change: moves[i] / 100, change30d: (moves[i] * 3) / 100,
        change1y: (moves[i] * 9) / 100, pe: 20 + i,
      })),
      gainers: [["SAMPLEA.NS", 2650, 0.03], ["SAMPLEB.NS", 410, 0.024], ["SAMPLEC.NS", 1290, 0.019]]
        .map(([symbol, price, change]) => ({ symbol: String(symbol), price: Number(price), change: Number(change) })),
      losers: [["SAMPLED.NS", 390, -0.019], ["SAMPLEE.NS", 720, -0.015], ["SAMPLEF.NS", 3150, -0.011]]
        .map(([symbol, price, change]) => ({ symbol: String(symbol), price: Number(price), change: Number(change) })),
      flows: [
        { category: "FII/FPI", date: "15-Jan-2026", buy: 15600, sell: 10800, net: 4800 },
        { category: "DII", date: "15-Jan-2026", buy: 11700, sell: 15200, net: -3500 },
      ],
    },
    usSectors: ["Technology", "Financials", "Health Care", "Energy", "Industrials", "Utilities"].map(
      (name, i) => ({ name, change: (i - 2) / 250, change30d: (i - 2) / 60, change1y: null, pe: null }),
    ),
    sampleData: true,
  };
}

export async function GET(): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  try {
    let data: PulseRouteData;
    if (isSampleData(getProvider().id)) {
      data = samplePulse();
    } else {
      const [india, usSectors] = await Promise.all([getIndiaPulse(), getUsSectors()]);
      data = { india, usSectors, sampleData: false };
    }
    const body: APIResponse<PulseRouteData> = { success: true, data, timestamp };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/pulse] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
