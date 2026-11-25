#!/usr/bin/env python3
"""
News archive collector. Runs in GitHub Actions on a schedule.

Why this exists: to ask "did high-materiality stories actually move stocks",
you need the stories as they were seen at the time, with a timestamp you
could have acted on. RSS feeds forget after a day or two, so the history has
to be kept by us, starting now. Price history can be fetched retroactively;
the news cannot.

  KIND=collect  -> data/intel/YYYY/MM/DD/HHMM.jsonl.gz, only articles not
                   already archived in the last two days
  KIND=audit    -> data/audit/<date>-<seed>/{sample,universe,meta}.json

Output goes into the `data` branch worktree passed as --out, never into main,
so the archive does not bloat the app or trigger deployments.
"""
import argparse, datetime as dt, glob, gzip, json, os, sys, time, urllib.request


def fetch(url, attempts=3):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "quantiq-collector/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = json.load(r)
            if body.get("success"):
                return body["data"]
            last = body.get("error", "unknown error")
        except Exception as e:  # cold starts and timeouts are routine
            last = str(e)
        time.sleep(10 * (i + 1))
    sys.exit(f"fetch failed after {attempts} attempts: {last}")


def seen_keys(root, now):
    keys = set()
    for d in (now, now - dt.timedelta(days=1)):
        for path in glob.glob(os.path.join(root, d.strftime("%Y/%m/%d"), "*.jsonl.gz")):
            with gzip.open(path, "rt", encoding="utf-8") as f:
                for line in f:
                    try:
                        keys.add(json.loads(line)["key"])
                    except Exception:
                        pass
    return keys


def collect(base, out):
    data = fetch(f"{base}/api/audit?kind=collect")
    now = dt.datetime.now(dt.timezone.utc)
    root = os.path.join(out, "data", "intel")
    seen = seen_keys(root, now)

    fresh = []
    for r in data["records"]:
        if r["key"] and r["key"] not in seen:
            r["firstSeen"] = data["generatedAt"]
            r["engineVersion"] = data["engineVersion"]
            fresh.append(r)
            seen.add(r["key"])

    stats = data["stats"]
    if stats.get("uniqueHeadlines", 0) == 0:
        sys.exit("sweep returned no headlines - treating as a failed run")

    day = os.path.join(root, now.strftime("%Y/%m/%d"))
    os.makedirs(day, exist_ok=True)
    if fresh:
        path = os.path.join(day, now.strftime("%H%M") + ".jsonl.gz")
        with gzip.open(path, "wt", encoding="utf-8") as f:
            for r in fresh:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    with open(os.path.join(root, "LATEST.json"), "w") as f:
        json.dump({
            "at": data["generatedAt"], "engineVersion": data["engineVersion"],
            "relevant": len(data["records"]), "new": len(fresh), "sweep": stats,
        }, f, indent=1)
    print(f"{len(data['records'])} relevant, {len(fresh)} new, "
          f"{stats['uniqueHeadlines']} unique headlines, {stats['feedsOk']}/{stats['feedsTried']} feeds")


def audit(base, out, n, seed):
    data = fetch(f"{base}/api/audit?kind=audit&n={n}&seed={seed}")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    d = os.path.join(out, "data", "audit", f"{stamp}-{seed}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "sample.json"), "w") as f:
        json.dump(data["sample"], f, ensure_ascii=False, indent=1)
    with open(os.path.join(d, "universe.json"), "w") as f:
        json.dump(data["universe"], f, ensure_ascii=False)
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump({k: data[k] for k in ("kind", "seed", "engineVersion", "generatedAt", "stats")}, f, indent=1)
    print(f"audit sample: {len(data['sample'])} articles, universe {len(data['universe'])} -> {d}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20261126)
    a = ap.parse_args()
    base = os.environ.get("BASE_URL", "https://quantiq-kappa.vercel.app").rstrip("/")
    kind = os.environ.get("KIND", "collect")
    (audit(base, a.out, a.n, a.seed) if kind == "audit" else collect(base, a.out))
