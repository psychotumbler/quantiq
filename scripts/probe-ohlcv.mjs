/**
 * Probe daily-OHLCV candidates, to replace Finnhub's premium-gated
 * `/stock/candle`.
 *
 * Reports, per provider and per symbol: whether real daily bars come back, how
 * many, the date range and therefore the years of history, the currency and
 * exchange, whether an adjusted close is available, and the parse shape the
 * eventual adapter will need.
 *
 * Run:
 *     node scripts/probe-ohlcv.mjs                  # everything configured
 *     node scripts/probe-ohlcv.mjs --dry-run        # plan only, no calls
 *     node scripts/probe-ohlcv.mjs --only twelvedata
 *     node scripts/probe-ohlcv.mjs --rate-limit-test
 *
 * Keys are read from the environment or `.env.local`:
 *
 *     TWELVEDATA_API_KEY      https://twelvedata.com/pricing   (free, no card)
 *     ALPHAVANTAGE_API_KEY    https://www.alphavantage.co/support/#api-key
 *
 * Stooq and the Yahoo v8 chart need no key.
 *
 * ## Conclusiveness discipline
 *
 * Carried forward from the Yahoo and Finnhub probes, where a per-endpoint
 * signal was twice promoted into a global conclusion. Five outcomes are kept
 * strictly apart, because they license completely different decisions:
 *
 * | Outcome | Means | Conclusion allowed |
 * |---|---|---|
 * | `data` | real bars parsed | yes |
 * | `provider-error` | the API answered "no" in its own words | yes |
 * | `blocked` | HTTP 200 carrying HTML, or a JS challenge | about this network only |
 * | `transport-failure` | every attempt failed to connect | **none** |
 * | `no-key` | nothing configured | **none** — untested, not unavailable |
 *
 * A provider with no key is NEVER reported as unavailable. That distinction is
 * the whole point.
 *
 * ## Why `--rate-limit-test` is opt-in
 *
 * It deliberately bursts requests until the provider refuses. On Alpha
 * Vantage's 25-calls-per-day free tier that **consumes the day's quota**, so
 * it never runs unless asked for.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/* ------------------------------------------------------------------ */
/* Flags and keys                                                      */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const RATE_LIMIT_TEST = argv.includes("--rate-limit-test");
const ONLY = (() => {
  const i = argv.indexOf("--only");
  return i === -1 ? null : argv[i + 1];
})();

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

/** Every configured key, for redaction. Values are never printed. */
const SECRETS = ["TWELVEDATA_API_KEY", "ALPHAVANTAGE_API_KEY", "FINNHUB_API_KEY"]
  .map((name) => (process.env[name] ?? "").trim())
  .filter((value) => value.length >= 8);

/** Replace any configured key, and any apikey/token parameter, with ***. */
function redact(value) {
  if (value === null || value === undefined) return value;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) text = text.split(secret).join("***");
  return text.replace(/((?:apikey|api_key|token)=)[^&\s"']+/gi, "$1***");
}
const redactDeep = (value) => JSON.parse(redact(JSON.stringify(value)) ?? "null");

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_DELAYS = [2_000, 6_000, 15_000];

/**
 * True when a body is a markup page rather than an API response.
 *
 * Checks for a leading `<` rather than specifically `<!doctype html`: Stooq's
 * block page begins `<meta charset=utf-8><title>Stooq</title>`, with no
 * doctype and no `<html>`, and a narrower test misfiled it as a generic HTTP
 * error instead of a block.
 */
function looksHtml(text) {
  const head = (text ?? "").trimStart().slice(0, 400);
  if (!head.startsWith("<")) return false;
  // Exclude XML/RSS payloads, which are legitimate API responses elsewhere.
  return !/^<\?xml/i.test(head);
}

/** Pull readable text out of a markup block page, for the report. */
function markupMessage(text) {
  const stripped = (text ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, 160) || "markup body with no readable text";
}

/** Years spanned by an ISO date range, to one decimal. */
function yearsBetween(first, last) {
  const a = Date.parse(first);
  const b = Date.parse(last);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((Math.abs(b - a) / (365.25 * 86_400_000)) * 10) / 10;
}

/**
 * Summarise parsed bars into the shape the report needs.
 *
 * `bars` must be `{ date, open, high, low, close, volume }` with ISO dates, in
 * any order — this sorts, so a provider's ordering cannot skew the range.
 */
function summarise(bars, extra = {}) {
  const dated = bars.filter((bar) => bar.date).sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length === 0) return { outcome: "empty", bars: 0, ...extra };

  const first = dated[0].date;
  const last = dated[dated.length - 1].date;
  const newest = dated[dated.length - 1];

  // A bar whose OHLC is unusable means the parse is wrong even if rows exist.
  const complete = dated.filter(
    (bar) =>
      [bar.open, bar.high, bar.low, bar.close].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
      ) && bar.high >= bar.low,
  );

  return {
    outcome: "data",
    bars: dated.length,
    completeBars: complete.length,
    first,
    last,
    years: yearsBetween(first, last),
    newestBar: {
      date: newest.date,
      open: newest.open,
      high: newest.high,
      low: newest.low,
      close: newest.close,
      volume: newest.volume,
    },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Provider adapters                                                   */
/* ------------------------------------------------------------------ */

/**
 * Each adapter owns its URL, its pacing, and its parse. The `parse` functions
 * double as the specification for the eventual `DataProvider` adapter, which
 * is why they record `valueType` and `order` — both are implementation traps.
 */
const PROVIDERS = [
  {
    id: "twelvedata",
    label: "Twelve Data",
    keyEnv: "TWELVEDATA_API_KEY",
    signupUrl: "https://twelvedata.com/pricing",
    // Free tier is documented at 8 requests/minute.
    paceMs: 8_000,
    quotaNote: "800 calls/day, 8/min (free)",
    symbols: {
      US: ["AAPL"],
      // The open question: is free global or US-only? Sources disagree, so
      // every plausible NSE/BSE spelling is tried.
      IN: ["RELIANCE", "RELIANCE.NS", "RELIANCE:NSE", "RELIANCE.BSE", "RELIANCE:BSE"],
    },
    url: (symbol, key) =>
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1day&outputsize=5000&apikey=${encodeURIComponent(key)}`,
    parse: (text) => {
      const json = JSON.parse(text);
      if (json?.status === "error" || json?.code >= 400) {
        return { outcome: "provider-error", message: String(json?.message ?? "").slice(0, 220) };
      }
      const values = json?.values ?? [];
      const meta = json?.meta ?? {};
      return summarise(
        values.map((row) => ({
          date: String(row?.datetime ?? "").slice(0, 10),
          open: Number(row?.open),
          high: Number(row?.high),
          low: Number(row?.low),
          close: Number(row?.close),
          volume: Number(row?.volume),
        })),
        {
          currency: meta.currency ?? null,
          exchange: meta.exchange ?? null,
          mic: meta.mic_code ?? null,
          // Implementation traps:
          valueType: "strings — every OHLCV field needs Number()",
          order: "newest first — must be reversed for PriceData (oldest first)",
          hasAdjClose: false,
          adjustmentNote:
            "no adjusted_close on this endpoint; prices appear split-adjusted but NOT dividend-adjusted",
        },
      );
    },
  },

  {
    id: "alphavantage",
    label: "Alpha Vantage",
    keyEnv: "ALPHAVANTAGE_API_KEY",
    signupUrl: "https://www.alphavantage.co/support/#api-key",
    // 25 calls/day on the current free tier, so pace is near-irrelevant; the
    // daily cap is the binding constraint.
    paceMs: 15_000,
    quotaNote: "25 calls/day (free) — the daily cap is the binding limit",
    symbols: {
      US: ["IBM"],
      // Alpha Vantage documents Indian listings via a .BSE suffix.
      IN: ["RELIANCE.BSE", "RELIANCE.NSE", "RELIANCE.BO"],
    },
    url: (symbol, key) =>
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
      `&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${encodeURIComponent(key)}`,
    parse: (text) => {
      const json = JSON.parse(text);
      // Alpha Vantage returns HTTP 200 for refusals, with the reason under one
      // of three different keys. All three are errors, not empty results.
      for (const key of ["Error Message", "Note", "Information"]) {
        if (json?.[key]) {
          return { outcome: "provider-error", message: String(json[key]).slice(0, 220) };
        }
      }
      const series = json?.["Time Series (Daily)"] ?? {};
      const meta = json?.["Meta Data"] ?? {};
      return summarise(
        Object.entries(series).map(([date, row]) => ({
          date,
          open: Number(row?.["1. open"]),
          high: Number(row?.["2. high"]),
          low: Number(row?.["3. low"]),
          close: Number(row?.["4. close"]),
          volume: Number(row?.["5. volume"]),
        })),
        {
          currency: null,
          exchange: null,
          timezone: meta?.["5. Time Zone"] ?? null,
          valueType: "strings under NUMBER-PREFIXED keys ('1. open', '4. close')",
          order: "object keyed by date — order is not guaranteed, sort explicitly",
          hasAdjClose: false,
          adjustmentNote:
            "TIME_SERIES_DAILY is unadjusted; DAILY_ADJUSTED is a premium function",
        },
      );
    },
  },

  {
    id: "stooq",
    label: "Stooq (no key)",
    keyEnv: null,
    signupUrl: null,
    paceMs: 1_500,
    quotaNote: "no published limit; no key, no registration",
    symbols: { US: ["aapl.us"], IN: ["reliance.in", "ril.in", "reliance.us"] },
    url: (symbol) => `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`,
    parse: (text) => {
      if (looksHtml(text)) {
        const challenge = /requires javascript/i.test(text);
        const denied = /access denied/i.test(text);
        return {
          outcome: "blocked",
          message: challenge
            ? "JavaScript browser-verification page, not CSV"
            : denied
              ? `access denied: ${markupMessage(text)}`
              : `markup body, not CSV: ${markupMessage(text)}`,
        };
      }
      const lines = text.trim().split("\n");
      const header = (lines[0] ?? "").toLowerCase();
      if (!header.startsWith("date")) {
        return { outcome: "provider-error", message: `unexpected CSV header: ${header.slice(0, 120)}` };
      }
      return summarise(
        lines.slice(1).map((line) => {
          const [date, open, high, low, close, volume] = line.split(",");
          return {
            date,
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume),
          };
        }),
        {
          currency: null,
          exchange: null,
          valueType: "CSV text — all fields need Number()",
          order: "oldest first (matches PriceData)",
          hasAdjClose: false,
          adjustmentNote: "adjustment basis undocumented",
        },
      );
    },
  },

  {
    id: "yahoo-chart",
    label: "Yahoo v8 chart (local dev only)",
    keyEnv: null,
    signupUrl: null,
    paceMs: 1_500,
    quotaNote: "no key; the one Yahoo endpoint that never required a crumb",
    // Retained as an offline-comparison source, NOT for production: it is
    // undocumented, and it 429s from datacenter IPs.
    localDevOnly: true,
    symbols: { US: ["AAPL"], IN: ["RELIANCE.NS", "RELIANCE.BO"] },
    url: (symbol) =>
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=10y&interval=1d&includeAdjustedClose=true`,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: "https://finance.yahoo.com/",
    },
    parse: (text) => {
      const json = JSON.parse(text);
      const error = json?.chart?.error;
      if (error) {
        return { outcome: "provider-error", message: JSON.stringify(error).slice(0, 220) };
      }
      const result = json?.chart?.result?.[0];
      const meta = result?.meta ?? {};
      const timestamps = result?.timestamp ?? [];
      const quote = result?.indicators?.quote?.[0] ?? {};
      const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
      return summarise(
        timestamps.map((ts, i) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open: Number(quote?.open?.[i]),
          high: Number(quote?.high?.[i]),
          low: Number(quote?.low?.[i]),
          close: Number(quote?.close?.[i]),
          volume: Number(quote?.volume?.[i]),
        })),
        {
          currency: meta.currency ?? null,
          exchange: meta.exchangeName ?? null,
          valueType: "native numbers, with nulls for halted sessions",
          order: "oldest first (matches PriceData)",
          hasAdjClose: adj.length > 0,
          adjustmentNote: "includeAdjustedClose=true gives a dividend-adjusted close",
        },
      );
    },
  },
];

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

function keyFor(provider) {
  if (!provider.keyEnv) return { ok: true, key: "" };
  const key = (process.env[provider.keyEnv] ?? "").trim();
  if (!key) return { ok: false, key: "" };
  return { ok: true, key };
}

async function fetchOnce(provider, symbol, key) {
  const url = provider.url(symbol, key);
  const attempts = [];

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    try {
      const response = await fetch(url, { headers: provider.headers ?? { Accept: "*/*" } });
      const text = await response.text();
      attempts.push(`HTTP ${response.status}`);

      if (response.status === 429 && attempt < RETRY_DELAYS.length) continue;

      if (!response.ok) {
        return {
          status: response.status,
          attempts,
          outcome: looksHtml(text) ? "blocked" : "http-error",
          message: looksHtml(text)
            ? `HTTP ${response.status} with a markup body: ${markupMessage(text)}`
            : text.slice(0, 200),
        };
      }

      try {
        return { status: response.status, attempts, ...provider.parse(text) };
      } catch (error) {
        return {
          status: response.status,
          attempts,
          outcome: looksHtml(text) ? "blocked" : "parse-failure",
          message: looksHtml(text)
            ? `HTTP 200 with a markup body: ${markupMessage(text)}`
            : `${error.message} | body: ${text.slice(0, 160)}`,
        };
      }
    } catch (error) {
      attempts.push(error.message);
    }
  }

  // Never an answer about the provider — only about this network.
  return { status: null, attempts, outcome: "transport-failure", inconclusive: true };
}

/**
 * Burst requests until refused, to observe the real limit rather than the
 * documented one. Opt-in: see the module header.
 */
async function probeRateLimit(provider, key, maxRequests = 12) {
  const symbol = provider.symbols.US[0];
  const observations = [];

  for (let i = 1; i <= maxRequests; i++) {
    const started = Date.now();
    const result = await fetchOnce(provider, symbol, key);
    observations.push({
      request: i,
      ms: Date.now() - started,
      outcome: result.outcome,
      status: result.status,
      message: result.message ? redact(result.message).slice(0, 140) : undefined,
    });
    if (result.outcome !== "data") {
      return { refusedAt: i, observations, note: `refused on request ${i}` };
    }
  }
  return {
    refusedAt: null,
    observations,
    note: `${maxRequests} consecutive requests all succeeded without refusal`,
  };
}

/* ------------------------------------------------------------------ */
/* Report                                                            */
/* ------------------------------------------------------------------ */

const pad = (value, width) => String(value).padEnd(width);

const selected = PROVIDERS.filter((p) => !ONLY || p.id === ONLY);

console.log("Daily-OHLCV provider probe");
console.log(`providers: ${selected.map((p) => p.id).join(", ")}`);
console.log(`rate-limit burst test: ${RATE_LIMIT_TEST ? "ON" : "off (--rate-limit-test to enable)"}`);
console.log();

console.log("KEY STATUS");
for (const provider of selected) {
  const { ok } = keyFor(provider);
  const state = !provider.keyEnv
    ? "no key needed"
    : ok
      ? `${provider.keyEnv} present (not shown)`
      : `${provider.keyEnv} MISSING -> sign up: ${provider.signupUrl}`;
  console.log(`  ${pad(provider.id, 14)} ${state}`);
}
console.log();

if (DRY_RUN) {
  console.log("DRY RUN — no requests will be made.\n");
  for (const provider of selected) {
    console.log(`  ${provider.id}  (${provider.quotaNote}, pace ${provider.paceMs}ms)`);
    for (const [market, symbols] of Object.entries(provider.symbols)) {
      console.log(`    ${market}: ${symbols.join(", ")}`);
    }
  }
  process.exit(0);
}

const report = [];

for (const provider of selected) {
  console.log("=".repeat(96));
  console.log(`${provider.label}  —  ${provider.quotaNote}`);
  if (provider.localDevOnly) console.log("  (local dev / offline comparison only — not for production)");
  console.log("=".repeat(96));

  const { ok, key } = keyFor(provider);
  if (!ok) {
    // UNTESTED, not unavailable.
    console.log(`  SKIPPED — no ${provider.keyEnv}. Sign up: ${provider.signupUrl}\n`);
    report.push({
      provider: provider.id,
      label: provider.label,
      outcome: "no-key",
      keyEnv: provider.keyEnv,
      signupUrl: provider.signupUrl,
      symbols: [],
    });
    continue;
  }

  const symbolResults = [];
  const flat = Object.entries(provider.symbols).flatMap(([market, symbols]) =>
    symbols.map((symbol) => ({ market, symbol })),
  );

  for (const [index, { market, symbol }] of flat.entries()) {
    process.stdout.write(`  ${pad(market, 3)} ${pad(symbol, 16)} `);
    const result = await fetchOnce(provider, symbol, key);
    symbolResults.push({ market, symbol, ...result });

    if (result.outcome === "data") {
      console.log(
        `DATA  bars=${pad(result.bars, 6)} ${result.first} -> ${result.last}  ` +
          `(${result.years}y)  ${result.currency ?? "?"} ${result.exchange ?? ""}`,
      );
    } else {
      console.log(`${pad(result.outcome.toUpperCase(), 18)} ${redact(result.message ?? "")}`);
    }

    if (index < flat.length - 1) await sleep(provider.paceMs);
  }

  let rateLimit = null;
  if (RATE_LIMIT_TEST) {
    console.log(`\n  rate-limit burst (${provider.id})...`);
    rateLimit = await probeRateLimit(provider, key);
    console.log(`  ${rateLimit.note}`);
  }

  const usable = symbolResults.filter((r) => r.outcome === "data" && r.completeBars > 0);
  const inconclusive = symbolResults.filter((r) => r.inconclusive);

  /**
   * A provider earns a coverage verdict only if something actually ANSWERED.
   *
   * An answer is real bars (`data`) or the API saying no in its own words
   * (`provider-error`). A 403/429, a markup block page and a dropped
   * connection are all refusals aimed at the caller, and say nothing about
   * which markets the provider serves.
   *
   * Phrasing it as "did anything answer?" rather than "were they all
   * refusals?" matters: on the first run Yahoo returned 429 for two symbols
   * and a dropped connection for the third, so an all-refusals test saw a
   * mixed set, fell through to `tested`, and printed `US: NO  India: NO` —
   * turning a network block into a false verdict on the provider. That is the
   * same mistake the Yahoo and Finnhub probes each made once already, so the
   * rule here is deliberately the conservative one.
   */
  const answered = symbolResults.filter(
    (r) => r.outcome === "data" || r.outcome === "provider-error",
  );
  const refusals = symbolResults.filter((r) => !answered.includes(r));

  const outcome =
    answered.length > 0
      ? "tested"
      : inconclusive.length === symbolResults.length
        ? "inconclusive"
        : "blocked";

  report.push({
    provider: provider.id,
    label: provider.label,
    localDevOnly: Boolean(provider.localDevOnly),
    quotaNote: provider.quotaNote,
    outcome,
    // Only meaningful when `outcome === "tested"`.
    usMarket: symbolResults.some((r) => r.market === "US" && r.outcome === "data"),
    inMarket: symbolResults.some((r) => r.market === "IN" && r.outcome === "data"),
    maxYears: Math.max(0, ...usable.map((r) => r.years ?? 0)),
    blockedStatuses:
      outcome === "blocked"
        ? [...new Set(refusals.map((r) => r.status ?? "no-connection"))]
        : [],
    rateLimit,
    symbols: symbolResults,
  });
  console.log();
}

/* ---------- verdict ---------- */

console.log("=".repeat(96));
console.log("VERDICT");
console.log("=".repeat(96));
console.log(pad("PROVIDER", 16) + pad("US", 6) + pad("INDIA", 8) + pad("HISTORY", 10) + "NOTE");
console.log("-".repeat(96));

for (const entry of report) {
  if (entry.outcome === "no-key") {
    console.log(pad(entry.provider, 16) + pad("?", 6) + pad("?", 8) + pad("?", 10) + "UNTESTED — no key configured");
    continue;
  }
  if (entry.outcome === "inconclusive") {
    console.log(pad(entry.provider, 16) + pad("?", 6) + pad("?", 8) + pad("?", 10) + "INCONCLUSIVE — every request failed to connect");
    continue;
  }
  if (entry.outcome === "blocked") {
    console.log(
      pad(entry.provider, 16) +
        pad("?", 6) +
        pad("?", 8) +
        pad("?", 10) +
        `BLOCKED FROM THIS NETWORK (${entry.blockedStatuses.join("/")}) — no verdict on coverage`,
    );
    continue;
  }
  console.log(
    pad(entry.provider, 16) +
      pad(entry.usMarket ? "yes" : "NO", 6) +
      pad(entry.inMarket ? "yes" : "NO", 8) +
      pad(entry.maxYears ? `${entry.maxYears}y` : "-", 10) +
      (entry.localDevOnly ? "local dev only" : ""),
  );
}

const untested = report.filter((e) => e.outcome === "no-key");
if (untested.length > 0) {
  console.log("\nSIGN UP FOR THESE TO FINISH THE PROBE:");
  for (const entry of untested) {
    console.log(`  ${pad(entry.provider, 14)} ${entry.signupUrl}`);
    console.log(`  ${pad("", 14)} then add ${entry.keyEnv}=... to .env.local`);
  }
  console.log("\n  These are UNTESTED, not unavailable. No conclusion may be drawn about them.");
}

const indiaCapable = report.filter((e) => e.outcome === "tested" && e.inMarket && !e.localDevOnly);
console.log(
  `\nIndia-capable production candidates: ${
    indiaCapable.length ? indiaCapable.map((e) => e.provider).join(", ") : "NONE CONFIRMED YET"
  }`,
);

const dump = {
  probedAt: new Date().toISOString(),
  rateLimitTestRun: RATE_LIMIT_TEST,
  providers: redactDeep(report),
};
mkdirSync(".scratch", { recursive: true });
writeFileSync(".scratch/ohlcv-probe-results.json", JSON.stringify(dump, null, 2));
console.log("\nWrote .scratch/ohlcv-probe-results.json (keys redacted — safe to paste).");

process.exitCode = untested.length > 0 ? 1 : 0;
