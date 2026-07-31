import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Node adapter for the cross-language request-body corpus
 * (`sdks/fixtures/wire/`, ADR-0030a §D1 Wire layer, issue #75).
 *
 * Node builds its body with `JSON.stringify` over exactly the object the
 * caller passed, so an unset optional is simply absent. Python and Rust had
 * to be fixed to match; this pins Node so it cannot drift the other way.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "../../fixtures/wire/meta-llm-request-bodies-v1.json"), "utf8"),
);

describe("cross-language wire request bodies (issue #75)", () => {
  it("the corpus is loaded and every case is complete", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
    for (const c of fixture.cases) {
      expect(c.id, "case needs an id").toBeTruthy();
      expect(c.why, `${c.id} must say why it exists`).toBeTruthy();
      expect(c.expectedBody, `${c.id} needs an expected body`).toBeTruthy();
    }
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.id} serialises to the canonical body`, () => {
      // This is what this SDK puts on the wire: `nonstream.ts` does
      // `JSON.stringify(body)` on the caller's object, unchanged.
      const serialised = JSON.parse(JSON.stringify(testCase.input));
      expect(normalise(serialised)).toEqual(normalise(testCase.expectedBody));
    });

    it(`${testCase.id} sends no null for an unset optional`, () => {
      // The specific defect: absent and null are different requests, and the
      // gateway rejects the null form.
      const nulls = findNullPaths(JSON.parse(JSON.stringify(testCase.input)));
      expect(nulls, `explicit nulls at ${nulls.join(", ")}`).toEqual([]);
    });
  }
});

/** Numbers compare by value: JSON has one number type, so 0 === 0.0. */
function normalise(value: unknown): unknown {
  if (typeof value === "number") return Number(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

function findNullPaths(value: unknown, at = "$"): string[] {
  if (value === null) return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => findNullPaths(v, `${at}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      findNullPaths(v, `${at}.${k}`),
    );
  }
  return [];
}
