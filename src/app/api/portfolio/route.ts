/**
 * POST /api/portfolio — value and analyse a list of holdings.
 *
 * Body: `{ holdings: [{ symbol, quantity, averageCost }], base: "INR" | "USD" }`.
 * Holdings live in the browser; nothing is stored server-side.
 */

import type { APIResponse } from "@/types/stock";
import { getProvider, isSampleData } from "@/services";
import { getChart, pooled } from "@/services/market";
import {
  analyzePortfolio,
  type BaseCurrency,
  type HoldingInput,
  type PortfolioAnalysis,
  type PricedHolding,
} from "@/analysis/portfolio";

const MAX_HOLDINGS = 40;
/** Used only with the fixture provider, where no live rate exists. */
const SAMPLE_USD_INR = 86.4;

export interface PortfolioRouteData extends PortfolioAnalysis {
  sampleData: boolean;
}

function parseHoldings(body: unknown): HoldingInput[] | null {
  const list = (body as { holdings?: unknown })?.holdings;
  if (!Array.isArray(list) || list.length > MAX_HOLDINGS) return null;

  const merged = new Map<string, HoldingInput>();
  for (const item of list) {
    const symbol = String((item as HoldingInput)?.symbol ?? "").trim().toUpperCase();
    const quantity = Number((item as HoldingInput)?.quantity);
    const averageCost = Number((item as HoldingInput)?.averageCost);
    if (!/^[A-Z0-9.^=&-]{1,20}$/.test(symbol)) return null;
    if (!(quantity > 0) || !(averageCost >= 0)) return null;

    // Two lots of one symbol become a single position at the blended cost.
    const existing = merged.get(symbol);
    if (existing) {
      const total = existing.quantity + quantity;
      existing.averageCost =
        (existing.averageCost * existing.quantity + averageCost * quantity) / total;
      existing.quantity = total;
    } else {
      merged.set(symbol, { symbol, quantity, averageCost });
    }
  }
  return [...merged.values()];
}

export async function POST(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const body: unknown = await request.json().catch(() => null);
    const holdings = parseHoldings(body);
    if (!holdings) {
      return Response.json(
        {
          success: false,
          error: `Send up to ${MAX_HOLDINGS} holdings, each with a symbol, a positive quantity and an average cost.`,
          timestamp,
        },
        { status: 400 },
      );
    }
    const base: BaseCurrency =
      (body as { base?: string })?.base === "USD" ? "USD" : "INR";

    const provider = getProvider();
    const sampleData = isSampleData(provider.id);

    let priced: PricedHolding[];
    let usdInr: number | null;

    if (sampleData) {
      usdInr = SAMPLE_USD_INR;
      priced = await Promise.all(
        holdings.map(async (h) => {
          const [quote, bars] = await Promise.all([
            provider.getQuote(h.symbol),
            provider.getPriceHistory(h.symbol, "1y", "1d"),
          ]);
          return {
            ...h,
            name: quote?.name ?? h.symbol,
            currency: quote?.currency ?? "USD",
            price: quote?.price ?? null,
            previousClose:
              quote?.price != null && quote.change != null
                ? quote.price - quote.change
                : null,
            bars,
          };
        }),
      );
    } else {
      // One chart call per holding carries price, currency and a year of bars.
      const [fx, charts] = await Promise.all([
        getChart("USDINR=X", "1mo"),
        pooled(holdings, 5, (h) => getChart(h.symbol, "1y")),
      ]);
      usdInr = fx.bundle?.price ?? null;
      priced = holdings.map((h, i) => {
        const bundle = charts[i].bundle;
        return {
          ...h,
          name: bundle?.name ?? h.symbol,
          currency: bundle?.currency ?? "USD",
          price: bundle?.price ?? null,
          previousClose: bundle?.previousClose ?? null,
          bars: bundle?.bars ?? [],
        };
      });
    }

    const data: PortfolioRouteData = {
      ...analyzePortfolio(priced, base, usdInr),
      sampleData,
    };
    const response: APIResponse<PortfolioRouteData> = { success: true, data, timestamp };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api/portfolio] unhandled:", message);
    return Response.json({ success: false, error: message, timestamp }, { status: 500 });
  }
}
