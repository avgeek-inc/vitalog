import { Decimal } from "decimal.js";
import { expect, test } from "vitest";
import { numericProjection } from "../src/domain/summary.js";

test("Nonzero computed values below the JSON-number range retain decimal text", () => {
  const smallestSourceNumber = new Decimal(Number.MIN_VALUE);
  const converted = smallestSourceNumber.div("4.184");
  expect(converted.toNumber()).toBe(0);
  expect(numericProjection(converted)).toBe(converted.toFixed());
  expect(new Decimal(numericProjection(converted)).isZero()).toBe(false);
  expect(numericProjection(converted.negated())).toBe(
    converted.negated().toFixed(),
  );
});

test("Computed zero remains the supplied numerical zero", () => {
  expect(numericProjection(new Decimal(0))).toBe(0);
  expect(numericProjection(new Decimal("0.000"))).toBe(0);
});
