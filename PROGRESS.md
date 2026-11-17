# QuantIQ — Build Progress

Running log, appended after each sub-step. Newest at the bottom.

---

## Phase 1 — Foundation + Data Layer

Split into three sub-steps: **1a** types + service, **1b** API routes, **1c** UI.

### 1a — Types + Yahoo service

**Files**

- `src/types/stock.ts` — all domain interfaces. Every provider-sourced numeric
  is `number | null` (never optional `?`), so missing data is explicit and
  cannot become `NaN` downstream. Also exports `Market`, `SignalDirection`,
  `CompositeSignal`, and helper shapes (`MACD`, `BollingerBands`,
  `SentimentHeadline`, `SIPYearlyPoint`).
- `src/services/yahooFinance.ts` — `searchTickers`, `getQuote`,
  `getPriceHistory`, `getFinancials`, `getFundamentalMetrics`, plus exported
  `marketFromExchange`.

**Notable decisions**

- Requests go through one shared axios instance with browser-like headers
  (User-Agent, Accept, Accept-Language, Referer). Yahoo rejects plain clients.
- `formatted=false` is passed to `quoteSummary`, so Yahoo returns bare numbers;
  the `raw()` helper handles both bare numbers and `{ raw, fmt }` wrappers and
  rejects non-finite values.
- `getFinancials` merges the three statement arrays **by fiscal period end
  date**, not by array index. The arrays are not always equal length, and an
  index merge would silently attribute one year's balance sheet to another
  year's revenue. Index is only a fallback.
- Yahoo reports no annual EBITDA (only TTM). It is reconstructed as
  `operatingIncome + depreciation` from the cash-flow statement.
- `freeCashFlow = operatingCashFlow + capitalExpenditures` (capex is reported
  negative).
- `roic`, `fcfYield`, `fcfPerShare`, `interestCoverage`, `altmanZScore` are
  deliberately left `null` — they get derived in the Phase 2 analysis layer.
- Every function absorbs its own errors, logs with context, and returns
  `[]` / `null`. Callers need no try/catch.

### 1b — API routes

**Files**

- `src/app/api/stock/[symbol]/route.ts` — `GET /api/stock/:symbol`. Four
  upstream calls via `Promise.all`. 400 missing symbol, 404 when neither a
  quote nor any price history came back, 500 on an unhandled throw. Exports a
  `StockRouteData` type.
- `src/app/api/search/route.ts` — `GET /api/search?q=`. An empty `q` returns
  **200 with `[]`**, not 400, because the UI debounces keystrokes and would
  otherwise flash errors mid-typing.

**Next.js 16 gotchas hit**

- Route `params` is a `Promise` and must be awaited.
- **`export const dynamic = "force-dynamic"` is incompatible with this
  project's `cacheComponents: true`** (set in `next.config.ts`) and returns a
  hard 500: `Route segment config "dynamic" is not compatible with
  nextConfig.cacheComponents`. Removed from both routes. It was unnecessary
  anyway — under Cache Components a GET handler that makes network requests is
  runtime-rendered automatically. Do not re-add it in later phases.

### 1c — UI

**Files**

- `src/app/page.tsx` — full client page: sticky header, debounced (300ms)
  autocomplete with outside-click dismissal, quote header, 6-card stat grid,
  fundamentals grid, 10-session price table, annual financials table, plus
  empty / loading-skeleton / error states. Helpers `formatNumber`,
  `formatPercent`, `formatRatio`, `formatPrice`, `currencySymbol`.
- `src/app/globals.css` — replaced the scaffold's light/dark CSS variables with
  a fixed dark palette. QuantIQ is dark-only on purpose: a light mode would
  wash out the red/green P&L semantics.
- `src/app/layout.tsx` — metadata title/description only.

**Notable decisions**

- A stale-response guard (`requestIdRef`) stops a slow earlier request from
  overwriting a newer result.
- Beta is rendered in the fundamentals card but sourced from `QuoteData`, not
  `FundamentalMetrics` — that's where the provider reports it.
- `debtToEquity` is divided by 100 for display, because Yahoo reports it in
  percent (154.5 meaning 1.54x). **Unverified** — see blocker below.

---

## BLOCKER — Yahoo Finance returns HTTP 429 from this network

**Status: open. The data layer is written but has never returned real data.**

Every `query1/query2.finance.yahoo.com` endpoint (chart, search, quoteSummary)
returns `429 Too Many Requests` from this machine's IP, consistently, over
~20 minutes of retries. Verified independently via curl, Node `fetch`, and the
app's own routes. It is not a code bug and not a transient spike:

- `https://finance.yahoo.com` and `fc.yahoo.com` are reachable and do set
  cookies, so it is not a general network/DNS failure.
- The 429 is returned by Yahoo's edge, not a local proxy (no proxy is set).
- The cookie + crumb handshake that sometimes lifts this could not be tested —
  it was blocked by the sandbox permission classifier.

**Consequence:** field-level mappings in `yahooFinance.ts` (Yahoo's exact key
names, EBITDA reconstruction, the `debtToEquity` percent assumption, the
`changePercent` fraction assumption) are written from knowledge of Yahoo's
schema but are **not confirmed against a live payload**. Expect to correct some
key names on first successful call.

**Options:** retry later / from another network; switch to a keyed provider
(Alpha Vantage, Finnhub, FMP, or twelvedata); or add a provider abstraction so
the source is swappable. Awaiting a decision.

## Secondary issue — ESLint is broken (pre-existing)

`npx eslint src` fails: `Cannot find module 'eslint-config-next/core-web-vitals'`.
`package.json` pins `eslint-config-next@^15.5.29` against `next@16.4.6`.
Bumping it to `^16` should fix it. Not changed — it's a dependency decision and
outside Phase 1 scope. `tsc --noEmit` is clean, so this does not block work.

---

### 1d — Provider abstraction (decision: "add a provider abstraction now")

**Files**

- `src/services/provider.ts` — the `DataProvider` interface and `ProviderId`
  union. Phases 2+ depend on this, never on a vendor module.
- `src/services/index.ts` — registry. `getProvider(id?)` resolves in the order
  explicit argument → `QUANTIQ_DATA_PROVIDER` env var → `DEFAULT_PROVIDER`
  (`"yahoo"`). An unrecognised id warns and falls back instead of throwing, so
  a typo in `.env` cannot take the app down. Also exports `listProviders()`.
- `src/services/yahooFinance.ts` — now also exports `yahooProvider`
  implementing the interface. The named functions remain exported for direct
  use and testing.
- `src/services/fixtureProvider.ts` — **sample data, not a data source.**
  Opt in with `QUANTIQ_DATA_PROVIDER=fixture npm run dev`. Exists so the UI,
  formatters and API contract can be verified while Yahoo is blocked. Its
  shapes deliberately include a `null` dividend yield, a `null` EBITDA period,
  a loss-making year and an INR listing, so the `N/A` and currency paths get
  tested rather than assumed. Unknown symbols resolve to `null`/`[]` rather
  than falling back to a default, so the route's 404 path stays testable.
- Both API routes now call `getProvider()` instead of importing Yahoo.

### 1e — Shared formatters extracted

- `src/lib/format.ts` — `formatNumber`, `formatPercent`, `formatRatio`,
  `formatPrice`, `currencySymbol`, `formatDebtToEquity`, `changeColor`,
  `withSign`, `fiscalYear`, `NA`. Moved out of `page.tsx` so every view
  formats a figure the same way, and so they are unit-testable. `page.tsx`
  imports them.
- **38/38 unit assertions pass** (compiled with `tsc`, run under node),
  covering T/B/M/K boundaries, negatives, zero, `null`/`undefined`/`NaN`/
  `Infinity`, the INR vs USD symbol switch, thousands separators, and the
  debt-to-equity percent normalisation.
- Note: `formatNumber(3_585_000_000_000)` returns `"3.58T"`, not `"3.59T"` —
  3.585 is stored as 3.58499… under IEEE-754. Correct JS behaviour, not a bug.

### Verification status at end of Phase 1

Verified by running:

- `tsc --noEmit` clean across the whole project.
- Route status codes: `/` 200, `/api/search?q=apple` 200,
  `/api/search?q=` 200 (empty list), `/api/stock/AAPL` 200,
  `/api/stock/RELIANCE.NS` 200, `/api/stock/ZZZZINVALID` 404.
- Response envelopes match `APIResponse<T>` exactly.
- Fixture-backed payloads: 180 price bars, 4 annual periods, INR currency and
  `null` dividend yield surviving the round trip intact.
- Graceful degradation under the live Yahoo 429: all four service calls logged
  `HTTP 429` and returned `[]`/`null`, the route returned a clean 404 envelope,
  and nothing threw or crashed.
- Page SSR shell contains the header, wordmark, "Built by Aryaveer", Live dot,
  search input, Analyze button and the empty state with all four example
  tickers.

**Not verified:**

- Any real market data. Yahoo has never returned a payload (see blocker).
- The browser-rendered results view. The results are client-rendered, and no
  browser automation was available in this session, so the quote header, stat
  grid, fundamentals grid and both tables have been verified only as code plus
  correct API payloads — not seen on screen. **Open `http://localhost:3000`
  and click an example ticker to confirm visually.**

**Suggested next:** have `/api/stock/:symbol` include the provider id/label in
its response and show a visible "sample data" banner when it is `fixture`, so
fixture output can never be mistaken for live data in a screenshot.

---

## Data blocker — RESOLVED (not a code problem)

Aryaveer tested Yahoo from his own browser and got a full valid payload
(AAPL `regularMarketPrice` 356.27, `error: null`, complete chart structure).
The 429 is specific to this sandbox's egress, **not** the user's network and
not the code. `yahooProvider` stays the default; no second provider needed.

Consequence: field mappings still cannot be verified from inside the sandbox.
Verification is proceeding by pasting raw JSON from the user's browser. URLs
requested cover `incomeStatementHistory` + `cashflowStatementHistory` +
`balanceSheetHistory` (settles the EBITDA reconstruction) and `financialData`
(settles whether `debtToEquity` is percent or ratio), for AAPL and RELIANCE.NS.
**Still open pending that paste.**

## Lint fixed

`eslint-config-next` bumped to `^16.4.6`. Lint now runs, and it caught two
real issues in `page.tsx`, both fixed:

1. `react-hooks/set-state-in-effect` (error) — the autocomplete effect called
   `setSuggestions([])` synchronously in the effect body when the box was
   emptied, which triggers cascading renders. Clearing now happens inside the
   debounce timer (with a `0ms` delay for the empty case), so no `setState`
   runs synchronously in the effect body.
2. An unused `currencySymbol` import.

`tsc --noEmit` and `eslint src` are both clean.

---

## Phase 2 — Analysis Layer

Split: **2a** indicators, **2b** signal interpretation, **2c** derived
fundamentals (blocked on the JSON paste), **2d** DCF, **2e** risk + composite.

### 2a — Technical indicators

**File:** `src/analysis/technicals.ts` — pure, no I/O, no provider coupling.

Exports `sma`, `ema`, `emaSeries`, `rsi`, `macd`, `bollingerBands`, `atr`,
`adx`, `obv`, `cleanBars`, `computeTechnicalIndicators`.

**Decisions**

- RSI, ATR and ADX use **Wilder smoothing**, the original definitions — not an
  SMA. Using an SMA here is a common bug and gives values that disagree with
  every charting platform.
- Indicators return `null` rather than a wrong number when there is too little
  history. A 50-day SMA on 30 bars is not a 50-day SMA.
- EMA is seeded with the SMA of the first `period` values, so the result does
  not depend on how much history precedes the window.
- `cleanBars` drops any bar missing high/low/close/volume (providers pad halted
  sessions with nulls) — carrying those into a standard deviation or a true
  range would produce silent garbage.
- Bollinger uses the **population** standard deviation.
- RSI returns 100 when the window has no downward movement (the correct limit,
  not a divide-by-zero) and 50 for a perfectly flat series.
- `computeTechnicalIndicators` is wired into `/api/stock/:symbol`, which now
  returns a `technicals` field. It is derived from `priceHistory` locally, so
  it adds no upstream latency.

**Verified**

- **36/36** assertions pass: exact hand-computed values for SMA, EMA, OBV, ATR
  and Bollinger (mean 5, population sd 2 → bands 1/5/9); limit properties for
  RSI (all-gains = 100, all-losses = 0, flat = 50, output always in [0,100]);
  MACD = 0 on a flat series and positive on a rising one; ADX ≈ 100 on a pure
  uptrend and within [0,100]; `null` for every indicator given insufficient
  bars; `cleanBars` dropping 4 of 6 malformed rows.
- **Cross-checked against an independent Python reference** written from the
  indicator definitions rather than from the TypeScript. All 13 outputs agree
  to floating-point noise — max relative difference **1.2e-16**.
- End-to-end through the route on 180 fixture bars: `sma50` 253.17,
  `rsi14` 44.14, `adx` 32.85, `atr` 3.10, bands correctly ordered, and
  `sma200` correctly `null` at 180 bars.

---

## CORRECTION — Phase 1's data layer was built on a dead endpoint

**What was wrong.** `v10/finance/quoteSummary` requires a crumb + cookie
session. Unauthenticated requests get:

```json
{"finance":{"result":null,"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}
```

Confirmed from Aryaveer's own machine (`.scratch/aapl-raw.json`,
`.scratch/reliance-raw.json`), so it is not a sandbox artifact. **Three of the
five service functions were non-functional as written** — `getQuote`,
`getFinancials` and `getFundamentalMetrics` all called `quoteSummary`. Only
`getPriceHistory` (v8 chart) and `searchTickers` ever worked.

**Why it wasn't caught.** The sandbox could not make any live Yahoo call (429
on every endpoint), and the one manual browser test used the chart endpoint,
which works. The 429 masked a second, unrelated failure. Lesson for later
phases: a provider function that has never returned a live payload should be
treated as unverified regardless of how clean its types are.

**What replaced it.** Two endpoints confirmed to work without auth:

- `v8/finance/chart/{symbol}` — prices, plus a `meta` block for quotes.
- `ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}` — statements.

**Timeseries shape** (from `.scratch/aapl-timeseries.json`): each requested
type is its own entry in `timeseries.result`, keyed by its own name, with
periods **oldest first**, values at `reportedValue.raw`, and `asOfDate` /
`currencyCode` on every row.

**Key changes in `src/services/yahooFinance.ts`:**

- All timeseries type names live in one exported `TS` map, so a probe
  correction is a one-line change. Names confirmed live are marked
  `CONFIRMED`; the rest are flagged `UNCONFIRMED: pending probe`.
- **EBITDA is read directly from `annualEBITDA`** (all-caps). The
  `operatingIncome + depreciation` reconstruction is **deleted**.
- **`debtToEquity` is now our own arithmetic**: `annualTotalDebt /
  annualStockholdersEquity`, a true ratio (0.71 = 0.71x). The percent-vs-ratio
  ambiguity is gone, and `formatDebtToEquity` (which divided by 100) has been
  **removed** from `src/lib/format.ts` — the page uses `formatRatio` now. The
  fixture's `debtToEquity` was changed from `154.49` to `1.5449` to match.
- Periods align by Yahoo's own `asOfDate`, so the index-merge hazard of the
  old implementation is gone by construction.
- **Yahoo silently drops unrecognised type names** rather than erroring, so a
  typo becomes a `null` metric with no HTTP error. `fetchTimeseries` therefore
  logs a loud `console.warn` listing every requested type that came back empty.
- Parsing and transformation are split into exported pure functions —
  `parseTimeseriesPayload`, `buildStatements`, `buildFundamentals` — so they
  can be tested against real saved payloads instead of trusted.

### What chart `meta` genuinely cannot provide

`getQuote` returns these as `null` rather than guessing. Flagged rather than
silently nulled, as requested:

| Field | Why | Plan |
|---|---|---|
| `marketCap` | not in meta | needs a share count; only an *annual average* is available from timeseries, which is stale and the wrong measure |
| `peRatio`, `eps` | not in meta | need trailing EPS from timeseries — derive in the analysis layer |
| `dividendYield` | not in meta at all | no unauthenticated source found yet |
| `beta` | not in meta | it's a computed statistic — the risk layer (2e) derives it from price history vs an index |
| `forwardPE`, `pegRatio` | need analyst estimates | **no unauthenticated endpoint provides these.** Likely permanently unavailable without a key |

`avgVolume` **is** provided: the chart response already carries the volume
series, so `getQuote` computes a 3-month average from it rather than returning
`null`.

### Probe script — ready to run

`.scratch/probe-types.mjs` (plain node, no deps). Requests **57 type names**
across AAPL and RELIANCE.NS in batches of 20, and prints which returned data
and which Yahoo dropped. It deliberately includes **casing probes** for the
ambiguous names (`annualEbitda` vs `annualEBITDA`, `annualEbit` vs
`annualEBIT`, `annualBasicEps` vs `annualBasicEPS`, `annualCapitalExpenditure`
vs `annualCapitalExpenditures`, `annualTotalLiabilities` vs
`annualTotalLiabilitiesNetMinorityInterest`) — exactly one of each pair should
come back, which is what identifies the real name.

It also prints a **US vs India divergence** section (types one listing has and
the other lacks) and a **chart meta** dump for both symbols, and writes
`.scratch/probe-results.json`.

Note: `.scratch/` has been added to `.gitignore`.

### Still open

- The 57 type names are unverified until the probe runs. `UNCONFIRMED` entries
  in `TS` may be wrong, and because Yahoo drops silently they would surface as
  `null` metrics, not errors.
- Whether Indian listings expose the same types as US ones (point 3) — the
  probe's divergence section answers this.

---

## CORRECTION — the probe run of 2026-11-14 established nothing

**The probe output could not be acted on. No type name has been marked
CONFIRMED, and the `TS` map is unchanged.**

`.scratch/probe-results.json` reported all 51 probed type names as `dropped`
for **both** AAPL and RELIANCE.NS, and `chartMeta` as `HTTP 429` for both. Read
literally, that says Yahoo recognises none of its own field names — including
`annualTotalRevenue`, which `.scratch/aapl-timeseries.json` already proves
returns four periods of data.

Three things identify it as a rate-limited probe rather than a result:

1. **Every** type dropped for **both** symbols, including names already
   confirmed against a saved payload.
2. **Zero** US/India divergence — the divergence section was empty in both
   directions, which is what you get when neither symbol returned anything,
   not when two markets genuinely differ.
3. `chartMeta` reported HTTP 429 explicitly, from the same script, same host,
   same minute.

Re-verified live from this sandbox on 2026-11-15: both
`ws/fundamentals-timeseries/...` and `v8/finance/chart/...` still return
**HTTP 429**. So this is the same egress block recorded in the Phase 1
blocker, which was never lifted for the sandbox — only for Aryaveer's own
browser.

### Root cause in the script, now fixed

The old probe **could not distinguish a dropped name from a failed request.**
It computed `dropped` as "every requested type not seen in a response", so a
total transport failure and a total vocabulary mismatch produced byte-identical
output. It did capture a per-symbol `httpNote`, but never serialised it into
the JSON dump — the one field that would have revealed the problem was dropped
on the way out.

**The script has been rewritten and moved to `scripts/probe-yahoo-types.mjs`**
(from `.scratch/`, which is gitignored — the fix would otherwise have been lost
with the next cleanup). It now:

- retries each batch with exponential backoff (2s, 8s, 20s, 45s), so a
  transient 429 does not become a finding;
- records the HTTP status of **every attempt** for every batch in the output;
- classifies a type as `dropped` **only when its batch returned HTTP 200** and
  the type still did not appear — otherwise it is `untested`;
- sets a top-level **`inconclusive`** flag, prints a `RESULT: INCONCLUSIVE`
  banner, suppresses the divergence section, and **exits non-zero** when any
  batch failed.

**Rule going forward: if `inconclusive` is true, do not touch the `TS` map or
`MARKET_INPUT_GAPS` from that run.** The old failure mode would have deleted a
working mapping on the strength of a network error.

### What is actually confirmed, and how

Five names, all from `.scratch/aapl-timeseries.json` — a real captured
response. That file is now committed as
`src/services/__fixtures__/aapl-timeseries.json`, and a test asserts the
CONFIRMED list matches it **exactly**, so no name can be promoted without
evidence:

| Type | Evidence |
|---|---|
| `annualTotalRevenue` | 4 periods, USD, 2023-09-30 → 2026-09-30 |
| `annualNetIncome` | 4 periods |
| `annualEBITDA` | 4 periods (confirms the all-caps spelling) |
| `annualTotalDebt` | 4 periods |
| `annualStockholdersEquity` | 4 periods |

The remaining **23** entries in `TS` are still `UNCONFIRMED`. Because Yahoo
drops unknown names silently, a wrong one surfaces as a `null` metric, never an
error. `fetchTimeseries` still logs a loud `console.warn` naming every
requested type that came back empty — that warning is now the primary
detection mechanism, and the first real payload should be read for it.

### US vs India type gaps — still unmeasured, and why that is recorded as a gap

**The probe did not measure this, so nothing is asserted.** Stating a
divergence here on the strength of the 2026-11-14 run would be inventing data.

`MARKET_INPUT_GAPS` in `src/analysis/fundamentals.ts` is the structure that
holds these findings, and it is **deliberately empty for every market**. A
wrongly-declared gap is worse than no gap: it produces a confident "not
reported for Indian listings" message for a line item that is actually
available, which is harder to notice and harder to undo than a plain
`missing-inputs`. Until a conclusive probe runs, every absent input is honestly
reported as `missing-inputs`.

The attribution path is nonetheless **built and unit-tested** (via an injected
gap list), so populating it when the probe runs is a one-line change plus a
test update.

**Hypotheses to check first when the probe does run** — these are the inputs
whose absence would break a Phase 2c metric for Indian listings, listed as
things to verify, *not* as findings:

| Input | Why it is suspect for `.NS` / `.BO` | Breaks |
|---|---|---|
| `annualRetainedEarnings` | Ind AS / Schedule III companies report "Reserves and Surplus", not a separate retained-earnings line | `altmanZScore` |
| `annualWorkingCapital` | a derived line Yahoo may not synthesise outside the US — a CA − CL fallback is already implemented | `altmanZScore` (mitigated) |
| `annualTaxProvision`, `annualPretaxIncome` | needed for the effective tax rate; Indian filings split current vs deferred tax | `roic` |
| `annualEBIT` | often absent where only EBITDA and D&A are reported | `roic`, `interestCoverage`, `altmanZScore` |
| `annualTotalLiabilitiesNetMinorityInterest` | the legacy `annualTotalLiabilities` may be the live name instead — both are probed | `altmanZScore` |
| `annualBasicAverageShares` | may be absent or annual-average-only | `fcfPerShare` |

Also still unresolved, and **not** a market gap: `marketCap` is unavailable
from every endpoint that works unauthenticated (see the chart-meta table
above). It blocks `fcfYield` and `altmanZScore` for **all** markets, US
included. Those two are reported as `requires-quote`, not as missing data.

---

## Test infrastructure — now committed and re-runnable

Phase 1e and 2a both reported passing assertion counts ("38/38", "36/36"), but
**no test file was ever committed** and no runner was configured, so none of it
could be re-run. Those numbers were unreproducible.

- **vitest 2.1.9** added as a devDependency, with `vitest.config.ts` wiring the
  `@/` path alias. `npm test` runs once; `npm run test:watch` watches.
- Tests live beside their subject as `*.test.ts`.

**`npm test` → 101 passed / 101**, `tsc --noEmit` clean, `eslint src` clean.

The 2a and 1e assertions are *not* retro-fitted here — they remain
unreproduced. Worth doing, but it is not Phase 2 work.

---

### 2c — Derived fundamentals

**Files:** `src/analysis/fundamentals.ts`, `src/analysis/fundamentals.test.ts`,
`src/analysis/fundamentals.crosscheck.test.ts`,
`src/analysis/__fixtures__/fundamentals-reference.{py,json}`.

Exports `roic`, `fcfYield`, `fcfPerShare`, `interestCoverage`, `altmanZScore`,
plus `computeDerivedFundamentals`, `effectiveTaxRate`, `altmanFromFactors`,
`workingCapitalOf`, `requireInputs`, `metricValue`, `collapseDerived`,
`emptyInputs` and `MARKET_INPUT_GAPS`. Pure, no I/O, no provider coupling.

#### The typed "unavailable" result

These five metrics take between two and seven inputs each, and `null` cannot
distinguish four very different situations. New in `src/types/stock.ts`:

```ts
type MetricResult<T = number> = { status: "ok"; value: T } | MetricUnavailable;
```

with `reason` one of:

| Reason | Means | Actionable? |
|---|---|---|
| `missing-inputs` | the provider reported nothing for a required line | retry, or check the `TS` name |
| `unavailable-for-market` | the line is not reported for this listing's market | no — permanent |
| `not-meaningful` | zero denominator, or an unbounded ratio | no — a finding about the company |
| `requires-quote` | needs a live price / market cap not supplied | yes — pass a quote |

Every unavailable result also carries `missing: string[]` (which inputs were
absent, by name) and a one-line `detail` safe to show in a tooltip.

**The case this exists for:** a debt-free company reports no interest expense,
so `interestCoverage` is *unbounded* — the strongest possible reading. Under
the old flat `number | null` shape that became `null`, which renders as a
coverage ratio of **zero**, i.e. insolvency. Exactly backwards, on the
healthiest input. It is now `not-meaningful` with the detail "No interest
expense reported, so interest coverage is unbounded — not zero."

#### Decisions

- **The effective tax rate is required for ROIC, not defaulted to zero.** An
  untaxed NOPAT overstates ROIC by the whole tax rate (typically 20–30%),
  which is enough to change an investment read. Better to return
  `missing-inputs` than a flatteringly wrong number.
- **The tax rate is clamped to [0, 1].** A loss-making year gives negative
  pretax income and a ratio that can be negative or far above 1, which would
  flip the sign of NOPAT. A rate outside [0, 1] is not a tax rate.
- **Altman X4 uses market equity**, per the original 1968 model, so the score
  needs a quote. Substituting book equity silently would make it the
  Z''-Score — different coefficients, different scale, different thresholds —
  so it is not swapped in. Hence `requires-quote` rather than a book-value
  approximation.
- **The Z-Score is not clamped.** A distressed company legitimately scores
  negative; clamping at zero would hide the worst cases.
- **Working capital falls back to CA − CL** when the reported line is absent.
- **A reported zero stays a zero.** `freeCashFlow: 0` yields `fcfYield` 0 and
  `fcfPerShare` 0 as `ok` values, never unavailable.
- `collapseDerived()` flattens to the nullable-number wire shape, and is
  marked lossy — prefer passing `DerivedFundamentals` through.

#### Wiring

`buildFundamentals(series, market)` now populates **roic, fcfPerShare and
interestCoverage**. `fcfYield` and `altmanZScore` stay `null` in the flat shape
because no market cap is available; `getDerivedFundamentals(symbol, marketCap)`
returns all five with reasons intact. `fundamentalInputs()` collects the inputs
from a series map and is exported for testing. `RATIO_TYPES` gained
`pretaxIncome`, `taxProvision`, `retainedEarnings`, `workingCapital`,
`totalLiabilities`, `operatingCashFlow` and `capex`. New
`marketFromSymbol()` resolves the market from a ticker suffix
(`.NS`/`.BO` → IN), which is the only market signal available before a quote.

**Not wired:** the route still returns the flat `FundamentalMetrics`, so the
`reason` strings do not yet reach the UI. Surfacing them needs
`getDerivedFundamentals` on the `DataProvider` interface and a matching
`fixtureProvider` implementation — a deliberate separate step, not a silent
half-migration.

#### Verified

- **60 assertions** across the metric and service suites.
- **Cross-checked against an independent Python reference**
  (`__fixtures__/fundamentals-reference.py`, written from the textbook
  definitions, not from the TypeScript) over **250 randomised input sets**
  spanning magnitudes 1 → 5e6, both signs, exact zeros and absent inputs:
  **881 values compared, maximum relative difference 0.00e+0** — bit-identical.
  The available/unavailable classification agreed on all 1,250 metric-cases.
- Exact hand-computed values on a round-numbered company: roic 0.15,
  fcfYield 0.05, fcfPerShare 4, interestCoverage 8, Z-Score 5.12.
- Each Altman coefficient isolated, so a transposed weight cannot pass.
- `fundamentalInputs` round-trips **every one of the 15 inputs** through its
  `TS` entry with a sentinel value, and the test fails if an input is not
  covered — a typo'd `TS` key would otherwise make that input permanently null.
- `buildStatements` proven to align by fiscal period, not array index, on
  deliberately unequal-length series.

---

### 2b — Technical signals

**Files:** `src/analysis/signals.ts`, `src/analysis/signals.test.ts`. Pure.
Also added `obvSeries` to `technicals.ts` and exported `CleanBar`.

Nine signals: `SMA 50/200 Cross`, `SMA 50`, `SMA 200`, `RSI (14)`,
`MACD (12/26/9)`, `Bollinger Bands (20, 2)`, `OBV Trend`, `ADX (14)`,
`ATR (14)`. Every threshold is in one exported `THRESHOLDS` object.

#### Decisions

- **An uncomputable indicator yields no signal at all**, not a neutral one. A
  neutral signal asserts "this indicator looked and saw balance"; silence is
  the honest output for "this indicator could not look". Collapsing them would
  let a 30-bar history emit a confident wall of neutrals. The *length* of the
  result is therefore information.
- **`strength` is magnitude, not probability.** 0–100, monotone in the
  underlying deviation, saturating at a documented full-scale point per
  indicator, so strengths are comparable across indicators and a reader can
  recover the deviation from the number.
- **Dead bands on every directional read.** Without them a price 0.01% above
  its moving average registers as bullish. 0.5% for price-vs-MA, 0.25% for the
  SMA spread, 0.1% of price for the MACD histogram, 0.05 of %B for Bollinger.
- **Mean reversion, stated explicitly.** RSI and Bollinger are read so that
  overbought is *bearish*; the SMA cross and price-vs-MA are trend-following
  and read the other way. Both conventions are deliberate, and a test asserts
  RSI and Bollinger agree with each other — if one ever inverts, the two
  silently cancel in the composite score, which is the kind of bug that leaves
  no trace.
- **MACD is read from the histogram, not the line.** The line's sign only says
  which EMA is higher; the histogram's sign says whether the gap is *widening*,
  which is the actual momentum claim. Normalised by price so a ₹40 stock and a
  $400 one score comparably.
- **The SMA cross is reported as a spread, not a crossing event.** A crossing
  is a single-bar occurrence that is stale the next day; the spread says how
  far into the regime the stock currently is.
- **OBV reads its slope, not its level.** OBV is a cumulative total with an
  arbitrary origin, so its level means nothing on its own — `obvSeries` now
  exists for this. The slope over 20 bars is normalised by average volume,
  making it dimensionless and comparable between a mega-cap and a small-cap
  (there is a test asserting invariance to the volume level).

#### ⚠ Context signals — a constraint on 2e

**ADX and ATR are always emitted with `signal: "neutral"`.** ADX is computed
from the *absolute* difference of the directional indicators, so it is
direction-blind by construction; high volatility is neither bullish nor
bearish. Reporting either as bullish because the stock happens to be rising
would attribute a claim to the indicator that it does not make.

`CONTEXT_INDICATORS` names them and `isContextSignal()` tests for membership.

**Phase 2e must not count these as directional votes.** Averaging two
direction-less neutrals into a bull/bear tally drags every score toward the
middle and makes a strongly trending stock look undecided. They belong in the
**confidence** term. A test asserts exactly these two are context signals, so
adding a third direction-less indicator without listing it will fail.

#### Verified

- **41 assertions.** Exact strengths (5% price deviation → 50 at a 10%
  full scale; 2.5% SMA spread → 50; RSI 70/30 → exactly 50 with no jump at the
  bounds; %B at the band edge → 100; ADX 25 → 50; ATR 2.5 on price 100 → 50).
- **Monotonicity** of strength in the underlying deviation across the full RSI
  range, and exact mirror symmetry below 50.
- **Sign symmetry** for all four directional indicators.
- Strength always integral and inside [0, 100] under extreme inputs (1e9, −1e9).
- Dead bands verified from both sides of each threshold.
- Degradation: `null` (not a neutral signal) for every missing input; 60 bars
  yields SMA 50 but no SMA 200 and no cross; 5 bars yields almost nothing;
  empty and all-unclean histories yield `[]`.
- Trend reads: a 260-bar advance is bullish on cross/SMA/OBV and *bearish* on
  RSI (correctly overbought); a decline mirrors it; a flat series is neutral on
  every signal that has an opinion.
- Collapsed Bollinger bands handled without dividing by zero.
- Passing pre-computed indicators gives results identical to recomputing them,
  and dropped (unclean) bars do not change the output.

#### Wiring

`/api/stock/:symbol` now returns `technicalSignals: TechnicalSignal[]`,
reusing the indicators it already computed rather than recomputing them.
`StockRouteData` updated.

Confirmed end-to-end against the fixture provider (dev server, 180 bars):
**7 signals** for both `AAPL` and `RELIANCE.NS` — `SMA 200` and the cross
correctly absent at 180 bars, `ADX (14)` strength 66 from ADX 32.85 (matching
2a's recorded value), `/api/stock/ZZZZINVALID` still 404.

`fixtureProvider`'s `FUNDAMENTALS` now carries real figures for the five 2c
metrics (previously all `null`), so the UI's number-formatting path is
exercised rather than only its `N/A` path.

#### Not done

- The UI does not render `technicalSignals` yet — the route returns them, but
  `page.tsx` has no signals panel. That is a Phase 3 view.

### Probe re-run 2026-11-15 — still blocked, but now says so

`node scripts/probe-yahoo-types.mjs` was re-run from the sandbox with the
rewritten script. Yahoo is **still returning HTTP 429**: all 6 batches failed
all 5 attempts (2s/8s/20s/45s backoff), for both symbols, plus both chart-meta
probes.

The re-run is the fix's own validation. On identical network conditions:

| | old script | new script |
|---|---|---|
| `dropped` | **51** (for each symbol) | **0** |
| `untested` | — (field did not exist) | **51** (for each symbol) |
| `inconclusive` | — (field did not exist) | **`true`** |
| HTTP statuses | discarded | every attempt recorded |
| exit code | 0 | **1** |

The old output invited exactly the wrong edit. The new output says
`RESULT: INCONCLUSIVE / Do NOT edit the TS map from this run`.

**The probe therefore remains outstanding — it must be run from Aryaveer's own
network, not the sandbox.** `npm test` and the committed payload fixture do not
depend on it; only the 23 `UNCONFIRMED` names and `MARKET_INPUT_GAPS` do.

---

## DATA SOURCE DECISION — Finnhub replaces Yahoo as primary

**Decision made by Aryaveer, 2026-11-15.** Yahoo is out as the primary source.

### Why Yahoo is out

Yahoo has had **no official API since 2017**. Every endpoint this project used
is undocumented internal plumbing for finance.yahoo.com. The diagnosis in the
Phase 1 blocker — and in the probe correction above — was **wrong about the
mechanism**, and that matters for anyone tempted to retry it:

- The 429s were **not IP rate limiting**. `query1` returns 429 for any request
  without a valid browser **session crumb**. There is additionally a ~2,000
  requests/hour IP cap, but the crumb is the binding constraint.
- So no amount of backoff would ever have fixed it. The rewritten Yahoo probe
  correctly reported `inconclusive` rather than a false negative, but it was
  retrying something that could not succeed.
- Implementing the cookie + crumb handshake **would still fail from a
  datacenter IP**, so it cannot work on a Vercel deploy regardless of effort
  spent.

The 23 `UNCONFIRMED` names in `TS` are therefore now **permanently
unresolvable** by this route, and the Yahoo type-name probe is closed as
won't-fix rather than outstanding. `scripts/probe-yahoo-types.mjs` is kept for
the record.

### Yahoo demoted, not deleted

`yahooProvider` stays in the codebase, per the decision, as a second opinion
when cross-checking another source's figures and as evidence the
`DataProvider` abstraction genuinely permits swapping sources. Its module
header now carries a prominent demotion notice. Opt in explicitly:

```
QUANTIQ_DATA_PROVIDER=yahoo npm run dev
```

### ⚠ Consequence: the default provider is now sample data

`DEFAULT_PROVIDER` was `yahoo`; demoting it leaves nothing live to point at
until `FinnhubProvider` is written, so **the default is now `fixture`, which is
sample data.** This is called out because it is a genuine hazard, and it is
mitigated three ways rather than left implicit:

1. `getProvider()` logs a one-time `serving SAMPLE DATA` warning when no
   `QUANTIQ_DATA_PROVIDER` is set.
2. `/api/stock/:symbol` now returns a **`provider` block** — `{ id, label,
   sampleData }` — so fabricated figures can never be mistaken for live data in
   a screenshot or a bug report. `isSampleData()` is exported from the
   registry.
3. `fixtureProvider`'s label is already `"Fixture (sample data — not live)"`.

**Do not ship a build with this default.** The remaining gap is a visible UI
banner (the route exposes the flag; `page.tsx` does not render it yet).

`ProviderId` now includes `finnhub` ahead of its implementation, so config,
docs and probe output can refer to a real id. `PROVIDERS` is `Partial`, and
`getProvider("finnhub")` warns **"declared but not implemented yet"** —
distinct from the "unknown provider" typo warning — and falls back. Verified
end-to-end: both warnings fire and the route still returns 200.

### Indian equities — deferred to a market-specific provider

Finnhub's free tier does not serve Indian fundamentals or market data. Rather
than pretend otherwise, this is now **modelled in the type system**.

New `MetricUnavailableReason`: **`no-provider-for-market`**. It is deliberately
distinct from `unavailable-for-market`:

| Reason | Means |
|---|---|
| `no-provider-for-market` | nothing is configured to fetch this market at all |
| `unavailable-for-market` | a provider covers the market but not this line item |

The difference is what the UI should say. `missing-inputs` for an Indian
listing would imply we tried and the data was absent; we never attempted it.

`MARKETS_WITHOUT_PROVIDER = ["IN", "CN", "EU"]` in
`src/analysis/fundamentals.ts`. `US` is absent — it is the market the incoming
provider covers. **IN is deferred to NSE/BSE direct**, which Phase 3 already
requires for institutional flows and promoter holdings; CN and EU have never
had a provider and are in the `Market` union for completeness only.

Precedence in `requireInputs`, coarsest true statement first:

```
no-provider-for-market  >  unavailable-for-market  >  missing-inputs
```

**Coverage is a property of the active provider, not the platform**, so
`FundamentalContext.marketsWithoutProvider` overrides the constant — otherwise
a local-dev run against the demoted `yahooProvider`, which nominally reaches
every market, would be wrongly told India has no provider. Every metric routes
through a `requireFrom` helper so the override is honoured everywhere rather
than in whichever metric remembered to pass it.

A `supportedMarkets` field on `DataProvider` would let the registry supply this
automatically. Worthwhile, not done — it widens the provider contract and the
override covers the present need.

`MARKET_INPUT_GAPS` stays empty for every market: no *individual line item* has
been attributed to a market, and with the Yahoo probe closed won't-fix, the
Finnhub probe is what will populate it.

### Probe ready to run — `scripts/probe-finnhub.mjs`

**24 probes, ~27 seconds**, paced at 1,100ms (free tier is 60/min, and a 429
here would be indistinguishable from the gating being measured).

```
node scripts/probe-finnhub.mjs --dry-run   # print the plan, no calls
node scripts/probe-finnhub.mjs             # execute
```

#### Key handling

- Read from `process.env.FINNHUB_API_KEY`, falling back to parsing
  `.env.local` (plain `node` does not load it; a dependency for a probe script
  is not worth it). Never hardcoded.
- Sent as an **`X-Finnhub-Token` header, never a query parameter**, so it
  cannot leak through a logged URL.
- Everything printed or written passes through `redact()`, which replaces both
  the literal key and any `token=` parameter with `***`. Verified against both
  forms. **`.scratch/finnhub-probe-results.json` is safe to paste back.**
- The console reports `present (40 chars, not shown)` — never the value.
- Missing key exits 2 with instructions; `--dry-run` works without a key.

#### What it measures, and why three fields not one

Per endpoint: **HTTP status**, **whether real data came back**, and **whether
it looks like a premium gate**. These are separate because Finnhub signals "no
access" inconsistently — a 403, or **HTTP 200 with an empty body**. "It didn't
throw" is not evidence of access, so the summary reports `OK but EMPTY` as its
own category and the closing line names those endpoints explicitly.

Data-presence detection is per-endpoint, since each shape says "nothing here"
differently: `{}`, `{"s":"no_data"}`, an empty array, or an all-zero quote
(`/quote` returns every field as `0` with `t=0` for an unsupported symbol,
status 200).

It carries the **same conclusiveness gate** as the rewritten Yahoo probe: an
endpoint whose every attempt failed at the transport level is marked
`inconclusive`, counted separately, and **excluded from the "not available on
this plan" conclusion**. 401s are called out as *key rejected* and explicitly
noted as saying nothing about plan coverage.

#### Coverage

The five the `DataProvider` interface needs — `/search`, `/quote`,
`/stock/profile2`, `/stock/candle`, `/stock/financials-reported`,
`/stock/metric` — plus later-phase endpoints (`/stock/symbol`,
`/stock/earnings`, `/stock/recommendation`, `/company-news`,
`/stock/insider-transactions`, `/institutional-ownership`, `/stock/dividend`).

`/stock/candle` is **expected to be gated** — Finnhub moved OHLCV to paid
plans. If it is, there is no price history, which blocks the entire Phase 2a
indicator layer and Phase 2b signal layer, and needs its own decision. That is
the single most consequential thing this probe will tell us.

#### The two specific questions, answered in dedicated output sections

**1. Does `profile2` unblock `fcfYield` / `altmanZScore`?** The probe reports
`marketCapitalization` and `shareOutstanding` presence separately from zero,
and sets `questions.profileUnblocksMarketCap` in the JSON.

⚠ If present, the output warns that Finnhub reports `marketCapitalization` in
**millions** of the profile currency and `shareOutstanding` in **millions of
shares**. A 1e6 error would silently scale `fcfYield` and the Z-Score's X4
factor — wrong by six orders of magnitude but still plausible-looking. Confirm
against a known value before wiring.

**2. Is India covered?** Probes `/quote` and `/stock/profile2` against four
symbol formats (`RELIANCE.NS`, `.BO`, `.BSE`, bare), plus `/search?q=reliance`
to see which exchanges the free tier will even name, `/stock/symbol?exchange=NS`,
and `/stock/financials-reported` for `RELIANCE.NS`. It prints
`CONFIRMED NOT COVERED` only when **no** Indian probe returns usable data —
and if any does, it says `UNEXPECTED` and tells us to re-read before deferring
India, rather than confirming the assumption it was given.

#### Next step

**Aryaveer runs the probe and points me at
`.scratch/finnhub-probe-results.json`.** `FinnhubProvider` gets built from the
`usable` set only — not from the docs' feature list.

---

## Finnhub probe results — 2026-11-15

**Run was CONCLUSIVE.** 24 probes, every one got an answer, no transport
failures. 9 usable, 11 gated, 4 empty-200.

### 🛑 BLOCKER — `/stock/candle` is premium-gated (HTTP 403)

**There is no OHLCV on this plan. Build is stopped here, pending a decision.**

```
candles   /stock/candle?symbol=AAPL&resolution=D   ->  HTTP 403  premium
```

This is not an implementation obstacle to work around, so `FinnhubProvider`
has **not** been written. Price history is the input to:

| Depends on OHLCV | Status without it |
|---|---|
| 2a — all 10 technical indicators | **dead**, no input |
| 2b — all 9 technical signals | **dead**, depends on 2a |
| 2e — risk metrics (Sharpe, Sortino, drawdown, volatility, VaR) | **dead**, needs a returns series |
| `getQuote.avgVolume` | **dead**, was computed from the volume series |
| the price chart / price table in the UI | **dead** |
| 2c — derived fundamentals | unaffected |
| 2d — DCF | unaffected |

That is roughly half the analysis layer, including the two phases just built
and tested. `beta` survives — `/stock/metric` serves it directly, so it does
not need a returns series.

#### Options, for the decision

1. **Finnhub paid** — candles are on a paid tier. Fixes it outright.
2. **Split the sources.** The `DataProvider` abstraction already allows this:
   a composite provider could take `getPriceHistory` from one source and
   fundamentals from Finnhub. This is the cheapest structural fix and the
   abstraction was built for exactly this, but it means two keys and two rate
   limits. Candidates for the OHLCV half: Twelve Data, Tiingo, Polygon,
   Alpha Vantage, EODHD.
3. **Drop Finnhub** for a provider that serves both.

⚠ **Do not pick from the list above on reputation.** Every one of these has
changed its free-tier limits recently, and this project has now twice been
burned by trusting a documented surface (Yahoo's `quoteSummary`, Finnhub's
candles). Whatever is chosen gets a probe script first, the same as this one.

### Question 2 — `profile2` DOES unblock `fcfYield` / `altmanZScore`

```
marketCapitalization : 5177380.424341398
shareOutstanding     : 14594.18
currency             : USD
```

Both present and real. **Both are in MILLIONS**, and that is established from
the payload rather than from the docs:

```
5177380.424341398 / 14594.18 = 354.76
/quote for AAPL, same run, pc = 354.88     (0.03% apart)
```

Market cap over share count must equal price per share, and it only does if
both are in millions. So market cap is USD 5.177 **trillion** and shares are
14.59 **billion**.

**Captured in code, as asked:** `src/services/finnhubUnits.ts` is now the only
place these scales are decoded, with the arithmetic proof in the module
header and 19 tests in `finnhubUnits.test.ts`. Two tests exist specifically to
fail if the scale is dropped:

- cap and shares must stay mutually consistent after conversion;
- an unscaled `fcfYield` is asserted to exceed 1,000 (i.e. 100,000%), pinning
  the failure signature — because the *scaled* answer is ~2% and the unscaled
  one still renders as an ordinary number.

#### ⚠ A second units trap, found while probing: `/stock/metric` mixes units

133 keys came back, and they do **not** share a convention:

| Key | Value | Unit |
|---|---|---|
| `grossMarginTTM` | 48.79 | **percent** |
| `roeTTM` | 127.61 | **percent** |
| `dividendYieldIndicatedAnnual` | 0.50534 | **percent** — 0.5%, not 50% |
| `totalDebt/totalEquityAnnual` | 0.7277 | plain ratio |
| `netInterestCoverageTTM` | 622.5082 | plain multiple |
| `beta` | 1.0899 | plain |

`FundamentalMetrics` uses decimal fractions, so the percent keys need ÷100 and
the ratio keys must be left alone — in the same response. This is the Yahoo
`debtToEquity` percent-vs-ratio bug in a new costume, and it is worse here
because `dividendYieldIndicatedAnnual` at `0.50534` is already small enough to
pass for a fraction; treating it as one reports a 50.5% yield on a stock that
pays 0.5%. `METRIC_UNITS` declares a unit per key and `readMetric()` is the
only sanctioned way to read one.

### Question 3 — the `KEY REJECTED` verdict was wrong. Four gate bugs fixed.

Correct call: one 401 alongside 9 endpoints returning real data **with the same
key** is endpoint-level gating, not authentication. A rejected key fails
everything. The verdict was promoting a per-endpoint signal to a global
conclusion — **the same class of bug as the original Yahoo probe**, which let
transport failures masquerade as findings. Fixed, plus three more found while
looking:

| # | Bug | Effect | Fix |
|---|---|---|---|
| 1 | any 401 ⇒ `KEY REJECTED` | one gated endpoint condemned the whole run | `keyRejected` now requires 401s **and zero usable results** |
| 2 | HTTP 200 with an **HTML body** classified `ok` | `institutional-ownership` read as "endpoint works, no rows for this symbol" — wrong and materially different | new `non-json-body` outcome |
| 3 | `indiaCovered` counted a `/search` hit | reported `indiaCovered: true` off a symbol-index lookup | probes flagged `indexOnly`; coverage counts **data** endpoints only |
| 4 | endpoint 401s excluded from the gated set | undercounted what the plan refuses | 401s fold into `gated` when the key is proven good |

Endpoint-level 401s and gates are *answers*, so they no longer make a run
inconclusive — only a rejected key or a transport failure does.

New `--reclassify <file>` mode re-derives a verdict from a saved results file
with **no requests**, so a verdict fix can be applied to an existing run
instead of costing another 24 calls. It also restores `india`/`indexOnly` flags
by probe id, so a file written before those flags existed still classifies
correctly. The corrected verdict below is output from the fixed code, not
asserted by hand:

```
OHLCV (/stock/candle) usable : NO
key rejected                 : false
conclusive                   : true
usable 9  empty-200 4  gated 11  (401-gated 1, html-body 1)  inconclusive 0
india: 0/9 DATA probes usable, 1 index-only hit ignored

OLD verdict: KEY REJECTED
NEW verdict: CONCLUSIVE
```

### India — CONFIRMED NOT COVERED

**0 of 9 Indian data probes returned usable data.** `.NS` and `.BO` are 403
premium on both `/quote` and `/stock/profile2`; `.BSE` and the bare symbol
return HTTP 200 with `c=0 t=0`, i.e. an all-zero quote; `/stock/financials-reported`
for `RELIANCE.NS` is 403.

`IN-search` returning 11 hits (`RELIANCE.NS`, `RPOWER.NS`, `RELINFRA.NS`, …)
is the **global symbol index**, not data access — being listed is not being
served. The probe now flags that probe `indexOnly` so it can never again imply
coverage.

`MARKETS_WITHOUT_PROVIDER = ["IN", "CN", "EU"]` and the
`no-provider-for-market` modelling stay exactly as built. Indian equities
remain deferred to NSE/BSE direct in Phase 3.

### Endpoint surface

**Usable (9):**

| Endpoint | Feeds |
|---|---|
| `/search` | `searchTickers` |
| `/quote` | `getQuote` — c/d/dp/h/l/o/pc/t all present |
| `/stock/profile2` | name, currency, exchange, **marketCap, shares** |
| `/stock/financials-reported` | `getFinancials` — 17 annual periods |
| `/stock/metric` | `getFundamentalMetrics` — 133 keys |
| `/stock/earnings` | earnings surprises (2d) |
| `/stock/recommendation` | analyst consensus (2e) |
| `/stock/insider-transactions` | `insiderTransactions` — 118 rows |
| `/search` (India) | symbol index only — **not** data |

**Gated (11):** `/stock/candle` (403), `/stock/dividend` (403),
`/stock/symbol` (200+gate), `/company-news` (200+gate),
`/institutional-ownership` (200+HTML), and all six Indian data probes.

So `dividendYield` has no source from `/stock/dividend`, but
`/stock/metric` serves `dividendYieldIndicatedAnnual` — use that instead.
`institutionalHolders` has **no source at all** on this plan.

#### ⚠ `financials-reported` needs a concept mapping, and its latest period is thin

Two things to settle before writing `getFinancials`:

1. **Line items are raw US-GAAP XBRL tags**, not friendly names —
   `us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax`,
   `us-gaap_IncomeTaxExpenseBenefit`, `us-gaap_NetIncomeLoss`. A
   concept→field mapping is required, and it is the Yahoo `TS` problem again:
   get a tag wrong and the metric is silently `null`. Tags also vary between
   filers, so a single-symbol mapping will not generalise. **Probe across
   several symbols before trusting it.**
2. **The latest period (2026) returned `bs: 0` rows** — income statement 24
   and cash flow 26, but an empty balance sheet. `roic` needs debt and equity;
   `altmanZScore` needs assets, liabilities and retained earnings. The
   provider must select the most recent period that actually carries a
   populated balance sheet, not blindly take `data[0]`.

### Sample-data banner — done

Built, since it is needed before any deploy and does not depend on the OHLCV
decision:

- Non-dismissible amber banner directly under the header, naming the provider
  label and saying every figure is fabricated.
- The header's status indicator was a **pulsing green "Live" dot shown
  unconditionally** — including next to fixture numbers, and even before any
  request had been made. It now reports what the data actually is: amber
  "Sample data", green "Live", or grey "Ready" before the first response. The
  claim is read from the response's `provider.sampleData`, so the client cannot
  disagree with the server about what it is showing.
- Verified in the SSR shell: no "Live" claim pre-fetch. `npm run build`
  passes. **Not verified on screen** — the banner is client-rendered and no
  browser automation is available here, same caveat as Phase 1c.

### Not done, deliberately

- **`FinnhubProvider`** — stopped on the OHLCV gate, as instructed.
- **`DEFAULT_PROVIDER` stays `fixture`.** It should flip to `finnhub` the
  moment the provider works; that moment has not arrived, and flipping it to a
  provider that does not exist would serve nothing.

`tsc --noEmit`, `eslint src` clean. **123/123 tests pass** (was 107; +16 for
the Finnhub units).

---

## ARCHITECTURE DECISION — split sources + cache

**Decided by Aryaveer, 2026-11-15**, in response to the `/stock/candle` gate.

- **Fundamentals / quotes / metrics** → Finnhub (keyed, probed, 9 usable endpoints)
- **OHLCV** → a separate provider, to be chosen from the probe below
- **Supabase cache in front of OHLCV** → fetch each symbol's daily bars once,
  store, then serve indicators and charts from the DB

The cache is the part that changes the arithmetic, and it is why a 25-call/day
tier is even on the table. Daily bars change once per day after close, so the
unit of consumption stops being *requests per page view* and becomes
**requests per symbol per day**. It also means a provider going dark does not
take the already-fetched history with it.

### OHLCV probe — `scripts/probe-ohlcv.mjs`

Four candidates, same probe-before-building discipline as Finnhub.

```
node scripts/probe-ohlcv.mjs                 # everything configured
node scripts/probe-ohlcv.mjs --dry-run       # plan only
node scripts/probe-ohlcv.mjs --only twelvedata
node scripts/probe-ohlcv.mjs --rate-limit-test
```

#### Results so far

| Provider | US | India | History | State |
|---|---|---|---|---|
| Twelve Data | ? | ? | **~20y** (demo) | **UNTESTED — needs a key** |
| Alpha Vantage | ? | ? | **27y** (demo) | **UNTESTED — needs a key** |
| Stooq | ? | ? | ? | **BLOCKED — HTTP 403 "Access denied"** |
| Yahoo v8 chart | ? | ? | ? | **BLOCKED from sandbox — 429** |

#### What the published demo keys already settle

Neither demo key accepts arbitrary symbols, so they cannot answer the India
question — but they do confirm shape, depth and that daily bars are served at
all, which is what the adapter needs:

**Twelve Data** (`demo`, AAPL): `status: ok`, **5,000 bars**, `2006-12-29 →
2026-11-13` (**~19.9 years**), `currency: USD`, `exchange: NASDAQ`,
`mic_code: XNGS`. Newest close **356.26999** — matches Finnhub's `/quote`
`c = 356.27` exactly, so the two sources agree on the same session.

**Alpha Vantage** (`demo`, IBM): **6,801 bars**, `1999-11-01 → 2026-11-13`
(**27.0 years**) — the deepest history of the candidates.

Implementation traps recorded in the adapters (they double as the spec):

| Provider | Value type | Order | Adjusted close |
|---|---|---|---|
| Twelve Data | **strings** — every field needs `Number()` | **newest first** — must be reversed for `PriceData` | none; looks split-adjusted, **not** dividend-adjusted |
| Alpha Vantage | strings under **number-prefixed keys** (`"1. open"`, `"4. close"`) | object keyed by date — **order not guaranteed**, sort explicitly | `TIME_SERIES_DAILY` is unadjusted; `DAILY_ADJUSTED` is premium |
| Yahoo v8 | native numbers, `null` for halted sessions | oldest first (matches `PriceData`) | **yes**, via `includeAdjustedClose=true` |

⚠ Only Yahoo offers a dividend-adjusted close. For total-return work that is a
real gap in both paid candidates, and it is worth deciding explicitly whether
`adjClose` should be `close` (and documented as split-only) rather than
silently implying dividend adjustment.

#### Stooq — ruled out, not merely blocked

Tested bare, then with full browser headers (UA, Accept, Accept-Language,
Referer). Identical result, so it is **not** header-based:

1. first requests → HTTP 200 with
   `This site requires JavaScript to verify your browser`
2. subsequent requests → **HTTP 403, "Stooq Access denied"**

A JavaScript browser-verification challenge is the same structural problem as
Yahoo's crumb: it would fail from Vercel's datacenter IPs regardless of effort,
and it cannot be satisfied by an HTTP client. **Recommend dropping Stooq** —
"no key required" is not an advantage if the gate is browser attestation. Its
reported formatting inconsistency never even became the issue.

#### Yahoo v8 — retained for local dev, as instructed

429 from this sandbox, consistent with every previous attempt; Aryaveer reports
200 from a residential connection. The module header in `yahooFinance.ts` now
distinguishes the endpoints properly rather than condemning all of Yahoo:

| Endpoint | State |
|---|---|
| `v8/finance/chart` | works unauthenticated — **kept for local dev** |
| `v1/finance/search` | works unauthenticated |
| `ws/fundamentals-timeseries` | 429 without a crumb |
| `v10/finance/quoteSummary` | dead — always `Invalid Crumb` |

It is the one independent implementation of the same daily series we will have,
which makes it genuinely useful for offline comparison. **Not production** — it
429s from datacenter IPs.

#### ➡ Keys needed: sign up for BOTH

- **Twelve Data** — https://twelvedata.com/pricing → `TWELVEDATA_API_KEY`
- **Alpha Vantage** — https://www.alphavantage.co/support/#api-key → `ALPHAVANTAGE_API_KEY`

Both free, no card. **Both**, not just the preferred one, because the decisive
question — whether Twelve Data's free tier is global or US-only — cannot be
answered from outside, and Alpha Vantage's documented `.BSE` path is the only
other India candidate. If Twelve Data turns out to be global, Alpha Vantage
costs nothing to have probed and becomes the fallback.

Add them to `.env.local` and re-run. `--rate-limit-test` is **opt-in** because
bursting Alpha Vantage consumes its entire 25-call daily quota.

#### Probe gate fixes made while running it

The verdict logic was wrong twice more, both the same family of bug as before:

1. **Markup detection too narrow.** Stooq's block page starts
   `<meta charset=utf-8><title>Stooq</title>` — no doctype, no `<html>` — so
   it was filed as a generic HTTP error rather than a block. Now any body
   starting with `<` (excluding XML) is markup, and readable text is extracted
   for the report.
2. **A mixed set of refusals produced a false coverage verdict.** Yahoo
   returned 429 for two symbols and a dropped connection for the third. An
   "were they *all* refusals?" test saw the mix, fell through to `tested`, and
   printed **`US: NO  India: NO`** — turning a network block into a verdict on
   Yahoo's coverage. The rule is now the conservative inverse: a provider earns
   a coverage verdict only if something **answered** (real bars, or the API
   saying no in its own words). Refusals — 403, 429, markup pages, dropped
   connections — yield `BLOCKED FROM THIS NETWORK` and no verdict.

A provider with no key is reported `UNTESTED`, never unavailable, and the run
exits non-zero while any candidate remains untested.

---

## CORRECTION to the Phase 3 plan — NSE has no official free public API

The methodology doc lists NSE/BSE direct endpoints as the Indian data source
for institutional flows and promoter holdings. **That is not a viable
production path and should be recorded as a correction.**

- NSE has **no official free public API**. Real-time and detailed feeds are
  paid-only through **NSE Data & Analytics**.
- The commonly-passed-around `nseindia.com/api/...` endpoints are **unofficial
  scraping targets**, with exactly the fragility profile that has already cost
  this project two rebuilds: undocumented, cookie/session gated, and prone to
  blocking datacenter IPs. Structurally the same bet as Yahoo's `quoteSummary`.

**Revised plan:** Indian **price** data goes through **Alpha Vantage's `.BSE`
symbols** (documented, keyed, stable contract) if the probe confirms it — the
more defensible route. Indian **fundamentals** remain unsolved: Finnhub's free
tier is confirmed not to cover them, and Alpha Vantage's fundamentals coverage
for Indian listings is unverified.

Promoter holdings and institutional flows are **India-specific disclosures with
no equivalent in any provider probed so far.** They may require accepting a
scraping dependency, or paid NSE data, or being cut from scope. That is a
product decision, not a technical one, and it should be made explicitly rather
than discovered during Phase 3.

`MARKETS_WITHOUT_PROVIDER` keeps `IN` until an Indian source is actually
confirmed — on current evidence India is unserved for both price and
fundamentals.

### Not built yet

- **Composite provider** and **Supabase cache** — blocked on the OHLCV choice,
  which is blocked on the two keys above. Building an adapter before knowing
  whether Twelve Data covers India would risk writing the wrong one.
- **`DEFAULT_PROVIDER` stays `fixture`** — it flips the moment something live
  works, per the decision.
- **Finnhub's fundamentals half is now decided and unblocked**, with one
  sub-blocker still open: `/stock/financials-reported` returns raw US-GAAP
  XBRL concept tags that vary between filers, and the latest AAPL period came
  back with **`bs: 0` rows**. `getQuote` (from `/quote` + `/stock/profile2`)
  and `getFundamentalMetrics` (from `/stock/metric`, via `finnhubUnits.ts`)
  need no such mapping and could be built independently of the OHLCV decision.

`tsc --noEmit`, `eslint src` clean. **123/123 tests pass.**

---

## 2026-11-16 — Live provider, risk layer, composite score, analysis UI

Built in one pass from a remote session. **Verified:** 148/148 tests, `eslint src`
clean, `next build` passes, fixture route + page render. **NOT verified:** any
live network call — the build sandbox cannot reach Finnhub, Yahoo or Twelve
Data. First thing to do is `npm run dev` and search AAPL.

**Data (Phase 1 closed, pending that live check)**
- `src/services/finnhub.ts` — search, quote (+profile2, metric), SEC
  as-reported statements via an XBRL concept-fallback map, fundamentals
  (Finnhub ratios through `finnhubUnits` + our derived metrics), analyst
  consensus, insider transactions. Only AAPL's tags were ever observed; the
  other fallbacks in `CONCEPTS` are standard us-gaap names, UNCONFIRMED.
  EBITDA is reconstructed (operating income + D&A). Derived metrics use the
  newest period that has a balance sheet.
- `src/services/twelveData.ts` — daily bars when `TWELVEDATA_API_KEY` is set.
  Parser tested against the demo-key shape; never run with a personal key.
- `src/services/liveProvider.ts` — composite: Finnhub for US fundamentals,
  Twelve Data or Yahoo `v8/chart` for bars (6h in-process cache), Yahoo chart
  meta for non-US quotes. Non-US listings get price, technicals and risk but
  no fundamentals.
- Default provider is now `live` whenever `FINNHUB_API_KEY` is set, else
  `fixture`. `QUANTIQ_DATA_PROVIDER` still overrides.

**Analysis**
- `src/analysis/risk.ts` — Sharpe, Sortino, Calmar, max drawdown, volatility,
  historical 1-day VaR/CVaR 95%. Risk-free rate is a 4% placeholder.
- `src/analysis/composite.ts` — scores Fundamental / Technical / Sentiment
  (analyst consensus as a proxy) / Risk, renormalises over layers present,
  reports model coverage. Institutional and Macro are not scored. Every
  threshold is an assumption, not calibrated or backtested.

**UI** — `src/components/AnalysisPanels.tsx`: score card, price chart, signals,
risk, analyst consensus, insider trades. Never viewed in a browser.

**Still open:** Yahoo chart will likely fail from Vercel (add a Twelve Data
key first); Supabase cache; 2a/1e test retrofit; DCF; institutional, macro,
NLP sentiment; India fundamentals; personal-finance module; deploy.
Pre-change copies of the five edited files are in `.scratch/backup-pre-fable/`.

---

## 2026-11-17 — Dashboard shell, market ribbon, portfolio, DCF, backtest, macro, news

**Verified:** 176/176 tests, `eslint src` clean, `next build` passes, all four
views rendered and screenshotted in headless Chrome **on sample data**.
**NOT verified:** any live network call (sandbox has no access to Finnhub,
Yahoo, FRED or the RSS feeds). Run `npm run dev` and check each view.

**New sources (all keyless)**
- `services/market.ts` — Yahoo `v8/chart` for 25 indices, commodities, FX,
  crypto and the US 10Y. 3-minute cache, serves last good value on failure.
  Day change comes from the last two daily closes, not `chartPreviousClose`
  (which is window-relative on multi-day ranges).
- `services/fred.ts` — FRED public CSV: Fed funds, 3M/2Y/10Y Treasuries,
  10Y-2Y spread, CPI YoY, unemployment. The 3M yield now feeds Sharpe,
  Sortino and the DCF instead of the 4% placeholder (falls back to it).
- `services/news.ts` — Yahoo Finance RSS, then Google News RSS.

**New analysis**
- `analysis/dcf.ts` — two-stage FCF model; defaults from filings + CAPM.
- `analysis/backtest.ts` — SMA 50/200, RSI reversion, MACD cross vs
  buy-and-hold; next-day execution, 10 bps per trade. Technical rules only:
  the composite score cannot be backtested without point-in-time fundamentals.
- `analysis/portfolio.ts` — valuation in INR/USD, weights, portfolio risk,
  correlation matrix.
- `analysis/sentiment.ts` — word-list headline tone (not a language model);
  joins analyst consensus in the Sentiment layer once 5+ headlines score.

**UI** — `app/page.tsx` is now a shell: black ticker ribbon, tabs
(Markets / Analyze / Portfolio / Tools), view + symbol kept in the URL hash.
Watchlist and holdings persist in localStorage. Portfolio accepts broker CSV.
The old page body lives in `components/StockView.tsx`.

**Known limits:** everything except Finnhub runs through unofficial or
keyless endpoints that may be refused from Vercel; macro is US-only; portfolio
risk ignores FX moves; no live broker sync; institutional (13F) layer, India
fundamentals, Supabase cache, 2a/1e test retrofit and deploy still open.

---

## Finnhub XBRL concept probe — 2026-11-17

`scripts/probe-finnhub-concepts.mjs`. Six filers chosen to break a
single-symbol mapping: **AAPL, MSFT** (tech), **JPM** (bank — no gross profit,
no inventory, no classified balance sheet), **XOM** (energy, noncontrolling
interests), **KO** (staples), **T** (telecom, heavy debt).

All six returned data: 15–17 annual periods each, 138–205 distinct concepts.

Row shape the adapter reads:

```json
{ "concept": "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax",
  "unit": "usd", "label": "Net sales", "value": 478834000000 }
```

### The `bs: 0` question — answered

Only the **newest, in-progress fiscal year** has an empty balance sheet, and
only for the two filers with a non-December year end:

```
AAPL   2026/0  bs=0  ic=24  cf=26     2025/0  bs=29  ic=24  cf=27
MSFT   2026/0  bs=0  ic=20  cf=32     2025/0  bs=34  ic=20  cf=32
JPM / XOM / KO / T   no empty balance sheet in any period
```

**Rule for the adapter: select the most recent period with `bs.length > 0`,
never `data[0]`.** Taking `data[0]` would silently null every balance-sheet
input — `totalAssets`, `totalEquity`, `retainedEarnings` — and so kill `roic`
and `altmanZScore` for exactly the largest, most-viewed symbols.

### Concept coverage — 9 of 22 fields are universal, 13 are not

Universal across all six filers: `revenue`, `netIncome`, `pretaxIncome`,
`taxProvision`, `eps`, `totalAssets`, `totalEquity`, `retainedEarnings`,
`operatingCashFlow`.

Multiple spellings genuinely in use, so the adapter needs **fallback chains,
not single tags**:

| Field | Primary | Also seen | Used by |
|---|---|---|---|
| `revenue` | `RevenueFromContractWithCustomerExcludingAssessedTax` | `Revenues` | JPM, KO, T |
| `totalEquity` | `StockholdersEquity` | `...IncludingPortionAttributableToNoncontrollingInterest` | T |
| `longTermDebt` | `LongTermDebtNoncurrent` | `LongTermDebt` | JPM |
| `currentDebt` | `LongTermDebtCurrent` | `DebtCurrent` | XOM, T |
| `depreciationAmortization` | `DepreciationDepletionAndAmortization` | `DepreciationAmortizationAndAccretionNet` | JPM |

Genuinely absent for some filers — **legitimate differences, not probe
failures**:

| Field | Missing for | Why |
|---|---|---|
| `grossProfit` | JPM, XOM, T | banks and these filers do not present one |
| `operatingIncome` | JPM, XOM | not a line in their statements; fall back to `pretaxIncome` |
| `inventory` | JPM, XOM, T | no inventory to report |
| `currentAssets`, `currentLiabilities` | JPM | banks do not present a classified balance sheet |
| `interestExpense` | AAPL, MSFT | **neither reports one** — see below |
| `totalLiabilities` | KO, T | neither reports `Liabilities` — see below |
| `shares` | XOM, T | no weighted-average share tag |

Two newly-found tags, added from the observed concept lists:

- **MSFT D&A** reports only `DepreciationAmortizationAndOther` /
  `...AndOtherNoncashItems`. ⚠ "AndOther" means it is **not pure D&A** — it
  bundles other non-cash items, so an EBITDA built on it is contaminated.
  Ranked last and must be flagged where used.
- **AAPL interest** has only `InterestPaid` / `InterestPaidNet` — cash
  interest *paid*, from the cash-flow statement, which is not interest expense
  (excludes accruals and capitalised interest). Ranked last.
  **MSFT reports no interest figure at all.** So `interestCoverage` is
  unavailable from this endpoint for both — but `/stock/metric` serves
  `netInterestCoverageTTM` directly (622.5082 for AAPL), which is the correct
  fallback.

### Fallback derivations — validated numerically, and two were wrong

Each candidate derivation was checked only against filers reporting **both**
the direct tag and all inputs, so agreement is evidence rather than
plausibility. Both obvious formulations failed:

**1. `totalLiabilities = Assets − StockholdersEquity`** — agreed exactly for
AAPL, MSFT, JPM; **disagreed for XOM by 4.0%**. Cause: XOM has a
noncontrolling interest. `Assets − Liabilities` is equity *including* NCI,
while `StockholdersEquity` excludes it.

Corrected to `Assets − StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`,
which agreed with XOM to `rel = 0.0`. Filers without an NCI do not report that
tag at all, which is the key insight: **the naive form is correct exactly when
the corrected tag is absent.** So the shippable rule is an ordered chain:

```
Liabilities
  -> else Assets - StockholdersEquityIncludingNCI
  -> else Assets - StockholdersEquity
```

**CHAIN VALIDATED, `rel = 0.0`, on all 4 cross-checkable filers.** KO and T
report no direct tag, so the chain is their only source — and it is now the
reason `totalLiabilities` is available for them at all, taking that field from
4/6 to 6/6 and unblocking `altmanZScore`.

**2. `shares = netIncome / EPS` — REJECTED, do not ship.** Failed on KO by
1.5%. The numerator was a red herring (JPM needed
`NetIncomeLossAvailableToCommonStockholdersBasic`, since EPS is computed after
preferred dividends). The real cause is **EPS precision, which varies per
filer**:

```
AAPL   EPS=7.49    2dp   implied 7.4931
MSFT   EPS=13.7    1dp   <- low precision
JPM    EPS=20.05   2dp   implied 20.5467  (preferred-dividend gap)
XOM    EPS=6.7     1dp   <- low precision
KO     EPS=3       0dp   implied 3.0460   <- low precision
T      EPS=3       0dp   <- low precision
```

**Four of six filers report EPS at one decimal or fewer.** KO's is the integer
`3` against a true 3.0460. Any shares-from-EPS derivation inherits that
rounding, and a 1.5% error in share count flows straight into `fcfPerShare`
while looking entirely plausible.

➡ **Use `profile2.shareOutstanding`** — directly reported, already decoded and
unit-tested in `finnhubUnits.ts`. This also means the EPS field from
`financials-reported` should not be used for any arithmetic, only display.

### Fields with no tag — derived, documented

```
ebitda          = operatingIncome + depreciationAmortization   (⚠ contaminated for MSFT)
ebit            = operatingIncome, else pretaxIncome + interestExpense
freeCashFlow    = operatingCashFlow - capitalExpenditure
totalDebt       = longTermDebt + currentDebt
workingCapital  = currentAssets - currentLiabilities           (null for JPM — no classified BS)
```

### Net effect on Phase 2c

With the validated chains, per-filer availability for the five derived
fundamentals on this probe set:

| Metric | Available for | Blocked for |
|---|---|---|
| `roic` | all 6 | — (`ebit` falls back to `pretaxIncome`) |
| `fcfPerShare` | all 6 | — (shares from `profile2`) |
| `altmanZScore` | 5 of 6 | JPM — no `currentAssets`/`currentLiabilities`, so no working capital |
| `interestCoverage` | 4 of 6 directly | AAPL, MSFT — use `/stock/metric` |
| `fcfYield` | all 6 | — (market cap from `profile2`) |

JPM's `altmanZScore` being unavailable is **correct, not a bug**: the Altman
Z-Score is not defined for banks, which have no classified balance sheet. The
`missing-inputs` reason will report it accurately.

### Status at the time of this probe — corrected

An earlier draft of this section said `FinnhubProvider` and the composite were
"still blocked". **That was wrong**, written before checking the tree: both
were built on 16–17 Nov, outside the session that ran this probe.

Present and passing as of 2026-11-17:

- `src/services/finnhub.ts` — `finnhubProvider`. `getPriceHistory` returns
  `[]`, consistent with the `/stock/candle` 403.
- `src/services/twelveData.ts` — OHLCV, gated on `twelveDataConfigured()`.
- `src/services/liveProvider.ts` — **the composite**: Finnhub for quotes,
  financials, metrics, consensus and insider data; Twelve Data for daily US
  bars; Yahoo v8 chart as the fallback when Twelve Data is unconfigured.
  Non-US symbols return `[]`/`null` rather than wrong data.
- `src/analysis/` — `dcf.ts`, `risk.ts`, `composite.ts`, `portfolio.ts`,
  `sentiment.ts`; `src/services/` — `market.ts`, `news.ts`, `fred.ts`.

**176/176 tests pass across 10 files**, `tsc --noEmit` and `eslint src` clean.
This probe added no `src` changes; 53 of those tests came from the 16–17 Nov
work, not from this session.

#### What is genuinely still open

1. **`TWELVEDATA_API_KEY` is not in `.env.local`**, so `twelveDataConfigured()`
   is false and the composite silently falls back to the Yahoo v8 chart —
   which 429s from any datacenter IP. **OHLCV will be empty on deploy.**
   `scripts/probe-ohlcv.mjs` still reports Twelve Data and Alpha Vantage as
   `UNTESTED`, and the global-vs-US-only question is still unanswered.
2. **`DEFAULT_PROVIDER` is still `fixture`** — correct while no OHLCV key
   exists, but it is what the decision said should flip once something live
   works.
3. **This probe's findings are not yet applied to `finnhub.ts`.** It was
   written before the concept mapping was validated, so the
   `totalLiabilities` chain, the `profile2.shareOutstanding` share count, the
   "newest period with a populated balance sheet" rule and the
   `/stock/metric` interest-coverage fallback still need wiring in. Until then
   `altmanZScore` is null for KO and T, `fcfPerShare` risks the EPS-rounding
   error, and `roic`/`altmanZScore` are null for AAPL and MSFT whenever the
   in-progress fiscal year is selected.
