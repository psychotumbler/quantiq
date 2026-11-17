/**
 * GET /api/nexus — themes, companies and deals read from today's headlines.
 */

import { connection } from "next/server";
import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getNexus, sampleNexus, type NexusData } from "@/services/newsNexus";

export interface NexusRouteData extends NexusData {
  sampleData: boolean;
}

export async function GET(): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  try {
    const sampleData = isSampleData(getProvider().id);
    const data = sampleData ? sampleNexus() : await getNexus();
    const body: APIResponse<NexusRouteData> = {
      success: true,
      data: { ...data, sampleData },
      timestamp,
    };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/nexus] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
