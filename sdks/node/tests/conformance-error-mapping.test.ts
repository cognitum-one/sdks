import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "../src/agentic/retry-after.js";
import { mapMetaLlmHttpError } from "../src/meta-llm/http-errors.js";

/**
 * Node adapter for the cross-language error-mapping corpus
 * (`sdks/fixtures/error-mapping/`, ADR-0030a §D1 Domain layer, issue #75).
 *
 * Python and Rust run the SAME cases through their own mappers. Each
 * language's own suite only ever checks that language against itself; this is
 * the one that catches the three drifting apart.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  __dirname,
  "../../fixtures/error-mapping/meta-llm-http-errors-v1.json",
);

interface CanonicalResult {
  kind: string;
  retryable: boolean;
  code: string | null;
  retryAfterMs: number | null;
  upgrade: Record<string, unknown> | null;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

function fakeResponse(status: number, body: string, headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/**
 * Emit the language-neutral shape the corpus compares. Absent values become
 * `null` rather than being omitted, so a missing security-significant field
 * cannot normalize into equality (ADR-0030a §D2).
 */
function canonical(error: {
  kind: string;
  retryable: boolean;
  code?: string;
  retryAfterMs?: number;
  upgrade?: {
    requiredTier?: string;
    heldTier?: string;
    requiredScope?: string;
    upgradeUrl?: string;
    retryWith?: { fallbackPolicy?: string };
  };
}): CanonicalResult {
  return {
    kind: error.kind,
    retryable: error.retryable,
    code: error.code ?? null,
    retryAfterMs: error.retryAfterMs ?? null,
    upgrade: error.upgrade
      ? {
          requiredTier: error.upgrade.requiredTier ?? null,
          heldTier: error.upgrade.heldTier ?? null,
          requiredScope: error.upgrade.requiredScope ?? null,
          upgradeUrl: error.upgrade.upgradeUrl ?? null,
          retryWith: error.upgrade.retryWith
            ? { fallbackPolicy: error.upgrade.retryWith.fallbackPolicy ?? null }
            : null,
        }
      : null,
  };
}

function expectationFor(testCase: any) {
  // A declared divergence pins THIS language's actual behaviour, so a
  // divergence can neither hide nor drift unnoticed.
  return testCase.knownDivergence?.node ?? testCase.expected;
}

describe("cross-language error-mapping conformance (issue #75)", () => {
  it("the corpus is non-empty and every case has an id and expectation", () => {
    // Guards the adapter itself: a fixture that failed to load, or a corpus
    // silently emptied, must not read as a green run.
    expect(fixture.cases.length).toBeGreaterThan(20);
    for (const testCase of fixture.cases) {
      expect(testCase.id, "every case needs an id").toBeTruthy();
      expect(testCase.expected, `${testCase.id} needs an expectation`).toBeTruthy();
      expect(testCase.why, `${testCase.id} must say why it exists`).toBeTruthy();
    }
  });

  for (const testCase of fixture.cases) {
    const divergent = Boolean(testCase.knownDivergence);
    const label = divergent ? `${testCase.id} [known divergence]` : testCase.id;

    it(label, async () => {
      const { status, body, headers } = testCase.response;
      const error = await mapMetaLlmHttpError(
        fakeResponse(status, body, headers ?? {}),
        fixture.operation,
        fixture.requestId,
      );

      const expected = expectationFor(testCase);
      expect(canonical(error as never)).toEqual({
        kind: expected.kind,
        retryable: expected.retryable,
        code: expected.code,
        retryAfterMs: expected.retryAfterMs,
        upgrade: expected.upgrade,
      });
      expect(error.message).toContain(expected.messageContains);

      if (testCase.mustNotAppearInUpgrade) {
        expect(JSON.stringify(error.upgrade ?? null)).not.toContain(testCase.mustNotAppearInUpgrade);
      }
    });
  }
});

/**
 * The HTTP-date cases above reach the mapper through `Date.now()`, so they are
 * pinned separately against the fixture's injected instant. Without this the
 * date branch would only be exercised at whatever "now" happens to be.
 */
describe("declared divergences stay declared", () => {
  // A `knownDivergence` is a deliberate exception. Without these, adding one
  // turns a regression green instantly and nobody notices.
  const invariants = fixture.divergenceInvariants;
  const divergent = fixture.cases.filter((c: any) => c.knownDivergence);

  it("only the cases the corpus declares are divergent", () => {
    expect(divergent.map((c: any) => c.id).sort()).toEqual(
      [...invariants.expectedDivergentCaseIds].sort(),
    );
  });

  it("each divergence names a tracking issue and a reason", () => {
    for (const testCase of divergent) {
      for (const key of invariants.requiredKeys) {
        expect(testCase.knownDivergence[key], `${testCase.id} needs ${key}`).toBeTruthy();
      }
    }
  });

  it("a divergence covers at most one language, and at least one", () => {
    // Widening a divergence to a second language would mean the corpus no
    // longer pins agreement anywhere -- that must be a deliberate edit, not a
    // quiet one.
    for (const testCase of divergent) {
      const languages = invariants.languages.filter((l: string) => testCase.knownDivergence[l]);
      expect(languages.length, `${testCase.id} language overrides`).toBeGreaterThanOrEqual(1);
      expect(languages.length).toBeLessThanOrEqual(invariants.maxLanguagesPerDivergence);
    }
  });
});

describe("Retry-After parsing against the corpus instant", () => {
  const nowMs = fixture.nowMsForHttpDateCases;

  for (const testCase of fixture.cases) {
    const header = testCase.response.headers?.["retry-after"];
    if (header === undefined) continue;

    const atInstant = testCase.retryAfterMsAtPinnedInstant ?? testCase.expected.retryAfterMs;
    it(`${testCase.id} -> ${atInstant}ms at the pinned instant`, () => {
      expect(parseRetryAfterMs(header, nowMs)).toBe(atInstant ?? undefined);
    });
  }

  // The grammar cases. Every row here disagreed across the three SDKs before
  // the parser was spelled out instead of delegated to each platform.
  for (const edge of fixture.retryAfterEdgeCases) {
    it(`${JSON.stringify(edge.header)} -> ${edge.expectedMs} (${edge.why})`, () => {
      expect(parseRetryAfterMs(edge.header, nowMs)).toBe(edge.expectedMs ?? undefined);
    });
  }
});
