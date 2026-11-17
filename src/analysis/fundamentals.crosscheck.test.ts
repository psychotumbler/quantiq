/**
 * Phase 2c cross-check against an independent reference implementation.
 *
 * `__fixtures__/fundamentals-reference.py` computes the same five metrics from
 * the textbook definitions, written without reference to the TypeScript. It
 * emitted `__fixtures__/fundamentals-reference.json`: 250 randomised input
 * sets spanning magnitudes from 1 to 5e6, both signs, exact zeros, and absent
 * (`null`) inputs, together with its own expected output for each.
 *
 * This is the same technique 2a used for the indicators, and it catches the
 * class of bug unit tests miss: a formula that is self-consistently wrong.
 * Regenerate with:
 *
 *     python3 -I src/analysis/__fixtures__/fundamentals-reference.py \
 *       > src/analysis/__fixtures__/fundamentals-reference.json
 */

import { describe, expect, it } from "vitest";
import type { DerivedFundamentals, MetricResult } from "@/types/stock";
import type { FundamentalInputs } from "@/analysis/fundamentals";
import { computeDerivedFundamentals } from "@/analysis/fundamentals";
import cases from "@/analysis/__fixtures__/fundamentals-reference.json";

/** One reference case. `"unavailable"` stands in for "not computable". */
interface ReferenceCase {
  inputs: Record<string, number | null>;
  marketCap: number | null;
  expected: Record<string, number | "unavailable">;
}

const METRICS = [
  "roic",
  "fcfYield",
  "fcfPerShare",
  "interestCoverage",
  "altmanZScore",
] as const;

/** Largest tolerable relative difference; both sides are IEEE-754 doubles. */
const REL_TOLERANCE = 1e-12;

function relativeDifference(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? Math.abs(a - b) : Math.abs(a - b) / scale;
}

describe("cross-check against the independent Python reference", () => {
  const reference = cases as unknown as ReferenceCase[];

  it("has a substantial, mixed corpus", () => {
    expect(reference.length).toBeGreaterThanOrEqual(250);
    // Both branches must be well represented, or agreement proves little.
    for (const metric of METRICS) {
      const ok = reference.filter(
        (c) => c.expected[metric] !== "unavailable",
      ).length;
      expect(ok, `${metric} computable cases`).toBeGreaterThan(50);
      expect(
        reference.length - ok,
        `${metric} unavailable cases`,
      ).toBeGreaterThan(10);
    }
  });

  it("agrees with the reference on every case", () => {
    let maxRelative = 0;
    let compared = 0;
    const disagreements: string[] = [];

    reference.forEach((testCase, index) => {
      const derived: DerivedFundamentals = computeDerivedFundamentals(
        testCase.inputs as unknown as FundamentalInputs,
        { market: "US", marketCap: testCase.marketCap },
      );

      for (const metric of METRICS) {
        const expected = testCase.expected[metric];
        const actual: MetricResult = derived[metric];

        if (expected === "unavailable") {
          if (actual.status !== "unavailable") {
            disagreements.push(
              `case ${index} ${metric}: reference says unavailable, got ${actual.value}`,
            );
          }
          continue;
        }

        if (actual.status !== "ok") {
          disagreements.push(
            `case ${index} ${metric}: reference says ${expected}, got unavailable (${actual.reason}: ${actual.detail})`,
          );
          continue;
        }

        compared += 1;
        const relative = relativeDifference(actual.value, expected);
        maxRelative = Math.max(maxRelative, relative);
        if (relative > REL_TOLERANCE) {
          disagreements.push(
            `case ${index} ${metric}: expected ${expected}, got ${actual.value} (rel ${relative})`,
          );
        }
      }
    });

    // Report every disagreement at once rather than failing on the first.
    expect(disagreements.slice(0, 10).join("\n")).toBe("");
    expect(compared).toBeGreaterThan(700);
    // Surfaced so a regression that merely loosens precision is still visible.
    expect(maxRelative).toBeLessThan(REL_TOLERANCE);
    console.log(
      `cross-check: ${compared} values compared, max relative difference ${maxRelative.toExponential(2)}`,
    );
  });
});
