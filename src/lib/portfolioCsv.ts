/**
 * Holdings CSV import/export.
 *
 * Accepts any CSV with a symbol column, a quantity column and an average-cost
 * column; header names are matched loosely so broker exports work as they
 * come (for example Zerodha Console's "Instrument", "Qty.", "Avg. cost").
 * Broker files list Indian tickers without an exchange suffix, so the caller
 * says which suffix to append to bare symbols.
 */

export interface CsvHolding {
  symbol: string;
  quantity: number;
  averageCost: number;
}

const SYMBOL_HEADERS = ["symbol", "ticker", "instrument", "scrip", "tradingsymbol", "stock"];
const QUANTITY_HEADERS = ["quantity", "qty", "shares", "units"];
const COST_HEADERS = ["avgcost", "averagecost", "avgprice", "averageprice", "buyprice", "buyavg", "cost", "avg"];

function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z]/g, "");
}

/** Split one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function toNumber(text: string): number {
  // Strip currency symbols and thousands separators: "₹1,234.50" → 1234.5.
  return Number.parseFloat(text.replace(/[^0-9.-]/g, ""));
}

export function parseHoldingsCsv(
  csv: string,
  bareSuffix: "" | ".NS" | ".BO" = "",
): { holdings: CsvHolding[]; skipped: number; error: string | null } {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    return { holdings: [], skipped: 0, error: "The file needs a header row and at least one holding." };
  }

  const headers = splitCsvLine(lines[0]).map(normalise);
  const find = (names: string[]) =>
    headers.findIndex((h) => names.some((name) => h === name || h.startsWith(name)));
  const symbolAt = find(SYMBOL_HEADERS);
  const quantityAt = find(QUANTITY_HEADERS);
  const costAt = find(COST_HEADERS);

  if (symbolAt === -1 || quantityAt === -1 || costAt === -1) {
    return {
      holdings: [],
      skipped: 0,
      error: "Could not find symbol, quantity and average-cost columns in the header row.",
    };
  }

  const holdings: CsvHolding[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    let symbol = (cells[symbolAt] ?? "").toUpperCase().replace(/\s+/g, "");
    const quantity = toNumber(cells[quantityAt] ?? "");
    const averageCost = toNumber(cells[costAt] ?? "");
    if (!symbol || !(quantity > 0) || !(averageCost >= 0)) {
      skipped += 1;
      continue;
    }
    if (bareSuffix && !symbol.includes(".") && !/[\^=]/.test(symbol)) symbol += bareSuffix;
    holdings.push({ symbol, quantity, averageCost });
  }
  return { holdings, skipped, error: holdings.length === 0 ? "No valid rows found." : null };
}

export function holdingsToCsv(holdings: CsvHolding[]): string {
  return [
    "symbol,quantity,average_cost",
    ...holdings.map((h) => `${h.symbol},${h.quantity},${h.averageCost}`),
  ].join("\n");
}
