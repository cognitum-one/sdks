import { describe, it, expect } from "vitest";

import { parseMoney } from "../src/meta-llm/types/money.js";

/**
 * Issue #90: only the simple decimal-string case (`"0.0042"`) was
 * previously exercised anywhere in this SDK. Adds a round-trip test for a
 * JSON-number amount sitting exactly on the classic binary-floating-point
 * boundary, plus a high-precision string that no `number` could represent
 * exactly -- the entire reason `Money.amount` is typed as `string`.
 */
describe("parseMoney", () => {
  it("parses a simple decimal-string amount", () => {
    const money = parseMoney({ amount: "0.0042", currency: "USD" });
    expect(money).toEqual({ amount: "0.0042", currency: "USD" });
  });

  it("round-trips a JSON-number amount at the float-precision boundary", () => {
    // 0.1 + 0.2 in IEEE-754 double precision is 0.30000000000000004, not
    // 0.3. `String()` of that number uses the shortest round-tripping
    // decimal representation, so this must come back byte-for-byte,
    // proving `parseMoney` performs no additional rounding/rescaling of
    // its own on the number path.
    const money = parseMoney({ amount: 0.30000000000000004, currency: "USD" });
    expect(money).toEqual({ amount: "0.30000000000000004", currency: "USD" });
  });

  it("preserves a high-precision decimal-string amount exactly", () => {
    // Beyond what any JS `number` could represent exactly -- must survive
    // untouched.
    const money = parseMoney({
      amount: "123.456789012345678901234567890",
      currency: "USD",
    });
    expect(money).toEqual({
      amount: "123.456789012345678901234567890",
      currency: "USD",
    });
  });

  it("accepts currency_code / currencyCode as fallback keys", () => {
    expect(parseMoney({ amount: "1.00", currency_code: "EUR" })).toEqual({
      amount: "1.00",
      currency: "EUR",
    });
    expect(parseMoney({ amount: "1.00", currencyCode: "GBP" })).toEqual({
      amount: "1.00",
      currency: "GBP",
    });
  });

  it("returns undefined for a missing or malformed value", () => {
    expect(parseMoney(null)).toBeUndefined();
    expect(parseMoney({ amount: "1.00" })).toBeUndefined();
    expect(parseMoney({ currency: "USD" })).toBeUndefined();
    expect(parseMoney({ amount: true, currency: "USD" })).toBeUndefined();
  });
});
