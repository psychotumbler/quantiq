/**
 * Discounted cash flow — a two-stage free-cash-flow-to-firm model.
 *
 * Stage 1: free cash flow grows at `growthRate` for `years`.
 * Stage 2: a Gordon-growth terminal value at `terminalGrowth`.
 * Both are discounted at `discountRate` (WACC); net debt is subtracted and
 * the result divided by shares outstanding.
 *
 * Pure and shared by the server (default valuation) and the browser (the
 * sliders recompute locally). The output is extremely sensitive to the growth
 * and discount assumptions: a DCF expresses what you believe, it does not
 * discover a price.
 */

import type { DCFResult, FinancialStatement } from "@/types/stock";

export interface DcfAssumptions {
  /** Starting free cash flow, in currency units. */
  baseFcf: number;
  /** Annual growth in the explicit period, decimal. */
  growthRate: number;
  /** Perpetual growth after the explicit period, decimal. */
  terminalGrowth: number;
  /** Discount rate (WACC), decimal. */
  discountRate: number;
  /** Explicit forecast length. */
  years: number;
  /** Total debt minus cash. May be negative for a net-cash company. */
  netDebt: number;
  sharesOutstanding: number;
}

export function computeDcf(
  a: DcfAssumptions,
  currentPrice: number | null,
): DCFResult | null {
  // A terminal growth at or above the discount rate makes the Gordon formula
  // meaningless (infinite or negative value), so refuse rather than return it.
  if (
    !(a.baseFcf > 0) ||
    !(a.sharesOutstanding > 0) ||
    !(a.discountRate > a.terminalGrowth) ||
    a.years < 1
  ) {
    return null;
  }

  const projectedFCF: number[] = [];
  let presentValue = 0;
  let fcf = a.baseFcf;
  for (let year = 1; year <= a.years; year += 1) {
    fcf *= 1 + a.growthRate;
    projectedFCF.push(fcf);
    presentValue += fcf / (1 + a.discountRate) ** year;
  }

  const terminalValue =
    (fcf * (1 + a.terminalGrowth)) / (a.discountRate - a.terminalGrowth);
  presentValue += terminalValue / (1 + a.discountRate) ** a.years;

  const equityValue = presentValue - a.netDebt;
  const intrinsicValue = equityValue / a.sharesOutstanding;

  return {
    intrinsicValue,
    currentPrice,
    upside:
      currentPrice !== null && currentPrice > 0
        ? intrinsicValue / currentPrice - 1
        : null,
    wacc: a.discountRate,
    terminalGrowthRate: a.terminalGrowth,
    projectedFCF,
  };
}

/** Assumed equity risk premium. A convention, not a measurement. */
export const EQUITY_RISK_PREMIUM = 0.05;
/** Assumed spread of the company's borrowing cost over the risk-free rate. */
export const DEBT_SPREAD = 0.015;
/** US federal statutory corporate rate, used for the debt tax shield. */
export const TAX_RATE = 0.21;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Compound annual growth between the oldest and newest positive values. */
export function cagr(newest: number | null, oldest: number | null, years: number): number | null {
  if (newest === null || oldest === null || oldest <= 0 || newest <= 0 || years <= 0) {
    return null;
  }
  return (newest / oldest) ** (1 / years) - 1;
}

/**
 * Starting assumptions from the company's own filings.
 *
 * - growth: historical FCF CAGR, else revenue CAGR, else 5%; clamped to 0–15%
 *   because extrapolating a hot streak for five more years is the classic
 *   DCF error.
 * - discount rate: WACC, with cost of equity from CAPM
 *   (`riskFree + beta × 5%`) and cost of debt at `riskFree + 1.5%` after tax;
 *   clamped to 6–15%.
 *
 * Returns `null` when free cash flow is not positive — a DCF on negative cash
 * flow needs a turnaround story the model cannot supply.
 */
export function defaultDcfAssumptions(input: {
  /** Most recent first. */
  financials: FinancialStatement[];
  marketCap: number | null;
  price: number | null;
  beta: number | null;
  riskFreeRate: number;
}): DcfAssumptions | null {
  const { financials, marketCap, price, riskFreeRate } = input;
  const latest = financials[0];
  if (!latest || !marketCap || !price) return null;

  const baseFcf = latest.freeCashFlow;
  if (baseFcf === null || baseFcf <= 0) return null;

  const oldest = financials[financials.length - 1];
  const span = financials.length - 1;
  const growth =
    cagr(latest.freeCashFlow, oldest.freeCashFlow, span) ??
    cagr(latest.revenue, oldest.revenue, span) ??
    0.05;

  // Net debt needs a balance sheet; the newest filing can lack one.
  const sheet = financials.find((p) => p.totalDebt !== null || p.cashAndEquivalents !== null);
  const debt = sheet?.totalDebt ?? 0;
  const cash = sheet?.cashAndEquivalents ?? 0;

  const beta = clamp(input.beta ?? 1, 0.5, 2);
  const costOfEquity = riskFreeRate + beta * EQUITY_RISK_PREMIUM;
  const costOfDebt = (riskFreeRate + DEBT_SPREAD) * (1 - TAX_RATE);
  const total = marketCap + debt;
  const wacc = (marketCap / total) * costOfEquity + (debt / total) * costOfDebt;

  return {
    baseFcf,
    growthRate: clamp(growth, 0, 0.15),
    terminalGrowth: 0.025,
    discountRate: clamp(wacc, 0.06, 0.15),
    years: 5,
    netDebt: debt - cash,
    sharesOutstanding: marketCap / price,
  };
}
