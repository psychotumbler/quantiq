/**
 * Probe the US-GAAP concept tags in Finnhub's `/stock/financials-reported`,
 * across several filers.
 *
 * ## Why this exists
 *
 * `financials-reported` does not return friendly field names. It returns the
 * filer's own XBRL concepts — `us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax`,
 * `us-gaap_IncomeTaxExpenseBenefit` — so `getFinancials` needs a
 * concept -> field mapping. This is structurally the same problem as Yahoo's
 * `TS` type names: pick the wrong tag and the metric is silently `null`, with
 * no error anywhere.
 *
 * It is **worse** than the Yahoo case in one way: XBRL tags vary legitimately
 * between filers. A bank does not report `GrossProfit`; a company with no
 * inventory does not report `InventoryNet`; revenue alone has four common
 * spellings. A mapping validated against one symbol will quietly fail on the
 * next, so this probes a deliberately mixed set of sectors.
 *
 * Run:  node scripts/probe-finnhub-concepts.mjs
 *       node scripts/probe-finnhub-concepts.mjs --dry-run
 *
 * Needs FINNHUB_API_KEY. Writes .scratch/finnhub-concepts.json.
 * The key travels as a header and is redacted from all output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");

function loadEnvLocal(path = ".env.local") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;
    process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, "$2").trim();
  }
}
loadEnvLocal();

const API_KEY = (process.env.FINNHUB_API_KEY ?? "").trim();
if (!API_KEY && !DRY_RUN) {
  console.error("FINNHUB_API_KEY is not set. Add it to .env.local and re-run.");
  process.exit(2);
}
const redact = (text) =>
  API_KEY ? String(text ?? "").split(API_KEY).join("***") : String(text ?? "");

/* ------------------------------------------------------------------ */
/* Symbols — deliberately mixed, because tags vary by filer            */
/* ------------------------------------------------------------------ */

const SYMBOLS = [
  { symbol: "AAPL", why: "tech, the symbol every earlier probe used" },
  { symbol: "MSFT", why: "tech, different filer conventions" },
  { symbol: "JPM", why: "bank — no GrossProfit, no Inventory, different debt tags" },
  { symbol: "XOM", why: "energy, heavy capex and D&A" },
  { symbol: "KO", why: "consumer staples, classic balance sheet" },
  { symbol: "T", why: "telecom, heavy long-term debt" },
];

/* ------------------------------------------------------------------ */
/* Candidate tags per field we need                                    */
/* ------------------------------------------------------------------ */

/**
 * Candidates in **preference order** for every field `FinancialStatement` and
 * `FundamentalInputs` require. The probe reports which candidate each symbol
 * actually carries, so the mapping is chosen from evidence rather than from
 * a guess about which spelling is canonical.
 *
 * `null` entries mark fields that are **not reported at all** and must be
 * derived — recorded here so the derivation is a documented decision.
 */
const FIELD_CANDIDATES = {
  // --- income statement ---
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  taxProvision: ["IncomeTaxExpenseBenefit"],
  interestExpense: [
    "InterestExpense",
    "InterestExpenseDebt",
    "InterestIncomeExpenseNet",
    "InterestAndDebtExpense",
    // Last resort: cash interest PAID, from the cash-flow statement. Not the
    // same as interest expense (excludes accruals and capitalised interest),
    // so it is ranked last and should be flagged where used.
    "InterestPaidNet",
    "InterestPaid",
  ],
  shares: [
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstanding",
  ],
  eps: ["EarningsPerShareBasic", "EarningsPerShareDiluted"],

  // --- balance sheet ---
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities", "LiabilitiesNoncurrent"],
  totalEquity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  inventory: ["InventoryNet"],
  retainedEarnings: ["RetainedEarningsAccumulatedDeficit"],
  cashAndEquivalents: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  currentDebt: ["LongTermDebtCurrent", "DebtCurrent"],

  // --- cash flow ---
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  capitalExpenditure: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ],
  depreciationAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
    // MSFT reports only these. "AndOther" means the figure is NOT pure D&A —
    // it bundles other non-cash items, so an EBITDA built on it is
    // contaminated. Ranked last and must be flagged where used.
    "DepreciationAmortizationAndOther",
    "DepreciationAmortizationAndOtherNoncashItems",
  ],
};

/**
 * Fields with no XBRL tag, which must be derived. Stated explicitly so a
 * missing tag is never mistaken for a probe failure.
 */
const DERIVED_FIELDS = {
  ebitda: "operatingIncome + depreciationAmortization",
  ebit: "operatingIncome, else pretaxIncome + interestExpense",
  freeCashFlow: "operatingCashFlow - capitalExpenditure",
  totalDebt: "longTermDebt + currentDebt",
  workingCapital: "currentAssets - currentLiabilities",
  // Fallbacks established by this probe, for filers that omit the direct tag.
  "totalLiabilities (fallback)":
    "Assets - StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest (NOT plain StockholdersEquity)",
  "shares (fallback)":
    "NetIncomeLossAvailableToCommonStockholdersBasic / EarningsPerShareBasic, else profile2.shareOutstanding",
};

/**
 * Fallback derivations to validate numerically.
 *
 * Each is checked only on filers that report BOTH the direct tag and all the
 * inputs, so agreement is evidence the fallback is correct rather than
 * plausible. A fallback that cannot be validated must not be shipped.
 */
const DERIVATION_CHECKS = [
  {
    // Naive form. Kept because it is the obvious thing to write, and it is
    // WRONG for any filer with a noncontrolling interest: Assets - Liabilities
    // is equity INCLUDING NCI, while StockholdersEquity excludes it. XOM
    // disagreed by 4.0% for exactly this reason.
    name: "totalLiabilities = Assets - StockholdersEquity  (naive)",
    direct: "Liabilities",
    inputs: ["Assets", "StockholdersEquity"],
    compute: ([assets, equity]) => assets - equity,
    tolerance: 0.01,
  },
  {
    // Corrected form: subtract equity including NCI.
    name: "totalLiabilities = Assets - StockholdersEquityIncludingNCI  (corrected)",
    direct: "Liabilities",
    inputs: ["Assets", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    compute: ([assets, equityInclNci]) => assets - equityInclNci,
    tolerance: 0.01,
  },
  {
    // Naive form. WRONG for any filer with preferred stock: EPS is computed on
    // income available to COMMON shareholders, i.e. after preferred
    // dividends. JPM disagreed by 2.5% for exactly this reason.
    name: "shares = NetIncomeLoss / EPSBasic  (naive)",
    direct: "WeightedAverageNumberOfSharesOutstandingBasic",
    inputs: ["NetIncomeLoss", "EarningsPerShareBasic"],
    compute: ([netIncome, eps]) => (eps === 0 ? null : netIncome / eps),
    tolerance: 0.02,
  },
  {
    // Corrected form: use the actual EPS numerator.
    name: "shares = NetIncomeLossAvailableToCommonStockholdersBasic / EPSBasic  (corrected)",
    direct: "WeightedAverageNumberOfSharesOutstandingBasic",
    inputs: ["NetIncomeLossAvailableToCommonStockholdersBasic", "EarningsPerShareBasic"],
    compute: ([available, eps]) => (eps === 0 ? null : available / eps),
    tolerance: 0.02,
  },
];

/* ------------------------------------------------------------------ */
/* Fetch                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = 1_200;

async function fetchFinancials(symbol) {
  const url =
    `https://finnhub.io/api/v1/stock/financials-reported` +
    `?symbol=${encodeURIComponent(symbol)}&freq=annual`;
  try {
    const response = await fetch(url, {
      headers: { "X-Finnhub-Token": API_KEY, Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, message: text.slice(0, 160) };
    return { ok: true, status: response.status, json: JSON.parse(text) };
  } catch (error) {
    return { ok: false, status: null, message: error.message };
  }
}

/** Strip Finnhub's namespace prefix: `us-gaap_Assets` -> `Assets`. */
const bareConcept = (concept) => String(concept ?? "").replace(/^[a-z-]+_/i, "");

/* ------------------------------------------------------------------ */
/* Run                                                               */
/* ------------------------------------------------------------------ */

console.log("Finnhub financials-reported concept probe");
console.log(`symbols: ${SYMBOLS.map((s) => s.symbol).join(", ")}`);
console.log(`fields:  ${Object.keys(FIELD_CANDIDATES).length} mapped, ${Object.keys(DERIVED_FIELDS).length} derived`);
console.log();

if (DRY_RUN) {
  console.log("DRY RUN — no requests.\n");
  for (const { symbol, why } of SYMBOLS) console.log(`  ${symbol.padEnd(6)} ${why}`);
  process.exit(0);
}

const perSymbol = {};
/** Raw payloads, kept in memory so derivations can be checked numerically. */
const rawBySymbol = {};

for (const [index, { symbol, why }] of SYMBOLS.entries()) {
  process.stdout.write(`[${index + 1}/${SYMBOLS.length}] ${symbol.padEnd(6)} `);
  const result = await fetchFinancials(symbol);

  if (!result.ok) {
    console.log(`FAILED  HTTP ${result.status ?? "-"}  ${redact(result.message)}`);
    perSymbol[symbol] = { ok: false, status: result.status };
    if (index < SYMBOLS.length - 1) await sleep(PACE_MS);
    continue;
  }

  const periods = result.json?.data ?? [];

  // Per-period section row counts — this is where the `bs: 0` problem lives.
  const periodInfo = periods.map((period) => {
    const report = period?.report ?? {};
    return {
      year: period?.year,
      quarter: period?.quarter,
      endDate: period?.endDate ?? null,
      filedDate: period?.filedDate ?? null,
      bs: Array.isArray(report.bs) ? report.bs.length : 0,
      ic: Array.isArray(report.ic) ? report.ic.length : 0,
      cf: Array.isArray(report.cf) ? report.cf.length : 0,
    };
  });

  // Every concept this filer uses, union across all periods, per section.
  const conceptsBySection = { bs: new Set(), ic: new Set(), cf: new Set() };
  for (const period of periods) {
    for (const section of ["bs", "ic", "cf"]) {
      for (const row of period?.report?.[section] ?? []) {
        const bare = bareConcept(row?.concept);
        if (bare) conceptsBySection[section].add(bare);
      }
    }
  }
  const allConcepts = new Set([
    ...conceptsBySection.bs,
    ...conceptsBySection.ic,
    ...conceptsBySection.cf,
  ]);

  // Row shape, recorded once — the adapter needs to know where the value is.
  const sampleRow =
    periods.flatMap((p) => p?.report?.ic ?? []).find((r) => r?.concept) ?? null;

  rawBySymbol[symbol] = result.json;
  perSymbol[symbol] = {
    ok: true,
    why,
    periods: periods.length,
    periodInfo,
    conceptsBySection: {
      bs: [...conceptsBySection.bs].sort(),
      ic: [...conceptsBySection.ic].sort(),
      cf: [...conceptsBySection.cf].sort(),
    },
    allConcepts: [...allConcepts].sort(),
    sampleRow,
  };

  const populatedBs = periodInfo.filter((p) => p.bs > 0).length;
  console.log(
    `OK  periods=${String(periods.length).padEnd(3)} concepts=${String(allConcepts.size).padEnd(4)} ` +
      `periods-with-balance-sheet=${populatedBs}/${periodInfo.length}`,
  );

  if (index < SYMBOLS.length - 1) await sleep(PACE_MS);
}

/* ------------------------------------------------------------------ */
/* Report                                                            */
/* ------------------------------------------------------------------ */

const ok = Object.entries(perSymbol).filter(([, v]) => v.ok);
const W = 112;
const pad = (v, w) => String(v).padEnd(w);

if (ok.length === 0) {
  console.log("\nNo symbol returned data — nothing can be concluded about the mapping.");
  process.exit(1);
}

/* ---------- the bs:0 question ---------- */
console.log("\n" + "=".repeat(W));
console.log("BALANCE-SHEET AVAILABILITY PER PERIOD  (the `bs: 0` question)");
console.log("=".repeat(W));
for (const [symbol, data] of ok) {
  const empties = data.periodInfo.filter((p) => p.bs === 0);
  console.log(
    `  ${pad(symbol, 6)} ${pad(`${data.periodInfo.length} periods`, 12)} ` +
      `${empties.length} with an EMPTY balance sheet` +
      (empties.length
        ? `: ${empties.map((p) => `${p.year}/${p.quarter}`).join(", ")}`
        : ""),
  );
}
console.log("\n  Newest 3 periods per symbol (bs/ic/cf row counts):");
for (const [symbol, data] of ok) {
  const newest = [...data.periodInfo]
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, 3)
    .map((p) => `${p.year}/${p.quarter} bs=${p.bs} ic=${p.ic} cf=${p.cf}`)
    .join("   ");
  console.log(`    ${pad(symbol, 6)} ${newest}`);
}

/* ---------- field coverage ---------- */
console.log("\n" + "=".repeat(W));
console.log("FIELD -> CONCEPT COVERAGE  (which candidate each filer actually uses)");
console.log("=".repeat(W));
console.log(pad("FIELD", 26) + pad("CHOSEN TAG (first match)", 56) + "COVERAGE");
console.log("-".repeat(W));

const mapping = {};
const problems = [];

for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
  /** symbol -> the first candidate that symbol carries */
  const hits = {};
  for (const [symbol, data] of ok) {
    const found = candidates.find((candidate) => data.allConcepts.includes(candidate));
    if (found) hits[symbol] = found;
  }

  const covered = Object.keys(hits).length;
  const distinct = [...new Set(Object.values(hits))];
  const primary = distinct[0] ?? null;

  mapping[field] = {
    candidates,
    primary,
    // More than one spelling in use means the adapter needs a fallback chain,
    // not a single tag.
    alsoSeen: distinct.slice(1),
    perSymbol: hits,
    coverage: `${covered}/${ok.length}`,
    missingFor: ok.map(([s]) => s).filter((s) => !hits[s]),
  };

  const flag =
    covered === 0 ? "  <- NOT FOUND ON ANY SYMBOL" : covered < ok.length ? "  <- PARTIAL" : "";
  console.log(
    pad(field, 26) + pad(primary ?? "(none)", 56) + `${covered}/${ok.length}${flag}`,
  );
  if (distinct.length > 1) {
    for (const extra of distinct.slice(1)) {
      console.log(
        pad("", 26) +
          pad(`also: ${extra}`, 56) +
          Object.entries(hits).filter(([, t]) => t === extra).map(([s]) => s).join(","),
      );
    }
  }
  if (covered < ok.length) {
    problems.push({ field, coverage: `${covered}/${ok.length}`, missingFor: mapping[field].missingFor });
  }
}

/* ---------- derived ---------- */
console.log("\n" + "=".repeat(W));
console.log("FIELDS WITH NO TAG — MUST BE DERIVED");
console.log("=".repeat(W));
for (const [field, formula] of Object.entries(DERIVED_FIELDS)) {
  console.log(`  ${pad(field, 24)} = ${formula}`);
}

/* ---------- problems ---------- */
console.log("\n" + "=".repeat(W));
console.log("FIELDS THAT WILL BE NULL FOR SOME FILERS");
console.log("=".repeat(W));
if (problems.length === 0) {
  console.log("  none — every mapped field resolved on every symbol");
} else {
  for (const problem of problems) {
    console.log(
      `  ${pad(problem.field, 24)} ${pad(problem.coverage, 8)} missing for: ${problem.missingFor.join(", ")}`,
    );
  }
  console.log(
    "\n  These are the silent-null risks. Each is either a legitimate filer\n" +
      "  difference (a bank has no inventory) or a missing candidate tag —\n" +
      "  check the per-symbol concept lists in the JSON before assuming which.",
  );
}

/* ---------- row shape ---------- */
/* ---------- EPS precision, the cause of the shares-chain failure ---------- */
console.log("\n" + "=".repeat(W));
console.log("EPS PRECISION PER FILER  (why shares-from-EPS is unsafe)");
console.log("=".repeat(W));
for (const [symbol, data] of ok) {
  const period = latestUsablePeriod(data);
  if (!period) continue;
  const eps = valueAt(rawBySymbol[symbol], period.year, "EarningsPerShareBasic");
  const netIncome = valueAt(rawBySymbol[symbol], period.year, "NetIncomeLoss");
  const shares = valueAt(
    rawBySymbol[symbol],
    period.year,
    "WeightedAverageNumberOfSharesOutstandingBasic",
  );
  const trueEps = netIncome !== null && shares ? netIncome / shares : null;
  const decimals = eps === null ? "-" : (String(eps).split(".")[1] ?? "").length;
  const lowPrecision = eps !== null && decimals <= 1;
  console.log(
    `  ${pad(symbol, 6)} reported EPS=${pad(eps ?? "-", 10)} decimals=${pad(decimals, 4)} ` +
      `implied=${pad(trueEps === null ? "-" : trueEps.toFixed(4), 10)} ` +
      (lowPrecision ? "<- LOW PRECISION, unsafe to divide by" : ""),
  );
}

console.log("\n" + "=".repeat(W));
console.log("ROW SHAPE (what the adapter reads)");
console.log("=".repeat(W));
const sample = ok.find(([, v]) => v.sampleRow)?.[1]?.sampleRow;
console.log(sample ? JSON.stringify(sample, null, 2) : "  no sample row found");

/* ---------- validate the fallback derivations ---------- */

console.log("\n" + "=".repeat(W));
console.log("FALLBACK DERIVATION CHECKS  (only on filers reporting BOTH sides)");
console.log("=".repeat(W));

/** Latest period for a symbol that has a populated balance sheet. */
function latestUsablePeriod(data) {
  return [...data.periodInfo]
    .filter((period) => period.bs > 0)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0] ?? null;
}

/** Value of a bare concept in a given symbol/year, across all sections. */
function valueAt(raw, year, bare) {
  const period = (raw?.data ?? []).find((p) => p?.year === year);
  for (const section of ["bs", "ic", "cf"]) {
    for (const row of period?.report?.[section] ?? []) {
      if (bareConcept(row?.concept) === bare && typeof row?.value === "number") {
        return row.value;
      }
    }
  }
  return null;
}

/**
 * The production fallback CHAINS.
 *
 * Each corrected derivation above validated only on the single filer that
 * carries the NCI / preferred tag, because filers without a noncontrolling
 * interest or preferred stock do not report those tags at all. That is the
 * key insight: the naive form is correct *exactly when* the corrected tag is
 * absent — no NCI means StockholdersEquity already IS total equity; no
 * preferred means NetIncomeLoss already IS income available to common.
 *
 * So the shippable rule is an ordered chain, and these checks prove the chain
 * against the direct tag on every filer that reports one.
 */
const CHAIN_CHECKS = [
  {
    name: "totalLiabilities chain",
    direct: "Liabilities",
    steps: [
      { label: "Assets - EquityInclNCI", inputs: ["Assets", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
      { label: "Assets - StockholdersEquity", inputs: ["Assets", "StockholdersEquity"] },
    ],
    compute: ([a, b]) => a - b,
    tolerance: 0.01,
  },
  {
    /**
     * REJECTED — do not ship. Kept as the record of why.
     *
     * Fails on KO by 1.5%, and the cause is not the numerator: KO's
     * `EarningsPerShareBasic` comes back as the integer **3**, where the true
     * figure is 3.0460. EPS precision varies per filer (AAPL and MSFT return
     * full precision, KO returns a whole number), so ANY shares-from-EPS
     * derivation inherits that rounding. A 1.5% error in share count flows
     * straight into `fcfPerShare` while still looking entirely plausible.
     *
     * Use `profile2.shareOutstanding` instead — directly reported, and
     * already unit-tested in `finnhubUnits.ts`.
     */
    name: "shares chain (REJECTED — EPS precision varies per filer)",
    direct: "WeightedAverageNumberOfSharesOutstandingBasic",
    steps: [
      { label: "AvailableToCommon / EPS", inputs: ["NetIncomeLossAvailableToCommonStockholdersBasic", "EarningsPerShareBasic"] },
      { label: "NetIncomeLoss / EPS", inputs: ["NetIncomeLoss", "EarningsPerShareBasic"] },
    ],
    compute: ([a, b]) => (b === 0 ? null : a / b),
    tolerance: 0.01,
  },
];

const derivationResults = [];

for (const check of DERIVATION_CHECKS) {
  console.log(`\n  ${check.name}`);
  let validated = 0;
  let disagreed = 0;

  for (const [symbol, data] of ok) {
    const raw = rawBySymbol[symbol];
    const period = latestUsablePeriod(data);
    if (!period) continue;

    const direct = valueAt(raw, period.year, check.direct);
    const inputs = check.inputs.map((name) => valueAt(raw, period.year, name));

    if (direct === null || inputs.some((v) => v === null)) {
      console.log(
        `    ${pad(symbol, 6)} ${pad(period.year, 6)} skipped (` +
          (direct === null ? "no direct tag" : "missing an input") +
          ")",
      );
      continue;
    }

    const derived = check.compute(inputs);
    if (derived === null) continue;

    const relative = Math.abs(derived - direct) / Math.max(Math.abs(direct), 1);
    const agrees = relative <= check.tolerance;
    if (agrees) validated += 1;
    else disagreed += 1;

    console.log(
      `    ${pad(symbol, 6)} ${pad(period.year, 6)} direct=${pad(direct.toExponential(4), 13)} ` +
        `derived=${pad(derived.toExponential(4), 13)} rel=${relative.toExponential(1)} ` +
        (agrees ? "AGREES" : "DISAGREES"),
    );
  }

  const verdict =
    validated === 0
      ? "UNVALIDATED — no filer reported both sides; do NOT ship this fallback"
      : disagreed === 0
        ? `VALIDATED on ${validated} filer(s)`
        : `MIXED — ${validated} agree, ${disagreed} disagree; investigate before shipping`;
  console.log(`    -> ${verdict}`);
  derivationResults.push({ check: check.name, validated, disagreed, verdict });
}

/* ---------- validate the production chains ---------- */

console.log("\n" + "=".repeat(W));
console.log("PRODUCTION FALLBACK CHAINS  (first available step wins)");
console.log("=".repeat(W));

const chainResults = [];

for (const chain of CHAIN_CHECKS) {
  console.log(`\n  ${chain.name}  (vs direct tag ${chain.direct})`);
  let agree = 0;
  let disagree = 0;

  for (const [symbol, data] of ok) {
    const raw = rawBySymbol[symbol];
    const period = latestUsablePeriod(data);
    if (!period) continue;

    const direct = valueAt(raw, period.year, chain.direct);
    if (direct === null) {
      console.log(`    ${pad(symbol, 6)} no direct tag — chain is the only source, cannot cross-check`);
      continue;
    }

    // Walk the chain and take the first step whose inputs are all present.
    let used = null;
    let derived = null;
    for (const step of chain.steps) {
      const inputs = step.inputs.map((name) => valueAt(raw, period.year, name));
      if (inputs.some((v) => v === null)) continue;
      const value = chain.compute(inputs);
      if (value === null) continue;
      used = step.label;
      derived = value;
      break;
    }

    if (derived === null) {
      console.log(`    ${pad(symbol, 6)} no chain step resolved`);
      disagree += 1;
      continue;
    }

    const relative = Math.abs(derived - direct) / Math.max(Math.abs(direct), 1);
    const agrees = relative <= chain.tolerance;
    agrees ? (agree += 1) : (disagree += 1);
    console.log(
      `    ${pad(symbol, 6)} via ${pad(used, 30)} rel=${relative.toExponential(1)} ` +
        (agrees ? "AGREES" : "DISAGREES"),
    );
  }

  const verdict =
    disagree === 0 && agree > 0
      ? `CHAIN VALIDATED on all ${agree} cross-checkable filer(s)`
      : `CHAIN NOT SAFE — ${agree} agree, ${disagree} disagree`;
  console.log(`    -> ${verdict}`);
  chainResults.push({ chain: chain.name, agree, disagree, verdict });
}

const dump = {
  probedAt: new Date().toISOString(),
  symbols: SYMBOLS,
  derivationChecks: derivationResults,
  chainChecks: chainResults,
  fieldCandidates: FIELD_CANDIDATES,
  derivedFields: DERIVED_FIELDS,
  mapping,
  problems,
  perSymbol,
};
mkdirSync(".scratch", { recursive: true });
writeFileSync(".scratch/finnhub-concepts.json", JSON.stringify(dump, null, 2));
console.log("\nWrote .scratch/finnhub-concepts.json");

process.exitCode = problems.length > 0 ? 1 : 0;
