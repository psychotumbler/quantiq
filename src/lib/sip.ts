/**
 * SIP (systematic investment plan) arithmetic.
 *
 * Contributions are made at the START of each month and compound monthly at
 * `annualReturn / 12` — the convention Indian SIP calculators use. The return
 * is an assumption the user supplies; markets do not deliver a constant rate.
 */

import type { SIPProjection } from "@/types/stock";

export function projectSip(
  monthlyInvestment: number,
  annualReturn: number,
  years: number,
  /** Yearly step-up in the monthly amount, decimal (0.1 = +10% each year). */
  stepUp = 0,
): SIPProjection {
  const monthlyRate = annualReturn / 12;
  let value = 0;
  let invested = 0;
  let contribution = monthlyInvestment;
  const yearlyBreakdown: SIPProjection["yearlyBreakdown"] = [];

  for (let year = 1; year <= years; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      value = (value + contribution) * (1 + monthlyRate);
      invested += contribution;
    }
    yearlyBreakdown.push({ year, invested, value, gains: value - invested });
    contribution *= 1 + stepUp;
  }

  return {
    monthlyInvestment,
    expectedAnnualReturn: annualReturn,
    years,
    totalInvested: invested,
    projectedValue: value,
    totalGains: value - invested,
    yearlyBreakdown,
  };
}

/** Monthly SIP needed to reach `target` (no step-up). */
export function requiredSip(target: number, annualReturn: number, years: number): number {
  const perRupee = projectSip(1, annualReturn, years).projectedValue;
  return perRupee > 0 ? target / perRupee : 0;
}
