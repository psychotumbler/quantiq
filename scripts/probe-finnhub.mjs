/**
 * Probe which Finnhub endpoints the configured API key can actually reach.
 *
 * Finnhub's docs list endpoints without saying which plan serves them, and the
 * free tier gates several behind 403. Some gated endpoints also return
 * **HTTP 200 with an empty body** rather than an error, so "it didn't throw"
 * is not evidence of access. Every endpoint the provider will depend on is
 * therefore probed, and the output records three separate things per endpoint:
 * the HTTP status, whether real data came back, and whether it looks like a
 * premium gate.
 *
 * Run:  node scripts/probe-finnhub.mjs
 *       node scripts/probe-finnhub.mjs --dry-run    (print the plan, no calls)
 *
 * Reads FINNHUB_API_KEY from the environment, or from .env.local if present.
 * Writes .scratch/finnhub-probe-results.json.
 *
 * ## The key is never printed
 *
 * It is sent as an `X-Finnhub-Token` header, never as a query parameter, so it
 * cannot leak through a logged URL. Everything written to the console or to
 * the results file passes through `redact()`, which replaces the key (and any
 * `token=` parameter) with `***`. The results file is safe to paste back.
 *
 * ## Why there is a conclusiveness gate
 *
 * The predecessor of this script (scripts/probe-yahoo-types.mjs) originally
 * could not distinguish "the API said no" from "the request never succeeded",
 * and a run where every request failed read as a definitive negative result.
 * See PROGRESS.md. So: any endpoint whose every attempt failed at the
 * transport level is marked `inconclusive`, counted separately, and excluded
 * from the "not available on this plan" conclusion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");
const BASE = "https://finnhub.io/api/v1";

/* ------------------------------------------------------------------ */
/* Key handling                                                        */
/* ------------------------------------------------------------------ */

/**
 * Load .env.local into process.env without overriding anything already set.
 *
 * Deliberately minimal — plain `node` does not read .env.local, and pulling in
 * dotenv for a probe script is not worth a dependency. Handles `KEY=value`,
 * `export KEY=value`, surrounding quotes, and `#` comments.
 */
function loadEnvLocal(path = ".env.local") {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;
    process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return true;
}

loadEnvLocal();

const API_KEY = (process.env.FINNHUB_API_KEY ?? "").trim();

if (!API_KEY && !DRY_RUN) {
  console.error("FINNHUB_API_KEY is not set.");
  console.error("Put it in .env.local as FINNHUB_API_KEY=... or export it, then re-run.");
  console.error("To inspect the probe plan without a key: node scripts/probe-finnhub.mjs --dry-run");
  process.exit(2);
}

/** Strip the key, and any token parameter, from anything we print or write. */
function redact(value) {
  if (value === null || value === undefined) return value;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (API_KEY) text = text.split(API_KEY).join("***");
  text = text.replace(/([?&]token=)[^&\s"']+/gi, "$1***");
  return text;
}

/** Deep-redact a structure on its way into the results file. */
function redactDeep(value) {
  return JSON.parse(redact(JSON.stringify(value)) ?? "null");
}

/* ------------------------------------------------------------------ */
/* Pacing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Free tier is 60 requests/minute. 1,100ms between calls keeps us just under
 * it with room for clock jitter, which matters because a 429 here would be
 * indistinguishable from the gating we are trying to measure.
 */
const PACE_MS = 1_100;
/** Backoff for a 429 or a transport error. */
const RETRY_DELAYS = [2_000, 6_000, 15_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Probe definitions                                                   */
/* ------------------------------------------------------------------ */

const now = Math.floor(Date.now() / 1000);
const ONE_YEAR_AGO = now - 365 * 24 * 60 * 60;
const iso = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** A US large-cap and the Indian listings we need to settle. */
const US_SYMBOL = "AAPL";
const IN_SYMBOLS = ["RELIANCE.NS", "RELIANCE.BO", "RELIANCE.BSE", "RELIANCE"];

/**
 * Each probe declares the call plus an `inspect` that decides whether *real
 * data* came back. That judgement is per-endpoint on purpose: Finnhub signals
 * "nothing here" differently in each shape — `{}`, `{"s":"no_data"}`, an empty
 * array, or an all-zero quote.
 */
const PROBES = [
  /* ---------- the five the DataProvider interface needs ---------- */
  {
    id: "search",
    need: "searchTickers",
    path: "/search",
    params: { q: "apple" },
    inspect: (json) => ({
      hasData: Number(json?.count ?? 0) > 0 && Array.isArray(json?.result) && json.result.length > 0,
      notes: `count=${json?.count ?? "?"}`,
      sample: json?.result?.[0],
    }),
  },
  {
    id: "quote",
    need: "getQuote",
    path: "/quote",
    params: { symbol: US_SYMBOL },
    inspect: (json) => ({
      // An unsupported symbol returns every field as 0 with t=0, HTTP 200.
      hasData: Number(json?.c ?? 0) > 0 && Number(json?.t ?? 0) > 0,
      notes: `c=${json?.c} pc=${json?.pc} t=${json?.t}`,
      fields: fieldReport(json, ["c", "d", "dp", "h", "l", "o", "pc", "t"]),
    }),
  },
  {
    id: "profile2",
    need: "getQuote (marketCap, shares), market resolution",
    path: "/stock/profile2",
    params: { symbol: US_SYMBOL },
    /**
     * The decisive one. `marketCapitalization` and `shareOutstanding` here
     * would unblock fcfYield and altmanZScore, which are currently
     * `requires-quote` for every market.
     */
    inspect: (json) => {
      const fields = fieldReport(json, [
        "ticker",
        "name",
        "currency",
        "exchange",
        "country",
        "marketCapitalization",
        "shareOutstanding",
        "finnhubIndustry",
        "ipo",
      ]);
      return {
        hasData: Boolean(json?.ticker),
        notes:
          `marketCapitalization=${describe(json?.marketCapitalization)} ` +
          `shareOutstanding=${describe(json?.shareOutstanding)} ` +
          `currency=${json?.currency ?? "-"}`,
        fields,
        unblocksFcfYieldAndAltman:
          isUsableNumber(json?.marketCapitalization) ||
          isUsableNumber(json?.shareOutstanding),
      };
    },
  },
  {
    id: "candles",
    need: "getPriceHistory",
    path: "/stock/candle",
    params: { symbol: US_SYMBOL, resolution: "D", from: ONE_YEAR_AGO, to: now },
    /**
     * Expected to be gated: Finnhub moved OHLCV candles to paid plans. If it
     * is, the provider has no price history, which blocks the whole Phase 2a
     * indicator layer and needs its own decision.
     */
    inspect: (json) => ({
      hasData: json?.s === "ok" && Array.isArray(json?.c) && json.c.length > 0,
      notes: `s=${json?.s ?? "-"} bars=${json?.c?.length ?? 0}`,
      fields: fieldReport(json, ["s", "c", "h", "l", "o", "t", "v"]),
    }),
  },
  {
    id: "financials-reported",
    need: "getFinancials",
    path: "/stock/financials-reported",
    params: { symbol: US_SYMBOL, freq: "annual" },
    inspect: (json) => {
      const first = json?.data?.[0];
      const report = first?.report ?? {};
      return {
        hasData: Array.isArray(json?.data) && json.data.length > 0,
        notes:
          `periods=${json?.data?.length ?? 0} ` +
          `sections=[${Object.keys(report).join(",")}] ` +
          `latest=${first?.year ?? "?"}/${first?.quarter ?? "?"}`,
        // The statement sections, and how many line items each carries.
        sectionSizes: Object.fromEntries(
          Object.entries(report).map(([key, rows]) => [
            key,
            Array.isArray(rows) ? rows.length : typeof rows,
          ]),
        ),
        // Concept labels are what a field mapping would key on.
        sampleConcepts: Array.isArray(report?.ic)
          ? report.ic.slice(0, 12).map((row) => row?.concept ?? row?.label)
          : undefined,
      };
    },
  },
  {
    id: "metrics",
    need: "getFundamentalMetrics",
    path: "/stock/metric",
    params: { symbol: US_SYMBOL, metric: "all" },
    inspect: (json) => {
      const metric = json?.metric ?? {};
      const keys = Object.keys(metric);
      /** The ratios Phase 2 wants, to see which are served directly. */
      const wanted = [
        "peBasicExclExtraTTM",
        "pbAnnual",
        "psTTM",
        "roiTTM",
        "roeTTM",
        "roaTTM",
        "grossMarginTTM",
        "operatingMarginTTM",
        "netProfitMarginTTM",
        "currentRatioAnnual",
        "quickRatioAnnual",
        "totalDebt/totalEquityAnnual",
        "netInterestCoverageTTM",
        "freeCashFlowPerShareTTM",
        "beta",
        "52WeekHigh",
        "52WeekLow",
        "dividendYieldIndicatedAnnual",
      ];
      return {
        hasData: keys.length > 0,
        notes: `metricType=${json?.metricType ?? "-"} metricKeys=${keys.length}`,
        wantedPresent: Object.fromEntries(
          wanted.map((key) => [key, describe(metric[key])]),
        ),
      };
    },
  },

  /* ---------- useful for later phases ---------- */
  {
    id: "symbols-US",
    need: "symbol universe / screener (Phase 4)",
    path: "/stock/symbol",
    params: { exchange: "US" },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `symbols=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json) ? json[0] : undefined,
    }),
  },
  {
    id: "basic-earnings",
    need: "earnings surprises (Phase 2d inputs)",
    path: "/stock/earnings",
    params: { symbol: US_SYMBOL },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `quarters=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json) ? json[0] : undefined,
    }),
  },
  {
    id: "recommendations",
    need: "analyst consensus (Phase 2e sentiment)",
    path: "/stock/recommendation",
    params: { symbol: US_SYMBOL },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `periods=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json) ? json[0] : undefined,
    }),
  },
  {
    id: "company-news",
    need: "sentiment headlines (Phase 2e)",
    path: "/company-news",
    params: { symbol: US_SYMBOL, from: iso(now - 14 * 86_400), to: iso(now) },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `articles=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json)
        ? { headline: json[0]?.headline, source: json[0]?.source }
        : undefined,
    }),
  },
  {
    id: "insider-transactions",
    need: "insiderTransactions",
    path: "/stock/insider-transactions",
    params: { symbol: US_SYMBOL },
    inspect: (json) => ({
      hasData: Array.isArray(json?.data) && json.data.length > 0,
      notes: `rows=${json?.data?.length ?? 0}`,
      sample: json?.data?.[0],
    }),
  },
  {
    id: "institutional-ownership",
    need: "institutionalHolders",
    path: "/institutional-ownership",
    params: { symbol: US_SYMBOL, limit: 10 },
    inspect: (json) => ({
      hasData: Array.isArray(json?.data) && json.data.length > 0,
      notes: `rows=${json?.data?.length ?? 0}`,
      sample: json?.data?.[0],
    }),
  },
  {
    id: "dividends",
    need: "dividendYield",
    path: "/stock/dividend",
    params: { symbol: US_SYMBOL, from: iso(ONE_YEAR_AGO), to: iso(now) },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `payments=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json) ? json[0] : undefined,
    }),
  },

  /* ---------- India: to be confirmed, not assumed ---------- */
  ...IN_SYMBOLS.flatMap((symbol) => [
    {
      id: `IN-quote:${symbol}`,
      need: "India coverage check",
      india: true,
      path: "/quote",
      params: { symbol },
      inspect: (json) => ({
        hasData: Number(json?.c ?? 0) > 0 && Number(json?.t ?? 0) > 0,
        notes: `c=${json?.c ?? "-"} t=${json?.t ?? "-"}`,
      }),
    },
    {
      id: `IN-profile2:${symbol}`,
      need: "India coverage check",
      india: true,
      path: "/stock/profile2",
      params: { symbol },
      inspect: (json) => ({
        hasData: Boolean(json?.ticker),
        notes: json?.ticker
          ? `ticker=${json.ticker} exchange=${json?.exchange} currency=${json?.currency}`
          : "empty object",
      }),
    },
  ]),
  {
    id: "IN-search",
    need: "India coverage check — what symbol format, if any",
    india: true,
    // Symbol lookup only. A hit here means the name is in Finnhub's global
    // index, NOT that any data endpoint will serve it, so this must never
    // count toward "India is covered".
    indexOnly: true,
    path: "/search",
    params: { q: "reliance" },
    inspect: (json) => ({
      hasData: Number(json?.count ?? 0) > 0,
      notes: `count=${json?.count ?? 0}`,
      // The decisive detail: which exchanges the free tier will even name.
      sample: Array.isArray(json?.result)
        ? json.result.slice(0, 10).map((row) => row?.symbol)
        : undefined,
    }),
  },
  {
    id: "IN-symbols-NSE",
    need: "India coverage check — NSE symbol universe",
    india: true,
    indexOnly: true,
    path: "/stock/symbol",
    params: { exchange: "NS" },
    inspect: (json) => ({
      hasData: Array.isArray(json) && json.length > 0,
      notes: `symbols=${Array.isArray(json) ? json.length : 0}`,
      sample: Array.isArray(json) ? json.slice(0, 3).map((r) => r?.symbol) : undefined,
    }),
  },
  {
    id: "IN-financials",
    need: "India coverage check — fundamentals",
    india: true,
    path: "/stock/financials-reported",
    params: { symbol: "RELIANCE.NS", freq: "annual" },
    inspect: (json) => ({
      hasData: Array.isArray(json?.data) && json.data.length > 0,
      notes: `periods=${json?.data?.length ?? 0}`,
    }),
  },
];

/* ------------------------------------------------------------------ */
/* Inspection helpers                                                  */
/* ------------------------------------------------------------------ */

function isUsableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

/** Compact description of a value, for the notes column. */
function describe(value) {
  if (value === undefined) return "ABSENT";
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return JSON.stringify(value);
}

/** Per-field presence report, so an absent field is distinct from a zero. */
function fieldReport(json, fields) {
  return Object.fromEntries(fields.map((field) => [field, describe(json?.[field])]));
}

/**
 * Classify a response.
 *
 * `premium` covers the documented 403 gate and the variants Finnhub actually
 * returns, including a 200 with an access message in the body.
 */
function classify(status, bodyText) {
  const text = bodyText ?? "";
  const lowered = text.toLowerCase();
  const gated =
    lowered.includes("don't have access") ||
    lowered.includes("do not have access") ||
    lowered.includes("premium") ||
    lowered.includes("upgrade");

  if (status === 401) return "unauthorized";
  if (status === 403) return "premium";
  if (status === 429) return "rate-limited";
  if (gated) return "premium";
  if (status >= 500) return "server-error";
  if (status !== 200) return `http-${status}`;

  // A 200 carrying HTML is not a successful API call — it is Finnhub serving a
  // landing or error page. Previously this fell through to "ok" with no data,
  // which reads in the summary as "the endpoint works but this symbol has
  // nothing", a materially different and wrong conclusion.
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "non-json-body";
  }

  return "ok";
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

function buildUrl(probe) {
  const url = new URL(BASE + probe.path);
  for (const [key, value] of Object.entries(probe.params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function runProbe(probe) {
  const url = buildUrl(probe);
  const attempts = [];

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);

    try {
      const response = await fetch(url, {
        // Header, not a query parameter: the key must not appear in a URL.
        headers: { "X-Finnhub-Token": API_KEY, Accept: "application/json" },
      });
      const bodyText = await response.text();
      attempts.push(`HTTP ${response.status}`);

      const outcome = classify(response.status, bodyText);

      // A 429 is ours to fix by waiting; anything else is an answer.
      if (outcome === "rate-limited" && attempt < RETRY_DELAYS.length) continue;

      let json = null;
      try {
        json = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        // Non-JSON body — keep the text, truncated, for diagnosis.
      }

      let inspected = {};
      if (outcome === "ok" && json !== null) {
        try {
          inspected = probe.inspect(json) ?? {};
        } catch (error) {
          inspected = { hasData: false, notes: `inspect threw: ${error.message}` };
        }
      }

      return {
        id: probe.id,
        need: probe.need,
        india: Boolean(probe.india),
        indexOnly: Boolean(probe.indexOnly),
        endpoint: probe.path,
        params: probe.params,
        status: response.status,
        outcome,
        attempts,
        hasData: Boolean(inspected.hasData),
        ...inspected,
        bodyPreview: json === null ? bodyText.slice(0, 200) : undefined,
      };
    } catch (error) {
      attempts.push(error.message);
    }
  }

  // Every attempt failed at the transport level: this proves nothing.
  return {
    id: probe.id,
    need: probe.need,
    india: Boolean(probe.india),
    indexOnly: Boolean(probe.indexOnly),
    endpoint: probe.path,
    params: probe.params,
    status: null,
    outcome: "transport-failure",
    attempts,
    hasData: false,
    inconclusive: true,
  };
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

const pad = (value, width) => String(value).padEnd(width);

console.log("Finnhub endpoint probe");
console.log(`base:    ${BASE}`);
console.log(`key:     ${API_KEY ? `present (${API_KEY.length} chars, not shown)` : "ABSENT (dry run)"}`);
console.log(`probes:  ${PROBES.length}`);
console.log(`pacing:  ${PACE_MS}ms between calls (free tier is 60/min)`);
console.log(
  `est:     ~${Math.ceil((PROBES.length * PACE_MS) / 1000)}s if nothing retries`,
);
console.log();

if (DRY_RUN) {
  console.log("DRY RUN — no requests will be made.\n");
  for (const probe of PROBES) {
    // Show the exact query that will be sent, minus the key (which travels as
    // a header and so never appears here at all).
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries(probe.params ?? {}).map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    console.log(`  ${pad(probe.id, 28)} ${pad(probe.path, 30)} ?${query}`);
    console.log(`  ${pad("", 28)} ${pad("", 30)} -> ${probe.need}`);
  }
  console.log(`\n${PROBES.length} probes planned. Re-run without --dry-run to execute.`);
  process.exit(0);
}

/**
 * Re-derive a verdict from a saved results file, making no requests.
 *
 * Exists so a verdict-logic fix can be applied to an *existing* run rather
 * than costing another 24 requests — and so the corrected verdict is produced
 * by this code rather than asserted by hand.
 *
 * Best-effort upgrade of results written by an older version: the stored
 * `outcome` was computed by the classifier of the day, so the one
 * classification fix that can be recovered from the stored fields is applied
 * here. `bodyPreview` is only populated when the body failed to parse as JSON,
 * which is exactly the HTML case.
 */
function reclassifyStored(stored) {
  const byId = new Map(PROBES.map((probe) => [probe.id, probe]));

  return stored.map((result) => {
    // `india` / `indexOnly` are properties of the probe DEFINITION, so they
    // are recoverable by id even for a file written before the flag existed.
    // Without this, an old run's IN-search hit still counts as India coverage.
    const definition = byId.get(result.id);
    const withFlags = definition
      ? {
          ...result,
          india: Boolean(definition.india),
          indexOnly: Boolean(definition.indexOnly),
        }
      : result;

    const preview = (result.bodyPreview ?? "").trimStart().slice(0, 200).toLowerCase();
    const looksHtml = preview.startsWith("<!doctype html") || preview.startsWith("<html");
    if (withFlags.outcome === "ok" && !withFlags.hasData && looksHtml) {
      return {
        ...withFlags,
        outcome: "non-json-body",
        reclassified: "ok -> non-json-body",
      };
    }
    return withFlags;
  });
}

const RECLASSIFY_FLAG = process.argv.indexOf("--reclassify");
if (RECLASSIFY_FLAG !== -1) {
  const file = process.argv[RECLASSIFY_FLAG + 1] ?? ".scratch/finnhub-probe-results.json";
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const upgraded = reclassifyStored(stored.results ?? []);
  const v = deriveVerdict(upgraded);

  console.log(`RECLASSIFY — re-derived from ${file}, no requests made.`);
  console.log(`  probed at: ${stored.probedAt}\n`);

  const changed = upgraded.filter((r) => r.reclassified);
  if (changed.length > 0) {
    console.log("  re-classified by the fixed classifier:");
    for (const r of changed) console.log(`    ${r.id}: ${r.reclassified}`);
    console.log();
  }

  console.log(`  OHLCV (/stock/candle) usable : ${
    upgraded.some((r) => r.id === "candles" && r.outcome === "ok" && r.hasData) ? "YES" : "NO"
  }`);
  console.log(`  key rejected                 : ${v.keyRejected}`);
  console.log(`  conclusive                   : ${v.conclusive}`);
  console.log(
    `  usable ${v.usable.length}  empty-200 ${v.empty.length}  gated ${v.gated.length}` +
      `  (of which 401-gated ${v.gatedBy401.length}, html-body ${v.nonJson.length})` +
      `  inconclusive ${v.inconclusive.length}`,
  );
  console.log(`  india: ${v.indiaUsable.length}/${v.indiaData.length} DATA probes usable` +
    `${v.indiaIndexOnly.length ? `, ${v.indiaIndexOnly.length} index-only hit(s) ignored` : ""}`);

  console.log("\n  OLD verdict: KEY REJECTED (any 401 condemned the run)");
  console.log(
    `  NEW verdict: ${
      v.keyRejected
        ? "KEY REJECTED"
        : v.conclusive
          ? "CONCLUSIVE"
          : "PARTIALLY INCONCLUSIVE"
    }`,
  );
  console.log(`\n  usable endpoints: ${v.usable.map((r) => r.id).join(", ")}`);
  console.log(`  gated endpoints : ${v.gated.map((r) => r.id).join(", ")}`);
  process.exit(0);
}

const results = [];
for (const [index, probe] of PROBES.entries()) {
  process.stdout.write(`[${index + 1}/${PROBES.length}] ${pad(probe.id, 28)} `);
  const result = await runProbe(probe);
  results.push(result);

  const verdict =
    result.outcome === "ok"
      ? result.hasData
        ? "OK + DATA"
        : "OK but EMPTY"
      : result.outcome.toUpperCase();
  console.log(`${pad(verdict, 18)} ${redact(result.notes ?? "")}`);

  if (index < PROBES.length - 1) await sleep(PACE_MS);
}

/* ---------- summary ---------- */

const W = 100;
console.log("\n" + "=".repeat(W));
console.log("SUMMARY");
console.log("=".repeat(W));
console.log(pad("PROBE", 28) + pad("STATUS", 10) + pad("OUTCOME", 20) + "DATA?");
console.log("-".repeat(W));
for (const result of results) {
  console.log(
    pad(result.id, 28) +
      pad(result.status ?? "-", 10) +
      pad(result.outcome, 20) +
      (result.outcome === "ok" ? (result.hasData ? "yes" : "NO — empty") : "-"),
  );
}

/**
 * Derive the run's verdict from its results.
 *
 * Pure and exported-by-reuse so `--reclassify` can re-derive a verdict from a
 * saved results file without spending another 24 requests.
 *
 * ## Why a 401 does not condemn the run
 *
 * The first version concluded `KEY REJECTED` whenever **any** endpoint
 * returned 401. On the 2026-11-15 run one endpoint 401'd
 * (`/stock/symbol?exchange=NS`) while nine others returned real data **with
 * the same key** — so the key was plainly valid and the 401 was Finnhub
 * signalling endpoint-level gating for an exchange outside the plan. The
 * verdict poisoned the whole run from a single probe.
 *
 * This is the *same class of bug* as the Yahoo probe's original flaw: a
 * per-endpoint signal being promoted to a global conclusion. The test is
 * therefore relative, not absolute — a key is only "rejected" if nothing
 * anywhere worked.
 */
function deriveVerdict(results) {
  const usable = results.filter((r) => r.outcome === "ok" && r.hasData);
  const empty = results.filter((r) => r.outcome === "ok" && !r.hasData);
  const premium = results.filter((r) => r.outcome === "premium");
  const unauthorized = results.filter((r) => r.outcome === "unauthorized");
  const nonJson = results.filter((r) => r.outcome === "non-json-body");
  const inconclusive = results.filter((r) => r.inconclusive);

  // A bad key fails everything. Some data getting through proves it is fine.
  const keyRejected = unauthorized.length > 0 && usable.length === 0;
  // 401s alongside working endpoints are gating, not authentication.
  const gatedBy401 = keyRejected ? [] : unauthorized;

  // Everything the free tier will not serve, however it chose to say so.
  const gated = [...premium, ...gatedBy401, ...nonJson];

  // India is covered only if a real DATA endpoint served an Indian symbol.
  // A hit in the global symbol index is not access.
  const indiaData = results.filter((r) => r.india && !r.indexOnly);
  const indiaUsable = indiaData.filter((r) => r.outcome === "ok" && r.hasData);
  const indiaIndexOnly = results.filter(
    (r) => r.india && r.indexOnly && r.outcome === "ok" && r.hasData,
  );

  return {
    usable,
    empty,
    premium,
    unauthorized,
    nonJson,
    inconclusive,
    keyRejected,
    gatedBy401,
    gated,
    indiaData,
    indiaUsable,
    indiaIndexOnly,
    // Endpoint-level 401s and gates are answers, so they do not make a run
    // inconclusive. Only a rejected key or a transport failure does.
    conclusive: !keyRejected && inconclusive.length === 0,
  };
}

const verdict = deriveVerdict(results);
const {
  usable,
  empty,
  gated,
  gatedBy401,
  nonJson,
  unauthorized,
  inconclusive,
  keyRejected,
} = verdict;

/* ---------- the two specific questions ---------- */

console.log("\n" + "=".repeat(W));
console.log("QUESTION 1 — does profile2 unblock fcfYield / altmanZScore?");
console.log("=".repeat(W));
const profile = results.find((r) => r.id === "profile2");
if (profile?.outcome !== "ok" || !profile.hasData) {
  console.log(`  NO — profile2 came back ${profile?.outcome ?? "?"}. Both stay requires-quote.`);
} else if (profile.unblocksFcfYieldAndAltman) {
  console.log("  YES — a usable market cap / share count is present:");
  console.log(`    marketCapitalization : ${profile.fields?.marketCapitalization}`);
  console.log(`    shareOutstanding     : ${profile.fields?.shareOutstanding}`);
  console.log("  NOTE: Finnhub reports marketCapitalization in MILLIONS of the");
  console.log("  profile currency, and shareOutstanding in millions of shares.");
  console.log("  Confirm against a known value before wiring — a 1e6 error here");
  console.log("  would silently scale fcfYield and the Z-Score's X4 factor.");
} else {
  console.log("  NO — profile2 returned data but both fields are absent or zero:");
  console.log(`    marketCapitalization : ${profile.fields?.marketCapitalization}`);
  console.log(`    shareOutstanding     : ${profile.fields?.shareOutstanding}`);
}

console.log("\n" + "=".repeat(W));
console.log("QUESTION 2 — is India covered on this plan?");
console.log("=".repeat(W));
const { indiaData, indiaUsable, indiaIndexOnly } = verdict;
for (const result of results.filter((r) => r.india)) {
  console.log(
    `  ${pad(result.id, 30)} ${pad(result.outcome, 18)} ` +
      `${result.outcome === "ok" ? (result.hasData ? "DATA" : "empty") : ""} ` +
      redact(result.notes ?? ""),
  );
}
console.log();
if (indiaUsable.length === 0) {
  console.log(
    `  CONFIRMED NOT COVERED — 0 of ${indiaData.length} Indian DATA probes returned usable data.`,
  );
  if (indiaIndexOnly.length > 0) {
    // Stated explicitly because it is the easy false positive here.
    console.log(
      `  (${indiaIndexOnly.map((r) => r.id).join(", ")} returned hits, but those are`,
    );
    console.log("   symbol-index lookups — being listed in a global index is not data access.)");
  }
  console.log("  Indian equities need a market-specific provider (NSE/BSE direct).");
} else {
  console.log(`  UNEXPECTED — ${indiaUsable.length} Indian DATA probe(s) returned data:`);
  for (const result of indiaUsable) console.log(`    ${result.id}: ${redact(result.notes)}`);
  console.log("  Re-read before deferring India; the assumption may be wrong.");
}

/* ---------- verdict ---------- */

console.log("\n" + "=".repeat(W));
if (keyRejected) {
  console.log("RESULT: KEY REJECTED");
  console.log(
    `  ${unauthorized.length} endpoint(s) returned 401 and NOTHING returned data.`,
  );
  console.log("  Check FINNHUB_API_KEY. This says nothing about plan coverage.");
} else if (inconclusive.length > 0) {
  console.log("RESULT: PARTIALLY INCONCLUSIVE");
  console.log(`  ${inconclusive.length} probe(s) never completed: ${inconclusive.map((r) => r.id).join(", ")}`);
  console.log("  Those endpoints are UNMEASURED — do not record them as unavailable.");
} else {
  console.log("RESULT: CONCLUSIVE — every probe got an answer.");
}
console.log(
  `  usable: ${usable.length}   empty-200: ${empty.length}   gated: ${gated.length}` +
    `   inconclusive: ${inconclusive.length}`,
);
if (gatedBy401.length > 0) {
  // Spelled out so this is never again mistaken for an auth problem.
  console.log(
    `  NOTE: ${gatedBy401.length} endpoint(s) returned 401 while ${usable.length} others` +
      ` returned data with the same key:`,
  );
  console.log(`        ${gatedBy401.map((r) => r.id).join(", ")}`);
  console.log("        That is endpoint-level gating, not a rejected key.");
}
if (nonJson.length > 0) {
  console.log(
    `  NOTE: ${nonJson.length} endpoint(s) returned HTTP 200 with an HTML body` +
      ` (not a JSON API response): ${nonJson.map((r) => r.id).join(", ")}`,
  );
}
console.log("=".repeat(W));

console.log("\nBuild the provider from the 'usable' set only.");
if (empty.length > 0) {
  console.log(
    `An 'OK but EMPTY' is not access: ${empty.map((r) => r.id).join(", ")}`,
  );
}

/* ---------- machine-readable ---------- */

const dump = {
  probedAt: new Date().toISOString(),
  base: BASE,
  // Never the key itself.
  keyPresent: Boolean(API_KEY),
  keyLength: API_KEY.length,
  pacingMs: PACE_MS,
  conclusive: verdict.conclusive,
  keyRejected,
  counts: {
    total: results.length,
    usable: usable.length,
    emptyButOk: empty.length,
    gated: gated.length,
    gatedBy401: gatedBy401.length,
    nonJsonBody: nonJson.length,
    unauthorized: unauthorized.length,
    inconclusive: inconclusive.length,
  },
  questions: {
    profileUnblocksMarketCap: Boolean(profile?.unblocksFcfYieldAndAltman),
    /** DATA endpoints only — a symbol-index hit is not access. */
    indiaCovered: indiaUsable.length > 0,
    indiaIndexOnlyHits: indiaIndexOnly.map((r) => r.id),
    ohlcvAvailable: results.some((r) => r.id === "candles" && r.outcome === "ok" && r.hasData),
  },
  results: redactDeep(results),
};

mkdirSync(".scratch", { recursive: true });
writeFileSync(".scratch/finnhub-probe-results.json", JSON.stringify(dump, null, 2));
console.log("\nWrote .scratch/finnhub-probe-results.json (key redacted — safe to paste).");

process.exitCode = dump.conclusive ? 0 : 1;
