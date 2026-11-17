/**
 * GET /api/health — probes every upstream from THIS machine.
 *
 * Diagnostic only. Reports HTTP status, latency and a short body preview per
 * source and transport, so "which feeds work from here" is a measurement
 * rather than a guess. Never returns or logs an API key.
 */

import { execFile } from "node:child_process";
import { connection } from "next/server";
import axios from "axios";

interface Probe {
  id: string;
  url: string;
  via: "axios" | "fetch" | "curl";
  headers?: Record<string, string>;
}

const UA_BARE = "Mozilla/5.0";
const UA_FULL =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function ymd(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const Y = "https://query1.finance.yahoo.com";
const CHART = `${Y}/v8/finance/chart/%5ENSEI?range=1mo&interval=1d`;
const BSE_H = { "User-Agent": UA_FULL, Referer: "https://www.bseindia.com/", Origin: "https://www.bseindia.com" };

function probes(extra: string | null): Probe[] {
  const list: Probe[] = [
    { id: "yahoo-chart axios fullUA", url: CHART, via: "axios", headers: { "User-Agent": UA_FULL } },
    { id: "yahoo-chart axios bareUA", url: CHART, via: "axios", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-chart fetch bareUA", url: CHART, via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-chart fetch fullUA", url: CHART, via: "fetch", headers: { "User-Agent": UA_FULL } },
    { id: "yahoo-chart curl bareUA", url: CHART, via: "curl", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-chart query2 fetch", url: CHART.replace("query1", "query2"), via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-search curl", url: `${Y}/v1/finance/search?q=reliance&quotesCount=8&newsCount=0`, via: "curl", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-search fetch", url: `${Y}/v1/finance/search?q=reliance&quotesCount=8&newsCount=0`, via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-timeseries IN curl", url: `${Y}/ws/fundamentals-timeseries/v1/finance/timeseries/RELIANCE.NS?symbol=RELIANCE.NS&type=annualTotalRevenue,annualNetIncome,annualEBITDA,annualTotalDebt,annualStockholdersEquity,annualFreeCashFlow&period1=1600000000&period2=1900000000&merge=false`, via: "curl", headers: { "User-Agent": UA_BARE } },
    { id: "yahoo-timeseries IN fetch", url: `${Y}/ws/fundamentals-timeseries/v1/finance/timeseries/RELIANCE.NS?symbol=RELIANCE.NS&type=annualTotalRevenue,annualNetIncome&period1=1600000000&period2=1900000000&merge=false`, via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "fred csv axios", url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-09-01", via: "axios" },
    { id: "fred csv curl", url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-09-01", via: "curl", headers: { "User-Agent": UA_BARE } },
    { id: "worldbank IN cpi", url: "https://api.worldbank.org/v2/country/IN/indicator/FP.CPI.TOTL.ZG?format=json&mrv=5", via: "fetch" },
    { id: "yahoo rss", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US", via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "google news rss", url: "https://news.google.com/rss/search?q=Reliance%20Industries%20stock&hl=en-IN&gl=IN&ceid=IN:en", via: "fetch", headers: { "User-Agent": UA_BARE } },
    { id: "et markets rss", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", via: "fetch", headers: { "User-Agent": UA_FULL } },
    { id: "moneycontrol rss", url: "https://www.moneycontrol.com/rss/business.xml", via: "fetch", headers: { "User-Agent": UA_FULL } },
    { id: "livemint rss", url: "https://www.livemint.com/rss/markets", via: "fetch", headers: { "User-Agent": UA_FULL } },
    { id: "bse quote fetch", url: "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=500325&seriesid=", via: "fetch", headers: BSE_H },
    { id: "bse announcements fetch", url: `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strPrevDate=${ymd(-2)}&strScrip=&strSearch=P&strToDate=${ymd()}&strType=C&subcategory=-1`, via: "fetch", headers: BSE_H },
    { id: "nse allIndices fetch", url: "https://www.nseindia.com/api/allIndices", via: "fetch", headers: { "User-Agent": UA_FULL, Accept: "application/json", Referer: "https://www.nseindia.com/" } },
    { id: "nse allIndices curl", url: "https://www.nseindia.com/api/allIndices", via: "curl", headers: { "User-Agent": UA_FULL, Accept: "application/json", Referer: "https://www.nseindia.com/" } },
    { id: "nse nifty500 csv", url: "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv", via: "fetch", headers: { "User-Agent": UA_FULL } },
    { id: "imf datamapper IN", url: "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/IND?periods=2025,2026", via: "fetch" },
    { id: "sec edgar tickers", url: "https://www.sec.gov/files/company_tickers.json", via: "fetch", headers: { "User-Agent": "QuantIQ student project contact@example.com" } },
  ];
  if (extra) list.push({ id: "extra fetch", url: extra, via: "fetch", headers: { "User-Agent": UA_FULL } }, { id: "extra curl", url: extra, via: "curl", headers: { "User-Agent": UA_BARE } });
  return list;
}

function curl(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const args = ["-s", "-L", "--compressed", "-m", "12", "-w", "\n%{http_code}"];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    execFile("curl", args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) return resolve({ status: 0, body: String(error.message).slice(0, 120) });
      const cut = stdout.lastIndexOf("\n");
      resolve({ status: Number(stdout.slice(cut + 1)) || 0, body: stdout.slice(0, cut) });
    });
  });
}

async function run(p: Probe) {
  const started = Date.now();
  let status = 0;
  let body = "";
  try {
    if (p.via === "curl") {
      ({ status, body } = await curl(p.url, p.headers ?? {}));
    } else if (p.via === "fetch") {
      const res = await fetch(p.url, { headers: p.headers, signal: AbortSignal.timeout(12_000) });
      status = res.status;
      body = await res.text();
    } else {
      const res = await axios.get(p.url, { headers: p.headers, timeout: 12_000, responseType: "text", validateStatus: () => true });
      status = res.status;
      body = String(res.data);
    }
  } catch (error) {
    body = `ERR ${(error as Error).message}`;
  }
  return {
    id: p.id,
    via: p.via,
    status,
    ms: Date.now() - started,
    bytes: body.length,
    preview: body.replace(/\s+/g, " ").slice(0, 140),
  };
}

/** Hosts the raw passthrough may fetch. Development only. */
const RAW_HOSTS = [
  "query1.finance.yahoo.com", "query2.finance.yahoo.com", "www.nseindia.com",
  "nsearchives.nseindia.com", "api.bseindia.com", "api.worldbank.org",
  "www.imf.org", "www.sec.gov", "data.sec.gov", "fred.stlouisfed.org",
];

export async function GET(request: Request): Promise<Response> {
  await connection();
  const query = new URL(request.url).searchParams;
  const extra = query.get("url");

  // ?raw=1&url=… returns one upstream body, for inspecting payload shapes.
  if (query.get("raw") && extra && process.env.NODE_ENV !== "production") {
    let host = "";
    try {
      host = new URL(extra).hostname;
    } catch {
      /* fall through to the refusal below */
    }
    if (!RAW_HOSTS.includes(host)) {
      return Response.json({ error: "host not allowed" }, { status: 400 });
    }
    const res = await fetch(extra, {
      headers: {
        "User-Agent": host.endsWith("sec.gov") ? "QuantIQ student project" : UA_BARE,
        ...(host.includes("nseindia") ? { Accept: "application/json", Referer: "https://www.nseindia.com/" } : {}),
        ...(host.includes("bseindia") ? BSE_H : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // ?concepts=MSFT lists the XBRL tags in Finnhub's newest two filings.
  const conceptsFor = query.get("concepts");
  if (conceptsFor && process.env.FINNHUB_API_KEY) {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/financials-reported?symbol=${encodeURIComponent(conceptsFor)}&freq=annual`,
      { headers: { "X-Finnhub-Token": process.env.FINNHUB_API_KEY }, signal: AbortSignal.timeout(15_000) },
    );
    const body = await res.json().catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filings: any[] = Array.isArray(body?.data) ? body.data.slice(0, 2) : [];
    return Response.json({
      status: res.status,
      filings: filings.map((f) => ({
        year: f.year,
        endDate: f.endDate,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bs: (f.report?.bs ?? []).map((r: any) => `${r.concept}=${r.value}`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ic: (f.report?.ic ?? []).map((r: any) => `${r.concept}=${r.value}`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cf: (f.report?.cf ?? []).map((r: any) => `${r.concept}=${r.value}`),
      })),
    });
  }

  const safeExtra = extra && /^https:\/\//.test(extra) ? extra : null;
  const results = await Promise.all(probes(safeExtra).map(run));
  return Response.json({
    finnhubKeySet: Boolean(process.env.FINNHUB_API_KEY?.trim()),
    node: process.version,
    results,
  });
}
