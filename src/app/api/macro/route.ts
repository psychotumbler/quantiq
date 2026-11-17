/**
 * GET /api/macro — US macro indicators from FRED.
 */

import { connection } from "next/server";
import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getMacro, sampleMacro, type MacroSeries } from "@/services/fred";
import { getIndiaMacro } from "@/services/imf";

export interface MacroRouteData {
  /** US: FRED. */
  series: MacroSeries[];
  /** India: IMF World Economic Outlook, annual. Empty on sample data. */
  india: MacroSeries[];
  sampleData: boolean;
}

export async function GET(): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  try {
    const sampleData = isSampleData(getProvider().id);
    const [series, india] = sampleData
      ? [sampleMacro(), [] as MacroSeries[]]
      : await Promise.all([getMacro(), getIndiaMacro()]);
    const body: APIResponse<MacroRouteData> = {
      success: true,
      data: { series, india, sampleData },
      timestamp,
    };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/macro] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
