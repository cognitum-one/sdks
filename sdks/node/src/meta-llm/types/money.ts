/**
 * ADR-0028's `Money`: an exact decimal amount + ISO-4217 currency, decoded
 * from wire USD decimal values so cost/price/savings fields never enter the
 * public domain model as binary floating point (ADR-0024b §D3: "Wire
 * fields such as current USD price values decode into ADR-0028 decimal
 * `Money`; they never enter the public domain model as binary floating
 * point").
 *
 * No `Money`/decimal type exists yet elsewhere in this SDK (checked
 * `../../agentic/receipts.ts`'s `CostObservation.amount`, which is still a
 * plain `number` from the earlier ADR-0028 receipt/lineage stub — that is
 * an existing gap, out of scope to fix here, not something this type
 * inherits). This is a minimal string-backed decimal wrapper rather than a
 * new bignum/decimal dependency — the SDK does not otherwise depend on one,
 * and a decimal string is the only representation that cannot silently
 * lose precision at the JS/TS layer.
 *
 * Deliberately no arithmetic is provided here — this type exists to
 * prevent accidental floating-point ingestion of money values, not to be a
 * money-math library. Callers needing arithmetic should parse `amount`
 * with a decimal library of their own choosing.
 */
export interface Money {
  /** Exact decimal string, e.g. `"0.0123"`. Never a `number`. */
  readonly amount: string;
  /** ISO-4217 currency code, e.g. `"USD"`. */
  readonly currency: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a wire money value into a {@link Money}. Accepts `amount` as
 * either a decimal string (preferred — exact) or a JSON number (tolerated;
 * a JSON number has already lost the ability to represent arbitrary
 * decimal precision at the `JSON.parse` boundary, but this decoder
 * performs no further floating-point arithmetic on it — it is converted
 * with `String()` only, never rounded or rescaled). Returns `undefined`
 * for a missing or malformed value rather than fabricating a zero amount.
 */
export function parseMoney(raw: unknown): Money | undefined {
  if (!isRecord(raw)) return undefined;
  const amountRaw = raw.amount;
  const currency = raw.currency ?? raw.currency_code ?? raw.currencyCode;
  if ((typeof amountRaw === "string" || typeof amountRaw === "number") && typeof currency === "string") {
    return { amount: String(amountRaw), currency };
  }
  return undefined;
}
