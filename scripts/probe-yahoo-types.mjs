/**
 * Probe which fundamentals-timeseries type names Yahoo actually recognises.
 *
 * Yahoo silently DROPS type names it doesn't know instead of erroring, and its
 * casing is inconsistent (annualEBITDA, not annualEbitda). So every name the
 * data layer depends on is probed rather than guessed, across a US and an
 * Indian listing.
 *
 * Run:  node scripts/probe-yahoo-types.mjs
 *
 * Writes .scratch/probe-results.json. No dependencies, plain node.
 *
 * ## Why this script was rewritten (2026-11-15)
 *
 * The first version could not distinguish "Yahoo dropped this name" from "the
 * request never succeeded". It recorded a `httpNote` per symbol but never
 * serialised it, and its `dropped` array was computed as "every requested type
 * not seen in a response" — which, when every request 429s, is *every type*.
 *
 * The run of 2026-11-14 did exactly that: all 51 types came back "dropped" for
 * both AAPL and RELIANCE.NS, and the chart-meta probe reported HTTP 429. Read
 * naively, that output says Yahoo recognises none of its own field names. It
 * was acted on as if it were a result, which would have deleted a working
 * mapping.
 *
 * This version therefore:
 *
 *  1. retries each batch with exponential backoff, so a transient 429 does not
 *     become a finding;
 *  2. records the HTTP status of every batch attempt in the output;
 *  3. only classifies a type as `dropped` when the batch containing it
 *     actually returned HTTP 200 — otherwise it is `unknown`;
 *  4. sets a top-level `inconclusive` flag, and prints a loud banner, when any
 *     batch failed. **If `inconclusive` is true, the results must not be used
 *     to change the TS map.**
 */

import { mkdirSync, writeFileSync } from "node:fs";

const SYMBOLS = ["AAPL", "RELIANCE.NS"];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://finance.yahoo.com/",
};

/**
 * Every type the data layer wants, grouped by what it feeds.
 * Where Yahoo's casing is uncertain, BOTH candidates are listed — exactly one
 * should come back, and that tells us the real name.
 */
const GROUPS = {
  "income statement": [
    "annualTotalRevenue",
    "annualGrossProfit",
    "annualOperatingIncome",
    "annualNetIncome",
    "annualEBITDA",
    "annualEbitda", // casing probe — expect this one to be dropped
    "annualEBIT",
    "annualEbit", // casing probe
    "annualPretaxIncome",
    "annualTaxProvision",
    "annualInterestExpense",
    "annualBasicEPS",
    "annualDilutedEPS",
    "annualBasicEps", // casing probe
    "annualBasicAverageShares",
    "annualDilutedAverageShares",
  ],
  "balance sheet": [
    "annualTotalAssets",
    "annualTotalLiabilitiesNetMinorityInterest",
    "annualTotalLiabilities", // legacy name probe
    "annualStockholdersEquity",
    "annualTotalEquityGrossMinorityInterest",
    "annualTotalDebt",
    "annualLongTermDebt",
    "annualCurrentDebt",
    "annualCashAndCashEquivalents",
    "annualCashCashEquivalentsAndShortTermInvestments",
    "annualCurrentAssets",
    "annualCurrentLiabilities",
    "annualInventory",
    "annualRetainedEarnings",
    "annualWorkingCapital",
    "annualInvestedCapital",
    "annualTangibleBookValue",
  ],
  "cash flow": [
    "annualOperatingCashFlow",
    "annualFreeCashFlow",
    "annualCapitalExpenditure",
    "annualCapitalExpenditures", // plural probe
    "annualDepreciationAndAmortization",
  ],
  "trailing (TTM)": [
    "trailingTotalRevenue",
    "trailingNetIncome",
    "trailingEBITDA",
    "trailingEBIT",
    "trailingBasicEPS",
    "trailingDilutedEPS",
    "trailingFreeCashFlow",
    "trailingOperatingCashFlow",
    "trailingGrossProfit",
    "trailingOperatingIncome",
    "trailingInterestExpense",
    "trailingPretaxIncome",
    "trailingTaxProvision",
  ],
};

const ALL_TYPES = Object.values(GROUPS).flat();

// ~8 years back, so there are several annual periods to see.
const PERIOD2 = Math.floor(Date.now() / 1000);
const PERIOD1 = PERIOD2 - 8 * 365 * 24 * 60 * 60;

/** Request types in batches — the URL gets rejected if it's too long. */
const BATCH_SIZE = 20;

/** Backoff schedule, in ms, for a batch that fails. */
const RETRY_DELAYS = [2_000, 8_000, 20_000, 45_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fetch one batch, retrying on any failure.
 *
 * Resolves `{ ok: true, json }` or `{ ok: false, status, attempts }`. A
 * non-200 is never treated as information about the type names.
 */
async function fetchBatch(symbol, batch) {
  const url =
    `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&type=${batch.join(",")}` +
    `&period1=${PERIOD1}&period2=${PERIOD2}&merge=false`;

  const attempts = [];

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1];
      console.error(`    retry ${attempt}/${RETRY_DELAYS.length} in ${delay / 1000}s`);
      await sleep(delay);
    }

    try {
      const res = await fetch(url, { headers: HEADERS });
      attempts.push(`HTTP ${res.status}`);
      if (res.ok) return { ok: true, json: await res.json(), attempts };
      console.error(`  ! ${symbol}: HTTP ${res.status}`);
    } catch (err) {
      attempts.push(err.message);
      console.error(`  ! ${symbol}: ${err.message}`);
    }
  }

  return { ok: false, status: attempts[attempts.length - 1], attempts };
}

async function probeTimeseries(symbol) {
  /** type name -> { periods, first, last, currency, sample } */
  const found = new Map();
  /** Types whose batch returned 200, so a non-appearance is real information. */
  const observed = new Set();
  const batchLog = [];

  for (const batch of batches(ALL_TYPES, BATCH_SIZE)) {
    const result = await fetchBatch(symbol, batch);

    batchLog.push({
      types: batch.length,
      ok: result.ok,
      attempts: result.attempts,
    });

    if (!result.ok) continue;

    // Only now are these names actually under test.
    for (const name of batch) observed.add(name);

    const json = result.json;
    if (json?.timeseries?.error) {
      console.error(
        `  ! ${symbol} API error:`,
        JSON.stringify(json.timeseries.error).slice(0, 200),
      );
    }

    for (const entry of json?.timeseries?.result ?? []) {
      const name = entry?.meta?.type?.[0];
      if (!name) continue;
      const rows = Array.isArray(entry[name]) ? entry[name].filter(Boolean) : [];
      if (rows.length === 0) continue; // present but empty == effectively no data
      found.set(name, {
        periods: rows.length,
        first: rows[0]?.asOfDate ?? "?",
        last: rows[rows.length - 1]?.asOfDate ?? "?",
        currency: rows[0]?.currencyCode ?? "?",
        sample: rows[rows.length - 1]?.reportedValue?.raw ?? null,
      });
    }

    // Be polite — this is an undocumented endpoint.
    await sleep(400);
  }

  return { found, observed, batchLog };
}

/** Fields getQuote depends on from the v8 chart meta block. */
const META_FIELDS = [
  "symbol",
  "longName",
  "shortName",
  "currency",
  "exchangeName",
  "fullExchangeName",
  "regularMarketPrice",
  "chartPreviousClose",
  "previousClose",
  "regularMarketDayHigh",
  "regularMarketDayLow",
  "regularMarketVolume",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLow",
  "instrumentType",
];

async function probeChartMeta(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includeAdjustedClose=true`;

  const attempts = [];
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    try {
      const res = await fetch(url, { headers: HEADERS });
      attempts.push(`HTTP ${res.status}`);
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) return { ok: false, error: "no meta block", attempts };

      const present = {};
      for (const f of META_FIELDS) {
        present[f] = Object.prototype.hasOwnProperty.call(meta, f)
          ? meta[f]
          : undefined;
      }
      return { ok: true, present, allKeys: Object.keys(meta).sort(), attempts };
    } catch (err) {
      attempts.push(err.message);
    }
  }
  return { ok: false, error: attempts[attempts.length - 1], attempts };
}

/* ------------------------------------------------------------------ */

console.log("Probing Yahoo fundamentals-timeseries + chart meta");
console.log(`types: ${ALL_TYPES.length}  symbols: ${SYMBOLS.join(", ")}`);
console.log(
  `window: ${new Date(PERIOD1 * 1000).toISOString().slice(0, 10)} -> ${new Date(PERIOD2 * 1000).toISOString().slice(0, 10)}`,
);
console.log();

const results = {};
for (const symbol of SYMBOLS) {
  console.log(`--- ${symbol} ---`);
  results[symbol] = await probeTimeseries(symbol);
  const { found, observed } = results[symbol];
  console.log(
    `  ${found.size}/${ALL_TYPES.length} types returned data; ${observed.size}/${ALL_TYPES.length} actually tested`,
  );
}
console.log();

/* ---------- conclusiveness gate ---------- */

const failedBatches = SYMBOLS.flatMap((s) =>
  results[s].batchLog.filter((b) => !b.ok),
);
const untested = Object.fromEntries(
  SYMBOLS.map((s) => [s, ALL_TYPES.filter((t) => !results[s].observed.has(t))]),
);
const inconclusive = failedBatches.length > 0;

/** A type is `dropped` only if its batch succeeded and it still didn't appear. */
const classify = (symbol, type) => {
  const { found, observed } = results[symbol];
  if (found.has(type)) return "ok";
  return observed.has(type) ? "dropped" : "unknown";
};

/* ---------- table ---------- */
const col = (s, w) => String(s).padEnd(w);
const W = 46;

console.log("=".repeat(W + 34));
console.log(col("TYPE", W) + col("AAPL", 17) + col("RELIANCE.NS", 17));
console.log("=".repeat(W + 34));

const mark = (symbol, type) => {
  const state = classify(symbol, type);
  if (state === "ok") return `OK (${results[symbol].found.get(type).periods}p)`;
  return state === "dropped" ? "-- dropped" : "?? untested";
};

for (const [group, types] of Object.entries(GROUPS)) {
  console.log(`\n[${group}]`);
  for (const t of types) {
    console.log(col("  " + t, W) + col(mark("AAPL", t), 17) + col(mark("RELIANCE.NS", t), 17));
  }
}

/* ---------- divergence ---------- */
console.log("\n" + "=".repeat(W + 34));
console.log("US vs INDIA DIVERGENCE");
console.log("=".repeat(W + 34));
if (inconclusive) {
  console.log("(suppressed — some batches failed, so divergence is not measurable)");
} else {
  const onlyUS = ALL_TYPES.filter(
    (t) => classify("AAPL", t) === "ok" && classify("RELIANCE.NS", t) === "dropped",
  );
  const onlyIN = ALL_TYPES.filter(
    (t) => classify("AAPL", t) === "dropped" && classify("RELIANCE.NS", t) === "ok",
  );
  console.log("AAPL only     :", onlyUS.length ? onlyUS.join(", ") : "(none)");
  console.log("RELIANCE only :", onlyIN.length ? onlyIN.join(", ") : "(none)");
}

/* ---------- currency + period sanity ---------- */
console.log("\n" + "=".repeat(W + 34));
console.log("CURRENCY / PERIOD SAMPLE");
console.log("=".repeat(W + 34));
for (const s of SYMBOLS) {
  const rev = results[s].found.get("annualTotalRevenue");
  console.log(
    rev
      ? `${col(s, 14)} currency=${rev.currency}  periods=${rev.periods}  ${rev.first} -> ${rev.last}  latestRevenue=${rev.sample}`
      : `${col(s, 14)} annualTotalRevenue ${classify(s, "annualTotalRevenue").toUpperCase()}`,
  );
}

/* ---------- chart meta ---------- */
console.log("\n" + "=".repeat(W + 34));
console.log("CHART META (what getQuote can read)");
console.log("=".repeat(W + 34));
const metaOut = {};
for (const s of SYMBOLS) {
  const m = await probeChartMeta(s);
  metaOut[s] = m;
  console.log(`\n--- ${s} ---`);
  if (!m.ok) {
    console.log("  ERROR:", m.error, `(attempts: ${m.attempts.join(", ")})`);
    continue;
  }
  for (const f of META_FIELDS) {
    const v = m.present[f];
    console.log("  " + col(f, 28) + (v === undefined ? "-- ABSENT" : JSON.stringify(v)));
  }
  console.log("  all meta keys:", m.allKeys.join(", "));
}

/* ---------- machine-readable ---------- */
const dump = {
  probedAt: new Date().toISOString(),
  window: { period1: PERIOD1, period2: PERIOD2 },
  /**
   * TRUE means some request never succeeded, so `dropped`/`unknown` cannot be
   * separated for the affected batches. Do not edit the TS map from an
   * inconclusive run.
   */
  inconclusive,
  batchLog: Object.fromEntries(SYMBOLS.map((s) => [s, results[s].batchLog])),
  timeseries: Object.fromEntries(
    SYMBOLS.map((s) => [s, Object.fromEntries(results[s].found)]),
  ),
  /** Confirmed absent: the batch returned 200 and the type still didn't appear. */
  dropped: Object.fromEntries(
    SYMBOLS.map((s) => [
      s,
      ALL_TYPES.filter((t) => classify(s, t) === "dropped"),
    ]),
  ),
  /** Never actually tested, because every attempt for its batch failed. */
  untested,
  chartMeta: metaOut,
};

mkdirSync(".scratch", { recursive: true });
writeFileSync(".scratch/probe-results.json", JSON.stringify(dump, null, 2));

console.log("\n" + "=".repeat(W + 34));
if (inconclusive) {
  console.log("RESULT: INCONCLUSIVE");
  console.log(
    `${failedBatches.length} batch(es) never succeeded. Untested types: ` +
      SYMBOLS.map((s) => `${s} ${untested[s].length}`).join(", "),
  );
  console.log("Do NOT edit the TS map from this run. Retry from another network.");
} else {
  console.log("RESULT: CONCLUSIVE — every batch returned HTTP 200.");
  console.log("Safe to update the TS map and MARKET_INPUT_GAPS from this run.");
}
console.log("=".repeat(W + 34));
console.log("\nWrote .scratch/probe-results.json");

process.exitCode = inconclusive ? 1 : 0;
