/**
 * GET /api/news            — market headlines
 * GET /api/news?symbol=X   — headlines for one security
 */

import type { APIResponse, SentimentData } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getNews, sampleNews } from "@/services/news";

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const params = new URL(request.url).searchParams;
    const symbol = (params.get("symbol") ?? "").trim().toUpperCase().slice(0, 20);
    const name = (params.get("name") ?? "").trim().slice(0, 80);

    const data = isSampleData(getProvider().id)
      ? sampleNews(symbol)
      : await getNews(symbol, name);
    const body: APIResponse<SentimentData> = { success: true, data, timestamp };
    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/news] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
