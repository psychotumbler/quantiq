#!/usr/bin/env python3
"""
Historical backfill for the Tier 2 backtest. Runs in GitHub Actions (the
sandbox and Vercel can't do long scrapes; GitHub runners can reach the sources).

  PART=news    Google News RSS, one query x one week at a time, for the
               engine's own sector queries plus a few broad ones.
               -> data/backfill/news/<YYYY-MM-DD>.jsonl.gz   (one file per week)
  PART=prices  Yahoo daily OHLC + adjusted close for every Indian company in
               the universe, plus Nifty 50 / Nifty 500.
               -> data/backfill/prices/<SYMBOL>.json
  PART=bhav    Official NSE end-of-day bhavcopy for a set of dates, used only to
               audit the Yahoo prices.  -> data/backfill/bhav/<YYYYMMDD>.csv.gz

Look-ahead caveat, written down on purpose: headlines found today for a past
week are the ones Google still indexes now. Stories that were deleted or
re-dated are missing, and pubDate is Google's, not the moment a trader saw it.
"""
import argparse, datetime as dt, gzip, io, json, os, re, sys, time, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def get(url, attempts=4, headers=None):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:
            last = e
            code = getattr(e, "code", None)
            if code == 404:
                return None
            time.sleep(5 * (i + 1) * (3 if code == 429 else 1))
    print(f"  give up {url[:120]}: {last}", file=sys.stderr)
    return None


def sector_queries(sources_ts):
    src = open(sources_ts, encoding="utf-8").read()
    block = src[src.index("const SECTOR_QUERIES"):src.index("export const SECTOR_FEEDS")]
    out = []
    for m in re.finditer(r'sector:\s*"([^"]+)",\s*queries:\s*\[(.*?)\]', block, re.S):
        for q in re.findall(r'"([^"]+)"', m.group(2)):
            out.append((m.group(1), q))
    return out


BROAD = [("Broad", q) for q in [
    "bags order crore", "wins order worth crore", "secures contract crore shares",
    "shares surge order win", "acquires stake crore", "to acquire company India crore",
    "stake sale block deal shares", "promoter sells stake", "QIP raises crore",
    "capacity expansion crore investment", "board approves fund raising",
    "USFDA warning letter shares", "order cancelled contract terminated India",
    "Q2 results profit crore", "NSE listed company announces",
]]


def news(out, weeks, end):
    queries = sector_queries("src/nlp/sources.ts") + BROAD
    root = os.path.join(out, "data", "backfill", "news")
    os.makedirs(root, exist_ok=True)
    total = 0
    for w in range(weeks):
        hi = end - dt.timedelta(days=7 * w)
        lo = hi - dt.timedelta(days=7)
        path = os.path.join(root, lo.isoformat() + ".jsonl.gz")
        if os.path.exists(path):
            continue
        rows, saturated = {}, 0
        for sector, q in queries:
            full = f"{q} after:{lo.isoformat()} before:{hi.isoformat()}"
            url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
                {"q": full, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"})
            body = get(url)
            time.sleep(1.2)
            if not body:
                continue
            try:
                items = ET.fromstring(body).findall("./channel/item")
            except ET.ParseError:
                continue
            if len(items) >= 95:
                saturated += 1
            for it in items:
                title = (it.findtext("title") or "").strip()
                src_el = it.find("source")
                source = src_el.text.strip() if src_el is not None and src_el.text else ""
                if source and title.endswith(" - " + source):
                    title = title[: -len(source) - 3]
                key = title.lower()
                if key in rows:
                    continue
                rows[key] = {"title": title, "source": source, "url": it.findtext("link"),
                             "publishedAt": it.findtext("pubDate"), "sector": sector, "query": q}
        with gzip.open(path, "wt", encoding="utf-8") as f:
            for r in rows.values():
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        total += len(rows)
        print(f"week {lo}: {len(rows)} headlines, {saturated}/{len(queries)} queries hit the 100 cap", flush=True)
    print(f"done: {total} headlines")


def prices(out, rng):
    rows = json.load(open("src/nlp/eval/fixtures/universe.json"))
    syms = [r[0] for r in rows if r[3] == "IN"] + ["^NSEI", "^CRSLDX", "^BSESN"]
    root = os.path.join(out, "data", "backfill", "prices")
    os.makedirs(root, exist_ok=True)
    ok = 0
    for i, s in enumerate(syms):
        path = os.path.join(root, s.replace("^", "_") + ".json")
        if os.path.exists(path):
            ok += 1
            continue
        url = f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(s)}?range={rng}&interval=1d&events=div%2Csplits"
        body = get(url)
        time.sleep(0.35)
        if not body:
            continue
        try:
            res = json.loads(body)["chart"]["result"][0]
            q = res["indicators"]["quote"][0]
            adj = (res["indicators"].get("adjclose") or [{}])[0].get("adjclose")
            rec = {"symbol": s, "t": res.get("timestamp", []), "o": q.get("open"), "h": q.get("high"),
                   "l": q.get("low"), "c": q.get("close"), "v": q.get("volume"), "adj": adj,
                   "events": res.get("events", {})}
        except Exception:
            continue
        with open(path, "w") as f:
            json.dump(rec, f, separators=(",", ":"))
        ok += 1
        if i % 200 == 0:
            print(f"{i}/{len(syms)}", flush=True)
    print(f"prices: {ok}/{len(syms)} symbols")


def bhav(out, dates):
    root = os.path.join(out, "data", "backfill", "bhav")
    os.makedirs(root, exist_ok=True)
    h = {"Referer": "https://www.nseindia.com/", "Accept": "*/*"}
    for d in dates:
        ymd = d.strftime("%Y%m%d")
        url = f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv.zip"
        body = get(url, headers=h)
        if not body:
            print(f"{ymd}: unavailable")
            continue
        try:
            z = zipfile.ZipFile(io.BytesIO(body))
            csv = z.read(z.namelist()[0])
        except Exception as e:
            print(f"{ymd}: bad zip {e}")
            continue
        with gzip.open(os.path.join(root, ymd + ".csv.gz"), "wb") as f:
            f.write(csv)
        print(f"{ymd}: {len(csv)} bytes")
        time.sleep(1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--weeks", type=int, default=26)
    ap.add_argument("--range", default="2y")
    a = ap.parse_args()
    part = os.environ.get("PART", "news")
    today = dt.date.today()
    if part == "news":
        news(a.out, a.weeks, today - dt.timedelta(days=today.weekday()))  # weeks end on Mondays
    elif part == "prices":
        prices(a.out, a.range)
    elif part == "bhav":
        days = [today - dt.timedelta(days=k) for k in range(1, 400, 9)]
        bhav(a.out, [d for d in days if d.weekday() < 5])
