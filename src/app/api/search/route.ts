/**
 * GET /api/search?q=apple
 *
 * Backs the header autocomplete. An empty query is a valid request that simply
 * has no matches, so it returns 200 with an empty list rather than a 400 — the
 * UI debounces keystrokes and would otherwise flash errors mid-typing.
 */

import type { APIResponse, SearchResult } from "@/types/stock";
import { getProvider } from "@/services";

// No `export const dynamic`: incompatible with this project's
// `cacheComponents: true`, and unnecessary because the upstream fetch already
// makes this handler runtime-rendered.

function json<T>(body: APIResponse<T>, status: number): Response {
  return Response.json(body, { status });
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();

  try {
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim();

    if (!query) {
      return json<SearchResult[]>({ success: true, data: [], timestamp }, 200);
    }

    const results = await getProvider().searchTickers(query);
    return json<SearchResult[]>({ success: true, data: results, timestamp }, 200);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/search] unhandled:", message);
    return json({ success: false, error: message, timestamp }, 500);
  }
}
