/**
 * Concrete `SecretRedactor` implementation — the sentinel scan defined by
 * ADR-0028 §D13, driven by ADR-0022 §D10 classification and the D12
 * category list. Closes issue #54.
 *
 * Faithful to D13's exact mechanism (see docs/adr/0028-...-redaction.md):
 *
 *   1. A key-name check against the D12 category list runs first — a value
 *      can be sensitive purely because of the field it lives in, regardless
 *      of shape.
 *   2. Fixed-format matchers (bearer token, JWT, PEM private-key block,
 *      cloud-provider access-key pattern, pre-signed URL query parameter)
 *      run next.
 *   3. A Shannon-entropy fallback over a contiguous token of >= 20 characters
 *      runs ONLY if no fixed-format matcher hit — a match is classified by
 *      pattern first, entropy only as a fallback. The threshold is scoped to
 *      the token's actual character set rather than one global cutoff: a
 *      16-symbol hex-only token (max possible entropy log2(16) = 4.0 bits/
 *      char) uses a 3.0 bits/char threshold, since real hex-encoded secrets
 *      never approach the unreachable theoretical max (empirically 3.4-3.9
 *      bits/char for 32/64-char hex tokens); a broader alphanumeric/
 *      base64-like token keeps the original 4.0 bits/char threshold. This is
 *      the same charset-scoped-threshold technique used by detect-secrets /
 *      truffleHog.
 *   4. Traversal is a bounded-depth-8 DFS: a value reached at depth 9 or
 *      deeper is replaced with `[max-depth-exceeded]` without further
 *      recursion. Cycles are broken by an object-identity ancestor set and
 *      replaced with `[cyclic-reference]`. Matches are replaced with
 *      `[redacted:<category>]`, where `<category>` is a D12 category name,
 *      or `secret-pattern` / `high-entropy` for value-only matches.
 */

import type { SecretClassification, SecretRedactor } from "./credentials.js";

/** D12/D13 category list consulted by the key-name check. */
export type D12Category =
  | "prompts"
  | "messages"
  | "tool-arguments-results"
  | "source"
  | "repository-urls"
  | "patches"
  | "credentials"
  | "environment-values"
  | "webhook-bodies"
  | "signed-urls"
  | "raw-tenant-user-identifiers";

const MAX_DEPTH = 8;
// Broader alphanumeric/base64-like alphabets (up to ~64 symbols, max
// possible entropy ~6.0 bits/char) keep the original cutoff.
const ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.0;
// Pure hex alphabets (16 symbols, max possible entropy exactly 4.0
// bits/char) can never realistically reach 4.0 — real hex-encoded secrets
// score 3.4-3.9 bits/char — so they get a charset-scoped, lower cutoff.
const ENTROPY_THRESHOLD_HEX_BITS_PER_CHAR = 3.0;
const ENTROPY_MIN_TOKEN_LEN = 20;

const MAX_DEPTH_MARKER = "[max-depth-exceeded]";
const CYCLIC_MARKER = "[cyclic-reference]";

interface KeyNameRule {
  category: D12Category;
  classification: SecretClassification;
  /** Matched against the field name lower-cased with separators stripped. */
  keys: RegExp;
}

// D12/D13 category list, ADR-0028 §D12 and §D13's restatement of it:
// prompts, messages, tool arguments/results, source, repository URLs,
// patches, credentials, environment values, webhook bodies, signed URLs,
// raw tenant/user identifiers.
const KEY_NAME_RULES: KeyNameRule[] = [
  {
    category: "credentials",
    classification: "secret",
    keys: /^(credential|credentials|apikey|clientsecret|secret|token|password|accesskey|authorization)$/,
  },
  {
    category: "environment-values",
    classification: "secret",
    keys: /^(env|environment|envvars|environmentvalues|environmentvariables)$/,
  },
  {
    category: "signed-urls",
    classification: "secret",
    keys: /^(signedurl|presignedurl|signedurls)$/,
  },
  {
    category: "webhook-bodies",
    classification: "sensitive",
    keys: /^(webhookbody|webhookpayload|webhookbodies)$/,
  },
  {
    category: "raw-tenant-user-identifiers",
    classification: "sensitive",
    keys: /^(userid|tenantid|rawuserid|rawtenantid|accountid)$/,
  },
  {
    category: "prompts",
    classification: "sensitive",
    keys: /^(prompt|prompts|systemprompt)$/,
  },
  {
    category: "messages",
    classification: "sensitive",
    keys: /^(message|messages|chatmessages)$/,
  },
  {
    category: "tool-arguments-results",
    classification: "sensitive",
    keys: /^(toolarguments|toolresults|toolargs|tooloutput)$/,
  },
  {
    category: "source",
    classification: "sensitive",
    keys: /^(source|sourcecode|sourcefiles)$/,
  },
  {
    category: "repository-urls",
    classification: "sensitive",
    keys: /^(repositoryurl|repourl|repositoryurls)$/,
  },
  {
    category: "patches",
    classification: "sensitive",
    keys: /^(patch|patches|diff)$/,
  },
];

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyNameRule(fieldName: string | undefined): KeyNameRule | undefined {
  if (!fieldName) return undefined;
  const normalized = normalizeFieldName(fieldName);
  return KEY_NAME_RULES.find((rule) => rule.keys.test(normalized));
}

// Fixed-format matchers (ADR-0028 §D13), evaluated before the entropy
// fallback. Each matches a *whole* leaf value, since D13 replaces the leaf
// entirely rather than redacting a substring.
const BEARER_TOKEN_RE = /^bearer\s+[a-z0-9._~+/-]{16,}=*$/i;
const JWT_RE = /^[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}$/i;
const PEM_PRIVATE_KEY_RE = /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/;
// AWS access/session key IDs (AKIA.../ASIA...) and Google API keys (AIza...).
const CLOUD_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/;
// Pre-signed URL query parameters (SigV4, generic "Signature="). Azure SAS
// uses a bare `se=` (signed-expiry) param, which is over-broad matched alone
// (any URL with a `se` query param would hit) — require it co-occur with
// `sig=` (the SAS signature param), which real SAS URLs always carry
// alongside `se=`. Safe-direction tradeoff: this narrows false positives
// without risking a missed real SAS URL. (Two plain regexes ANDed rather
// than one lookahead-based regex, so the same logic ports unchanged to
// Rust's `regex` crate, which has no lookaround support.)
const PRESIGNED_URL_PARAM_RE = /[?&](?:X-Amz-Signature|X-Amz-Credential|Signature)=/i;
const AZURE_SAS_SE_RE = /[?&]se=/i;
const AZURE_SAS_SIG_RE = /[?&]sig=/i;

function matchesFixedFormat(value: string): boolean {
  return (
    BEARER_TOKEN_RE.test(value) ||
    JWT_RE.test(value) ||
    PEM_PRIVATE_KEY_RE.test(value) ||
    CLOUD_ACCESS_KEY_RE.test(value) ||
    PRESIGNED_URL_PARAM_RE.test(value) ||
    (AZURE_SAS_SE_RE.test(value) && AZURE_SAS_SIG_RE.test(value))
  );
}

/** Shannon entropy in bits/char over a string's character distribution. */
function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = token.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Maximal runs of token-shaped characters (letters, digits, and the small
// symbol set typical of base64/URL-safe secrets), used to find contiguous
// candidates for the entropy fallback without over-matching plain prose.
const TOKEN_RE = /[A-Za-z0-9+/=_.~-]+/g;

// A token drawn purely from the 16-symbol hex alphabet gets the lower,
// charset-scoped entropy threshold (see ENTROPY_THRESHOLD_HEX_BITS_PER_CHAR).
const HEX_CHARSET_RE = /^[0-9a-fA-F]+$/;

function entropyThresholdFor(token: string): number {
  return HEX_CHARSET_RE.test(token) ? ENTROPY_THRESHOLD_HEX_BITS_PER_CHAR : ENTROPY_THRESHOLD_BITS_PER_CHAR;
}

function matchesEntropyFallback(value: string): boolean {
  const tokens = value.match(TOKEN_RE) ?? [];
  for (const token of tokens) {
    if (token.length >= ENTROPY_MIN_TOKEN_LEN && shannonEntropy(token) >= entropyThresholdFor(token)) {
      return true;
    }
  }
  return false;
}

/** Redacted-leaf category, per D13: a D12 category, or a value-only match. */
type LeafCategory = D12Category | "secret-pattern" | "high-entropy";

function classifyLeaf(fieldName: string | undefined, value: string): LeafCategory | undefined {
  const rule = keyNameRule(fieldName);
  if (rule) return rule.category;
  if (matchesFixedFormat(value)) return "secret-pattern";
  if (matchesEntropyFallback(value)) return "high-entropy";
  return undefined;
}

/**
 * Concrete `SecretRedactor` (ADR-0022 §D1/§D10) implementing the exact
 * sentinel-scan mechanism specified by ADR-0028 §D13.
 */
export class SentinelSecretRedactor implements SecretRedactor {
  classify(fieldName: string, value: unknown): SecretClassification {
    const rule = keyNameRule(fieldName);
    if (rule) return rule.classification;
    if (typeof value === "string") {
      if (matchesFixedFormat(value)) return "secret";
      if (matchesEntropyFallback(value)) return "secret";
    }
    return "public";
  }

  redact<T>(value: T): T {
    return this.#walk(value, undefined, 0, new Set<object>()) as T;
  }

  #walk(value: unknown, fieldName: string | undefined, depth: number, ancestors: Set<object>): unknown {
    if (depth > MAX_DEPTH) {
      return MAX_DEPTH_MARKER;
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      const category = classifyLeaf(fieldName, value);
      return category ? `[redacted:${category}]` : value;
    }

    if (typeof value !== "object") {
      // Numbers, booleans, bigints: D13's matcher set applies to string
      // leaves only.
      return value;
    }

    const obj = value as object;
    if (ancestors.has(obj)) {
      return CYCLIC_MARKER;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(obj);

    if (Array.isArray(value)) {
      return value.map((item) => this.#walk(item, fieldName, depth + 1, nextAncestors));
    }

    if (value instanceof Map) {
      const result = new Map<unknown, unknown>();
      for (const [key, val] of value.entries()) {
        const keyName = typeof key === "string" ? key : undefined;
        result.set(key, this.#walk(val, keyName, depth + 1, nextAncestors));
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.#walk(val, key, depth + 1, nextAncestors);
    }
    return result;
  }
}
