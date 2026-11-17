"""
Independent reference for the Phase 2c derived fundamentals.

Written from the textbook definitions only -- deliberately NOT from
src/analysis/fundamentals.ts -- so that agreement between the two is evidence
rather than a tautology.

Definitions used:
  effective tax rate = taxProvision / pretaxIncome, clamped to [0, 1]
  NOPAT              = EBIT * (1 - effective tax rate)
  invested capital   = totalDebt + totalEquity
  ROIC               = NOPAT / invested capital
  FCF yield          = freeCashFlow / marketCap
  FCF per share      = freeCashFlow / shares
  interest coverage  = EBIT / abs(interestExpense)
  Altman Z (1968)    = 1.2*X1 + 1.4*X2 + 3.3*X3 + 0.6*X4 + 1.0*X5
      X1 = workingCapital   / totalAssets
      X2 = retainedEarnings / totalAssets
      X3 = EBIT             / totalAssets
      X4 = marketCap        / totalLiabilities
      X5 = revenue          / totalAssets

Emits a JSON array of {inputs, marketCap, expected} cases.
"""

import json
import random

random.seed(20261115)

UNAVAILABLE = "unavailable"


def tax_rate(pretax, tax):
    if pretax is None or tax is None or pretax == 0:
        return None
    return min(1.0, max(0.0, tax / pretax))


def roic(d, mcap):
    for k in ("ebit", "pretaxIncome", "taxProvision", "totalDebt", "totalEquity"):
        if d[k] is None:
            return UNAVAILABLE
    r = tax_rate(d["pretaxIncome"], d["taxProvision"])
    if r is None:
        return UNAVAILABLE
    ic = d["totalDebt"] + d["totalEquity"]
    if ic == 0:
        return UNAVAILABLE
    return d["ebit"] * (1.0 - r) / ic


def fcf_yield(d, mcap):
    if d["freeCashFlow"] is None or mcap is None or mcap <= 0:
        return UNAVAILABLE
    return d["freeCashFlow"] / mcap


def fcf_per_share(d, mcap):
    if d["freeCashFlow"] is None or d["shares"] is None or d["shares"] == 0:
        return UNAVAILABLE
    return d["freeCashFlow"] / d["shares"]


def interest_coverage(d, mcap):
    if d["ebit"] is None or d["interestExpense"] is None:
        return UNAVAILABLE
    i = abs(d["interestExpense"])
    if i == 0:
        return UNAVAILABLE
    return d["ebit"] / i


def working_capital(d):
    if d["workingCapital"] is not None:
        return d["workingCapital"]
    if d["currentAssets"] is None or d["currentLiabilities"] is None:
        return None
    return d["currentAssets"] - d["currentLiabilities"]


def altman(d, mcap):
    for k in ("retainedEarnings", "ebit", "revenue", "totalAssets", "totalLiabilities"):
        if d[k] is None:
            return UNAVAILABLE
    wc = working_capital(d)
    if wc is None or mcap is None:
        return UNAVAILABLE
    ta, tl = d["totalAssets"], d["totalLiabilities"]
    if ta == 0 or tl == 0:
        return UNAVAILABLE
    return (
        1.2 * (wc / ta)
        + 1.4 * (d["retainedEarnings"] / ta)
        + 3.3 * (d["ebit"] / ta)
        + 0.6 * (mcap / tl)
        + 1.0 * (d["revenue"] / ta)
    )


FIELDS = [
    "ebit", "pretaxIncome", "taxProvision", "interestExpense", "revenue",
    "totalAssets", "totalLiabilities", "totalEquity", "totalDebt",
    "retainedEarnings", "workingCapital", "currentAssets",
    "currentLiabilities", "freeCashFlow", "shares",
]


def rand_value():
    """Spread over magnitudes, signs, and the awkward exact values."""
    roll = random.random()
    if roll < 0.08:
        return None
    if roll < 0.13:
        return 0
    v = random.uniform(1, 5_000_000) * random.choice([1, 1, 1, -1])
    return round(v, 4)


cases = []
for _ in range(250):
    d = {f: rand_value() for f in FIELDS}
    mcap = None if random.random() < 0.12 else round(random.uniform(1, 5_000_000), 4)
    cases.append({
        "inputs": d,
        "marketCap": mcap,
        "expected": {
            "roic": roic(d, mcap),
            "fcfYield": fcf_yield(d, mcap),
            "fcfPerShare": fcf_per_share(d, mcap),
            "interestCoverage": interest_coverage(d, mcap),
            "altmanZScore": altman(d, mcap),
        },
    })

print(json.dumps(cases, indent=None, separators=(",", ":")))
