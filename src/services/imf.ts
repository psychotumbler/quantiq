/**
 * India macro from the IMF World Economic Outlook, via the IMF DataMapper
 * API (`imf.org/external/datamapper/api/v1/{indicator}/IND`) — official,
 * keyless, and confirmed reachable on 2026-11-17.
 *
 * These are ANNUAL figures. The current and future years are IMF
 * projections, not outturns, and are labelled as such. India's monthly
 * releases (CPI, IIP, RBI policy rate) have no free machine-readable source
 * that was found to be current: the FRED mirrors of them stopped updating.
 */

import axios from "axios";
import type { MacroSeries } from "@/services/fred";

interface ImfSpec {
  id: string;
  label: string;
  unit: "%" | "pp";
  note: string;
  /** Divide the raw value by this before display. */
  scale?: number;
  suffix?: string;
}

export const INDIA_SERIES: readonly ImfSpec[] = [
  { id: "NGDP_RPCH", label: "Real GDP growth", unit: "%", note: "Annual change in real GDP" },
  { id: "PCPIPCH", label: "CPI inflation", unit: "%", note: "Average consumer prices, annual change" },
  { id: "LUR", label: "Unemployment rate", unit: "%", note: "Share of the labour force" },
  { id: "BCA_NGDPD", label: "Current account", unit: "%", note: "Balance as a share of GDP; negative is a deficit" },
  { id: "GGXWDG_NGDP", label: "Government debt", unit: "%", note: "General government gross debt as a share of GDP" },
  { id: "NGDPD", label: "GDP (US$ trillion)", unit: "pp", note: "Nominal GDP at current prices", scale: 1000 },
];

/** Summarise one indicator's year→value map. Pure; exported for tests. */
export function summariseImf(
  spec: ImfSpec,
  byYear: Record<string, number> | undefined,
  currentYear: number,
): MacroSeries {
  const scale = spec.scale ?? 1;
  const years = Object.keys(byYear ?? {})
    .map(Number)
    .filter((y) => Number.isFinite(y) && typeof byYear![String(y)] === "number")
    .sort((a, b) => a - b);

  // Show the current year (an IMF projection until the year closes), with
  // the change from the year before.
  const shown = years.includes(currentYear) ? currentYear : years[years.length - 1];
  const value = shown === undefined ? null : byYear![String(shown)] / scale;
  const prior = shown !== undefined && years.includes(shown - 1) ? byYear![String(shown - 1)] / scale : null;
  const next = shown !== undefined && years.includes(shown + 1) ? byYear![String(shown + 1)] / scale : null;

  return {
    id: spec.id,
    label: spec.label,
    unit: spec.unit,
    note:
      next === null
        ? spec.note
        : `${spec.note}. IMF projects ${next.toFixed(1)} for ${shown! + 1}`,
    value,
    date: shown === undefined ? null : `${shown}${shown >= currentYear ? " (IMF projection)" : ""}`,
    change: value !== null && prior !== null ? value - prior : null,
    changeLabel: "vs prior year",
    history: years
      .filter((y) => y >= currentYear - 15 && y <= currentYear + 2)
      .map((y) => ({ date: String(y), value: byYear![String(y)] / scale })),
  };
}

const TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: MacroSeries }>();

async function fetchIndicator(spec: ImfSpec): Promise<MacroSeries> {
  const hit = cache.get(spec.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const year = new Date().getFullYear();
  try {
    const { data } = await axios.get(
      `https://www.imf.org/external/datamapper/api/v1/${spec.id}/IND`,
      { timeout: 20_000, headers: { "User-Agent": "Mozilla/5.0" } },
    );
    const value = summariseImf(spec, data?.values?.[spec.id]?.IND, year);
    if (value.value !== null) {
      cache.set(spec.id, { at: Date.now(), value });
      return value;
    }
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[imf] ${spec.id} failed${status ? ` (HTTP ${status})` : ""}`);
  }
  return hit?.value ?? summariseImf(spec, undefined, year);
}

export async function getIndiaMacro(): Promise<MacroSeries[]> {
  return Promise.all(INDIA_SERIES.map(fetchIndicator));
}
