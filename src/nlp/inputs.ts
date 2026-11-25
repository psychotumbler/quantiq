/**
 * Everything the sweep needs besides the feeds: the company universe and the
 * exchange filings. Shared by the live Intelligence route and the audit /
 * collection route, so what gets measured is exactly what users see.
 */

import { getUniverse } from "@/services/universe";
import { getMarketFilings } from "@/services/nse";
import { filingToHeadline } from "@/services/newsNexus";
import type { NamedCompany } from "@/analysis/themes";
import type { RichHeadline } from "@/services/news";

export interface SweepInputs {
  universe: NamedCompany[];
  extra: { item: RichHeadline; trust: number; sector?: string }[];
}

export async function gatherInputs(): Promise<SweepInputs> {
  const [listed, filings] = await Promise.all([
    getUniverse(),
    getMarketFilings(5).catch(() => []),
  ]);

  // Filings name companies the downloaded equity lists can miss (new listings,
  // or the fallback list is in use). Fold them in so they resolve.
  const universe: NamedCompany[] = [...listed];
  const known = new Set(universe.map((c) => c.symbol));
  for (const f of filings) {
    if (!known.has(f.symbol)) {
      known.add(f.symbol);
      universe.push({ symbol: f.symbol, name: f.company, industry: f.industry, market: "IN", core: false });
    }
  }

  // Exchange filings are primary documents, so they carry the highest trust.
  return { universe, extra: filings.map((f) => ({ item: filingToHeadline(f), trust: 0.95 })) };
}
