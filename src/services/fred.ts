/**
 * US macro indicators from FRED (Federal Reserve Bank of St. Louis).
 *
 * Uses FRED's public CSV download (`fredgraph.csv?id=…`), which needs no API
 * key. Series are official releases: Treasury yields are daily, Fed funds,
 * CPI and unemployment monthly. Cached for six hours.
 *
 * UNVERIFIED from the build sandbox (no network). The parser accepts either
 * header FRED has used (`DATE` / `observation_date`) and skips `.` gaps.
 */

import axios from "axios";

export interface MacroSeries {
  id: string;
  label: string;
  unit: "%" | "pp";
  /** One line on what the reading means. */
  note: string;
  value: number | null;
  date: string | null;
  /** Change versus the comparison point named in `changeLabel`. */
  change: number | null;
  changeLabel: string;
  history: { date: string; value: number }[];
}

interface SeriesSpec {
  id: string;
  label: string;
  unit: "%" | "pp";
  note: string;
  /** Observations back to compare against. */
  lookback: number;
  changeLabel: string;
  /** Convert an index level to a year-over-year percent change. */
  yoy?: boolean;
}

export const MACRO_SERIES: readonly SeriesSpec[] = [
  { id: "FEDFUNDS", label: "Fed funds rate", unit: "%", note: "US policy rate, monthly average", lookback: 12, changeLabel: "vs 1y ago" },
  { id: "DGS3MO", label: "US 3M Treasury", unit: "%", note: "Short-term risk-free rate", lookback: 21, changeLabel: "vs 1m ago" },
  { id: "DGS2", label: "US 2Y Treasury", unit: "%", note: "Tracks expected policy rates", lookback: 21, changeLabel: "vs 1m ago" },
  { id: "DGS10", label: "US 10Y Treasury", unit: "%", note: "Benchmark long-term yield", lookback: 21, changeLabel: "vs 1m ago" },
  { id: "T10Y2Y", label: "10Y minus 2Y spread", unit: "pp", note: "Below zero is an inverted curve", lookback: 21, changeLabel: "vs 1m ago" },
  { id: "CPIAUCSL", label: "US CPI inflation", unit: "%", note: "Year-over-year change in consumer prices", lookback: 12, changeLabel: "vs 1y ago", yoy: true },
  { id: "UNRATE", label: "US unemployment", unit: "%", note: "Share of the labour force unemployed", lookback: 12, changeLabel: "vs 1y ago" },
];

/** Pure CSV parser. Exported for tests. */
export function parseFredCsv(csv: string): { date: string; value: number }[] {
  const rows: { date: string; value: number }[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    const value = Number.parseFloat(raw ?? "");
    // FRED writes "." for a day with no observation.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && Number.isFinite(value)) {
      rows.push({ date, value });
    }
  }
  return rows;
}

/** Year-over-year percent change of a monthly index. Exported for tests. */
export function yearOverYear(
  rows: { date: string; value: number }[],
): { date: string; value: number }[] {
  return rows
    .map((row, i) =>
      i >= 12 && rows[i - 12].value !== 0
        ? { date: row.date, value: (row.value / rows[i - 12].value - 1) * 100 }
        : null,
    )
    .filter((row): row is { date: string; value: number } => row !== null);
}

/** Summarise a parsed series. Exported for tests. */
export function summarise(
  spec: SeriesSpec,
  parsed: { date: string; value: number }[],
): MacroSeries {
  const rows = spec.yoy ? yearOverYear(parsed) : parsed;
  const latest = rows[rows.length - 1] ?? null;
  const reference = rows[rows.length - 1 - spec.lookback] ?? null;
  return {
    id: spec.id,
    label: spec.label,
    unit: spec.unit,
    note: spec.note,
    value: latest?.value ?? null,
    date: latest?.date ?? null,
    change: latest && reference ? latest.value - reference.value : null,
    changeLabel: spec.changeLabel,
    history: rows.slice(-120),
  };
}

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: MacroSeries }>();

async function fetchSeries(spec: SeriesSpec): Promise<MacroSeries> {
  const hit = cache.get(spec.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const start = new Date();
    start.setFullYear(start.getFullYear() - 4);
    const { data } = await axios.get("https://fred.stlouisfed.org/graph/fredgraph.csv", {
      timeout: 15_000,
      responseType: "text",
      params: { id: spec.id, cosd: start.toISOString().slice(0, 10) },
    });
    const value = summarise(spec, parseFredCsv(String(data)));
    if (value.value !== null) {
      cache.set(spec.id, { at: Date.now(), value });
      return value;
    }
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    console.error(`[fred] ${spec.id} failed${status ? ` (HTTP ${status})` : ""}`);
  }
  return hit?.value ?? summarise(spec, []);
}

export async function getMacro(): Promise<MacroSeries[]> {
  return Promise.all(MACRO_SERIES.map(fetchSeries));
}

/**
 * Annual risk-free rate as a decimal, from the 3-month Treasury.
 * `null` when FRED is unreachable — callers fall back to a stated default.
 */
export async function getRiskFreeRate(): Promise<number | null> {
  const spec = MACRO_SERIES.find((s) => s.id === "DGS3MO")!;
  const series = await fetchSeries(spec);
  return series.value === null ? null : series.value / 100;
}

/** Fabricated readings for the fixture provider. */
export function sampleMacro(): MacroSeries[] {
  const levels: Record<string, number> = {
    FEDFUNDS: 4.33, DGS3MO: 4.3, DGS2: 4.2, DGS10: 4.4, T10Y2Y: 0.2, CPIAUCSL: 2.9, UNRATE: 4.1,
  };
  return MACRO_SERIES.map((spec) => {
    const level = levels[spec.id] ?? 1;
    const history = Array.from({ length: 36 }, (_, i) => ({
      date: `20${23 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`,
      value: level + Math.sin(i / 5) * 0.4,
    }));
    return {
      id: spec.id, label: spec.label, unit: spec.unit, note: spec.note,
      value: level, date: "2026-01-01", change: -0.25,
      changeLabel: spec.changeLabel, history,
    };
  });
}
