/**
 * India macro, annual figures.
 *
 * Primary source is the IMF World Economic Outlook via the IMF DataMapper
 * API (`imf.org/external/datamapper/api/v1/{indicator}/IND`) — official,
 * keyless, and it carries projections for the current and coming years
 * (labelled as such). But IMF's host blocks datacenter IPs (it returns 403
 * from Vercel), so each indicator falls back to the World Bank API
 * (`api.worldbank.org`), which is keyless and reachable from both a laptop
 * and the cloud. The World Bank has no projections — it gives the latest
 * actual outturn — so the deployed app shows real figures either way.
 *
 * India's monthly releases (CPI, IIP, RBI policy rate) have no free
 * machine-readable source found to be current: the FRED mirrors stopped.
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
  /** World Bank fallback: indicator code + its own scale divisor. */
  wb?: { code: string; scale?: number };
}

export const INDIA_SERIES: readonly ImfSpec[] = [
  { id: "NGDP_RPCH", label: "Real GDP growth", unit: "%", note: "Annual change in real GDP", wb: { code: "NY.GDP.MKTP.KD.ZG" } },
  { id: "PCPIPCH", label: "CPI inflation", unit: "%", note: "Average consumer prices, annual change", wb: { code: "FP.CPI.TOTL.ZG" } },
  { id: "LUR", label: "Unemployment rate", unit: "%", note: "Share of the labour force", wb: { code: "SL.UEM.TOTL.ZS" } },
  { id: "BCA_NGDPD", label: "Current account", unit: "%", note: "Balance as a share of GDP; negative is a deficit", wb: { code: "BN.CAB.XOKA.GD.ZS" } },
  { id: "GGXWDG_NGDP", label: "Government debt", unit: "%", note: "General government gross debt as a share of GDP", wb: { code: "GC.DOD.TOTL.GD.ZS" } },
  { id: "NGDPD", label: "GDP (US$ trillion)", unit: "pp", note: "Nominal GDP at current prices", scale: 1000, wb: { code: "NY.GDP.MKTP.CD", scale: 1e12 } },
];

/** Summarise one indicator's year→value map. Pure; exported for tests. */
export function summariseImf(
  spec: ImfSpec,
  byYear: Record<string, number> | undefined,
  currentYear: number,
  scaleOverride?: number,
): MacroSeries {
  const scale = scaleOverride ?? spec.scale ?? 1;
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

/**
 * World Bank fallback. Its API returns `[pagination, [{date, value}, …]]`;
 * `date` is the year, `value` a number or null. We build the same year→value
 * map `summariseImf` consumes, so one summariser serves both sources.
 */
async function fetchWorldBank(spec: ImfSpec, year: number): Promise<MacroSeries | null> {
  if (!spec.wb) return null;
  try {
    const { data } = await axios.get(
      `https://api.worldbank.org/v2/country/IND/indicator/${spec.wb.code}`,
      { timeout: 15_000, params: { format: "json", per_page: 80, date: `${year - 20}:${year + 1}` } },
    );
    const rows: Array<{ date?: string; value?: number | null }> = Array.isArray(data?.[1]) ? data[1] : [];
    const byYear: Record<string, number> = {};
    for (const row of rows) {
      if (row && typeof row.value === "number" && row.date) byYear[row.date] = row.value;
    }
    if (Object.keys(byYear).length === 0) return null;
    const value = summariseImf(spec, byYear, year, spec.wb.scale);
    return value.value === null ? null : { ...value, note: `${spec.note}. World Bank` };
  } catch {
    return null;
  }
}

async function fetchIndicator(spec: ImfSpec): Promise<MacroSeries> {
  const hit = cache.get(spec.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const year = new Date().getFullYear();

  // IMF first — it carries projections, and works from a laptop.
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

  // World Bank fallback — reachable from the cloud when IMF 403s.
  const wb = await fetchWorldBank(spec, year);
  if (wb) {
    cache.set(spec.id, { at: Date.now(), value: wb });
    return wb;
  }

  return hit?.value ?? summariseImf(spec, undefined, year);
}

export async function getIndiaMacro(): Promise<MacroSeries[]> {
  return Promise.all(INDIA_SERIES.map(fetchIndicator));
}
