/**
 * Twelve Data — daily OHLCV only.
 *
 * Used when `TWELVEDATA_API_KEY` is set. Response shape confirmed against the
 * published demo key (see PROGRESS.md): `values` is an array of **strings**,
 * **newest first**, so it is parsed and reversed here.
 *
 * UNVERIFIED with a personal free key — in particular whether the free plan
 * serves non-US exchanges. A refusal returns `[]` and the caller falls back.
 *
 * There is no dividend-adjusted close on this source: `adjClose` equals
 * `close` (split-adjusted only).
 */

import axios from "axios";
import type { PriceData } from "@/types/stock";

const BASE = "https://api.twelvedata.com";

export function twelveDataConfigured(): boolean {
  return Boolean(process.env.TWELVEDATA_API_KEY?.trim());
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Bars per requested range, in trading days. */
const OUTPUT_SIZE: Record<string, number> = {
  "1mo": 23, "3mo": 66, "6mo": 130, "1y": 260, "2y": 520, "5y": 1300,
};

/** Pure parser, exported for tests. */
export function parseTwelveData(body: unknown): PriceData[] {
  const values = (body as { values?: unknown })?.values;
  if (!Array.isArray(values)) return [];

  const bars: PriceData[] = values.map((row: Record<string, unknown>) => {
    const close = toNumber(row.close);
    return {
      date: String(row.datetime ?? "").slice(0, 10),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close,
      volume: toNumber(row.volume),
      adjClose: close,
    };
  });

  return bars
    .filter((bar) => bar.close !== null && bar.date !== "")
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getTwelveDataHistory(
  symbol: string,
  range = "1y",
): Promise<PriceData[]> {
  const key = process.env.TWELVEDATA_API_KEY?.trim();
  if (!key) return [];

  try {
    const { data } = await axios.get(`${BASE}/time_series`, {
      timeout: 15_000,
      params: {
        symbol,
        interval: "1day",
        outputsize: String(OUTPUT_SIZE[range] ?? 260),
      },
      headers: { Authorization: `apikey ${key}` },
    });
    // Errors arrive as HTTP 200 with `{ status: "error", code, message }`.
    if (data?.status === "error") {
      console.error(`[twelvedata] ${symbol}: code ${data?.code ?? "?"}`);
      return [];
    }
    return parseTwelveData(data);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[twelvedata] ${symbol} failed${status ? ` (HTTP ${status})` : ""}`);
    return [];
  }
}
